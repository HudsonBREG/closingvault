// Transaction API: vaults, people, offers, documents, signatures, notifications.
const express = require('express');
const multer = require('multer');
const path = require('path');
const { q, tx } = require('./db');
const storage = require('./storage');
const { stampCertificate } = require('./certificate');
const { requireUser, requireVerified, throttle } = require('./auth');
const mail = require('./mail');
const D = require('./domain');
const { ROLES, FOLDERS, now, uid, randomToken, hashToken, fail, notify, audit } = D;

const router = express.Router();

const ALLOWED_EXT = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.rtf', '.png', '.jpg', '.jpeg', '.gif', '.heic', '.webp', '.zip']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_EXT.has(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new D.HttpError(400, `${file.originalname}: file type not allowed`), ok);
  },
});

const money = (n) => (n == null ? '' : `$${Number(n).toLocaleString('en-US')}`);
const intOrNull = (v) => (v === undefined || v === null || v === '' ? null : Math.round(Number(String(v).replace(/[$,\s]/g, ''))));
const userName = (id) => q.get('SELECT name FROM users WHERE id = ?', id)?.name || 'Someone';
const cleanName = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 200);

function loadVault(id) {
  const v = q.get('SELECT * FROM vaults WHERE id = ?', id);
  if (!v) fail(404, 'Vault not found');
  return v;
}

// ---------- Documents (shared helper) ----------

