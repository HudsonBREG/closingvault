// Accounts, sessions, email verification, password reset, and invitations.
const crypto = require('crypto');
const express = require('express');
const { q, tx } = require('./db');
const mail = require('./mail');
const { ROLES, now, uid, randomToken, hashToken, fail, notify, audit, vaultLabel } = require('./domain');

const SESSION_DAYS = 14;
const COOKIE = 'cv_session';
const SECURE_COOKIE = mail.APP_URL.startsWith('https://');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k)
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function startSession(res, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  q.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', hashToken(token), userId, expires.toISOString());
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${SECURE_COOKIE ? '; Secure' : ''}`);
}

function loadUser(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = q.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`, hashToken(token), now());
    if (row) { req.user = row; req.sessionTokenHash = hashToken(token); }
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}
function requireVerified(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (!req.user.email_verified) return res.status(403).json({ error: 'Please verify your email address first.' });
  next();
}

const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name, phone: u.phone, brokerage: u.brokerage, emailVerified: !!u.email_verified });

// Simple in-memory throttle for credential endpoints.
const attempts = new Map();
function throttle(key, limit = 10, windowMs = 15 * 60e3) {
  const t = Date.now();
  const list = (attempts.get(key) || []).filter((x) => t - x < windowMs);
  if (list.length >= limit) fail(429, 'Too many attempts. Please wait a few minutes and try again.');
  list.push(t);
  attempts.set(key, list);
}

function issueToken(userId, purpose, hours) {
  const token = randomToken();
  q.run('INSERT INTO tokens (token_hash, user_id, purpose, expires_at) VALUES (?,?,?,?)',
    hashToken(token), userId, purpose, new Date(Date.now() + hours * 36e5).toISOString());
  return token;
}
function consumeToken(token, purpose) {
  const row = q.get('SELECT * FROM tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?', hashToken(token), purpose, now());
  if (!row) fail(400, 'This link is invalid or has expired.');
  q.run('DELETE FROM tokens WHERE token_hash = ?', row.token_hash);
  return row;
}

function sendVerification(user) {
  const token = issueToken(user.id, 'verify', 48);
  mail.send(user.email, 'Verify your ClosingVault email',
    `Hi ${user.name},\n\nConfirm your email address to unlock your transaction vaults:\n${mail.APP_URL}/#/verify/${token}\n\nThis link expires in 48 hours.`);
}

// Once an email is proven, pending invitations sent to it become active memberships.
function claimInvitesForEmail(user) {
  const pending = q.all("SELECT * FROM members WHERE lower(email) = lower(?) AND status = 'invited'", user.email);
  for (const m of pending) {
    q.run("UPDATE members SET user_id = ?, status = 'active', invite_token_hash = NULL, name = COALESCE(name, ?) WHERE id = ?", user.id, user.name, m.id);
    const others = q.all("SELECT user_id FROM members WHERE vault_id = ? AND status = 'active' AND user_id IS NOT NULL AND side IN (?, 'listing')", m.vault_id, m.side);
    notify(others.map((o) => o.user_id), {
      vaultId: m.vault_id, type: 'member_joined',
      title: `${user.name} joined ${vaultLabel(m.vault_id)} as ${ROLES[m.role].label}`,
      link: `#/vault/${m.vault_id}/people`,
    }, { actorId: user.id, email: false });
    audit({ user, ip: null }, m.vault_id, 'member.joined', `${user.name} (${ROLES[m.role].label})`);
  }
}

const router = express.Router();
const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

router.post('/register', (req, res) => {
  const { name, password, phone, brokerage, inviteToken } = req.body || {};
  const email = normEmail(req.body?.email);
  throttle(`register:${req.ip}`, 20);
  if (!name?.trim()) fail(400, 'Name is required.');
  if (!validEmail(email)) fail(400, 'Enter a valid email address.');
  if (!password || password.length < 10) fail(400, 'Password must be at least 10 characters.');
  if (q.get('SELECT 1 FROM users WHERE email = ?', email)) fail(409, 'An account with this email already exists. Sign in instead.');

  // Registering from an invite link proves ownership of the invited address.
  let invite = null;
  if (inviteToken) {
    invite = q.get("SELECT * FROM members WHERE invite_token_hash = ? AND status = 'invited'", hashToken(inviteToken));
    if (invite && normEmail(invite.email) !== email) invite = null;
  }
  const user = { id: uid(), email, name: name.trim(), phone: phone?.trim() || null, brokerage: brokerage?.trim() || null };
  tx(() => {
    q.run('INSERT INTO users (id, email, name, phone, brokerage, password_hash, email_verified, created_at) VALUES (?,?,?,?,?,?,?,?)',
      user.id, user.email, user.name, user.phone, user.brokerage, hashPassword(password), invite ? 1 : 0, now());
    if (invite) claimInvitesForEmail(user);
  });
  if (!invite) sendVerification(user);
  startSession(res, user.id);
  res.json({ user: publicUser(q.get('SELECT * FROM users WHERE id = ?', user.id)) });
});

