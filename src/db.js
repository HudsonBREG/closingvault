// SQLite persistence (Node's built-in node:sqlite, no native build step).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'closingvault.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  brokerage TEXT,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,            -- verify | reset
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  city TEXT, state TEXT, zip TEXT,
  mls_number TEXT,
  list_price INTEGER,
  status TEXT NOT NULL DEFAULT 'active', -- active | under_contract | closed | withdrawn
  offer_token TEXT NOT NULL UNIQUE,
  accepting_offers INTEGER NOT NULL DEFAULT 1,
  accepted_offer_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL,
  side TEXT NOT NULL,               -- listing | buyer | neutral
  status TEXT NOT NULL,             -- invited | active | removed
  invite_token_hash TEXT,
  invited_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS members_vault ON members(vault_id);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  agent_user_id TEXT NOT NULL REFERENCES users(id),
  buyer_names TEXT NOT NULL,
  price INTEGER NOT NULL,
  earnest_money INTEGER,
  financing TEXT,
  down_payment_pct REAL,
  closing_date TEXT,
  expires_at TEXT,
  contingencies TEXT,
  notes TEXT,
  status TEXT NOT NULL,             -- submitted | countered | accepted | rejected | withdrawn | not_selected | terminated
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offer_events (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),
  kind TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  offer_id TEXT REFERENCES offers(id),
  folder TEXT NOT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL,         -- all | listing | buyer | offer
  status TEXT NOT NULL DEFAULT 'uploaded', -- uploaded | awaiting_signatures | signed
  current_version INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS doc_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  note TEXT,
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(document_id, version)
);
CREATE TABLE IF NOT EXISTS signature_requests (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  doc_sha256 TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  message TEXT,
  due_date TEXT,
  status TEXT NOT NULL,             -- pending | completed | declined | cancelled | void
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS signers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,             -- pending | signed | declined
  signed_name TEXT,
  signed_at TEXT,
  ip TEXT,
  user_agent TEXT,
  decline_reason TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  visibility TEXT NOT NULL DEFAULT 'all',
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_vault ON activity(vault_id, created_at);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
`);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

module.exports = { db, q, tx, DATA_DIR };
