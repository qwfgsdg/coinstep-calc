const express = require('express');
const { verifyJwt, requireAdmin } = require('../lib/auth');
const db = require('../lib/db');

const router = express.Router();

// GET /api/data - Get user's synced data
router.get('/', verifyJwt, (req, res) => {
  try {
    const { startDate, endDate, maskId } = req.query;

    // Determine target user
    let targetUserId = req.user.userId;

    if (maskId && req.user.role === 'admin') {
      const targetUser = db.getUserByMaskId(maskId);
      if (!targetUser) {
        return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User with given maskId not found' });
      }
      targetUserId = targetUser.id;
    } else if (maskId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Only admins can query other users' });
    }

    const user = db.getUserById(targetUserId);
    if (!user) {
      return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User not found' });
    }

    const positions = db.getPositions(targetUserId);
    const accounts = db.getAccounts(targetUserId);
    const histories = db.getHistories(targetUserId, startDate || null, endDate || null);
    const counts = db.getUserCounts(targetUserId);

    return res.json({
      positions,
      accounts,
      histories,
      profile: {
        maskId: user.tapbitMaskId,
        remarkName: user.remarkName
      },
      meta: {
        lastSyncedAt: user.lastSyncedAt,
        recordCount: {
          positions: counts.positions,
          accounts: counts.accounts,
          histories: counts.histories
        }
      }
    });
  } catch (err) {
    console.error('[Data] Error:', err);
    return res.status(500).json({ error: 'DATA_ERROR', message: 'Failed to fetch data' });
  }
});

// GET /api/data/all - Admin: get all users with summary
router.get('/all', verifyJwt, requireAdmin, (req, res) => {
  try {
    const users = db.getAllUsers();

    const usersWithCounts = users.map(user => {
      const counts = db.getUserCounts(user.id);
      return {
        id: user.id,
        email: user.email,
        tapbitMaskId: user.tapbitMaskId,
        remarkName: user.remarkName,
        role: user.role,
        lastSyncedAt: user.lastSyncedAt,
        isActive: user.isActive,
        createdAt: user.createdAt,
        counts
      };
    });

    return res.json({ users: usersWithCounts });
  } catch (err) {
    console.error('[Data] Error fetching all users:', err);
    return res.status(500).json({ error: 'DATA_ERROR', message: 'Failed to fetch users' });
  }
});

module.exports = router;
