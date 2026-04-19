db = db.getSiblingDB('autoresolve-ai');

// Create collections with validation
db.createCollection('tickets', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['ticket_id', 'email', 'subject', 'body'],
      properties: {
        ticket_id: { bsonType: 'string' },
        email: { bsonType: 'string' },
        subject: { bsonType: 'string' },
        body: { bsonType: 'string' },
        category: { enum: ['refund', 'shipping', 'payment', 'account', 'bug', 'abuse', 'general'] },
        decision: { enum: ['resolve', 'escalate', 'retry'] },
      },
    },
  },
});

db.createCollection('audit_logs');
db.createCollection('admins');
db.createCollection('email_logs');
db.createCollection('webhook_logs');
db.createCollection('metrics');
db.createCollection('learned_patterns');

// Create indexes
db.tickets.createIndex({ ticket_id: 1 }, { unique: true });
db.tickets.createIndex({ email: 1 });
db.tickets.createIndex({ created_at: -1 });
db.tickets.createIndex({ status: 1 });

db.audit_logs.createIndex({ ticket_id: 1 });
db.audit_logs.createIndex({ timestamp: -1 });

db.admins.createIndex({ username: 1 }, { unique: true });
db.admins.createIndex({ email: 1 }, { unique: true });

db.email_logs.createIndex({ ticket_id: 1 });
db.email_logs.createIndex({ status: 1 });

db.webhook_logs.createIndex({ ticket_id: 1 });

db.metrics.createIndex({ timestamp: -1 });

db.learned_patterns.createIndex({ pattern_type: 1, category: 1 });

// Create default admin user (username: admin, password: admin123)
db.admins.insertOne({
  username: 'admin',
  email: 'admin@autoresolve.ai',
  password_hash: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcg7b3XeKeUxWdeS86E36P4/FDO',
  role: 'admin',
  is_active: true,
  created_at: new Date(),
  updated_at: new Date(),
});

print('✅ MongoDB initialized successfully');
