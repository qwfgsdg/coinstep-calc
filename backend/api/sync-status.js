const express = require('express');
const { verifyJwt } = require('../lib/auth');
const db = require('../lib/db');

const router = express.Router();

// GET /api/sync/status - Get sync status for the authenticated user
router.get('/', verifyJwt, (req, res) => {
  try {
    const userId = req.user.userId;
    const user = db.getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User not found' });
    }

    const lastSnapshot = db.getLastSnapshot(userId);
    const counts = db.getUserCounts(userId);

    const hasSyncedData = !!user.lastSyncedAt;
    const syncComplete = lastSnapshot ? lastSnapshot.status === 'completed' : false;

    return res.json({
      hasSyncedData,
      lastSyncedAt: user.lastSyncedAt || null,
      syncSource: 'bookmarklet',
      syncComplete,
      lastSnapshot: lastSnapshot ? {
        id: lastSnapshot.id,
        status: lastSnapshot.status,
        positionCount: lastSnapshot.positionCount,
        accountCount: lastSnapshot.accountCount,
        historyCount: lastSnapshot.historyCount,
        createdAt: lastSnapshot.createdAt
      } : null,
      counts
    });
  } catch (err) {
    console.error('[SyncStatus] Error:', err);
    return res.status(500).json({ error: 'STATUS_ERROR', message: 'Failed to get sync status' });
  }
});

module.exports = router;
