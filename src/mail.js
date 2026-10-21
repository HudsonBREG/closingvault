// Outbound email. With SMTP_URL set, mail is delivered; otherwise it is kept in the
// outbox table and shown in the in-app "Dev mailbox" so the flows can be tried locally.
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { q } = require('./db');

const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
const FROM = process.env.MAIL_FROM || 'ClosingVault <no-reply@closingvault.local>';
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

function send(to, subject, text) {
  const id = crypto.randomUUID();
  q.run('INSERT INTO outbox (id, to_email, subject, body, created_at) VALUES (?,?,?,?,?)',
    id, to, subject, text, new Date().toISOString());
  if (!transport) {
    console.log(`[mail] to=${to} subject="${subject}" (no SMTP_URL; see Dev mailbox)`);
    return;
  }
  transport.sendMail({ from: FROM, to, subject, text })
    .then(() => q.run('UPDATE outbox SET sent_at = ? WHERE id = ?', new Date().toISOString(), id))
    .catch((err) => {
      console.error('[mail] send failed', err.message);
      q.run('UPDATE outbox SET error = ? WHERE id = ?', err.message, id);
    });
}

// The dev mailbox exposes every outgoing email (including sign-in links), so it is never on in production.
const devMailbox = !transport && process.env.NODE_ENV !== 'production';
if (!transport && !devMailbox) console.warn('[mail] SMTP_URL is not set: emails will be recorded but not delivered.');

module.exports = { send, APP_URL, devMailbox };
