// End-to-end walkthrough of a full transaction against a throwaway server instance.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'closingvault-test-'));
const stamp = Date.now();

let server;
test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, SMTP_URL: '', APP_URL: BASE }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/auth/me`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
test.after(() => { server.kill(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  async function call(method, url, body) {
    const headers = { 'X-Requested-With': 'ClosingVault' };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(BASE + '/api' + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data };
  }
  return { call, get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}) };
}

async function makePdf(text) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  page.drawText(text, { x: 50, y: 700, size: 14, font: await pdf.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await pdf.save());
}
const form = (fields, files = []) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) fd.append(k, x);
  for (const [name, buf] of files) fd.append('files', new Blob([buf], { type: 'application/pdf' }), name);
  return fd;
};

const outbox = async () => (await client().get('/dev/outbox')).data.emails;
async function linkFor(email, kind) {
  const mail = (await outbox()).find((m) => m.to_email === email && m.body.includes(`#/${kind}/`));
  assert.ok(mail, `expected a ${kind} email for ${email}`);
  return mail.body.match(new RegExp(`#/${kind}/([A-Za-z0-9_-]+)`))[1];
}
async function account(name) {
  const c = client();
  const email = `${name.toLowerCase().replace(/\W/g, '')}.${stamp}@example.com`;
  const r = await c.post('/auth/register', { name, email, password: 'correct-horse-battery' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await c.post('/auth/verify', { token: await linkFor(email, 'verify') });
  c.email = email; c.id = r.data.user.id; c.name = name;
  return c;
}
const notes = async (c) => (await c.get('/notifications')).data.notifications;

test('full transaction lifecycle', async () => {
  // Listing agent sets up the vault.
  const la = await account('Lisa Listing');
  const v = await la.post('/vaults', { address: '42 Harbor Lane', city: 'Austin', state: 'TX', listPrice: '$650,000' });
  assert.equal(v.status, 200);
  const vaultId = v.data.id;

  // Seller is invited and joins through the invitation link.
  const sellerEmail = `seller.${stamp}@example.com`;
  assert.equal((await la.post(`/vaults/${vaultId}/members`, { email: sellerEmail, name: 'Sam Seller', role: 'seller' })).status, 200);
  const seller = client();
  const reg = await seller.post('/auth/register', { name: 'Sam Seller', email: sellerEmail, password: 'correct-horse-battery', inviteToken: await linkFor(sellerEmail, 'invite') });
  assert.equal(reg.data.user.emailVerified, true);
  assert.equal((await seller.get(`/vaults/${vaultId}`)).data.me.role, 'seller');

  // Documents: one for everyone, one for the listing side only.
  const disclosure = await la.post(`/vaults/${vaultId}/documents`, form({ folder: 'Disclosures', visibility: 'all' }, [['sellers-disclosure.pdf', await makePdf('SECRET-DISCLOSURE-MARKER')]]));
  assert.equal(disclosure.status, 200, JSON.stringify(disclosure.data));
  await la.post(`/vaults/${vaultId}/documents`, form({ folder: 'Listing', visibility: 'listing' }, [['net-sheet.pdf', await makePdf('seller net sheet')]]));

  // Files on disk are encrypted.
  const fileDir = path.join(DATA_DIR, 'files');
  const raw = fs.readdirSync(fileDir).map((f) => fs.readFileSync(path.join(fileDir, f)).toString('latin1'));
  assert.ok(!raw.some((r) => r.includes('SECRET-DISCLOSURE-MARKER') || r.startsWith('%PDF')), 'files must be encrypted at rest');

  // Two buyer's agents submit offers through the offer link.
  const offerToken = (await la.get(`/vaults/${vaultId}`)).data.vault.offerLink.split('/offer/')[1];
  const agentA = await account('Alex Buyeragent');
  const agentB = await account('Blair Otheragent');
  const offerA = await agentA.post(`/offer-link/${offerToken}/offers`, form({ buyerNames: 'Jordan Rivera', price: '640,000', financing: 'Conventional', contingencies: ['Inspection', 'Appraisal'] }, [['offer-A.pdf', await makePdf('Offer A')]]));
  assert.equal(offerA.status, 200, JSON.stringify(offerA.data));
  const offerB = await agentB.post(`/offer-link/${offerToken}/offers`, form({ buyerNames: 'Pat Lee', price: '630000', financing: 'Cash' }, [['offer-B.pdf', await makePdf('Offer B')]]));
  assert.equal(offerB.status, 200);

  // Listing side is notified; offer contingencies were captured as a list.
  assert.equal((await notes(la)).filter((n) => n.type === 'offer_received').length, 2);
  assert.ok((await notes(seller)).some((n) => n.type === 'offer_received'));
  const offers = (await la.get(`/vaults/${vaultId}/offers`)).data.offers;
  assert.equal(offers.find((o) => o.id === offerA.data.id).contingencies, 'Inspection, Appraisal');

  // Competing agents cannot see the vault or each other's offers.
  assert.equal((await agentB.get(`/vaults/${vaultId}`)).status, 404);
  assert.equal((await agentB.get(`/offers/${offerA.data.id}`)).status, 404);
  const offerADoc = (await agentA.get(`/offers/${offerA.data.id}`)).data.offer.documents[0];
  assert.equal((await agentB.get(`/documents/${offerADoc.id}/versions/1/file`)).status, 404);

  // Counter, revise, accept.
  assert.equal((await la.post(`/offers/${offerA.data.id}/respond`, { action: 'counter', note: 'Counter at $655,000' })).status, 200);
  assert.ok((await notes(agentA)).some((n) => n.type === 'offer_countered'));
  assert.equal((await agentA.post(`/offers/${offerA.data.id}/revise`, form({ price: '655000', note: 'Accepting counter' }))).status, 200);
  assert.equal((await la.post(`/offers/${offerA.data.id}/respond`, { action: 'accept' })).status, 200);

  assert.ok((await notes(agentA)).some((n) => n.type === 'offer_accepted'));
  assert.ok((await notes(agentB)).some((n) => n.type === 'offer_not_selected'));
  const vaultForA = await agentA.get(`/vaults/${vaultId}`);
  assert.equal(vaultForA.data.vault.status, 'under_contract');
  assert.equal(vaultForA.data.me.role, 'buyer_agent');
  assert.equal(vaultForA.data.vault.offerLink, null);

  // Buyer side sees shared docs + the purchase agreement, never listing-only docs.
  const docsA = (await agentA.get(`/vaults/${vaultId}/documents`)).data.documents;
  assert.deepEqual(docsA.map((d) => d.name).sort(), ['offer-A.pdf', 'sellers-disclosure.pdf']);
  assert.ok(docsA.every((d) => d.visibility === 'all'));

  // Buyer's agent brings in their client.
  const buyerEmail = `buyer.${stamp}@example.com`;
  assert.equal((await agentA.post(`/vaults/${vaultId}/members`, { email: buyerEmail, name: 'Jordan Rivera', role: 'buyer' })).status, 200);
  assert.equal((await agentA.post(`/vaults/${vaultId}/members`, { email: 'x@example.com', role: 'seller' })).status, 403, 'buyer side cannot invite sellers');
  const buyer = client();
  await buyer.post('/auth/register', { name: 'Jordan Rivera', email: buyerEmail, password: 'correct-horse-battery', inviteToken: await linkFor(buyerEmail, 'invite') });

  // Buyer-side private document is invisible to the listing side.
  await agentA.post(`/vaults/${vaultId}/documents`, form({ folder: 'Financing', visibility: 'buyer' }, [['preapproval.pdf', await makePdf('preapproval')]]));
  assert.ok(!(await la.get(`/vaults/${vaultId}/documents`)).data.documents.some((d) => d.name === 'preapproval.pdf'));

  // Signatures on the purchase agreement.
  const contract = docsA.find((d) => d.name === 'offer-A.pdf');
  const sellerId = (await seller.get('/auth/me')).data.user.id;
  const buyerId = (await buyer.get('/auth/me')).data.user.id;
  const sr = await la.post(`/documents/${contract.id}/signature-requests`, { signers: [sellerId, buyerId], message: 'Please sign' });
  assert.equal(sr.status, 200, JSON.stringify(sr.data));
  assert.ok((await notes(buyer)).some((n) => n.type === 'signature_requested'));
  assert.equal((await agentB.post(`/signature-requests/${sr.data.id}/sign`, { signedName: 'x', consent: true })).status, 404);
  assert.equal((await buyer.post(`/signature-requests/${sr.data.id}/sign`, { signedName: 'Jordan Rivera', consent: true })).data.completed, false);
  assert.equal((await seller.post(`/signature-requests/${sr.data.id}/sign`, { signedName: 'Sam Seller', consent: true })).data.completed, true);

  for (const c of [la, agentA, buyer]) assert.ok((await notes(c)).some((n) => n.type === 'document_signed'), 'everyone hears it is fully signed');
  const signed = (await la.get(`/documents/${contract.id}`)).data;
  assert.equal(signed.document.status, 'signed');
  assert.equal(signed.document.version, 2);
  const executed = await la.get(`/documents/${contract.id}/versions/2/file`);
  assert.equal((await PDFDocument.load(executed.data)).getPageCount(), 2, 'certificate page appended');

  // Audit trail and CSRF guard.
  const activity = (await la.get(`/vaults/${vaultId}/activity`)).data.activity.map((a) => a.action);
  for (const a of ['offer.accepted', 'signature.completed', 'document.downloaded']) assert.ok(activity.includes(a), a);
  const csrf = await fetch(`${BASE}/api/vaults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(csrf.status, 403);
});
