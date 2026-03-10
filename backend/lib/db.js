const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;
const DB_PATH = path.join(__dirname, '..', 'data', 'coinstep.db');

async function initDb() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const SQL = await initSqlJs();

  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      tapbitMaskId TEXT UNIQUE,
      remarkName TEXT DEFAULT '',
      syncTokenHash TEXT,
      syncTokenIndex TEXT,
      password TEXT,
      role TEXT DEFAULT 'user',
      lastSyncedAt TEXT,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      positionCount INTEGER DEFAULT 0,
      accountCount INTEGER DEFAULT 0,
      historyCount INTEGER DEFAULT 0,
      checksum TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      tapbitMaskId TEXT NOT NULL,
      rawData TEXT NOT NULL,
      snapshotAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      tapbitMaskId TEXT NOT NULL,
      rawData TEXT NOT NULL,
      snapshotAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS histories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      tapbitMaskId TEXT NOT NULL,
      tradeId TEXT NOT NULL,
      tradeFee REAL DEFAULT 0,
      tradeAt TEXT,
      rawData TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id),
      UNIQUE(userId, tradeId)
    )
  `);

  // Indexes
  try { db.run('CREATE INDEX IF NOT EXISTS idx_histories_user_trade ON histories(userId, tradeAt)'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(userId)'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(userId)'); } catch (e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_users_sync_token_index ON users(syncTokenIndex)'); } catch (e) {}

  saveDb();
  console.log('[DB] Database initialized');
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

function saveDb() {
  if (!db) return;
  try {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.error('[DB] Save error:', e.message);
  }
}

// Auto-save periodically
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveDb(); }, 1000);
}

// ── Helper: run query and get first row as object ──
function getOne(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    stmt.free();
    const row = {};
    for (let i = 0; i < cols.length; i++) row[cols[i]] = vals[i];
    return row;
  }
  stmt.free();
  return null;
}

// ── Helper: run query and get all rows as array of objects ──
function getAll(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  const cols = stmt.getColumnNames();
  while (stmt.step()) {
    const vals = stmt.get();
    const row = {};
    for (let i = 0; i < cols.length; i++) row[cols[i]] = vals[i];
    rows.push(row);
  }
  stmt.free();
  return rows;
}

// ── Helper: run statement ──
function run(sql, params) {
  db.run(sql, params);
  scheduleSave();
}

// ── Helper: get last insert rowid ──
function lastInsertRowid() {
  const r = getOne('SELECT last_insert_rowid() as id');
  return r ? r.id : null;
}

// ── User queries ──
function getUserBySyncTokenIndex(tokenIndex) {
  return getOne('SELECT * FROM users WHERE syncTokenIndex = ? AND isActive = 1', [tokenIndex]);
}

function getUserByMaskId(maskId) {
  return getOne('SELECT * FROM users WHERE tapbitMaskId = ? AND isActive = 1', [maskId]);
}

function getUserById(id) {
  return getOne('SELECT * FROM users WHERE id = ?', [id]);
}

function getUserByEmail(email) {
  return getOne('SELECT * FROM users WHERE email = ? AND isActive = 1', [email]);
}

function createUser({ email, tapbitMaskId, remarkName, syncTokenHash, syncTokenIndex, password, role }) {
  run(
    'INSERT INTO users (email, tapbitMaskId, remarkName, syncTokenHash, syncTokenIndex, password, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [email || null, tapbitMaskId || null, remarkName || '', syncTokenHash || null, syncTokenIndex || null, password || null, role || 'user']
  );
  return lastInsertRowid();
}

// ── Positions/Accounts upsert ──
function upsertPositions(userId, maskId, positionsArray) {
  run('DELETE FROM positions WHERE userId = ?', [userId]);
  const items = positionsArray || [];
  for (const item of items) {
    run('INSERT INTO positions (userId, tapbitMaskId, rawData) VALUES (?, ?, ?)',
      [userId, maskId, JSON.stringify(item)]);
  }
  return items.length;
}

function upsertAccounts(userId, maskId, accountsArray) {
  run('DELETE FROM accounts WHERE userId = ?', [userId]);
  const items = accountsArray || [];
  for (const item of items) {
    run('INSERT INTO accounts (userId, tapbitMaskId, rawData) VALUES (?, ?, ?)',
      [userId, maskId, JSON.stringify(item)]);
  }
  return items.length;
}

// ── Histories insert (skip duplicates) ──
function insertHistories(userId, maskId, historiesArray) {
  let inserted = 0;
  let skipped = 0;

  for (const item of (historiesArray || [])) {
    const tradeId = String(item.tradeId || item.id || '');
    // Tapbit nests tradeFee under item.data.tradeFee
    const tradeFee = parseFloat((item.data && item.data.tradeFee) || item.tradeFee || item.fee || 0);

    // Convert timestamp to ISO string
    let tradeAt = item.tradeAt || item.ctime || item.createTime || '';
    if (typeof tradeAt === 'number' || /^\d{13}$/.test(String(tradeAt))) {
      tradeAt = new Date(Number(tradeAt)).toISOString();
    } else if (/^\d{10}$/.test(String(tradeAt))) {
      tradeAt = new Date(Number(tradeAt) * 1000).toISOString();
    }

    try {
      run('INSERT INTO histories (userId, tapbitMaskId, tradeId, tradeFee, tradeAt, rawData) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, maskId, tradeId, tradeFee, tradeAt, JSON.stringify(item)]);
      inserted++;
    } catch (e) {
      // UNIQUE constraint violation = duplicate, skip
      if (e.message && e.message.indexOf('UNIQUE') !== -1) {
        skipped++;
      } else {
        throw e;
      }
    }
  }

  scheduleSave();
  return { inserted, skipped };
}

// ── Data queries ──
function getPositions(userId) {
  const rows = getAll('SELECT rawData FROM positions WHERE userId = ? ORDER BY snapshotAt DESC', [userId]);
  return rows.map(r => JSON.parse(r.rawData));
}

function getAccounts(userId) {
  const rows = getAll('SELECT rawData FROM accounts WHERE userId = ? ORDER BY snapshotAt DESC', [userId]);
  return rows.map(r => JSON.parse(r.rawData));
}

function getHistories(userId, startDate, endDate) {
  let sql = 'SELECT rawData FROM histories WHERE userId = ?';
  const params = [userId];

  if (startDate) {
    sql += ' AND tradeAt >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND tradeAt <= ?';
    params.push(endDate);
  }

  sql += ' ORDER BY tradeAt DESC';
  const rows = getAll(sql, params);
  return rows.map(r => JSON.parse(r.rawData));
}

function calculateFee(userId, startDate, endDate) {
  let sql = 'SELECT COALESCE(SUM(tradeFee), 0) as totalFee, COUNT(*) as recordCount FROM histories WHERE userId = ?';
  const params = [userId];

  if (startDate) {
    sql += ' AND tradeAt >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND tradeAt <= ?';
    params.push(endDate);
  }

  return getOne(sql, params) || { totalFee: 0, recordCount: 0 };
}

// ── Snapshot management ──
function createSnapshot(userId, status, counts, checksum) {
  run('INSERT INTO sync_snapshots (userId, status, positionCount, accountCount, historyCount, checksum) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, status || 'pending', counts.positions || 0, counts.accounts || 0, counts.histories || 0, checksum || null]);
  return lastInsertRowid();
}

function updateSnapshot(snapshotId, status) {
  run('UPDATE sync_snapshots SET status = ? WHERE id = ?', [status, snapshotId]);
}

function getLastSnapshot(userId) {
  return getOne('SELECT * FROM sync_snapshots WHERE userId = ? ORDER BY createdAt DESC LIMIT 1', [userId]);
}

function updateLastSyncedAt(userId) {
  run("UPDATE users SET lastSyncedAt = datetime('now') WHERE id = ?", [userId]);
}

function updateRemarkName(userId, remarkName) {
  run('UPDATE users SET remarkName = ? WHERE id = ?', [remarkName, userId]);
}

function updateUserActive(userId, isActive) {
  run('UPDATE users SET isActive = ? WHERE id = ?', [isActive ? 1 : 0, userId]);
}

function getAllUsers() {
  return getAll('SELECT id, email, tapbitMaskId, remarkName, role, lastSyncedAt, isActive, createdAt FROM users ORDER BY createdAt DESC');
}

function checkDuplicateChecksum(userId, checksum) {
  const row = getOne(
    "SELECT id FROM sync_snapshots WHERE userId = ? AND checksum = ? AND status = 'completed' AND createdAt >= datetime('now', '-5 minutes') LIMIT 1",
    [userId, checksum]
  );
  return !!row;
}

function hasPendingSnapshot(userId) {
  const row = getOne(
    "SELECT id FROM sync_snapshots WHERE userId = ? AND status = 'pending' AND createdAt >= datetime('now', '-2 minutes') LIMIT 1",
    [userId]
  );
  return !!row;
}

function getAdminCount() {
  const row = getOne("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'");
  return row ? row.cnt : 0;
}

function getUserCounts(userId) {
  const p = getOne('SELECT COUNT(*) as cnt FROM positions WHERE userId = ?', [userId]);
  const a = getOne('SELECT COUNT(*) as cnt FROM accounts WHERE userId = ?', [userId]);
  const h = getOne('SELECT COUNT(*) as cnt FROM histories WHERE userId = ?', [userId]);
  return {
    positions: p ? p.cnt : 0,
    accounts: a ? a.cnt : 0,
    histories: h ? h.cnt : 0
  };
}

// ── Data retention cleanup ──
function cleanupOldData() {
  try {
    const histDeleted = getOne("SELECT COUNT(*) as cnt FROM histories WHERE tradeAt < datetime('now', '-180 days')");
    if (histDeleted && histDeleted.cnt > 0) {
      run("DELETE FROM histories WHERE tradeAt < datetime('now', '-180 days')");
      console.log('[DB] Cleaned up ' + histDeleted.cnt + ' histories older than 180 days');
    }

    const snapDeleted = getOne("SELECT COUNT(*) as cnt FROM sync_snapshots WHERE createdAt < datetime('now', '-30 days')");
    if (snapDeleted && snapDeleted.cnt > 0) {
      run("DELETE FROM sync_snapshots WHERE createdAt < datetime('now', '-30 days')");
      console.log('[DB] Cleaned up ' + snapDeleted.cnt + ' snapshots older than 30 days');
    }
  } catch (e) {
    console.error('[DB] Cleanup error:', e.message);
  }
}

// Run cleanup daily (every 24 hours)
let cleanupTimer = null;
function startCleanupSchedule() {
  cleanupOldData(); // Run once on startup
  cleanupTimer = setInterval(cleanupOldData, 24 * 60 * 60 * 1000);
}

module.exports = {
  initDb,
  getDb,
  saveDb,
  getUserBySyncTokenIndex,
  getUserByMaskId,
  getUserById,
  getUserByEmail,
  createUser,
  upsertPositions,
  upsertAccounts,
  insertHistories,
  getPositions,
  getAccounts,
  getHistories,
  calculateFee,
  createSnapshot,
  updateSnapshot,
  getLastSnapshot,
  updateLastSyncedAt,
  updateRemarkName,
  getAllUsers,
  checkDuplicateChecksum,
  hasPendingSnapshot,
  getAdminCount,
  getUserCounts,
  updateUserActive,
  cleanupOldData,
  startCleanupSchedule
};
