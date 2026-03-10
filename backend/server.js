require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const corsMiddleware = require('./lib/cors');
const { initDb, startCleanupSchedule } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3001;

// Security headers
app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true },
  frameguard: { action: 'deny' },
  contentSecurityPolicy: false, // API server, not serving HTML
}));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// CORS
app.use(corsMiddleware);

// Body parsing with 5MB limit for large sync payloads
app.use(express.json({ limit: '5mb' }));

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many requests, please try again later' }
});

const syncLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many sync requests, please slow down' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many auth attempts, please try again later' }
});

// Apply general rate limit to all routes
app.use('/api/', generalLimiter);

// Static files for bookmarklet
app.use('/static', express.static(path.join(__dirname, 'static')));

// Routes
const syncRouter = require('./api/sync');
const dataRouter = require('./api/data');
const feeRouter = require('./api/fee');
const syncStatusRouter = require('./api/sync-status');
const adminRouter = require('./api/admin');

app.use('/api/sync', syncLimiter, syncRouter);
app.use('/api/data', dataRouter);
app.use('/api/fee', feeRouter);
app.use('/api/sync/status', syncStatusRouter);
app.use('/api/admin', authLimiter, adminRouter);

// Convenience redirects for admin/install pages
app.get('/admin', (req, res) => res.redirect('/static/admin.html'));
app.get('/install', (req, res) => res.redirect('/static/install.html'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
});

// Initialize database and start server
initDb().then(() => {
  startCleanupSchedule();
  app.listen(PORT, () => {
    console.log(`[Server] Coinstep backend running on port ${PORT}`);
    console.log(`[Server] Health check: http://localhost:${PORT}/health`);
  });
}).catch((err) => {
  console.error('[Server] Failed to start:', err);
  process.exit(1);
});

module.exports = app;
