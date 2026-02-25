import Database from 'better-sqlite3';
import path from 'path';
import type { SettingRecord, SupportPresenceState, TokenSessionRecord, VisitorRecord } from './types';

const ROOT_DIR = path.resolve(__dirname, '..');
const dbPath = process.env.DB_PATH || path.join(ROOT_DIR, 'chat.db');

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS visitors (
    id TEXT PRIMARY KEY,
    name TEXT,
    site TEXT,
    email TEXT,
    telegram_topic_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT REFERENCES visitors(id),
    sender TEXT CHECK(sender IN ('visitor', 'agent')),
    content TEXT,
    type TEXT DEFAULT 'text' CHECK(type IN ('text', 'image', 'file')),
    file_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS token_sessions (
    jti TEXT PRIMARY KEY,
    sub TEXT NOT NULL,
    site TEXT,
    origin_host TEXT,
    expires_at INTEGER NOT NULL,
    revoked_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_token_sessions_sub ON token_sessions(sub);
  CREATE INDEX IF NOT EXISTS idx_token_sessions_expires_at ON token_sessions(expires_at);
`);

const visitorCols = db.prepare("PRAGMA table_info(visitors)").all() as Array<{ name: string }>;
if (!visitorCols.some((col) => col.name === 'email')) {
  db.exec('ALTER TABLE visitors ADD COLUMN email TEXT');
}
if (!visitorCols.some((col) => col.name === 'name')) {
  db.exec('ALTER TABLE visitors ADD COLUMN name TEXT');
}
if (!visitorCols.some((col) => col.name === 'auth_type')) {
  db.exec("ALTER TABLE visitors ADD COLUMN auth_type TEXT DEFAULT 'authenticated'");
}

const msgCols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
if (!msgCols.some((col) => col.name === 'file_url')) {
  db.exec('ALTER TABLE messages ADD COLUMN file_url TEXT');
}

const stmts = {
  upsertVisitor: db.prepare(`
    INSERT INTO visitors (id, name, site, email, auth_type) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = CURRENT_TIMESTAMP,
      site = COALESCE(excluded.site, site),
      name = COALESCE(excluded.name, visitors.name),
      email = COALESCE(excluded.email, visitors.email),
      auth_type = COALESCE(excluded.auth_type, visitors.auth_type)
  `),
  getVisitor: db.prepare('SELECT * FROM visitors WHERE id = ?'),
  setTopicId: db.prepare('UPDATE visitors SET telegram_topic_id = ? WHERE id = ?'),
  getVisitorByTopic: db.prepare('SELECT * FROM visitors WHERE telegram_topic_id = ?'),
  addMessage: db.prepare(`
    INSERT INTO messages (visitor_id, sender, content, type, file_url) VALUES (?, ?, ?, ?, ?)
  `),
  getHistory: db.prepare(`
    SELECT * FROM messages WHERE visitor_id = ? ORDER BY created_at ASC
  `),
  getVisitorCount: db.prepare('SELECT COUNT(*) as count FROM visitors'),

  getTokenSession: db.prepare('SELECT * FROM token_sessions WHERE jti = ?'),
  insertTokenSession: db.prepare(`
    INSERT INTO token_sessions (jti, sub, site, origin_host, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  touchTokenSession: db.prepare(`
    UPDATE token_sessions
    SET last_seen = CURRENT_TIMESTAMP
    WHERE jti = ?
  `),
  revokeTokenSession: db.prepare(`
    UPDATE token_sessions
    SET revoked_at = CURRENT_TIMESTAMP,
        last_seen = CURRENT_TIMESTAMP
    WHERE jti = ?
  `),
  purgeExpiredTokenSessions: db.prepare('DELETE FROM token_sessions WHERE expires_at < ?'),
  getSetting: db.prepare('SELECT * FROM settings WHERE key = ?'),
  upsertSetting: db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `),
};

function getVisitor(visitorId: string): VisitorRecord | undefined {
  return stmts.getVisitor.get(visitorId) as VisitorRecord | undefined;
}

function getTokenSession(jti: string): TokenSessionRecord | undefined {
  return stmts.getTokenSession.get(jti) as TokenSessionRecord | undefined;
}

function getSetting(key: string): SettingRecord | undefined {
  return stmts.getSetting.get(key) as SettingRecord | undefined;
}

const SUPPORT_PRESENCE_SETTING_KEY = 'support_presence_state';

function getSupportPresenceState(): SupportPresenceState {
  const record = getSetting(SUPPORT_PRESENCE_SETTING_KEY);
  if (!record) return 'online';

  const value = record.value?.trim().toLowerCase();
  if (value === 'offline' || value === 'online') {
    return value;
  }
  return 'online';
}

function setSupportPresenceState(state: SupportPresenceState): void {
  stmts.upsertSetting.run(SUPPORT_PRESENCE_SETTING_KEY, state);
}

export { db, stmts, getVisitor, getTokenSession, getSetting, getSupportPresenceState, setSupportPresenceState };
