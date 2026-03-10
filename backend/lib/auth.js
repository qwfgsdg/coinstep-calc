const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const BCRYPT_ROUNDS = 12;

/**
 * Generate a new SyncToken with its hashes.
 * Returns { token, hash (bcrypt), index (sha256 for fast lookup) }
 */
async function generateSyncToken() {
  const token = 'stk_' + crypto.randomBytes(32).toString('hex');
  const hash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  const index = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash, index };
}

/**
 * Compute the SHA256 index for a given token (for lookup).
 */
function computeTokenIndex(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Middleware: verify SyncToken from Authorization header.
 * Format: Authorization: SyncToken stk_xxxx...
 */
async function verifySyncToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('SyncToken ')) {
      return res.status(401).json({ error: 'MISSING_SYNC_TOKEN', message: 'Authorization header with SyncToken required' });
    }

    const token = authHeader.slice('SyncToken '.length).trim();
    if (!token || !token.startsWith('stk_')) {
      return res.status(401).json({ error: 'INVALID_SYNC_TOKEN', message: 'Invalid token format' });
    }

    // Fast lookup by SHA256 index
    const tokenIndex = computeTokenIndex(token);
    const user = db.getUserBySyncTokenIndex(tokenIndex);

    if (!user) {
      return res.status(401).json({ error: 'INVALID_SYNC_TOKEN', message: 'Token not recognized' });
    }

    // Verify with bcrypt for security
    const valid = await bcrypt.compare(token, user.syncTokenHash);
    if (!valid) {
      return res.status(401).json({ error: 'INVALID_SYNC_TOKEN', message: 'Token verification failed' });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('[Auth] SyncToken verification error:', err);
    return res.status(500).json({ error: 'AUTH_ERROR', message: 'Authentication failed' });
  }
}

/**
 * Middleware: verify JWT from Authorization header.
 * Format: Authorization: Bearer xxx
 */
function verifyJwt(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'MISSING_TOKEN', message: 'Authorization header with Bearer token required' });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'TOKEN_EXPIRED', message: 'JWT token has expired' });
    }
    return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Invalid JWT token' });
  }
}

/**
 * Middleware: require admin role (use after verifyJwt).
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Admin access required' });
  }
  next();
}

/**
 * Generate a JWT for a user.
 */
function generateJwt(user) {
  return jwt.sign(
    { userId: user.id, maskId: user.tapbitMaskId, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
}

/**
 * Hash a password with bcrypt.
 */
async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Compare a password against a bcrypt hash.
 */
async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = {
  generateSyncToken,
  computeTokenIndex,
  verifySyncToken,
  verifyJwt,
  requireAdmin,
  generateJwt,
  hashPassword,
  comparePassword
};
