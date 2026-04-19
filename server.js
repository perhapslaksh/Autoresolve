import 'dotenv/config.js';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';
import { register } from 'prom-client';

// Import services
import {
  DatabaseService,
  RedisService,
  QueueService,
  EmailService,
  LLMService,
  AuthService,
  WebhookService,
  MetricsService,
  logger,
} from './services.js';

import {
  Ticket,
  AuditLog,
  Admin,
  EmailLog,
  WebhookLog,
  Metrics as MetricsModel,
  LearnedPatterns,
} from './models.js';

// ============================================================================
// APP SETUP
// ============================================================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(helmet());
app.use(cors());
app.use(express.json());

// Middleware
app.use(AuthService.middleware());

// ============================================================================
// INITIALIZATION
// ============================================================================

async function initializeServices() {
  try {
    logger.info('🚀 Initializing AutoResolve AI Enterprise...');

    // Database
    if (process.env.ENABLE_MONGODB === 'true') {
      await DatabaseService.connect();
    }

    // Redis
    if (process.env.ENABLE_REDIS === 'true') {
      await RedisService.connect();
      QueueService.initQueues();
    }

    // Email
    if (process.env.ENABLE_EMAIL === 'true') {
      EmailService.initialize();
    }

    // LLM
    if (process.env.ENABLE_LLM === 'true') {
      LLMService.initialize();
    }

    // Metrics
    if (process.env.ENABLE_METRICS === 'true') {
      MetricsService.initialize();
    }

    logger.info('✅ All services initialized');
  } catch (error) {
    logger.error('❌ Initialization failed:', error);
    process.exit(1);
  }
}

// ============================================================================
// API ROUTES
// ============================================================================

// ====== HEALTH & INFO ======

app.get('/', (req, res) => {
  res.json({
    name: 'AutoResolve AI - Enterprise Edition',
    version: '2.0.0',
    status: 'running ✅',
    features: {
      database: process.env.ENABLE_MONGODB === 'true',
      redis: process.env.ENABLE_REDIS === 'true',
      llm: process.env.ENABLE_LLM === 'true',
      email: process.env.ENABLE_EMAIL === 'true',
      metrics: process.env.ENABLE_METRICS === 'true',
      auth: process.env.ENABLE_AUTH === 'true',
      webhooks: process.env.ENABLE_WEBHOOKS === 'true',
    },
    endpoints: {
      docs: '/docs',
      api: '/api',
      health: '/health',
      metrics: '/metrics',
    },
  });
});