router.post('/login', (req, res) => {
  const email = normEmail(req.body?.email);
  throttle(`login:${email}`);
  throttle(`login-ip:${req.ip}`, 50);
  const user = q.get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !verifyPassword(String(req.body?.password || ''), user.password_hash)) fail(401, 'Incorrect email or password.');
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  if (req.sessionTokenHash) q.run('DELETE FROM sessions WHERE token_hash = ?', req.sessionTokenHash);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

router.get('/me', (req, res) => res.json({ user: publicUser(req.user) || null, devMailbox: mail.devMailbox }));

router.patch('/me', requireUser, (req, res) => {
  const { name, phone, brokerage } = req.body || {};
  if (name !== undefined && !String(name).trim()) fail(400, 'Name is required.');
  q.run('UPDATE users SET name = COALESCE(?, name), phone = ?, brokerage = ? WHERE id = ?',
    name?.trim() || null, phone?.trim() || null, brokerage?.trim() || null, req.user.id);
  res.json({ user: publicUser(q.get('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

router.post('/verify', (req, res) => {
  const row = consumeToken(req.body?.token, 'verify');
  const user = q.get('SELECT * FROM users WHERE id = ?', row.user_id);
  tx(() => {
    q.run('UPDATE users SET email_verified = 1 WHERE id = ?', user.id);
    claimInvitesForEmail(user);
  });
  res.json({ ok: true });
});

router.post('/resend-verification', requireUser, (req, res) => {
  throttle(`verify:${req.user.id}`, 5);
  if (!req.user.email_verified) sendVerification(req.user);
  res.json({ ok: true });
});

router.post('/forgot', (req, res) => {
  const email = normEmail(req.body?.email);
  throttle(`forgot:${req.ip}`, 10);
  const user = q.get('SELECT * FROM users WHERE email = ?', email);
  if (user) {
    const token = issueToken(user.id, 'reset', 1);
    mail.send(user.email, 'Reset your ClosingVault password',
      `Hi ${user.name},\n\nReset your password here (valid for 1 hour):\n${mail.APP_URL}/#/reset/${token}\n\nIf you didn't ask for this, you can ignore this email.`);
  }
  res.json({ ok: true }); // same answer either way, so accounts can't be enumerated
});

router.post('/reset', (req, res) => {
  const { token, password } = req.body || {};
  if (!password || password.length < 10) fail(400, 'Password must be at least 10 characters.');
  const row = consumeToken(token, 'reset');
  tx(() => {
    // The reset link was delivered by email, so it also proves the address.
    q.run('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?', hashPassword(password), row.user_id);
    q.run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
    claimInvitesForEmail(q.get('SELECT * FROM users WHERE id = ?', row.user_id));
  });
  res.json({ ok: true });
});

// Invitation landing page info (public: the token itself is the secret).
router.get('/invites/:token', (req, res) => {
  const m = q.get("SELECT * FROM members WHERE invite_token_hash = ? AND status = 'invited'", hashToken(req.params.token));
  if (!m) fail(404, 'This invitation is no longer valid. It may already have been accepted.');
  const inviter = q.get('SELECT name, brokerage FROM users WHERE id = ?', m.invited_by);
  res.json({ email: m.email, role: ROLES[m.role].label, property: vaultLabel(m.vault_id), invitedBy: inviter, accountExists: !!q.get('SELECT 1 FROM users WHERE email = ?', normEmail(m.email)) });
});

router.post('/invites/:token/accept', requireUser, (req, res) => {
  const m = q.get("SELECT * FROM members WHERE invite_token_hash = ? AND status = 'invited'", hashToken(req.params.token));
  if (!m) fail(404, 'This invitation is no longer valid.');
  if (normEmail(m.email) !== normEmail(req.user.email)) fail(403, `This invitation was sent to ${m.email}. Sign in with that address to accept it.`);
  tx(() => {
    q.run('UPDATE users SET email_verified = 1 WHERE id = ?', req.user.id);
    claimInvitesForEmail(req.user);
  });
  res.json({ vaultId: m.vault_id });
});

module.exports = { router, loadUser, requireUser, requireVerified, publicUser, throttle };
