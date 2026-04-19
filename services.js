import mongoose from 'mongoose';
import { createClient } from 'redis';
import Queue from 'bull';
import nodemailer from 'nodemailer';
import Anthropic from '@anthropic-ai/sdk';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import { register, Counter, Gauge, Histogram } from 'prom-client';
import * as winston from 'winston';

// ============================================================================
// LOGGER
// ============================================================================

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// ============================================================================
// DATABASE SERVICE
// ============================================================================

export class DatabaseService {
  static async connect() {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        user: process.env.MONGODB_USER,
        pass: process.env.MONGODB_PASSWORD,
        dbName: process.env.MONGODB_DB,
      });
      logger.info('✅ MongoDB connected');
    } catch (error) {
      logger.error('❌ MongoDB connection failed:', error);
      throw error;
    }
  }

  static async disconnect() {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected');
  }

  static getConnection() {
    return mongoose;
  }
}

// ============================================================================
// REDIS SERVICE
// ============================================================================

export class RedisService {
  static client = null;

  static async connect() {
    try {
      this.client = createClient({
        url: process.env.REDIS_URL,
        password: process.env.REDIS_PASSWORD,
      });

      this.client.on('error', (err) => logger.error('Redis error:', err));
      this.client.on('connect', () => logger.info('✅ Redis connected'));

      await this.client.connect();
    } catch (error) {
      logger.error('❌ Redis connection failed:', error);
      throw error;
    }
  }

  static async get(key) {
    return await this.client.get(key);
  }

  static async set(key, value, ttl = null) {
    if (ttl) {
      await this.client.setEx(key, ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  static async delete(key) {
    await this.client.del(key);
  }

  static async disconnect() {
    if (this.client) {
      await this.client.quit();
      logger.info('Redis disconnected');
    }
  }
}

// ============================================================================
// QUEUE SERVICE (BullMQ)
// ============================================================================

export class QueueService {
  static queues = {};

  static initQueues() {
    this.queues.tickets = new Queue('tickets', process.env.REDIS_URL);
    this.queues.emails = new Queue('emails', process.env.REDIS_URL);
    this.queues.webhooks = new Queue('webhooks', process.env.REDIS_URL);

    logger.info('✅ Queues initialized');
  }

  static async addTicketJob(ticketData) {
    const job = await this.queues.tickets.add(ticketData, {
      attempts: parseInt(process.env.MAX_RETRY_ATTEMPTS || 3),
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: true,
    });

    logger.info(`Ticket job added: ${job.id}`);
    return job;
  }

  static async addEmailJob(emailData) {
    const job = await this.queues.emails.add(emailData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
    });

    return job;
  }

  static async addWebhookJob(webhookData) {
    const job = await this.queues.webhooks.add(webhookData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    return job;
  }

  static onTicketProcess(handler) {
    this.queues.tickets.process(parseInt(process.env.QUEUE_CONCURRENCY || 5), handler);
  }

  static onEmailProcess(handler) {
    this.queues.emails.process(handler);
  }

  static onWebhookProcess(handler) {
    this.queues.webhooks.process(handler);
  }
}

// ============================================================================
// EMAIL SERVICE
// ============================================================================

export class EmailService {
  static transporter = null;

  static initialize() {
    // Gmail configuration
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASSWORD,
      },
    });

    logger.info('✅ Email service initialized');
  }

  static async sendTicketReply(ticketId, customerEmail, subject, body) {
    try {
      const mailOptions = {
        from: process.env.SMTP_FROM || 'support@autoresolve.ai',
        to: customerEmail,
        subject: `Re: ${subject}`,
        html: this.getEmailTemplate(body),
      };

      const result = await this.transporter.sendMail(mailOptions);
      logger.info(`Email sent to ${customerEmail} for ticket ${ticketId}`);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      logger.error(`Email send failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  static getEmailTemplate(body) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #10b981; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2>Your Support Ticket Has Been Updated</h2>
        </div>
        <div style="background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb;">
          <p>Hello,</p>
          <p>${body}</p>
          <p>Best regards,<br/>AutoResolve AI Support Team</p>
        </div>
        <div style="background: #f3f4f6; padding: 10px; text-align: center; font-size: 12px; color: #6b7280;">
          <p>© 2024 AutoResolve AI. All rights reserved.</p>
        </div>
      </div>
    `;
  }
}

// ============================================================================
// LLM SERVICE (Claude)
// ============================================================================

export class LLMService {
  static client = null;

  static initialize() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    logger.info('✅ Claude API initialized');
  }

  static async classifyTicket(ticketText) {
    try {
      const message = await this.client.messages.create({
        model: process.env.CLAUDE_MODEL || 'claude-3-sonnet-20240229',
        max_tokens: 500,
        system: `You are an expert support ticket classifier. Analyze the ticket and respond ONLY with valid JSON.
        Return a JSON object with: category (refund|shipping|payment|account|bug|abuse), urgency (low|medium|high|critical), sentiment (angry|neutral|happy).`,
        messages: [
          {
            role: 'user',
            content: `Classify this support ticket:\n\n${ticketText}`,
          },
        ],
      });

      const responseText = message.content[0].text;
      const classification = JSON.parse(responseText);
      logger.info(`Ticket classified: ${classification.category} (${classification.urgency})`);
      return classification;
    } catch (error) {
      logger.error(`LLM classification failed: ${error.message}`);
      throw error;
    }
  }

  static async generateExplanation(ticketData, decision) {
    try {
      const message = await this.client.messages.create({
        model: process.env.CLAUDE_MODEL || 'claude-3-sonnet-20240229',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: `Generate a brief human-readable explanation for this support ticket decision:\n\nTicket: ${ticketData.subject}\nCategory: ${ticketData.category}\nDecision: ${decision}\nConfidence: ${ticketData.confidence}%\n\nExplain why this decision was made.`,
          },
        ],
      });

      return message.content[0].text;
    } catch (error) {
      logger.error(`LLM explanation generation failed: ${error.message}`);
      return 'Unable to generate explanation';
    }
  }
}

