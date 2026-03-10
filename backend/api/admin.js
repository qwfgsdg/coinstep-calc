const express = require('express');
const { verifyJwt, requireAdmin, generateSyncToken, generateJwt, hashPassword, comparePassword } = require('../lib/auth');
const db = require('../lib/db');

const router = express.Router();

// POST /api/admin/setup - Initial admin setup (only works when no admin exists)
router.post('/setup', async (req, res) => {
  try {
    const adminCount = db.getAdminCount();
    if (adminCount > 0) {
      return res.status(409).json({ error: 'ADMIN_EXISTS', message: 'Admin account already exists' });
    }

    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(422).json({ error: 'MISSING_FIELDS', message: 'email and password are required' });
    }

    if (password.length < 8) {
      return res.status(422).json({ error: 'WEAK_PASSWORD', message: 'Password must be at least 8 characters' });
    }

    const hashedPassword = await hashPassword(password);

    const userId = db.createUser({
      email,
      tapbitMaskId: null,
      remarkName: 'Admin',
      syncTokenHash: null,
      syncTokenIndex: null,
      password: hashedPassword,
      role: 'admin'
    });

    return res.json({ success: true, message: 'Admin created', userId: Number(userId) });
  } catch (err) {
    console.error('[Admin] Setup error:', err);
    if (err.message && err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'DUPLICATE_EMAIL', message: 'Email already in use' });
    }
    return res.status(500).json({ error: 'SETUP_ERROR', message: 'Failed to create admin' });
  }
});

// POST /api/admin/login - Admin login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(422).json({ error: 'MISSING_FIELDS', message: 'email and password are required' });
    }

    const user = db.getUserByEmail(email);
    if (!user || !user.password) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }

    const valid = await comparePassword(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
    }

    const token = generateJwt(user);

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('[Admin] Login error:', err);
    return res.status(500).json({ error: 'LOGIN_ERROR', message: 'Login failed' });
  }
});

// GET /api/admin/users - List all users
router.get('/users', verifyJwt, requireAdmin, (req, res) => {
  try {
    const users = db.getAllUsers();
    const result = users.map(u => {
      const counts = db.getUserCounts(u.id);
      return { ...u, counts };
    });
    return res.json({ users: result });
  } catch (err) {
    console.error('[Admin] List users error:', err);
    return res.status(500).json({ error: 'LIST_ERROR', message: 'Failed to list users' });
  }
});

// PATCH /api/admin/users/:id - Toggle user active status
router.patch('/users/:id', verifyJwt, requireAdmin, (req, res) => {
  try {
    const userId = Number(req.params.id);
    const user = db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
    }
    if (user.role === 'admin') {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot deactivate admin' });
    }
    const newStatus = user.isActive ? 0 : 1;
    db.updateUserActive(userId, newStatus);
    return res.json({ success: true, userId, isActive: newStatus });
  } catch (err) {
    console.error('[Admin] Toggle user error:', err);
    return res.status(500).json({ error: 'UPDATE_ERROR', message: 'Failed to update user' });
  }
});

// POST /api/admin/users - Create a new user with SyncToken
router.post('/users', verifyJwt, requireAdmin, async (req, res) => {
  try {
    const { email, tapbitMaskId, remarkName } = req.body;

    if (!tapbitMaskId) {
      return res.status(422).json({ error: 'MISSING_FIELDS', message: 'tapbitMaskId is required' });
    }

    // Generate SyncToken
    const { token, hash, index } = await generateSyncToken();

    const userId = db.createUser({
      email: email || null,
      tapbitMaskId,
      remarkName: remarkName || '',
      syncTokenHash: hash,
      syncTokenIndex: index,
      password: null,
      role: 'user'
    });

    return res.json({
      userId: Number(userId),
      syncToken: token
    });
  } catch (err) {
    console.error('[Admin] Create user error:', err);
    if (err.message && err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'DUPLICATE_USER', message: 'User with this email or maskId already exists' });
    }
    return res.status(500).json({ error: 'CREATE_USER_ERROR', message: 'Failed to create user' });
  }
});

module.exports = router;
