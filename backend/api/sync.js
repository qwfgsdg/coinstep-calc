const express = require('express');
const crypto = require('crypto');
const { verifySyncToken } = require('../lib/auth');
const db = require('../lib/db');

const router = express.Router();

// ── Phase 5: Per-user sync rate limiting ──
const userSyncTimestamps = new Map(); // userId → [timestamp, ...]
const USER_SYNC_MAX_PER_HOUR = 10;
const USER_SYNC_MAX_PER_MINUTE = 3;

function checkUserSyncRate(userId) {
  const now = Date.now();
  const timestamps = userSyncTimestamps.get(userId) || [];

  // Clean old entries (older than 1 hour)
  const recent = timestamps.filter(t => now - t < 3600000);
  userSyncTimestamps.set(userId, recent);

  // Check per-minute limit
  const lastMinute = recent.filter(t => now - t < 60000);
  if (lastMinute.length >= USER_SYNC_MAX_PER_MINUTE) {
    return { limited: true, retryAfter: 60 };
  }

  // Check per-hour limit
  if (recent.length >= USER_SYNC_MAX_PER_HOUR) {
    const oldest = recent[0];
    const retryAfter = Math.ceil((oldest + 3600000 - now) / 1000);
    return { limited: true, retryAfter };
  }

  return { limited: false };
}

function recordUserSync(userId) {
  const timestamps = userSyncTimestamps.get(userId) || [];
  timestamps.push(Date.now());
  userSyncTimestamps.set(userId, timestamps);
}

// ── Phase 5: Audit logging ──
function auditLog(action, userId, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    userId,
    ...details,
  };
  console.log('[Audit]', JSON.stringify(entry));
}

router.post('/', verifySyncToken, async (req, res) => {
  let snapshotId = null;

  try {
    const { profile, positions, accounts, histories } = req.body;

    // Validate required fields
    if (!profile || !profile.maskId) {
      return res.status(422).json({ error: 'MISSING_PROFILE', message: 'profile.maskId is required' });
    }

    // Verify maskId matches the authenticated user
    if (profile.maskId !== req.user.tapbitMaskId) {
      auditLog('SYNC_MASKID_MISMATCH', req.user.id, { expected: req.user.tapbitMaskId, received: profile.maskId });
      return res.status(422).json({ error: 'MASKID_MISMATCH', message: 'profile.maskId does not match authenticated user' });
    }

    // Phase 5: Per-user rate limit check
    const rateCheck = checkUserSyncRate(req.user.id);
    if (rateCheck.limited) {
      auditLog('SYNC_RATE_LIMITED', req.user.id, { retryAfter: rateCheck.retryAfter });
      res.setHeader('Retry-After', String(rateCheck.retryAfter));
      return res.status(429).json({ error: 'RATE_LIMIT_EXCEEDED', message: 'Too many sync requests', retryAfter: rateCheck.retryAfter });
    }

    const userId = req.user.id;
    const maskId = profile.maskId;

    // Compute checksum
    const checksumPayload = JSON.stringify({ positions, accounts, histories });
    const checksum = crypto.createHash('md5').update(checksumPayload).digest('hex');

    // Check for duplicate request within 5-minute window
    if (db.checkDuplicateChecksum(userId, checksum)) {
      return res.status(409).json({ error: 'DUPLICATE_REQUEST', message: 'Identical data was synced recently' });
    }

    // Check for pending snapshot
    if (db.hasPendingSnapshot(userId)) {
      return res.status(409).json({ error: 'SYNC_IN_PROGRESS', message: 'A sync operation is already in progress' });
    }

    // Create pending snapshot
    snapshotId = db.createSnapshot(userId, 'pending', {
      positions: (positions || []).length,
      accounts: (accounts || []).length,
      histories: (histories || []).length
    }, checksum);

    // Execute sync operations
    const posCount = db.upsertPositions(userId, maskId, positions || []);
    const accCount = db.upsertAccounts(userId, maskId, accounts || []);
    const histResult = db.insertHistories(userId, maskId, histories || []);
    const result = { posCount, accCount, histResult };

    // Update snapshot to completed
    db.updateSnapshot(snapshotId, 'completed');

    // Update user metadata
    db.updateLastSyncedAt(userId);
    if (profile.remarkName) {
      db.updateRemarkName(userId, profile.remarkName);
    }

    // Record sync for rate limiting
    recordUserSync(userId);

    // Audit log
    auditLog('SYNC_COMPLETED', userId, {
      maskId,
      positions: result.posCount,
      accounts: result.accCount,
      historiesInserted: result.histResult.inserted,
      historiesSkipped: result.histResult.skipped,
      ip: req.ip,
    });

    return res.json({
      success: true,
      snapshotId: Number(snapshotId),
      counts: {
        positions: result.posCount,
        accounts: result.accCount,
        historiesInserted: result.histResult.inserted,
        historiesSkipped: result.histResult.skipped
      }
    });
  } catch (err) {
    console.error('[Sync] Error:', err);
    auditLog('SYNC_FAILED', req.user?.id, { error: err.message });

    // Mark snapshot as failed if it was created
    if (snapshotId) {
      try {
        db.updateSnapshot(snapshotId, 'failed');
      } catch (updateErr) {
        console.error('[Sync] Failed to update snapshot status:', updateErr);
      }
    }

    return res.status(500).json({ error: 'SYNC_FAILED', message: 'Sync operation failed' });
  }
});

module.exports = router;