app.get('/health', async (req, res) => {
  try {
    const ticketCount = await Ticket.countDocuments();
    res.json({
      status: 'ok ✅',
      uptime: Math.floor(process.uptime()),
      tickets_in_db: ticketCount,
      database: process.env.ENABLE_MONGODB === 'true' ? 'connected' : 'disabled',
      redis: process.env.ENABLE_REDIS === 'true' ? 'connected' : 'disabled',
    });
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

app.get('/api', (req, res) => {
  res.json({
    message: 'AutoResolve AI - Enterprise API',
    endpoints: {
      tickets: [
        { method: 'POST', path: '/ticket', description: 'Submit ticket' },
        { method: 'GET', path: '/tickets', description: 'Get all tickets' },
        { method: 'GET', path: '/tickets/:id', description: 'Get specific ticket' },
        { method: 'PATCH', path: '/tickets/:id', description: 'Update ticket' },
      ],
      admin: [
        { method: 'POST', path: '/admin/login', description: 'Admin login' },
        { method: 'POST', path: '/admin/register', description: 'Admin registration' },
        { method: 'GET', path: '/admin/users', description: 'List users (admin)' },
      ],
      analytics: [
        { method: 'GET', path: '/analytics', description: 'System analytics' },
        { method: 'GET', path: '/audit-log', description: 'Audit logs' },
        { method: 'GET', path: '/metrics', description: 'Prometheus metrics' },
      ],
      demo: [
        { method: 'POST', path: '/demo/start', description: 'Start demo' },
        { method: 'GET', path: '/demo/status', description: 'Demo status' },
      ],
    },
  });
});

// ====== TICKETS ======

app.post('/ticket', async (req, res) => {
  try {
    const { email, subject, body } = req.body;

    // Classify using LLM if enabled
    let classification = {
      category: 'general',
      urgency: 'medium',
      sentiment: 'neutral',
    };

    if (process.env.ENABLE_LLM === 'true') {
      try {
        classification = await LLMService.classifyTicket(`${subject}\n${body}`);
      } catch (error) {
        logger.warn('LLM classification failed, using defaults');
      }
    }

    // Create ticket in database
    const ticketData = {
      ticket_id: `TK_${uuidv4().substring(0, 8)}`,
      email,
      subject,
      body,
      ...classification,
      status: 'processing',
    };

    const ticket = await Ticket.create(ticketData);

    // Queue for processing
    if (process.env.ENABLE_REDIS === 'true') {
      await QueueService.addTicketJob({
        ticket_id: ticket.ticket_id,
        data: ticketData,
      });
    }

    // Send webhook
    if (process.env.ENABLE_WEBHOOKS === 'true') {
      if (process.env.SLACK_WEBHOOK_URL) {
        await WebhookService.sendSlackNotification(ticketData, 'created');
      }
    }

    res.json({
      ticket_id: ticket.ticket_id,
      status: 'queued',
      message: 'Ticket received and queued for processing',
    });
  } catch (error) {
    logger.error('Error creating ticket:', error);
    MetricsService.recordError('ticket_creation');
    res.status(500).json({ error: error.message });
  }
});

app.get('/tickets', async (req, res) => {
  try {
    const tickets = await Ticket.find().limit(100).sort({ created_at: -1 });
    res.json({ count: tickets.length, tickets });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/tickets/:id', async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ ticket_id: req.params.id });
    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/tickets/:id', AuthService.requireRole(['admin', 'supervisor']), async (req, res) => {
  try {
    const ticket = await Ticket.findOneAndUpdate(
      { ticket_id: req.params.id },
      { ...req.body, updated_at: new Date() },
      { new: true }
    );

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    res.json(ticket);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====== AUTHENTICATION ======

app.post('/admin/register', async (req, res) => {
  try {
    const { username, email, password, role } = req.body;

    const existingUser = await Admin.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const passwordHash = await AuthService.hashPassword(password);

    const admin = await Admin.create({
      username,
      email,
      password_hash: passwordHash,
      role: role || 'agent',
    });

    const token = AuthService.generateToken(admin._id, admin.role);

    res.json({
      token,
      user: { id: admin._id, username: admin.username, role: admin.role },
    });
  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const admin = await Admin.findOne({ username });
    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isPasswordValid = await AuthService.verifyPassword(password, admin.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = AuthService.generateToken(admin._id, admin.role);

    await Admin.updateOne({ _id: admin._id }, { last_login: new Date() });

    res.json({
      token,
      user: { id: admin._id, username: admin.username, role: admin.role },
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/admin/users', AuthService.requireRole(['admin']), async (req, res) => {
  try {
    const users = await Admin.find({}, { password_hash: 0 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====== ANALYTICS ======

app.get('/analytics', async (req, res) => {
  try {
    const total = await Ticket.countDocuments();
    const resolved = await Ticket.countDocuments({ decision: 'resolve' });
    const escalated = await Ticket.countDocuments({ decision: 'escalate' });

    const avgConfidence = await Ticket.aggregate([
      { $group: { _id: null, avg: { $avg: '$confidence_score' } } },
    ]);

    res.json({
      total_tickets: total,
      resolved,
      escalated,
      resolution_rate: total > 0 ? ((resolved / total) * 100).toFixed(1) + '%' : '0%',
      escalation_rate: total > 0 ? ((escalated / total) * 100).toFixed(1) + '%' : '0%',
      avg_confidence: avgConfidence[0]?.avg ? (avgConfidence[0].avg * 100).toFixed(1) + '%' : 'N/A',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/audit-log', async (req, res) => {
  try {
    const logs = await AuditLog.find().limit(100).sort({ timestamp: -1 });
    res.json({ count: logs.length, logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ====== METRICS ======

app.get('/metrics', (req, res) => {
  if (process.env.ENABLE_METRICS !== 'true') {
    return res.status(404).json({ error: 'Metrics disabled' });
  }

  res.set('Content-Type', register.contentType);
  res.end(MetricsService.getMetrics());
});

// ====== DEMO ======

let demoRunning = false;

app.post('/demo/start', async (req, res) => {
  if (demoRunning) {
    return res.json({ error: 'Demo already running' });
  }

  demoRunning = true;
  const count = req.body.count || 20;

  res.json({ status: 'started', count, message: 'Processing tickets...' });

  // Process demo tickets
  for (let i = 0; i < count; i++) {
    const ticketData = {
      email: `demo_${i}@example.com`,
      subject: ['Refund request', 'Shipping delay', 'Payment issue'][Math.floor(Math.random() * 3)],
      body: 'Demo ticket for testing',
    };

    try {
      const ticket = await Ticket.create({
        ticket_id: `DEMO_${i}`,
        ...ticketData,
        decision: Math.random() > 0.7 ? 'escalate' : 'resolve',
        confidence_score: Math.random(),
      });

      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: 'ticket_processed', ticket }));
        }
      });

      await new Promise((r) => setTimeout(r, 500));
    } catch (error) {
      logger.error(`Demo ticket error: ${error.message}`);
    }
  }

  demoRunning = false;
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'demo_complete', count }));
    }
  });
});

app.get('/demo/status', (req, res) => {
  res.json({ running: demoRunning });
});

// ====== WEBHOOKS ======

app.post('/webhooks/ticket-resolved', async (req, res) => {
  try {
    const { ticket_id } = req.body;
    const ticket = await Ticket.findOne({ ticket_id });

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    if (process.env.SLACK_WEBHOOK_URL) {
      await WebhookService.sendSlackNotification(ticket.toObject(), ticket.decision);
    }

    if (process.env.DISCORD_WEBHOOK_URL) {
      await WebhookService.sendDiscordNotification(ticket.toObject(), ticket.decision);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ====== WEBSOCKET ======

wss.on('connection', (ws) => {
  logger.info('WebSocket client connected');
  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to AutoResolve AI' }));

  ws.on('close', () => {
    logger.info('WebSocket client disconnected');
  });
});

// ====== ERROR HANDLER ======

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  MetricsService.recordError('unhandled');
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// SERVER START
// ============================================================================

const PORT = process.env.PORT || 5000;

async function start() {
  await initializeServices();

  server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║    🚀 AUTORESOLVE AI - ENTERPRISE EDITION STARTED          ║
║                                                            ║
║  API: http://localhost:${PORT}                              ║
║  Metrics: http://localhost:${PORT}/metrics                  ║
║  WebSocket: ws://localhost:${PORT}                          ║
║                                                            ║
║  Features:                                                 ║
║  ✅ MongoDB Database: ${process.env.ENABLE_MONGODB === 'true' ? '✓' : '✗'}                          ║
║  ✅ Redis Queue: ${process.env.ENABLE_REDIS === 'true' ? '✓' : '✗'}                            ║
║  ✅ Claude LLM: ${process.env.ENABLE_LLM === 'true' ? '✓' : '✗'}                             ║
║  ✅ Email Service: ${process.env.ENABLE_EMAIL === 'true' ? '✓' : '✗'}                         ║
║  ✅ Prometheus Metrics: ${process.env.ENABLE_METRICS === 'true' ? '✓' : '✗'}                    ║
║  ✅ JWT Auth: ${process.env.ENABLE_AUTH === 'true' ? '✓' : '✗'}                              ║
║  ✅ Webhooks: ${process.env.ENABLE_WEBHOOKS === 'true' ? '✓' : '✗'}                            ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
    `);
  });
}

start().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});

export default app;
