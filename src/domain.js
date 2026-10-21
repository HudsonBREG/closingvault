// Roles, permissions, notifications, and audit helpers shared by the routes.
const crypto = require('crypto');
const { q } = require('./db');
const mail = require('./mail');

const ROLES = {
  listing_agent: { label: 'Listing Agent', side: 'listing', manager: true },
  listing_team: { label: 'Listing Team Member', side: 'listing', manager: true },
  seller: { label: 'Seller', side: 'listing' },
  buyer_agent: { label: "Buyer's Agent", side: 'buyer', manager: true },
  buyer_team: { label: "Buyer's Agent Team Member", side: 'buyer', manager: true },
  buyer: { label: 'Buyer', side: 'buyer' },
  lender: { label: 'Lender / Loan Officer', side: 'buyer' },
  inspector: { label: 'Inspector', side: 'buyer' },
  title_escrow: { label: 'Title / Escrow Officer', side: 'neutral', canRequestSignatures: true },
  attorney: { label: 'Attorney', side: 'neutral', canRequestSignatures: true },
  appraiser: { label: 'Appraiser', side: 'neutral' },
};

const FOLDERS = ['Listing', 'Disclosures', 'Offers', 'Purchase Agreement', 'Addenda & Amendments',
  'Inspection', 'Appraisal', 'Financing', 'Title & Escrow', 'Closing', 'Other'];

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function activeMember(vaultId, userId) {
  return q.get("SELECT * FROM members WHERE vault_id = ? AND user_id = ? AND status = 'active'", vaultId, userId);
}

function requireMember(vaultId, user) {
  const m = activeMember(vaultId, user.id);
  if (!m) fail(404, 'Vault not found');
  return m;
}

const isManager = (m) => !!ROLES[m.role]?.manager;
const canRequestSignatures = (m) => isManager(m) || !!ROLES[m.role]?.canRequestSignatures;
const isListingManager = (m) => m.side === 'listing' && isManager(m);

// Which roles a member may invite: managers invite their own side and neutral parties.
function invitableRoles(m) {
  if (!isManager(m)) return [];
  return Object.entries(ROLES)
    .filter(([key, r]) => key !== 'listing_agent' && key !== 'buyer_agent' && (r.side === m.side || r.side === 'neutral'))
    .map(([key]) => key);
}

// Visibility values a member may put on a document they upload.
function allowedVisibility(m) {
  return m.side === 'neutral' ? ['all'] : ['all', m.side];
}

// Can this user see this document? Offer documents are visible to the listing side and
// the agent who submitted the offer, even though that agent is not yet a vault member.
function canSeeDocument(user, doc) {
  const m = activeMember(doc.vault_id, user.id);
  if (doc.visibility === 'offer') {
    if (m && m.side === 'listing') return true;
    const offer = q.get('SELECT agent_user_id FROM offers WHERE id = ?', doc.offer_id);
    return !!offer && offer.agent_user_id === user.id;
  }
  if (!m || doc.archived) return false;
  return doc.visibility === 'all' || doc.visibility === m.side;
}

function membersWhoCanSee(vaultId, visibility) {
  const rows = q.all("SELECT * FROM members WHERE vault_id = ? AND status = 'active' AND user_id IS NOT NULL", vaultId);
  if (visibility === 'all') return rows;
  if (visibility === 'offer') return rows.filter((m) => m.side === 'listing');
  return rows.filter((m) => m.side === visibility);
}

function vaultLabel(vaultId) {
  const v = q.get('SELECT address, city FROM vaults WHERE id = ?', vaultId);
  return v ? [v.address, v.city].filter(Boolean).join(', ') : 'a transaction';
}

// Live push channel (Server-Sent Events), keyed by user id.
const streams = new Map();
function addStream(userId, res) {
  if (!streams.has(userId)) streams.set(userId, new Set());
  streams.get(userId).add(res);
  return () => streams.get(userId)?.delete(res);
}
function push(userId, event, data) {
  for (const res of streams.get(userId) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// In-app notification + email for each recipient (deduplicated, never the actor).
function notify(userIds, { vaultId, type, title, body, link }, { actorId, email = true } = {}) {
  const seen = new Set();
  for (const userId of userIds) {
    if (!userId || userId === actorId || seen.has(userId)) continue;
    seen.add(userId);
    const n = { id: uid(), user_id: userId, vault_id: vaultId || null, type, title, body: body || null, link: link || null, created_at: now() };
    q.run('INSERT INTO notifications (id, user_id, vault_id, type, title, body, link, created_at) VALUES (?,?,?,?,?,?,?,?)',
      n.id, n.user_id, n.vault_id, n.type, n.title, n.body, n.link, n.created_at);
    push(userId, 'notification', n);
    if (email) {
      const u = q.get('SELECT email, name FROM users WHERE id = ?', userId);
      if (u) {
        mail.send(u.email, `[ClosingVault] ${title}`,
          `Hi ${u.name},\n\n${title}${body ? `\n\n${body}` : ''}\n\nOpen in ClosingVault: ${mail.APP_URL}/${link || ''}\n\nFor your security, documents are never attached to email. Sign in to view them.`);
      }
    }
  }
}

function audit(req, vaultId, action, detail, visibility = 'all') {
  q.run('INSERT INTO activity (id, vault_id, user_id, action, detail, visibility, ip, created_at) VALUES (?,?,?,?,?,?,?,?)',
    uid(), vaultId, req.user?.id || null, action, detail || null, visibility, req.ip, now());
}

module.exports = {
  ROLES, FOLDERS, now, uid, randomToken, hashToken, HttpError, fail,
  activeMember, requireMember, isManager, isListingManager, canRequestSignatures, invitableRoles, allowedVisibility,
  canSeeDocument, membersWhoCanSee, vaultLabel, addStream, push, notify, audit,
};