function addVersion(doc, file, userId, note) {
  const sealed = storage.save(file.buffer);
  const version = doc.current_version_next;
  q.run(`INSERT INTO doc_versions (id, document_id, version, filename, mime, size, sha256, storage_key, iv, auth_tag, note, uploaded_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, uid(), doc.id, version, cleanName(file.originalname), file.mimetype || 'application/octet-stream',
  sealed.size, sealed.sha256, sealed.storageKey, sealed.iv, sealed.authTag, note || null, userId, now());
  return version;
}

function createDocument({ vaultId, offerId = null, folder, visibility, file, userId, name }) {
  const doc = { id: uid(), current_version_next: 1 };
  q.run(`INSERT INTO documents (id, vault_id, offer_id, folder, name, visibility, uploaded_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, doc.id, vaultId, offerId, folder, cleanName(name || file.originalname), visibility, userId, now(), now());
  addVersion(doc, file, userId);
  return doc.id;
}

function voidPendingRequests(docId, reason, actorId) {
  const pending = q.all("SELECT * FROM signature_requests WHERE document_id = ? AND status = 'pending'", docId);
  for (const r of pending) {
    q.run("UPDATE signature_requests SET status = 'void' WHERE id = ?", r.id);
    const signers = q.all("SELECT user_id FROM signers WHERE request_id = ? AND status = 'pending'", r.id);
    const doc = q.get('SELECT * FROM documents WHERE id = ?', docId);
    notify(signers.map((s) => s.user_id), {
      vaultId: doc.vault_id, type: 'signature_void', title: `Signature no longer needed: ${doc.name}`, body: reason,
      link: `#/vault/${doc.vault_id}/documents`,
    }, { actorId });
  }
}

function docSummary(doc, user) {
  const v = q.get('SELECT version, filename, mime, size, sha256, created_at, uploaded_by FROM doc_versions WHERE document_id = ? AND version = ?', doc.id, doc.current_version);
  const req = q.get("SELECT * FROM signature_requests WHERE document_id = ? AND status IN ('pending','completed','declined') ORDER BY created_at DESC LIMIT 1", doc.id);
  let signature = null;
  if (req) {
    const signers = q.all('SELECT s.user_id, s.status, u.name FROM signers s JOIN users u ON u.id = s.user_id WHERE request_id = ?', req.id);
    signature = {
      requestId: req.id, status: req.status, total: signers.length,
      signed: signers.filter((s) => s.status === 'signed').length,
      awaitingMe: req.status === 'pending' && signers.some((s) => s.user_id === user.id && s.status === 'pending'),
      signers: signers.map((s) => ({ name: s.name, status: s.status })),
    };
  }
  return {
    id: doc.id, vaultId: doc.vault_id, offerId: doc.offer_id, folder: doc.folder, name: doc.name, visibility: doc.visibility,
    status: doc.status, version: doc.current_version, uploadedBy: userName(doc.uploaded_by), uploadedById: doc.uploaded_by,
    updatedAt: doc.updated_at, file: v && { filename: v.filename, mime: v.mime, size: v.size, sha256: v.sha256 }, signature,
  };
}

// ---------- Vaults ----------

router.get('/meta', (req, res) => {
  res.json({ roles: ROLES, folders: FOLDERS });
});

router.get('/dashboard', requireVerified, (req, res) => {
  const vaults = q.all(`SELECT v.*, m.role, m.side FROM vaults v JOIN members m ON m.vault_id = v.id
    WHERE m.user_id = ? AND m.status = 'active' ORDER BY v.created_at DESC`, req.user.id).map((v) => ({
    id: v.id, address: v.address, city: v.city, state: v.state, zip: v.zip, listPrice: v.list_price, status: v.status,
    role: v.role, roleLabel: ROLES[v.role].label, side: v.side,
    newOffers: v.side === 'listing' ? q.get("SELECT count(*) c FROM offers WHERE vault_id = ? AND status = 'submitted'", v.id).c : 0,
    members: q.get("SELECT count(*) c FROM members WHERE vault_id = ? AND status = 'active'", v.id).c,
    documents: q.all('SELECT * FROM documents WHERE vault_id = ? AND archived = 0', v.id).filter((d) => D.canSeeDocument(req.user, d)).length,
  }));
  const offers = q.all(`SELECT o.*, v.address, v.city FROM offers o JOIN vaults v ON v.id = o.vault_id
    WHERE o.agent_user_id = ? ORDER BY o.updated_at DESC`, req.user.id)
    .map((o) => ({ id: o.id, vaultId: o.vault_id, address: o.address, city: o.city, price: o.price, status: o.status, buyerNames: o.buyer_names, updatedAt: o.updated_at }));
  const signatures = q.all(`SELECT r.id, d.name, d.vault_id, v.address, r.created_at, r.due_date FROM signers s
    JOIN signature_requests r ON r.id = s.request_id JOIN documents d ON d.id = r.document_id JOIN vaults v ON v.id = d.vault_id
    WHERE s.user_id = ? AND s.status = 'pending' AND r.status = 'pending' ORDER BY r.created_at`, req.user.id);
  res.json({ vaults, offers, signatures });
});

router.post('/vaults', requireVerified, (req, res) => {
  const b = req.body || {};
  if (!b.address?.trim()) fail(400, 'Property address is required.');
  const id = uid();
  tx(() => {
    q.run(`INSERT INTO vaults (id, address, city, state, zip, mls_number, list_price, offer_token, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, id, b.address.trim(), b.city?.trim() || null, b.state?.trim() || null, b.zip?.trim() || null,
    b.mlsNumber?.trim() || null, intOrNull(b.listPrice), randomToken(), req.user.id, now());
    q.run(`INSERT INTO members (id, vault_id, user_id, email, name, role, side, status, invited_by, created_at)
      VALUES (?,?,?,?,?,'listing_agent','listing','active',?,?)`, uid(), id, req.user.id, req.user.email, req.user.name, req.user.id, now());
    audit(req, id, 'vault.created', `Vault created for ${b.address.trim()}`);
  });
  res.json({ id });
});

router.get('/vaults/:id', requireVerified, (req, res) => {
  const v = loadVault(req.params.id);
  const me = D.requireMember(v.id, req.user);
  const members = q.all(`SELECT m.id, m.user_id, m.email, m.role, m.side, m.status, m.created_at,
      COALESCE(u.name, m.name) name, u.phone, u.brokerage
    FROM members m LEFT JOIN users u ON u.id = m.user_id WHERE m.vault_id = ? AND m.status != 'removed'
    ORDER BY CASE m.side WHEN 'listing' THEN 0 WHEN 'buyer' THEN 1 ELSE 2 END, m.created_at`, v.id)
    .map((m) => ({ ...m, roleLabel: ROLES[m.role].label, isMe: m.user_id === req.user.id }));
  const isListing = me.side === 'listing';
  res.json({
    vault: {
      id: v.id, address: v.address, city: v.city, state: v.state, zip: v.zip, mlsNumber: v.mls_number, listPrice: v.list_price,
      status: v.status, acceptingOffers: !!v.accepting_offers, createdAt: v.created_at,
      offerLink: isListing ? `${mail.APP_URL}/#/offer/${v.offer_token}` : null,
      acceptedOfferId: v.accepted_offer_id,
    },
    me: {
      memberId: me.id, role: me.role, roleLabel: ROLES[me.role].label, side: me.side,
      manager: D.isManager(me), listingManager: D.isListingManager(me), isListingAgent: me.role === 'listing_agent',
      canRequestSignatures: D.canRequestSignatures(me), invitableRoles: D.invitableRoles(me), visibilityOptions: D.allowedVisibility(me),
    },
    members,
    pendingOffers: isListing ? q.get("SELECT count(*) c FROM offers WHERE vault_id = ? AND status = 'submitted'", v.id).c : 0,
  });
});

router.patch('/vaults/:id', requireVerified, (req, res) => {
  const v = loadVault(req.params.id);
  const me = D.requireMember(v.id, req.user);
  if (!D.isListingManager(me)) fail(403, 'Only the listing agent and their team can edit listing details.');
  const b = req.body || {};
  q.run(`UPDATE vaults SET address = COALESCE(?, address), city = ?, state = ?, zip = ?, mls_number = ?, list_price = ?,
    accepting_offers = ? WHERE id = ?`, b.address?.trim() || null, b.city ?? v.city, b.state ?? v.state, b.zip ?? v.zip,
  b.mlsNumber ?? v.mls_number, b.listPrice !== undefined ? intOrNull(b.listPrice) : v.list_price,
  b.acceptingOffers !== undefined ? (b.acceptingOffers ? 1 : 0) : v.accepting_offers, v.id);
  audit(req, v.id, 'vault.updated', 'Listing details updated', 'listing');
  res.json({ ok: true });
});

router.post('/vaults/:id/rotate-offer-link', requireVerified, (req, res) => {
  const v = loadVault(req.params.id);
  if (!D.isListingManager(D.requireMember(v.id, req.user))) fail(403, 'Not allowed.');
  q.run('UPDATE vaults SET offer_token = ? WHERE id = ?', randomToken(), v.id);
  audit(req, v.id, 'vault.offer_link_rotated', 'Offer submission link was reset; the old link no longer works', 'listing');
  res.json({ ok: true });
});

// Status changes: closing, withdrawing, or releasing an accepted contract (back on market).
router.post('/vaults/:id/status', requireVerified, (req, res) => {
  const v = loadVault(req.params.id);
  const me = D.requireMember(v.id, req.user);
  if (me.role !== 'listing_agent') fail(403, 'Only the listing agent can change the transaction status.');
  const { status, note } = req.body || {};
  const everyone = () => q.all("SELECT user_id FROM members WHERE vault_id = ? AND status = 'active'", v.id).map((m) => m.user_id);
  const label = D.vaultLabel(v.id);
  tx(() => {
    if (status === 'closed' || status === 'withdrawn') {
      q.run('UPDATE vaults SET status = ?, accepting_offers = 0 WHERE id = ?', status, v.id);
      notify(everyone(), { vaultId: v.id, type: 'vault_status', title: status === 'closed' ? `Closed: ${label} 🎉` : `Listing withdrawn: ${label}`, body: note, link: `#/vault/${v.id}` }, { actorId: req.user.id });
      audit(req, v.id, `vault.${status}`, note);
    } else if (status === 'active' && v.status === 'under_contract') {
      const buyerSide = q.all("SELECT user_id FROM members WHERE vault_id = ? AND side = 'buyer' AND status = 'active'", v.id).map((m) => m.user_id);
      notify(everyone(), { vaultId: v.id, type: 'vault_status', title: `Contract released: ${label} is back on the market`, body: note, link: '#/' }, { actorId: req.user.id });
      q.run("UPDATE offers SET status = 'terminated', updated_at = ? WHERE id = ?", now(), v.accepted_offer_id);
      q.run("UPDATE members SET status = 'removed' WHERE vault_id = ? AND side = 'buyer'", v.id);
      q.run("UPDATE vaults SET status = 'active', accepted_offer_id = NULL, accepting_offers = 1 WHERE id = ?", v.id);
      audit(req, v.id, 'vault.contract_released', `Contract released; ${buyerSide.length} buyer-side participant(s) lost access. ${note || ''}`);
    } else if (status === 'active' && ['closed', 'withdrawn'].includes(v.status)) {
      q.run("UPDATE vaults SET status = ? WHERE id = ?", v.accepted_offer_id ? 'under_contract' : 'active', v.id);
      audit(req, v.id, 'vault.reopened', note);
    } else fail(400, 'That status change is not allowed.');
  });
  res.json({ ok: true });
});

// ---------- People ----------

router.post('/vaults/:id/members', requireVerified, (req, res) => {
  const v = loadVault(req.params.id);
  const me = D.requireMember(v.id, req.user);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const { role, name } = req.body || {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
  if (!D.invitableRoles(me).includes(role)) fail(403, 'You can’t invite someone with that role.');
  throttle(`invite:${req.user.id}`, 60, 60 * 60e3);
  const existing = q.get("SELECT * FROM members WHERE vault_id = ? AND lower(email) = ? AND status != 'removed'", v.id, email);
  if (existing) fail(409, 'That person is already part of this vault.');

  const user = q.get('SELECT * FROM users WHERE email = ? AND email_verified = 1', email);
  const token = randomToken();
  const memberId = uid();
  tx(() => {
    q.run(`INSERT INTO members (id, vault_id, user_id, email, name, role, side, status, invite_token_hash, invited_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, memberId, v.id, user?.id || null, email, user?.name || name?.trim() || null, role, ROLES[role].side,
    user ? 'active' : 'invited', user ? null : hashToken(token), req.user.id, now());
    audit(req, v.id, 'member.invited', `${req.user.name} added ${name || email} as ${ROLES[role].label}`);
  });
  const label = D.vaultLabel(v.id);
  if (user) {
    notify([user.id], { vaultId: v.id, type: 'added_to_vault', title: `${req.user.name} added you to ${label} as ${ROLES[role].label}`, link: `#/vault/${v.id}` });
  } else {
    mail.send(email, `${req.user.name} invited you to the ${label} transaction vault`,
      `Hi${name ? ` ${name}` : ''},\n\n${req.user.name}${req.user.brokerage ? ` (${req.user.brokerage})` : ''} invited you to join the secure document vault for ${label} as ${ROLES[role].label}.\n\nAccept the invitation:\n${mail.APP_URL}/#/invite/${token}\n\nClosingVault keeps every document for this transaction in one encrypted place, so nothing sensitive has to travel by email.`);
  }
  res.json({ id: memberId, status: user ? 'active' : 'invited' });
});

router.post('/vaults/:id/members/:memberId/resend', requireVerified, (req, res) => {
  const v = loadVault(req.params.id);
  const me = D.requireMember(v.id, req.user);
  const m = q.get("SELECT * FROM members WHERE id = ? AND vault_id = ? AND status = 'invited'", req.params.memberId, v.id);
  if (!m || !D.isManager(me) || (m.side !== me.side && m.side !== 'neutral')) fail(404, 'Invitation not found.');
  throttle(`invite:${req.user.id}`, 60, 60 * 60e3);
  const token = randomToken();
  q.run('UPDATE members SET invite_token_hash = ? WHERE id = ?', hashToken(token), m.id);
  mail.send(m.email, `Reminder: join the ${D.vaultLabel(v.id)} transaction vault`,
    `${req.user.name} is waiting for you to join the secure document vault for ${D.vaultLabel(v.id)}.\n\n${mail.APP_URL}/#/invite/${token}`);
  res.json({ ok: true });
});

router.delete('/vaults/:id/members/:memberId', requireVerified, (req, res) => {
  const v = loadVault(req.params.id);
  const me = D.requireMember(v.id, req.user);
  const m = q.get("SELECT * FROM members WHERE id = ? AND vault_id = ? AND status != 'removed'", req.params.memberId, v.id);
  if (!m) fail(404, 'Member not found.');
  const allowed = m.role !== 'listing_agent' && m.id !== me.id && (
    me.role === 'listing_agent' ? m.role !== 'buyer_agent' : D.isManager(me) && m.side === me.side && !['buyer_agent'].includes(m.role));
  if (!allowed) fail(403, 'You can’t remove this person.');
  q.run("UPDATE members SET status = 'removed', invite_token_hash = NULL WHERE id = ?", m.id);
  if (m.user_id) notify([m.user_id], { vaultId: v.id, type: 'removed', title: `Your access to ${D.vaultLabel(v.id)} was removed`, link: '#/' }, { actorId: req.user.id });
  audit(req, v.id, 'member.removed', `${req.user.name} removed ${m.name || m.email} (${ROLES[m.role].label})`);
  res.json({ ok: true });
});

router.get('/vaults/:id/activity', requireVerified, (req, res) => {
  const v = loadVault(req.params.id);
  const me = D.requireMember(v.id, req.user);
  const vis = me.side === 'listing' ? ['all', 'listing', 'offer'] : ['all', me.side];
  const rows = q.all(`SELECT a.*, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.vault_id = ?
    AND a.visibility IN (${vis.map(() => '?').join(',')}) ORDER BY a.created_at DESC LIMIT 500`, v.id, ...vis);
  res.json({ activity: rows.map((a) => ({ id: a.id, action: a.action, detail: a.detail, user: a.name, createdAt: a.created_at, ip: D.isManager(me) ? a.ip : undefined })) });
});

// ---------- Offers ----------

function offerView(o, user) {
  const docs = q.all('SELECT * FROM documents WHERE offer_id = ? AND archived = 0 ORDER BY created_at', o.id)
    .filter((d) => D.canSeeDocument(user, d)).map((d) => docSummary(d, user));
  const agent = q.get('SELECT name, email, phone, brokerage FROM users WHERE id = ?', o.agent_user_id);
  const events = q.all('SELECT e.kind, e.note, e.created_at, u.name FROM offer_events e LEFT JOIN users u ON u.id = e.user_id WHERE offer_id = ? ORDER BY e.created_at', o.id);
  return {
    id: o.id, vaultId: o.vault_id, buyerNames: o.buyer_names, price: o.price, earnestMoney: o.earnest_money, financing: o.financing,
    downPaymentPct: o.down_payment_pct, closingDate: o.closing_date, expiresAt: o.expires_at, contingencies: o.contingencies,
    notes: o.notes, status: o.status, createdAt: o.created_at, updatedAt: o.updated_at, agent, documents: docs, events,
    isMine: o.agent_user_id === user.id,
  };
}

function loadOfferFor(user, id) {
  const o = q.get('SELECT * FROM offers WHERE id = ?', id);
  if (!o) fail(404, 'Offer not found');
  const m = D.activeMember(o.vault_id, user.id);
  const listing = m && m.side === 'listing';
  if (!listing && o.agent_user_id !== user.id) fail(404, 'Offer not found');
  return { o, m, listing };
}

const offerFields = (b) => ({
  buyer_names: String(b.buyerNames || '').trim(),
  price: intOrNull(b.price),
  earnest_money: intOrNull(b.earnestMoney),
  financing: b.financing || null,
  down_payment_pct: b.downPaymentPct ? Number(b.downPaymentPct) : null,
  closing_date: b.closingDate || null,
  expires_at: b.expiresAt || null,
  contingencies: Array.isArray(b.contingencies) ? b.contingencies.join(', ') : (b.contingencies || null),
  notes: b.notes?.trim() || null,
});

// Public-by-link: what a buyer's agent sees before submitting.
router.get('/offer-link/:token', requireUser, (req, res) => {
  const v = q.get('SELECT * FROM vaults WHERE offer_token = ?', req.params.token);
  if (!v) fail(404, 'This offer link is not valid. Ask the listing agent for a current link.');
  const agent = q.get("SELECT u.name, u.email, u.phone, u.brokerage FROM members m JOIN users u ON u.id = m.user_id WHERE m.vault_id = ? AND m.role = 'listing_agent'", v.id);
  const mine = q.all('SELECT id, status, price, created_at FROM offers WHERE vault_id = ? AND agent_user_id = ? ORDER BY created_at DESC', v.id, req.user.id);
  res.json({
    address: v.address, city: v.city, state: v.state, zip: v.zip, listPrice: v.list_price, mlsNumber: v.mls_number,
    open: v.status === 'active' && !!v.accepting_offers, status: v.status, listingAgent: agent, myOffers: mine,
  });
});

router.post('/offer-link/:token/offers', requireVerified, upload.array('files'), (req, res) => {
  const v = q.get('SELECT * FROM vaults WHERE offer_token = ?', req.params.token);
  if (!v) fail(404, 'This offer link is not valid.');
  if (v.status !== 'active' || !v.accepting_offers) fail(409, 'The listing agent is not accepting offers on this property right now.');
  const m = D.activeMember(v.id, req.user.id);
  if (m && m.side === 'listing') fail(400, 'You are on the listing side of this transaction.');
  throttle(`offer:${req.user.id}`, 30, 60 * 60e3);
  const f = offerFields(req.body || {});
  if (!f.buyer_names) fail(400, 'Buyer name(s) are required.');
  if (!f.price || f.price < 1) fail(400, 'Offer price is required.');
  if (!req.files?.length) fail(400, 'Attach the signed offer / purchase agreement.');
  const id = uid();
  tx(() => {
    q.run(`INSERT INTO offers (id, vault_id, agent_user_id, buyer_names, price, earnest_money, financing, down_payment_pct, closing_date,
      expires_at, contingencies, notes, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?,?)`,
    id, v.id, req.user.id, f.buyer_names, f.price, f.earnest_money, f.financing, f.down_payment_pct, f.closing_date, f.expires_at,
    f.contingencies, f.notes, now(), now());
    for (const file of req.files) createDocument({ vaultId: v.id, offerId: id, folder: 'Offers', visibility: 'offer', file, userId: req.user.id });
    q.run('INSERT INTO offer_events (id, offer_id, user_id, kind, note, created_at) VALUES (?,?,?,?,?,?)', uid(), id, req.user.id, 'submitted', f.notes, now());
    audit(req, v.id, 'offer.submitted', `${req.user.name}${req.user.brokerage ? ` (${req.user.brokerage})` : ''} submitted an offer of ${money(f.price)} for ${f.buyer_names}`, 'listing');
    notify(D.membersWhoCanSee(v.id, 'offer').map((x) => x.user_id), {
      vaultId: v.id, type: 'offer_received', title: `New offer on ${D.vaultLabel(v.id)}: ${money(f.price)}`,
      body: `From ${req.user.name}${req.user.brokerage ? `, ${req.user.brokerage}` : ''} for ${f.buyer_names}. ${f.financing ? `Financing: ${f.financing}.` : ''}${f.expires_at ? ` Expires ${f.expires_at.replace('T', ' ')}.` : ''}`,
      link: `#/vault/${v.id}/offers/${id}`,
    }, { actorId: req.user.id });
  });
  res.json({ id });
});

router.get('/vaults/:id/offers', requireVerified, (req, res) => {
  const v = loadVault(req.params.id);
  const me = D.requireMember(v.id, req.user);
  if (me.side !== 'listing') fail(403, 'Offers are only visible to the listing side.');
  const offers = q.all('SELECT * FROM offers WHERE vault_id = ? ORDER BY CASE status WHEN \'accepted\' THEN 0 WHEN \'submitted\' THEN 1 WHEN \'countered\' THEN 2 ELSE 3 END, price DESC', v.id);
  res.json({ offers: offers.map((o) => offerView(o, req.user)) });
});

router.get('/offers/:id', requireVerified, (req, res) => {
  const { o, listing, m } = loadOfferFor(req.user, req.params.id);
  const v = loadVault(o.vault_id);
  res.json({
    offer: offerView(o, req.user), property: { id: v.id, address: v.address, city: v.city, state: v.state, listPrice: v.list_price, status: v.status },
    canRespond: listing && D.isListingManager(m) && ['submitted', 'countered'].includes(o.status) && v.status === 'active',
    canRevise: o.agent_user_id === req.user.id && ['submitted', 'countered'].includes(o.status) && v.status === 'active',
    isMember: !!m,
  });
});

function offerEvent(req, o, kind, note) {
  q.run('INSERT INTO offer_events (id, offer_id, user_id, kind, note, created_at) VALUES (?,?,?,?,?,?)', uid(), o.id, req.user.id, kind, note || null, now());
}

router.post('/offers/:id/respond', requireVerified, upload.array('files'), (req, res) => {
  const { o, m } = loadOfferFor(req.user, req.params.id);
  const v = loadVault(o.vault_id);
  if (!m || !D.isListingManager(m)) fail(403, 'Only the listing agent or their team can respond to offers.');
  if (!['submitted', 'countered'].includes(o.status) || v.status !== 'active') fail(409, 'This offer can no longer be changed.');
  const { action, note } = req.body || {};
  const label = D.vaultLabel(v.id);
  const link = `#/offer-status/${o.id}`;
  tx(() => {
    if (action === 'counter') {
      for (const file of req.files || []) createDocument({ vaultId: v.id, offerId: o.id, folder: 'Offers', visibility: 'offer', file, userId: req.user.id, name: `Counter – ${file.originalname}` });
      q.run("UPDATE offers SET status = 'countered', updated_at = ? WHERE id = ?", now(), o.id);
      offerEvent(req, o, 'countered', note);
      audit(req, v.id, 'offer.countered', `${req.user.name} countered the ${money(o.price)} offer from ${userName(o.agent_user_id)}`, 'listing');
      notify([o.agent_user_id], { vaultId: v.id, type: 'offer_countered', title: `Counter offer on ${label}`, body: note, link });
    } else if (action === 'reject') {
      q.run("UPDATE offers SET status = 'rejected', updated_at = ? WHERE id = ?", now(), o.id);
      offerEvent(req, o, 'rejected', note);
      audit(req, v.id, 'offer.rejected', `${req.user.name} declined the ${money(o.price)} offer from ${userName(o.agent_user_id)}`, 'listing');
      notify([o.agent_user_id], { vaultId: v.id, type: 'offer_rejected', title: `Your offer on ${label} was declined`, body: note, link });
    } else if (action === 'accept') {
      acceptOffer(req, o, v, note);
    } else fail(400, 'Unknown action.');
  });
  res.json({ ok: true });
});

function acceptOffer(req, o, v, note) {
  const label = D.vaultLabel(v.id);
  q.run("UPDATE offers SET status = 'accepted', updated_at = ? WHERE id = ?", now(), o.id);
  offerEvent(req, o, 'accepted', note);
  q.run("UPDATE vaults SET status = 'under_contract', accepted_offer_id = ?, accepting_offers = 0 WHERE id = ?", o.id, v.id);
  // The winning offer's paperwork becomes the shared purchase agreement.
  q.run("UPDATE documents SET visibility = 'all', folder = 'Purchase Agreement', updated_at = ? WHERE offer_id = ?", now(), o.id);

  // Bring the buyer's agent into the vault (or re-activate them).
  const agent = q.get('SELECT * FROM users WHERE id = ?', o.agent_user_id);
  const existing = q.get('SELECT * FROM members WHERE vault_id = ? AND lower(email) = lower(?)', v.id, agent.email);
  if (existing) q.run("UPDATE members SET user_id = ?, role = 'buyer_agent', side = 'buyer', status = 'active', invite_token_hash = NULL WHERE id = ?", agent.id, existing.id);
  else {
    q.run(`INSERT INTO members (id, vault_id, user_id, email, name, role, side, status, invited_by, created_at)
      VALUES (?,?,?,?,?,'buyer_agent','buyer','active',?,?)`, uid(), v.id, agent.id, agent.email, agent.name, req.user.id, now());
  }

  // Everyone else who was still in the running hears the outcome.
  const others = q.all("SELECT * FROM offers WHERE vault_id = ? AND id != ? AND status IN ('submitted','countered')", v.id, o.id);
  for (const other of others) {
    q.run("UPDATE offers SET status = 'not_selected', updated_at = ? WHERE id = ?", now(), other.id);
    q.run('INSERT INTO offer_events (id, offer_id, user_id, kind, note, created_at) VALUES (?,?,?,?,?,?)', uid(), other.id, req.user.id, 'not_selected', 'The seller accepted another offer.', now());
    notify([other.agent_user_id], { vaultId: v.id, type: 'offer_not_selected', title: `The seller accepted another offer on ${label}`, body: 'Thank you for your offer. Your documents remain private to you and the listing side.', link: `#/offer-status/${other.id}` });
  }

  audit(req, v.id, 'offer.accepted', `${req.user.name} accepted the ${money(o.price)} offer from ${agent.name} for ${o.buyer_names}. ${agent.name} now has access to the vault.`);
  notify([agent.id], {
    vaultId: v.id, type: 'offer_accepted', title: `🎉 Your offer on ${label} was accepted!`,
    body: `You now have access to the transaction vault. Invite your buyers, lender, and team to start exchanging documents.${note ? `\n\nNote from ${req.user.name}: ${note}` : ''}`,
    link: `#/vault/${v.id}`,
  });
  const vaultPeople = q.all("SELECT user_id FROM members WHERE vault_id = ? AND status = 'active' AND user_id != ?", v.id, agent.id).map((x) => x.user_id);
  notify(vaultPeople, { vaultId: v.id, type: 'offer_accepted', title: `Offer accepted on ${label}: ${money(o.price)}`, body: `${agent.name} (buyer's agent) has joined the vault.`, link: `#/vault/${v.id}` }, { actorId: req.user.id });
}

router.post('/offers/:id/revise', requireVerified, upload.array('files'), (req, res) => {
  const { o } = loadOfferFor(req.user, req.params.id);
  const v = loadVault(o.vault_id);
  if (o.agent_user_id !== req.user.id) fail(403, 'Only the submitting agent can revise this offer.');
  if (!['submitted', 'countered'].includes(o.status) || v.status !== 'active') fail(409, 'This offer can no longer be changed.');
  const b = req.body || {};
  const price = b.price ? intOrNull(b.price) : o.price;
  tx(() => {
    q.run(`UPDATE offers SET price = ?, closing_date = COALESCE(?, closing_date), expires_at = COALESCE(?, expires_at),
      status = 'submitted', updated_at = ? WHERE id = ?`, price, b.closingDate || null, b.expiresAt || null, now(), o.id);
    for (const file of req.files || []) createDocument({ vaultId: v.id, offerId: o.id, folder: 'Offers', visibility: 'offer', file, userId: req.user.id, name: `Revised – ${file.originalname}` });
    offerEvent(req, o, 'revised', [price !== o.price ? `New price ${money(price)}.` : '', b.note || ''].join(' ').trim());
    audit(req, v.id, 'offer.revised', `${req.user.name} revised their offer${price !== o.price ? ` to ${money(price)}` : ''}`, 'listing');
    notify(D.membersWhoCanSee(v.id, 'offer').map((x) => x.user_id), {
      vaultId: v.id, type: 'offer_revised', title: `Revised offer on ${D.vaultLabel(v.id)}: ${money(price)}`, body: b.note, link: `#/vault/${v.id}/offers/${o.id}`,
    }, { actorId: req.user.id });
  });
  res.json({ ok: true });
});

router.post('/offers/:id/withdraw', requireVerified, (req, res) => {
  const { o } = loadOfferFor(req.user, req.params.id);
  if (o.agent_user_id !== req.user.id) fail(403, 'Only the submitting agent can withdraw this offer.');
  if (!['submitted', 'countered'].includes(o.status)) fail(409, 'This offer can no longer be withdrawn.');
  q.run("UPDATE offers SET status = 'withdrawn', updated_at = ? WHERE id = ?", now(), o.id);
  offerEvent(req, o, 'withdrawn', req.body?.note);
  audit(req, o.vault_id, 'offer.withdrawn', `${req.user.name} withdrew their ${money(o.price)} offer`, 'listing');
  notify(D.membersWhoCanSee(o.vault_id, 'offer').map((x) => x.user_id), { vaultId: o.vault_id, type: 'offer_withdrawn', title: `Offer withdrawn on ${D.vaultLabel(o.vault_id)}`, body: `${req.user.name} withdrew their ${money(o.price)} offer.`, link: `#/vault/${o.vault_id}/offers/${o.id}` }, { actorId: req.user.id });
  res.json({ ok: true });
});

// ---------- Documents ----------

router.get('/vaults/:id/documents', requireVerified, (req, res) => {
  const v = loadVault(req.params.id);
  D.requireMember(v.id, req.user);
  const docs = q.all('SELECT * FROM documents WHERE vault_id = ? AND archived = 0 ORDER BY updated_at DESC', v.id)
    .filter((d) => D.canSeeDocument(req.user, d));
  res.json({ documents: docs.map((d) => docSummary(d, req.user)) });
});

router.post('/vaults/:id/documents', requireVerified, upload.array('files'), (req, res) => {
  const v = loadVault(req.params.id);
  const me = D.requireMember(v.id, req.user);
  const { folder, visibility, note } = req.body || {};
  const executed = req.body?.executed === 'true' || req.body?.executed === '1';
  if (!req.files?.length) fail(400, 'Choose at least one file.');
  const label = D.vaultLabel(v.id);
  const ids = [];
  tx(() => {
    if (req.body?.documentId) {
      // New version of an existing document.
      const doc = q.get('SELECT * FROM documents WHERE id = ? AND vault_id = ? AND archived = 0', req.body.documentId, v.id);
      if (!doc || !D.canSeeDocument(req.user, doc)) fail(404, 'Document not found.');
      voidPendingRequests(doc.id, `A new version of ${doc.name} was uploaded by ${req.user.name}.`, req.user.id);
      const version = addVersion({ id: doc.id, current_version_next: doc.current_version + 1 }, req.files[0], req.user.id, note);
      q.run('UPDATE documents SET current_version = ?, status = ?, updated_at = ? WHERE id = ?', version, executed ? 'signed' : 'uploaded', now(), doc.id);
      ids.push(doc.id);
      audit(req, v.id, executed ? 'document.executed' : 'document.new_version', `${req.user.name} uploaded ${executed ? 'the fully executed copy' : `version ${version}`} of “${doc.name}”`, doc.visibility);
      notify(D.membersWhoCanSee(v.id, doc.visibility).map((m) => m.user_id), {
        vaultId: v.id, type: executed ? 'document_signed' : 'document_updated',
        title: executed ? `✅ Fully executed: ${doc.name}` : `Updated document: ${doc.name} (v${version})`,
        body: `${req.user.name} uploaded it to ${label}.${note ? ` Note: ${note}` : ''}`, link: `#/vault/${v.id}/doc/${doc.id}`,
      }, { actorId: req.user.id });
      return;
    }
    if (!FOLDERS.includes(folder)) fail(400, 'Choose a folder.');
    if (!D.allowedVisibility(me).includes(visibility)) fail(400, 'Choose who can see this document.');
    for (const file of req.files) {
      const id = createDocument({ vaultId: v.id, folder, visibility, file, userId: req.user.id });
      if (executed) q.run("UPDATE documents SET status = 'signed' WHERE id = ?", id);
      ids.push(id);
    }
    const names = req.files.map((f) => f.originalname).join(', ');
    audit(req, v.id, 'document.uploaded', `${req.user.name} uploaded ${names} to ${folder}`, visibility);
    notify(D.membersWhoCanSee(v.id, visibility).map((m) => m.user_id), {
      vaultId: v.id, type: executed ? 'document_signed' : 'document_uploaded',
      title: `${executed ? '✅ Fully executed document' : 'New document'}${req.files.length > 1 ? 's' : ''} in ${label}`,
      body: `${req.user.name} added ${names} to ${folder}.${note ? ` Note: ${note}` : ''}`,
      link: ids.length === 1 ? `#/vault/${v.id}/doc/${ids[0]}` : `#/vault/${v.id}/documents`,
    }, { actorId: req.user.id });
  });
  res.json({ ids });
});

function loadDocFor(user, id) {
  const doc = q.get('SELECT * FROM documents WHERE id = ?', id);
  if (!doc || !D.canSeeDocument(user, doc)) fail(404, 'Document not found');
  return doc;
}

router.get('/documents/:id', requireVerified, (req, res) => {
  const doc = loadDocFor(req.user, req.params.id);
  const me = D.activeMember(doc.vault_id, req.user.id);
  const versions = q.all('SELECT v.version, v.filename, v.mime, v.size, v.sha256, v.note, v.created_at, u.name uploaded_by FROM doc_versions v LEFT JOIN users u ON u.id = v.uploaded_by WHERE document_id = ? ORDER BY version DESC', doc.id);
  const requests = q.all('SELECT r.*, u.name requested_by_name FROM signature_requests r JOIN users u ON u.id = r.requested_by WHERE document_id = ? ORDER BY created_at DESC', doc.id)
    .map((r) => ({
      id: r.id, version: r.version, status: r.status, message: r.message, dueDate: r.due_date, requestedBy: r.requested_by_name,
      createdAt: r.created_at, completedAt: r.completed_at,
      signers: q.all('SELECT s.status, s.signed_name, s.signed_at, s.decline_reason, s.user_id, u.name FROM signers s JOIN users u ON u.id = s.user_id WHERE request_id = ?', r.id)
        .map((s) => ({ name: s.name, status: s.status, signedName: s.signed_name, signedAt: s.signed_at, declineReason: s.decline_reason, isMe: s.user_id === req.user.id })),
    }));
  const access = q.all("SELECT a.action, a.created_at, u.name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.vault_id = ? AND a.action IN ('document.viewed','document.downloaded') AND a.detail LIKE ? ORDER BY a.created_at DESC LIMIT 100", doc.vault_id, `%[${doc.id}]%`);
  const signable = me ? D.membersWhoCanSee(doc.vault_id, doc.visibility).map((m) => ({ userId: m.user_id, name: m.name || m.email, role: ROLES[m.role].label })) : [];
  res.json({
    document: docSummary(doc, req.user), versions, requests, access: me && D.isManager(me) ? access : [],
    canRequestSignatures: !!me && D.canRequestSignatures(me) && doc.visibility !== 'offer', signable,
    canArchive: !!me && (doc.uploaded_by === req.user.id || me.role === 'listing_agent'), canUpload: !!me,
  });
});

router.get('/documents/:id/versions/:version/file', requireVerified, (req, res) => {
  const doc = loadDocFor(req.user, req.params.id);
  const v = q.get('SELECT * FROM doc_versions WHERE document_id = ? AND version = ?', doc.id, Number(req.params.version));
  if (!v) fail(404, 'Version not found');
  const inline = req.query.inline === '1' && (v.mime === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(v.mime));
  audit(req, doc.vault_id, inline ? 'document.viewed' : 'document.downloaded', `${req.user.name} ${inline ? 'viewed' : 'downloaded'} “${doc.name}” v${v.version} [${doc.id}]`, doc.visibility);
  res.setHeader('Content-Type', inline ? v.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(v.filename)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(storage.load(v));
});

router.delete('/documents/:id', requireVerified, (req, res) => {
  const doc = loadDocFor(req.user, req.params.id);
  const me = D.activeMember(doc.vault_id, req.user.id);
  if (!me || !(doc.uploaded_by === req.user.id || me.role === 'listing_agent')) fail(403, 'Only the uploader or listing agent can remove this document.');
  voidPendingRequests(doc.id, `${doc.name} was removed from the vault.`, req.user.id);
  q.run('UPDATE documents SET archived = 1, updated_at = ? WHERE id = ?', now(), doc.id);
  audit(req, doc.vault_id, 'document.archived', `${req.user.name} removed “${doc.name}” (kept in the audit archive)`, doc.visibility);
  res.json({ ok: true });
});

// ---------- Signatures ----------

router.post('/documents/:id/signature-requests', requireVerified, (req, res) => {
  const doc = loadDocFor(req.user, req.params.id);
  const me = D.activeMember(doc.vault_id, req.user.id);
  if (!me || !D.canRequestSignatures(me) || doc.visibility === 'offer') fail(403, 'You can’t request signatures on this document.');
  const signerIds = [...new Set(req.body?.signers || [])];
  if (!signerIds.length) fail(400, 'Choose at least one signer.');
  const eligible = new Set(D.membersWhoCanSee(doc.vault_id, doc.visibility).map((m) => m.user_id));
  if (signerIds.some((id) => !eligible.has(id))) fail(400, 'Every signer must be a vault member who can see this document.');
  const v = q.get('SELECT * FROM doc_versions WHERE document_id = ? AND version = ?', doc.id, doc.current_version);
  const id = uid();
  tx(() => {
    voidPendingRequests(doc.id, 'A new signature request replaced the previous one.', req.user.id);
    q.run(`INSERT INTO signature_requests (id, document_id, version, doc_sha256, requested_by, message, due_date, status, created_at)
      VALUES (?,?,?,?,?,?,?,'pending',?)`, id, doc.id, v.version, v.sha256, req.user.id, req.body?.message?.trim() || null, req.body?.dueDate || null, now());
    for (const s of signerIds) q.run("INSERT INTO signers (id, request_id, user_id, status) VALUES (?,?,?,'pending')", uid(), id, s);
    q.run("UPDATE documents SET status = 'awaiting_signatures', updated_at = ? WHERE id = ?", now(), doc.id);
    audit(req, doc.vault_id, 'signature.requested', `${req.user.name} requested signatures on “${doc.name}” from ${signerIds.map(userName).join(', ')}`, doc.visibility);
    notify(signerIds, {
      vaultId: doc.vault_id, type: 'signature_requested', title: `Signature requested: ${doc.name}`,
      body: `${req.user.name} needs your signature for ${D.vaultLabel(doc.vault_id)}.${req.body?.dueDate ? ` Due ${req.body.dueDate}.` : ''}${req.body?.message ? `\n\n“${req.body.message.trim()}”` : ''}`,
      link: `#/sign/${id}`,
    }, { actorId: req.user.id });
  });
  res.json({ id });
});

function loadRequestFor(user, id) {
  const r = q.get('SELECT * FROM signature_requests WHERE id = ?', id);
  if (!r) fail(404, 'Signature request not found');
  const doc = loadDocFor(user, r.document_id);
  return { r, doc };
}

router.get('/signature-requests/:id', requireVerified, (req, res) => {
  const { r, doc } = loadRequestFor(req.user, req.params.id);
  const signers = q.all('SELECT s.*, u.name FROM signers s JOIN users u ON u.id = s.user_id WHERE request_id = ?', r.id);
  const mine = signers.find((s) => s.user_id === req.user.id);
  const v = q.get('SELECT filename, mime FROM doc_versions WHERE document_id = ? AND version = ?', doc.id, r.version);
  res.json({
    request: { id: r.id, status: r.status, message: r.message, dueDate: r.due_date, version: r.version, sha256: r.doc_sha256, requestedBy: userName(r.requested_by), createdAt: r.created_at },
    document: { id: doc.id, name: doc.name, vaultId: doc.vault_id, filename: v.filename, mime: v.mime, property: D.vaultLabel(doc.vault_id) },
    signers: signers.map((s) => ({ name: s.name, status: s.status, signedAt: s.signed_at, isMe: s.user_id === req.user.id })),
    myStatus: mine?.status || null,
  });
});

router.post('/signature-requests/:id/sign', requireVerified, async (req, res) => {
  const { r, doc } = loadRequestFor(req.user, req.params.id);
  const signer = q.get('SELECT * FROM signers WHERE request_id = ? AND user_id = ?', r.id, req.user.id);
  if (!signer) fail(403, 'You are not a signer on this request.');
  if (r.status !== 'pending' || signer.status !== 'pending') fail(409, 'This request is no longer awaiting your signature.');
  const signedName = String(req.body?.signedName || '').trim();
  if (!req.body?.consent) fail(400, 'Please agree to sign electronically.');
  if (signedName.length < 2) fail(400, 'Type your full legal name to sign.');
  // Make sure the bytes being signed are exactly the bytes that were sent out for signature.
  const v = q.get('SELECT * FROM doc_versions WHERE document_id = ? AND version = ?', doc.id, r.version);
  if (v.sha256 !== r.doc_sha256) fail(409, 'The document changed after this request was sent.');

  q.run("UPDATE signers SET status = 'signed', signed_name = ?, signed_at = ?, ip = ?, user_agent = ? WHERE id = ?",
    signedName, now(), req.ip, String(req.headers['user-agent'] || '').slice(0, 300), signer.id);
  audit(req, doc.vault_id, 'signature.signed', `${req.user.name} signed “${doc.name}” v${r.version} as “${signedName}”`, doc.visibility);
  const remaining = q.get("SELECT count(*) c FROM signers WHERE request_id = ? AND status != 'signed'", r.id).c;
  const label = D.vaultLabel(doc.vault_id);

  if (remaining > 0) {
    notify([r.requested_by], { vaultId: doc.vault_id, type: 'signature_progress', title: `${req.user.name} signed ${doc.name}`, body: `${remaining} signature${remaining > 1 ? 's' : ''} still outstanding.`, link: `#/vault/${doc.vault_id}/doc/${doc.id}` }, { actorId: req.user.id, email: false });
    return res.json({ ok: true, completed: false });
  }

  // Everyone has signed: produce the executed copy with a certificate of completion.
  const signers = q.all('SELECT s.*, u.name, u.email FROM signers s JOIN users u ON u.id = s.user_id WHERE request_id = ?', r.id);
  let executedVersion = null;
  if (v.mime === 'application/pdf' || v.filename.toLowerCase().endsWith('.pdf')) {
    try {
      const stamped = await stampCertificate(storage.load(v), { document: doc.name, property: label, request: r, signers, requestedBy: userName(r.requested_by) });
      executedVersion = addVersion({ id: doc.id, current_version_next: doc.current_version + 1 },
        { buffer: stamped, originalname: v.filename.replace(/(\.pdf)?$/i, ' (executed).pdf'), mimetype: 'application/pdf' }, null, 'Fully executed copy with signature certificate');
    } catch (e) {
      console.warn('[sign] could not stamp certificate:', e.message);
    }
  }
  tx(() => {
    q.run("UPDATE signature_requests SET status = 'completed', completed_at = ? WHERE id = ?", now(), r.id);
    q.run("UPDATE documents SET status = 'signed', current_version = COALESCE(?, current_version), updated_at = ? WHERE id = ?", executedVersion, now(), doc.id);
    audit(req, doc.vault_id, 'signature.completed', `All parties signed “${doc.name}”${executedVersion ? ` — executed copy saved as v${executedVersion}` : ''}`, doc.visibility);
    notify(D.membersWhoCanSee(doc.vault_id, doc.visibility).map((m) => m.user_id), {
      vaultId: doc.vault_id, type: 'document_signed', title: `✅ Fully signed: ${doc.name}`,
      body: `All ${signers.length} signer${signers.length > 1 ? 's' : ''} signed (${signers.map((s) => s.name).join(', ')}) for ${label}.`,
      link: `#/vault/${doc.vault_id}/doc/${doc.id}`,
    });
  });
  res.json({ ok: true, completed: true });
});

router.post('/signature-requests/:id/decline', requireVerified, (req, res) => {
  const { r, doc } = loadRequestFor(req.user, req.params.id);
  const signer = q.get("SELECT * FROM signers WHERE request_id = ? AND user_id = ? AND status = 'pending'", r.id, req.user.id);
  if (!signer || r.status !== 'pending') fail(409, 'This request is no longer awaiting your signature.');
  const reason = String(req.body?.reason || '').trim() || null;
  tx(() => {
    q.run("UPDATE signers SET status = 'declined', decline_reason = ?, signed_at = ? WHERE id = ?", reason, now(), signer.id);
    q.run("UPDATE signature_requests SET status = 'declined' WHERE id = ?", r.id);
    q.run("UPDATE documents SET status = 'uploaded', updated_at = ? WHERE id = ?", now(), doc.id);
    audit(req, doc.vault_id, 'signature.declined', `${req.user.name} declined to sign “${doc.name}”${reason ? `: ${reason}` : ''}`, doc.visibility);
    const team = D.membersWhoCanSee(doc.vault_id, doc.visibility).filter((m) => D.isManager(m)).map((m) => m.user_id);
    notify([r.requested_by, ...team], { vaultId: doc.vault_id, type: 'signature_declined', title: `${req.user.name} declined to sign ${doc.name}`, body: reason, link: `#/vault/${doc.vault_id}/doc/${doc.id}` }, { actorId: req.user.id });
  });
  res.json({ ok: true });
});

router.post('/signature-requests/:id/cancel', requireVerified, (req, res) => {
  const { r, doc } = loadRequestFor(req.user, req.params.id);
  const me = D.activeMember(doc.vault_id, req.user.id);
  if (r.status !== 'pending' || !(r.requested_by === req.user.id || me?.role === 'listing_agent')) fail(403, 'You can’t cancel this request.');
  tx(() => {
    voidPendingRequests(doc.id, `${req.user.name} cancelled the signature request.`, req.user.id);
    q.run("UPDATE signature_requests SET status = 'cancelled' WHERE id = ?", r.id);
    q.run("UPDATE documents SET status = 'uploaded', updated_at = ? WHERE id = ?", now(), doc.id);
    audit(req, doc.vault_id, 'signature.cancelled', `${req.user.name} cancelled the signature request on “${doc.name}”`, doc.visibility);
  });
  res.json({ ok: true });
});

// ---------- Notifications ----------

router.get('/notifications', requireUser, (req, res) => {
  const items = q.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', req.user.id);
  res.json({ notifications: items, unread: q.get('SELECT count(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL', req.user.id).c });
});

router.post('/notifications/read', requireUser, (req, res) => {
  if (req.body?.all) q.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', now(), req.user.id);
  else for (const id of req.body?.ids || []) q.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', now(), id, req.user.id);
  res.json({ ok: true });
});

router.get('/events', requireUser, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('event: ready\ndata: {}\n\n');
  const off = D.addStream(req.user.id, res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); off(); });
});

// Local development only: read the emails the app would have sent.
router.get('/dev/outbox', (req, res) => {
  if (!mail.devMailbox) fail(404, 'Not found');
  res.json({ emails: q.all('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 100') });
});

module.exports = router;
