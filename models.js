import mongoose from 'mongoose';

// ============================================================================
// TICKET SCHEMA
// ============================================================================

const TicketSchema = new mongoose.Schema(
  {
    ticket_id: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, index: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    
    // Classification
    category: { type: String, enum: ['refund', 'shipping', 'payment', 'account', 'bug', 'abuse', 'general'] },
    urgency: { type: String, enum: ['low', 'medium', 'high', 'critical'] },
    sentiment: { type: String, enum: ['angry', 'neutral', 'happy', 'frustrated'] },
    
    // Decision
    decision: { type: String, enum: ['resolve', 'escalate', 'retry'], default: 'resolve' },
    confidence_score: { type: Number, min: 0, max: 1 },
    risk_score: { type: Number, min: 0, max: 1 },
    
    // Processing
    status: { type: String, enum: ['pending', 'processing', 'resolved', 'escalated', 'failed'], default: 'pending' },
    retry_count: { type: Number, default: 0 },
    
    // Explanation & Logs
    explanation: { type: String },
    audit_log: [{ stage: String, duration: Number, status: String }],
    
    // Results
    resolution_summary: { type: String },
    assigned_to: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    
    // Metadata
    customer_tier: { type: String, enum: ['VIP', 'normal', 'risky'] },
    customer_id: { type: String },
    order_id: { type: String },
    
    // Tags
    tags: [String],
    
    created_at: { type: Date, default: Date.now, index: true },
    updated_at: { type: Date, default: Date.now },
    resolved_at: { type: Date },
  },
  { collection: 'tickets' }
);

TicketSchema.index({ created_at: -1 });
TicketSchema.index({ status: 1 });
TicketSchema.index({ decision: 1 });

// ============================================================================
// AUDIT LOG SCHEMA
// ============================================================================

const AuditLogSchema = new mongoose.Schema(
  {
    ticket_id: { type: String, required: true, index: true },
    agent: { type: String, required: true },
    action: { type: String, required: true },
    status: { type: String, enum: ['success', 'failure', 'retry'] },
    duration_ms: { type: Number },
    
    tool_name: String,
    tool_input: mongoose.Schema.Types.Mixed,
    tool_output: mongoose.Schema.Types.Mixed,
    tool_error: String,
    
    stage: { type: String },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { collection: 'audit_logs' }
);

AuditLogSchema.index({ ticket_id: 1, timestamp: -1 });

// ============================================================================
// ADMIN/USER SCHEMA
// ============================================================================

const AdminSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true },
    password_hash: { type: String, required: true },
    
    role: { type: String, enum: ['admin', 'supervisor', 'agent', 'viewer'], default: 'agent' },
    permissions: [String],
    
    is_active: { type: Boolean, default: true },
    last_login: Date,
    
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  { collection: 'admins' }
);

// ============================================================================
// EMAIL LOG SCHEMA
// ============================================================================

const EmailLogSchema = new mongoose.Schema(
  {
    ticket_id: { type: String, required: true, index: true },
    customer_email: { type: String, required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    
    status: { type: String, enum: ['sent', 'failed', 'pending'], default: 'pending' },
    error_message: String,
    
    created_at: { type: Date, default: Date.now },
    sent_at: Date,
  },
  { collection: 'email_logs' }
);

EmailLogSchema.index({ ticket_id: 1 });
EmailLogSchema.index({ status: 1 });

// ============================================================================
// WEBHOOK LOG SCHEMA
// ============================================================================

const WebhookLogSchema = new mongoose.Schema(
  {
    webhook_type: { type: String, enum: ['slack', 'discord', 'custom'], required: true },
    ticket_id: { type: String, required: true, index: true },
    payload: mongoose.Schema.Types.Mixed,
    response_status: Number,
    response_body: mongoose.Schema.Types.Mixed,
    
    status: { type: String, enum: ['success', 'failed'], default: 'success' },
    error: String,
    
    created_at: { type: Date, default: Date.now },
  },
  { collection: 'webhook_logs' }
);

WebhookLogSchema.index({ ticket_id: 1 });

// ============================================================================
// METRICS SCHEMA
// ============================================================================

const MetricsSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, default: Date.now, index: true },
    
    // Throughput
    tickets_processed: { type: Number, default: 0 },
    tickets_resolved: { type: Number, default: 0 },
    tickets_escalated: { type: Number, default: 0 },
    tickets_failed: { type: Number, default: 0 },
    
    // Performance
    avg_processing_time_ms: Number,
    avg_confidence_score: Number,
    avg_risk_score: Number,
    
    // Tool metrics
    tool_calls: Number,
    tool_failures: Number,
    tool_retries: Number,
    
    // Queue
    queue_length: Number,
    queue_processed: Number,
    
    // System
    memory_usage_mb: Number,
    cpu_usage_percent: Number,
    uptime_seconds: Number,
  },
  { collection: 'metrics' }
);

MetricsSchema.index({ timestamp: -1 });

// ============================================================================
// LEARNED PATTERNS SCHEMA
// ============================================================================

const LearnedPatternsSchema = new mongoose.Schema(
  {
    pattern_type: { type: String, required: true }, // e.g., "category_resolution"
    category: String,
    success_count: { type: Number, default: 0 },
    failure_count: { type: Number, default: 0 },
    avg_confidence: { type: Number, default: 0 },
    success_rate: { type: Number, default: 0 },
    
    last_updated: { type: Date, default: Date.now },
  },
  { collection: 'learned_patterns' }
);

LearnedPatternsSchema.index({ pattern_type: 1, category: 1 });

// ============================================================================
// MODELS
// ============================================================================

export const Ticket = mongoose.model('Ticket', TicketSchema);
export const AuditLog = mongoose.model('AuditLog', AuditLogSchema);
export const Admin = mongoose.model('Admin', AdminSchema);
export const EmailLog = mongoose.model('EmailLog', EmailLogSchema);
export const WebhookLog = mongoose.model('WebhookLog', WebhookLogSchema);
export const Metrics = mongoose.model('Metrics', MetricsSchema);
export const LearnedPatterns = mongoose.model('LearnedPatterns', LearnedPatternsSchema);

export default {
  Ticket,
  AuditLog,
  Admin,
  EmailLog,
  WebhookLog,
  Metrics,
  LearnedPatterns,
};
