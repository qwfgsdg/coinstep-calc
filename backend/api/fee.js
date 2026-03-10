const express = require('express');
const { verifyJwt } = require('../lib/auth');
const db = require('../lib/db');

const router = express.Router();

// POST /api/fee - Calculate trading fees
router.post('/', verifyJwt, (req, res) => {
  try {
    const { startDate, endDate, maskId } = req.body;

    if (!startDate || !endDate) {
      return res.status(422).json({ error: 'MISSING_DATES', message: 'startDate and endDate are required' });
    }

    // Determine target user(s)
    let targetUserIds = [];

    if (maskId && req.user.role === 'admin') {
      const targetUser = db.getUserByMaskId(maskId);
      if (!targetUser) {
        return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User with given maskId not found' });
      }
      targetUserIds = [targetUser.id];
    } else if (maskId && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Only admins can query other users' });
    } else if (req.user.role === 'admin' && !maskId) {
      // Admin without maskId: calculate for all users
      const allUsers = db.getAllUsers();
      targetUserIds = allUsers.map(u => u.id);
    } else {
      targetUserIds = [req.user.userId];
    }

    let totalFee = 0;
    let totalRecordCount = 0;
    const traders = [];

    for (const userId of targetUserIds) {
      const result = db.calculateFee(userId, startDate, endDate);
      const user = db.getUserById(userId);

      if (result.recordCount > 0) {
        traders.push({
          userId,
          maskId: user ? user.tapbitMaskId : null,
          remarkName: user ? user.remarkName : '',
          totalFee: result.totalFee,
          recordCount: result.recordCount
        });
      }

      totalFee += result.totalFee;
      totalRecordCount += result.recordCount;
    }

    return res.json({
      totalFee,
      recordCount: totalRecordCount,
      traders
    });
  } catch (err) {
    console.error('[Fee] Error:', err);
    return res.status(500).json({ error: 'FEE_ERROR', message: 'Failed to calculate fees' });
  }
});

module.exports = router;