// ============================================================================
// AUTHENTICATION SERVICE
// ============================================================================

export class AuthService {
  static generateToken(userId, role) {
    return jwt.sign(
      { userId, role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRY || '7d' }
    );
  }

  static verifyToken(token) {
    try {
      return jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      logger.warn('Token verification failed');
      return null;
    }
  }

  static async hashPassword(password) {
    return await bcrypt.hash(password, 10);
  }

  static async verifyPassword(password, hash) {
    return await bcrypt.compare(password, hash);
  }

  static middleware() {
    return (req, res, next) => {
      const token = req.headers.authorization?.split(' ')[1];

      if (!token) {
        return res.status(401).json({ error: 'No token provided' });
      }

      const decoded = this.verifyToken(token);
      if (!decoded) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      req.user = decoded;
      next();
    };
  }

  static requireRole(roles) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      next();
    };
  }
}

// ============================================================================
// WEBHOOK SERVICE
// ============================================================================

export class WebhookService {
  static async sendSlackNotification(ticketData, decision) {
    try {
      const message = {
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `🎫 Ticket ${decision === 'escalate' ? '⬆️ Escalated' : '✅ Resolved'}`,
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Ticket ID*\n${ticketData.ticket_id}` },
              { type: 'mrkdwn', text: `*Category*\n${ticketData.category}` },
              { type: 'mrkdwn', text: `*Urgency*\n${ticketData.urgency}` },
              { type: 'mrkdwn', text: `*Confidence*\n${(ticketData.confidence * 100).toFixed(0)}%` },
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Subject*\n${ticketData.subject}`,
            },
          },
        ],
      };

      await axios.post(process.env.SLACK_WEBHOOK_URL, message);
      logger.info(`Slack notification sent for ticket ${ticketData.ticket_id}`);
      return { success: true };
    } catch (error) {
      logger.error(`Slack notification failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  static async sendDiscordNotification(ticketData, decision) {
    try {
      const embed = {
        title: `Ticket ${decision === 'escalate' ? 'Escalated' : 'Resolved'} ✅`,
        description: ticketData.subject,
        color: decision === 'escalate' ? 0xff0000 : 0x00ff00,
        fields: [
          { name: 'Ticket ID', value: ticketData.ticket_id, inline: true },
          { name: 'Category', value: ticketData.category, inline: true },
          { name: 'Urgency', value: ticketData.urgency, inline: true },
          { name: 'Confidence', value: `${(ticketData.confidence * 100).toFixed(0)}%`, inline: true },
          { name: 'Customer', value: ticketData.email, inline: false },
        ],
        timestamp: new Date().toISOString(),
      };

      await axios.post(process.env.DISCORD_WEBHOOK_URL, { embeds: [embed] });
      logger.info(`Discord notification sent for ticket ${ticketData.ticket_id}`);
      return { success: true };
    } catch (error) {
      logger.error(`Discord notification failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }
}

// ============================================================================
// METRICS SERVICE (Prometheus)
// ============================================================================

export class MetricsService {
  static counters = {};
  static gauges = {};
  static histograms = {};

  static initialize() {
    // Counters
    this.counters.ticketsProcessed = new Counter({
      name: 'autoresolve_tickets_processed_total',
      help: 'Total tickets processed',
      labelNames: ['status', 'decision'],
    });

    this.counters.toolCalls = new Counter({
      name: 'autoresolve_tool_calls_total',
      help: 'Total tool calls made',
      labelNames: ['tool', 'status'],
    });

    this.counters.errors = new Counter({
      name: 'autoresolve_errors_total',
      help: 'Total errors',
      labelNames: ['error_type'],
    });

    // Gauges
    this.gauges.queueLength = new Gauge({
      name: 'autoresolve_queue_length',
      help: 'Current queue length',
      labelNames: ['queue_name'],
    });

    this.gauges.avgConfidence = new Gauge({
      name: 'autoresolve_avg_confidence',
      help: 'Average confidence score',
    });

    // Histograms
    this.histograms.processingTime = new Histogram({
      name: 'autoresolve_processing_time_ms',
      help: 'Ticket processing time in milliseconds',
      buckets: [100, 500, 1000, 2000, 5000],
      labelNames: ['stage'],
    });

    logger.info('✅ Prometheus metrics initialized');
  }

  static recordTicketProcessed(status, decision) {
    this.counters.ticketsProcessed.labels(status, decision).inc();
  }

  static recordToolCall(toolName, status) {
    this.counters.toolCalls.labels(toolName, status).inc();
  }

  static recordError(errorType) {
    this.counters.errors.labels(errorType).inc();
  }

  static updateQueueLength(queueName, length) {
    this.gauges.queueLength.labels(queueName).set(length);
  }

  static updateAvgConfidence(score) {
    this.gauges.avgConfidence.set(score);
  }

  static recordProcessingTime(stage, ms) {
    this.histograms.processingTime.labels(stage).observe(ms);
  }

  static getMetrics() {
    return register.metrics();
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  DatabaseService,
  RedisService,
  QueueService,
  EmailService,
  LLMService,
  AuthService,
  WebhookService,
  MetricsService,
  logger,
};
