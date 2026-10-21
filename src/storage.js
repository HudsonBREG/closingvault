// Encrypted file storage: every file version is sealed with AES-256-GCM before touching disk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./db');

const FILE_DIR = path.join(DATA_DIR, 'files');
const KEY_FILE = path.join(DATA_DIR, 'master.key');

function loadMasterKey() {
  if (process.env.VAULT_MASTER_KEY) {
    const key = Buffer.from(process.env.VAULT_MASTER_KEY, 'base64');
    if (key.length !== 32) throw new Error('VAULT_MASTER_KEY must be 32 bytes, base64-encoded');
    return key;
  }
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    console.warn(`[storage] Generated a new master key at ${KEY_FILE}. Set VAULT_MASTER_KEY in production.`);
  }
  return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
}
const MASTER_KEY = loadMasterKey();

// Each file gets its own key derived from the master key + a random storage key.
function fileKey(storageKey) {
  return Buffer.from(crypto.hkdfSync('sha256', MASTER_KEY, Buffer.from(storageKey), 'closingvault-file', 32));
}

function save(buffer) {
  const storageKey = crypto.randomBytes(16).toString('hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey(storageKey), iv);
  const sealed = Buffer.concat([cipher.update(buffer), cipher.final()]);
  fs.writeFileSync(path.join(FILE_DIR, storageKey), sealed, { mode: 0o600 });
  return {
    storageKey,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    size: buffer.length,
  };
}

function load(version) {
  const sealed = fs.readFileSync(path.join(FILE_DIR, version.storage_key));
  const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey(version.storage_key), Buffer.from(version.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(version.auth_tag, 'base64'));
  return Buffer.concat([decipher.update(sealed), decipher.final()]);
}

module.exports = { save, load };
