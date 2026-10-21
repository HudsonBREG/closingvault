/* ClosingVault front end: a small hash-routed single-page app with no build step. */
'use strict';

// ---------- Utilities ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v == null || v === false ? '' : esc(v));
// Tagged template that escapes every interpolation unless it is already-built markup.
const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? fmt(vals[i]) : ''), ''));

const money = (n) => (n == null || n === '' ? '—' : `$${Number(n).toLocaleString('en-US')}`);
const date = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const dateTime = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const plainDate = (d) => (d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
function ago(d) {
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return date(d);
}
const size = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

async function api(method, url, body) {
  const opts = { method, headers: { 'X-Requested-With': 'ClosingVault' }, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(`/api${url}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(title, kind = '', body = '', onClick) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = html`<div>${title}</div>${body ? html`<div class="b">${body}</div>` : ''}`.s;
  el.onclick = () => { el.remove(); onClick?.(); };
  $('#toasts').append(el);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => el.remove(), kind === 'live' ? 9000 : 4500);
}

// ---------- Domain labels ----------

const STATUS = {
  active: ['Active listing', 'blue'], under_contract: ['Under contract', 'amber'], closed: ['Closed', 'green'], withdrawn: ['Withdrawn', ''],
};
const OFFER_STATUS = {
  submitted: ['New / under review', 'blue'], countered: ['Countered', 'purple'], accepted: ['Accepted', 'green'], rejected: ['Declined', 'red'],
  withdrawn: ['Withdrawn', ''], not_selected: ['Not selected', ''], terminated: ['Contract released', 'red'],
};
const VIS = { all: ['Everyone in vault', ''], listing: ['Listing side only', 'navy'], buyer: ['Buyer side only', 'navy'], offer: ['Private offer', 'purple'] };
const SIDES = { listing: 'Listing side', buyer: 'Buyer side', neutral: 'Title, escrow & other parties' };
const pill = ([label, color]) => html`<span class="pill ${color}">${label}</span>`;

function docStatusPill(d) {
  if (d.signature?.awaitingMe) return html`<span class="pill red">✍️ Needs your signature</span>`;
  if (d.status === 'signed') return html`<span class="pill green">✓ Signed</span>`;
  if (d.signature?.status === 'pending') return html`<span class="pill amber">Signatures ${d.signature.signed}/${d.signature.total}</span>`;
  if (d.signature?.status === 'declined') return html`<span class="pill red">Signature declined</span>`;
  return '';
}
function fileIcon(file) {
  const name = file?.filename || '';
  const ext = (name.split('.').pop() || '').toUpperCase().slice(0, 4);
  const cls = ext === 'PDF' ? 'pdf' : /PNG|JPG|JPEG|GIF|WEBP|HEIC/.test(ext) ? 'img' : '';
  return html`<div class="file-icon ${cls}">${ext || 'FILE'}</div>`;
}

// ---------- App state ----------

const state = { me: null, meta: null, devMailbox: false, notifications: [], unread: 0, events: null };

function setReturn(hash) { try { sessionStorage.setItem('cv_return', hash); } catch { /* storage unavailable */ } }
function takeReturn() {
  try { const h = sessionStorage.getItem('cv_return'); sessionStorage.removeItem('cv_return'); return h; } catch { return null; }
}

function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

async function refreshMe() {
  const r = await api('GET', '/auth/me');
  state.me = r.user;
  state.devMailbox = r.devMailbox;
  renderChrome();
  if (state.me) { connectEvents(); loadNotifications(); } else disconnectEvents();
}

function renderChrome() {
  const bar = $('#topbar');
  bar.hidden = !state.me;
  if (!state.me) return;
  $('#user-btn').textContent = initials(state.me.name);
  $('#user-menu').innerHTML = html`
    <div class="who"><b>${state.me.name}</b><div class="muted small">${state.me.email}</div></div>
    <a href="#/">Dashboard</a>
    <a href="#/new">New listing vault</a>
    <a href="#/profile">Profile</a>
    ${state.devMailbox ? html`<a href="#/mailbox">Dev mailbox</a>` : ''}
    <button id="logout">Sign out</button>`.s;
  $('#logout').onclick = async () => { await api('POST', '/auth/logout'); state.me = null; renderChrome(); disconnectEvents(); go('#/login'); };
}

// ---------- Notifications ----------

async function loadNotifications() {
  const r = await api('GET', '/notifications');
  state.notifications = r.notifications;
  state.unread = r.unread;
  renderBell();
}

function renderBell() {
  const c = $('#bell-count');
  c.hidden = !state.unread;
  c.textContent = state.unread > 99 ? '99+' : state.unread;
  const items = state.notifications.slice(0, 30);
  $('#notif-panel').innerHTML = html`
    <div class="notif-head"><span>Notifications</span>${state.unread ? html`<button class="btn link small" id="mark-all">Mark all read</button>` : ''}</div>
    ${items.length ? items.map((n) => html`
      <a class="notif ${n.read_at ? '' : 'unread'}" href="${n.link || '#/'}" data-id="${n.id}">
        <div class="t">${n.title}</div>${n.body ? html`<div class="b">${n.body.length > 180 ? `${n.body.slice(0, 180)}…` : n.body}</div>` : ''}
        <div class="d">${ago(n.created_at)}</div>
      </a>`) : html`<div class="empty small">You're all caught up.</div>`}`.s;
  $$('#notif-panel .notif').forEach((a) => a.addEventListener('click', () => { markRead([a.dataset.id]); $('#notif-panel').hidden = true; }));
  $('#mark-all')?.addEventListener('click', async () => {
    await api('POST', '/notifications/read', { all: true });
    state.notifications.forEach((n) => { n.read_at = n.read_at || new Date().toISOString(); });
    state.unread = 0; renderBell();
  });
}

async function markRead(ids) {
  const fresh = state.notifications.filter((n) => ids.includes(n.id) && !n.read_at);
  if (!fresh.length) return;
  fresh.forEach((n) => { n.read_at = new Date().toISOString(); });
  state.unread = Math.max(0, state.unread - fresh.length);
  renderBell();
  await api('POST', '/notifications/read', { ids });
}

function connectEvents() {
  if (state.events) return;
  const es = new EventSource('/api/events');
  es.addEventListener('notification', (e) => {
    const n = JSON.parse(e.data);
    state.notifications.unshift(n);
    state.unread += 1;
    renderBell();
    toast(n.title, 'live', n.body ? n.body.slice(0, 140) : '', () => { markRead([n.id]); if (n.link) go(n.link); });
    // Keep whatever the user is looking at current, unless they are mid-form.
    if (!$('#modal-root').children.length && (!n.vault_id || location.hash.includes(n.vault_id) || location.hash === '#/' || location.hash === '')) route(true);
  });
  state.events = es;
}
function disconnectEvents() { state.events?.close(); state.events = null; }

document.addEventListener('click', (e) => {
  const bell = e.target.closest('#bell');
  const userBtn = e.target.closest('#user-btn');
  if (bell) { $('#notif-panel').hidden = !$('#notif-panel').hidden; $('#user-menu').hidden = true; return; }
  if (userBtn) { $('#user-menu').hidden = !$('#user-menu').hidden; $('#notif-panel').hidden = true; return; }
  if (!e.target.closest('.dropdown')) { $('#notif-panel').hidden = true; $('#user-menu').hidden = true; }
});

// ---------- Modal + forms ----------

function modal({ title, body, submitLabel = 'Save', submitClass = 'primary', wide = false, onSubmit, onOpen }) {
  const root = $('#modal-root');
  root.innerHTML = html`
    <div class="modal-backdrop">
      <form class="modal ${wide ? 'wide' : ''}" novalidate>
        <div class="modal-head"><h2>${title}</h2><button type="button" class="x" data-close aria-label="Close">×</button></div>
        <div class="modal-body"><div class="error" hidden></div>${body}</div>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button>${onSubmit ? html`<button class="btn ${submitClass}" type="submit">${submitLabel}</button>` : ''}</div>
      </form>
    </div>`.s;
  const form = $('form', root);
  const close = () => { root.innerHTML = ''; };
  $$('[data-close]', root).forEach((b) => { b.onclick = close; });
  $('.modal-backdrop', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    const err = $('.error', form);
    err.hidden = true;
    btn.disabled = true;
    try {
      await onSubmit(form, close);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
    } finally { btn.disabled = false; }
  };
  onOpen?.(form);
  $('input:not([type=hidden]), select, textarea', form)?.focus();
  return { form, close };
}

function confirmModal(title, message, label, cls, action) {
  modal({ title, body: html`<p>${message}</p>`, submitLabel: label, submitClass: cls, onSubmit: async (f, close) => { await action(); close(); } });
}

// Wire a dropzone (click + drag-and-drop) to a hidden file input.
function dropzone(root, { multiple = true } = {}) {
  const zone = $('.dropzone', root);
  const input = $('input[type=file]', root);
  const list = $('.file-list', root);
  let files = [];
  const show = () => { list.innerHTML = files.map((f) => html`<div>📄 ${f.name} <span class="muted">(${size(f.size)})</span></div>`.s).join(''); };
  zone.onclick = () => input.click();
  input.onchange = () => { files = multiple ? [...files, ...input.files] : [...input.files].slice(0, 1); show(); input.value = ''; };
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); files = multiple ? [...files, ...e.dataTransfer.files] : [e.dataTransfer.files[0]]; show(); };
  return () => files;
}
const dropzoneHtml = (label = 'Drop files here or click to browse', multiple = true) => html`
  <div class="field"><div class="dropzone">${label}<div class="small">PDF, Word, Excel, images · up to 50 MB each</div></div>
  <input type="file" hidden ${multiple ? 'multiple' : ''}><div class="file-list"></div></div>`;

// ---------- Router ----------

const app = $('#app');
const view = (markup) => { app.innerHTML = fmt(markup); };
const loading = () => { app.innerHTML = '<div class="spinner"></div>'; };

const routes = [
  [/^#\/login$/, viewLogin, { public: true }],
  [/^#\/register$/, viewRegister, { public: true }],
  [/^#\/forgot$/, viewForgot, { public: true }],
  [/^#\/reset\/(.+)$/, viewReset, { public: true }],
  [/^#\/verify\/(.+)$/, viewVerify, { public: true }],
  [/^#\/invite\/(.+)$/, viewInvite, { public: true }],
  [/^#\/mailbox$/, viewMailbox, { public: true }],
  [/^#\/new$/, viewNewVault],
  [/^#\/profile$/, viewProfile],
  [/^#\/offer\/(.+)$/, viewSubmitOffer],
  [/^#\/offer-status\/(.+)$/, viewOfferStatus],
  [/^#\/sign\/(.+)$/, viewSign],
  [/^#\/vault\/([^/]+)\/doc\/([^/]+)$/, viewDocument],
  [/^#\/vault\/([^/]+)\/offers\/([^/]+)$/, viewOfferDetail],
  [/^#\/vault\/([^/]+)(?:\/(\w+))?$/, viewVault],
  [/^(?:#\/?)?$/, viewDashboard],
];

let routing = 0;
async function route(quiet = false) {
  const hash = location.hash || '#/';
  const match = routes.find(([re]) => re.test(hash));
  if (!match) return go('#/');
  const [re, fn, opts = {}] = match;
  if (!opts.public && !state.me) { setReturn(hash); return go('#/login'); }
  if (!opts.public) leaveAuthLayout();
  const ticket = ++routing;
  if (!quiet) { loading(); window.scrollTo(0, 0); }
  try {
    await fn(...hash.match(re).slice(1), ticket);
  } catch (e) {
    if (ticket !== routing) return;
    if (e.status === 401) { setReturn(hash); await refreshMe(); return go('#/login'); }
    view(html`<div class="card empty"><div class="big">🔒</div><h2>${e.status === 403 ? 'Not available' : e.status === 404 ? 'Not found' : 'Something went wrong'}</h2><p>${e.message}</p><a class="btn" href="#/">Back to dashboard</a></div>`);
  }
}
window.addEventListener('hashchange', () => route());
const stale = (ticket) => ticket !== routing;

// ---------- Auth views ----------

function authLayout(inner) {
  $('#topbar').hidden = true;
  app.classList.remove('container');
  view(html`
    <div class="auth-wrap">
      <section class="auth-hero">
        <h1>Every document for every deal, in one secure vault.</h1>
        <p>Stop emailing contracts back and forth. Listing agents open a vault, buyer's agents submit offers into it, and once an offer is accepted both teams share documents and collect signatures in one place.</p>
        <ul>
          <li>Offers arrive privately and notify the listing team instantly</li>
          <li>Accepting an offer opens the vault to the buyer's agent automatically</li>
          <li>Side-only folders keep each team's documents private</li>
          <li>Built-in e-signatures with alerts the moment everyone has signed</li>
          <li>Files are encrypted at rest, and every view and download is logged</li>
        </ul>
      </section>
      <section class="auth-form"><div class="card">
        <div class="auth-brand"><span class="logo"></span>ClosingVault</div>
        ${inner}
        ${state.devMailbox ? html`<p class="small muted" style="margin-top:22px">Running locally without email? Open the <a href="#/mailbox">dev mailbox</a>.</p>` : ''}
      </div></section>
    </div>`);
}
function leaveAuthLayout() { app.classList.add('container'); renderChrome(); }

function bindAuthForm(handler) {
  const form = $('#auth-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('.error', form);
    err.hidden = true;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try { await handler(Object.fromEntries(new FormData(form))); } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; }
  };
}

async function afterSignIn() {
  await refreshMe();
  leaveAuthLayout();
  go(takeReturn() || '#/');
}

function viewLogin() {
  if (state.me) return go('#/');
  authLayout(html`
    <h2>Sign in</h2><p class="muted">Welcome back.</p>
    <form id="auth-form"><div class="error" hidden></div>
      <div class="field"><label>Email</label><input type="email" name="email" autocomplete="username" required></div>
      <div class="field"><label>Password</label><input type="password" name="password" autocomplete="current-password" required></div>
      <button class="btn primary" style="width:100%;justify-content:center" type="submit">Sign in</button>
    </form>
    <p class="small" style="margin-top:16px"><a href="#/forgot">Forgot password?</a> · New here? <a href="#/register">Create an account</a></p>`);
  bindAuthForm(async (d) => { await api('POST', '/auth/login', d); await afterSignIn(); });
}

function registerForm(prefill = {}) {
  return html`
    <form id="auth-form"><div class="error" hidden></div>
      <div class="field"><label>Full name</label><input type="text" name="name" autocomplete="name" required></div>
      <div class="field"><label>Email</label><input type="email" name="email" autocomplete="username" value="${prefill.email || ''}" ${prefill.email ? 'readonly' : ''} required></div>
      <div class="form-grid">
        <div class="field"><label>Mobile</label><input type="tel" name="phone" autocomplete="tel"></div>
        <div class="field"><label>Brokerage / company</label><input type="text" name="brokerage" autocomplete="organization"></div>
      </div>
      <div class="field"><label>Password</label><input type="password" name="password" autocomplete="new-password" minlength="10" required><div class="hint">At least 10 characters.</div></div>
      <button class="btn primary" style="width:100%;justify-content:center" type="submit">Create account</button>
    </form>`;
}

function viewRegister() {
  if (state.me) return go('#/');
  authLayout(html`<h2>Create your account</h2><p class="muted">For agents, clients, lenders, title, and everyone else on the deal.</p>
    ${registerForm()}<p class="small" style="margin-top:16px">Already have an account? <a href="#/login">Sign in</a></p>`);
  bindAuthForm(async (d) => { await api('POST', '/auth/register', d); await afterSignIn(); });
}

function viewForgot() {
  authLayout(html`<h2>Reset your password</h2><p class="muted">We'll email you a link to reset it.</p>
    <form id="auth-form"><div class="error" hidden></div>
      <div class="field"><label>Email</label><input type="email" name="email" required></div>
      <button class="btn primary" type="submit">Send reset link</button></form>
    <p class="small" style="margin-top:16px"><a href="#/login">Back to sign in</a></p>`);
  bindAuthForm(async (d) => {
    await api('POST', '/auth/forgot', d);
    $('#auth-form').outerHTML = html`<div class="banner green">If that email has an account, a reset link is on its way.</div>`.s;
  });
}

function viewReset(token) {
  authLayout(html`<h2>Choose a new password</h2>
    <form id="auth-form"><div class="error" hidden></div>
      <div class="field"><label>New password</label><input type="password" name="password" minlength="10" autocomplete="new-password" required></div>
      <button class="btn primary" type="submit">Update password</button></form>`);
  bindAuthForm(async (d) => {
    await api('POST', '/auth/reset', { token, password: d.password });
    toast('Password updated. Please sign in.', 'ok');
    go('#/login');
  });
}

async function viewVerify(token) {
  try {
    await api('POST', '/auth/verify', { token });
    await refreshMe();
    toast('Email verified. Welcome to ClosingVault!', 'ok');
    if (state.me) { leaveAuthLayout(); go(takeReturn() || '#/'); } else go('#/login');
  } catch (e) {
    authLayout(html`<h2>Verification link expired</h2><p class="muted">${e.message}</p><a class="btn primary" href="#/">Continue</a>`);
  }
}

async function viewInvite(token) {
  const inv = await api('GET', `/auth/invites/${token}`).catch((e) => ({ error: e.message }));
  if (inv.error) {
    authLayout(html`<h2>Invitation unavailable</h2><p class="muted">${inv.error}</p><a class="btn primary" href="#/">Go to dashboard</a>`);
    return;
  }
  const intro = html`<div class="banner blue"><div class="grow"><b>${inv.invitedBy?.name || 'An agent'}</b>${inv.invitedBy?.brokerage ? ` (${inv.invitedBy.brokerage})` : ''} invited you to the transaction vault for <b>${inv.property}</b> as <b>${inv.role}</b>.</div></div>`;
  if (state.me) {
    leaveAuthLayout();
    view(html`<div class="card" style="max-width:560px;margin:40px auto">${intro}
      <p>You're signed in as <b>${state.me.email}</b>.</p><div class="error" hidden></div>
      <button class="btn primary" id="accept">Accept invitation</button></div>`);
    $('#accept').onclick = async () => {
      try { const r = await api('POST', `/auth/invites/${token}/accept`); await refreshMe(); go(`#/vault/${r.vaultId}`); } catch (e) { $('.error').textContent = e.message; $('.error').hidden = false; }
    };
    return;
  }
  setReturn(`#/invite/${token}`);
  if (inv.accountExists) {
    authLayout(html`${intro}<p>Sign in as <b>${inv.email}</b> to accept.</p><a class="btn primary" href="#/login">Sign in</a>`);
  } else {
    authLayout(html`${intro}<h2>Create your account</h2>${registerForm({ email: inv.email })}`);
    bindAuthForm(async (d) => {
      await api('POST', '/auth/register', { ...d, inviteToken: token });
      takeReturn();
      await refreshMe();
      leaveAuthLayout();
      go('#/');
    });
  }
}

async function viewMailbox() {
  const { emails } = await api('GET', '/dev/outbox');
  if (state.me) leaveAuthLayout(); else { app.classList.add('container'); }
  const linkify = (t) => esc(t).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
  view(html`
    <div class="section-head"><div><h1>Dev mailbox</h1><p class="muted">No SMTP server is configured, so emails are captured here instead of being sent. Set <code>SMTP_URL</code> to deliver real email.</p></div>
    ${state.me ? '' : html`<a class="btn" href="#/login">Sign in</a>`}</div>
    ${emails.length ? emails.map((m) => html`<div class="card"><div class="row between"><b>${m.subject}</b><span class="muted small">${dateTime(m.created_at)}</span></div>
      <div class="muted small" style="margin-bottom:8px">To: ${m.to_email}</div><div class="mail">${new Raw(linkify(m.body))}</div></div>`) : html`<div class="card empty">No emails yet.</div>`}`);
}

// ---------- Dashboard ----------

function verifyBanner() {
  return html`<div class="banner amber"><div class="grow"><b>Verify your email to get started.</b> We sent a link to ${state.me.email}. Vault access, offers, and signatures unlock once it's confirmed.</div>
    <button class="btn sm" id="resend">Resend link</button></div>`;
}
function bindVerifyBanner() {
  const b = $('#resend');
  if (b) b.onclick = async () => { await api('POST', '/auth/resend-verification'); toast('Verification email sent.', 'ok'); };
}

async function viewDashboard(ticket) {
  if (!state.me.emailVerified) {
    view(html`<h1>Welcome, ${state.me.name.split(' ')[0]}</h1>${verifyBanner()}`);
    bindVerifyBanner();
    return;
  }
  const d = await api('GET', '/dashboard');
  if (stale(ticket)) return;
  const isListingAgent = (v) => v.role === 'listing_agent' || v.role === 'listing_team';
  const listing = d.vaults.filter(isListingAgent);
  const other = d.vaults.filter((v) => !isListingAgent(v));
  const card = (v) => html`
    <a class="card vault-card" href="#/vault/${v.id}">
      <div class="row between"><span>${pill(STATUS[v.status])}</span>${v.newOffers ? html`<span class="pill red">${v.newOffers} new offer${v.newOffers > 1 ? 's' : ''}</span>` : ''}</div>
      <div class="addr" style="margin-top:10px">${v.address}</div>
      <div class="muted small">${[v.city, v.state, v.zip].filter(Boolean).join(', ')}</div>
      <div class="row" style="margin-top:8px"><span class="price">${money(v.listPrice)}</span><span class="muted small">· You: ${v.roleLabel}</span></div>
      <div class="stats"><span>👥 ${v.members} people</span><span>📄 ${v.documents} documents</span></div>
    </a>`;
  view(html`
    <div class="section-head"><div><h1>Welcome back, ${state.me.name.split(' ')[0]}</h1><p class="muted">Here's everything that needs your attention.</p></div>
      <a class="btn primary" href="#/new">+ New listing vault</a></div>

    ${d.signatures.length ? html`<div class="section"><h2>✍️ Waiting for your signature</h2><div class="list">
      ${d.signatures.map((s) => html`<a class="list-row" href="#/sign/${s.id}"><div class="grow"><div class="name">${s.name}</div><div class="muted small">${s.address} · requested ${ago(s.created_at)}${s.due_date ? ` · due ${plainDate(s.due_date)}` : ''}</div></div><span class="btn sm gold">Review & sign</span></a>`)}
    </div></div>` : ''}

    <div class="section"><h2>Your listings</h2>
      ${listing.length ? html`<div class="grid cols-3">${listing.map(card)}</div>` : other.length ? html`<p class="muted">Listing agents: create a vault for each listing with <a href="#/new">New listing vault</a>.</p>` : html`<div class="card empty"><div class="big">🏡</div><p>Create a vault for each new listing. You'll get a private link to share with buyer's agents so they can submit offers straight into it.</p><a class="btn primary" href="#/new">Create your first listing vault</a></div>`}
    </div>

    ${other.length ? html`<div class="section"><h2>Transactions you're part of</h2><div class="grid cols-3">${other.map(card)}</div></div>` : ''}

    ${d.offers.length ? html`<div class="section"><h2>Offers you've submitted</h2><div class="table-wrap"><table class="data">
      <thead><tr><th>Property</th><th>Buyers</th><th>Price</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${d.offers.map((o) => html`<tr class="clickable" data-href="#/offer-status/${o.id}"><td><b>${o.address}</b><div class="muted small">${o.city || ''}</div></td><td>${o.buyerNames}</td><td class="price">${money(o.price)}</td><td>${pill(OFFER_STATUS[o.status])}</td><td class="muted">${ago(o.updatedAt)}</td></tr>`)}</tbody>
    </table></div></div>` : ''}`);
  $$('tr[data-href]').forEach((tr) => { tr.onclick = () => go(tr.dataset.href); });
}

function viewProfile() {
  const u = state.me;
  view(html`<div class="card" style="max-width:560px"><h1>Your profile</h1>
    <form id="auth-form"><div class="error" hidden></div>
      <div class="field"><label>Full name</label><input type="text" name="name" value="${u.name}" required></div>
      <div class="field"><label>Email</label><input type="email" value="${u.email}" disabled></div>
      <div class="field"><label>Mobile</label><input type="tel" name="phone" value="${u.phone || ''}"></div>
      <div class="field"><label>Brokerage / company</label><input type="text" name="brokerage" value="${u.brokerage || ''}"></div>
      <button class="btn primary" type="submit">Save</button></form></div>`);
  bindAuthForm(async (d) => { await api('PATCH', '/auth/me', d); await refreshMe(); toast('Profile saved.', 'ok'); });
}

// ---------- New vault ----------

function viewNewVault() {
  if (!state.me.emailVerified) { view(verifyBanner()); bindVerifyBanner(); return; }
  view(html`<div class="card" style="max-width:720px">
    <h1>New listing vault</h1><p class="muted">You'll be the listing agent. After creating it you can invite your sellers and team, upload disclosures, and share the offer link with buyer's agents.</p>
    <form id="auth-form"><div class="error" hidden></div>
      <div class="field"><label>Street address</label><input type="text" name="address" placeholder="1234 Maple Ave" required></div>
      <div class="form-grid">
        <div class="field"><label>City</label><input type="text" name="city"></div>
        <div class="field"><label>State</label><input type="text" name="state" maxlength="2" placeholder="TX"></div>
        <div class="field"><label>ZIP</label><input type="text" name="zip"></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>List price</label><input type="text" name="listPrice" inputmode="numeric" placeholder="$650,000"></div>
        <div class="field"><label>MLS #</label><input type="text" name="mlsNumber"></div>
      </div>
      <button class="btn primary" type="submit">Create vault</button>
    </form></div>`);
  bindAuthForm(async (d) => { const r = await api('POST', '/vaults', d); toast('Vault created.', 'ok'); go(`#/vault/${r.id}`); });
}

// ---------- Vault ----------

function stages(status) {
  const order = ['active', 'under_contract', 'closed'];
  const idx = status === 'withdrawn' ? -1 : order.indexOf(status);
  const names = ['Listed · taking offers', 'Offer accepted · under contract', 'Closed'];
  return html`<div class="stages">${names.map((n, i) => html`<div class="stage ${i < idx || status === 'closed' ? 'done' : i === idx ? 'current' : ''}"><div class="dot">${i < idx || status === 'closed' ? '✓' : i + 1}</div>${n}</div>`)}</div>`;
}

async function viewVault(id, tab, ticket) {
  const data = await api('GET', `/vaults/${id}`);
  if (stale(ticket)) return;
  const { vault: v, me } = data;
  const isListing = me.side === 'listing';
  tab = tab || 'documents';
  if (tab === 'offers' && !isListing) tab = 'documents';
  const tabs = [['documents', 'Documents'], ...(isListing ? [['offers', 'Offers']] : []), ['people', 'People'], ['activity', 'Activity']];

  view(html`
    <div class="vault-head">
      <div>
        <div class="row">${pill(STATUS[v.status])}<span class="pill">You: ${me.roleLabel}</span></div>
        <div class="addr" style="margin-top:8px">${v.address}</div>
        <div class="kv"><span>${[v.city, v.state, v.zip].filter(Boolean).join(', ')}</span><span>List price <b>${money(v.listPrice)}</b></span>${v.mlsNumber ? html`<span>MLS <b>${v.mlsNumber}</b></span>` : ''}</div>
      </div>
      <div class="row">
        ${isListing && v.status === 'active' ? html`<button class="btn gold" id="share-link">🔗 Offer link</button>` : ''}
        ${me.isListingAgent ? html`<button class="btn" id="status-btn">Transaction status ▾</button>` : ''}
      </div>
    </div>
    ${v.status !== 'withdrawn' ? stages(v.status) : html`<div class="banner amber" style="margin-top:16px">This listing has been withdrawn.</div>`}
    <nav class="tabs">${tabs.map(([k, label]) => html`<a class="tab ${k === tab ? 'active' : ''}" href="#/vault/${v.id}/${k}">${label}${k === 'offers' && data.pendingOffers ? html`<span class="pill red">${data.pendingOffers}</span>` : ''}</a>`)}</nav>
    <div id="tab-body"><div class="spinner"></div></div>`);

  $('#share-link')?.addEventListener('click', () => shareOfferLink(v));
  $('#status-btn')?.addEventListener('click', () => statusModal(v));

  const body = $('#tab-body');
  if (tab === 'documents') await tabDocuments(body, data, ticket);
  else if (tab === 'offers') await tabOffers(body, data, ticket);
  else if (tab === 'people') tabPeople(body, data);
  else if (tab === 'activity') await tabActivity(body, data, ticket);
}

function shareOfferLink(v) {
  modal({
    title: 'Share the offer link',
    body: html`<p>Send this link to buyer's agents. They sign in, fill out the offer terms, and upload their paperwork. You'll be notified right away, and offers stay private to your team.</p>
      <div class="copybox"><input type="text" readonly value="${v.offerLink}" id="offer-link"><button type="button" class="btn primary" id="copy">Copy</button></div>
      <label class="check" style="margin-top:16px"><input type="checkbox" id="accepting" ${v.acceptingOffers ? 'checked' : ''}> Accepting offers through this link</label>
      <p class="small muted" style="margin-top:14px">Link shared somewhere it shouldn't be? <button type="button" class="btn link small" id="rotate">Reset the link</button> and the old one stops working.</p>`,
    onOpen: () => {
      $('#copy').onclick = async () => { $('#offer-link').select(); try { await navigator.clipboard.writeText(v.offerLink); } catch { document.execCommand('copy'); } toast('Offer link copied.', 'ok'); };
      $('#accepting').onchange = async (e) => { await api('PATCH', `/vaults/${v.id}`, { acceptingOffers: e.target.checked }); toast(e.target.checked ? 'Now accepting offers.' : 'Offer link paused.', 'ok'); };
      $('#rotate').onclick = async () => { await api('POST', `/vaults/${v.id}/rotate-offer-link`); $('#modal-root').innerHTML = ''; toast('Offer link reset.', 'ok'); const d = await api('GET', `/vaults/${v.id}`); shareOfferLink(d.vault); };
    },
  });
}

function statusModal(v) {
  const options = [];
  if (v.status === 'under_contract') options.push(['closed', '🎉 Mark as closed', 'Everyone in the vault is notified. Documents stay available.']);
  if (v.status === 'under_contract') options.push(['active', 'Release contract (back on market)', "The accepted offer is terminated and the buyer side loses access to the vault. Offers reopen."]);
  if (v.status === 'active') options.push(['withdrawn', 'Withdraw listing', 'Stops accepting offers.']);
  if (['closed', 'withdrawn'].includes(v.status)) options.push(['active', 'Reopen', 'Restore the vault to its previous stage.']);
  modal({
    title: 'Transaction status',
    body: html`${options.map(([val, label, hint], i) => html`<label class="check" style="margin-bottom:12px"><input type="radio" name="status" value="${val}" ${i === 0 ? 'checked' : ''}><span>${label}<div class="hint">${hint}</div></span></label>`)}
      <div class="field"><label>Note to everyone (optional)</label><textarea name="note"></textarea></div>`,
    submitLabel: 'Update status',
    onSubmit: async (form, close) => {
      const d = Object.fromEntries(new FormData(form));
      await api('POST', `/vaults/${v.id}/status`, d);
      close(); toast('Status updated.', 'ok'); route();
    },
  });
}

// ---- Documents tab ----

async function tabDocuments(body, data, ticket) {
  const { documents } = await api('GET', `/vaults/${data.vault.id}/documents`);
  if (stale(ticket)) return;
  const meta = state.meta;
  const folders = meta.folders.filter((f) => documents.some((d) => d.folder === f));
  const needsMe = documents.filter((d) => d.signature?.awaitingMe);
  const render = (filter = '') => {
    const f = filter.toLowerCase();
    const shown = documents.filter((d) => !f || d.name.toLowerCase().includes(f) || d.folder.toLowerCase().includes(f));
    $('#doc-list').innerHTML = (shown.length ? folders.filter((fo) => shown.some((d) => d.folder === fo)).map((fo) => html`
      <div class="folder"><div class="folder-name">📁 ${fo}</div><div class="list">
        ${shown.filter((d) => d.folder === fo).map((d) => html`
          <a class="list-row" href="#/vault/${data.vault.id}/doc/${d.id}">
            ${fileIcon(d.file)}
            <div class="grow"><div class="name">${d.name}</div>
              <div class="muted small">v${d.version} · ${d.uploadedBy} · ${ago(d.updatedAt)}${d.file ? ` · ${size(d.file.size)}` : ''}</div></div>
            <div class="row meta-pills">${d.visibility !== 'all' ? pill(VIS[d.visibility]) : ''}${docStatusPill(d)}</div>
          </a>`)}
      </div></div>`.s).join('') : html`<div class="card empty"><div class="big">📂</div><p>${documents.length ? 'No documents match your search.' : 'No documents yet. Upload listing paperwork, disclosures, or anything the other parties need.'}</p></div>`.s);
  };
  body.innerHTML = html`
    ${needsMe.length ? html`<div class="banner amber"><div class="grow"><b>${needsMe.length} document${needsMe.length > 1 ? 's need' : ' needs'} your signature.</b></div>${needsMe.map((d) => html`<a class="btn sm gold" href="#/sign/${d.signature.requestId}">Sign ${d.name}</a>`)}</div>` : ''}
    <div class="section-head"><input type="text" id="doc-search" placeholder="Search documents…" style="max-width:320px">
      <button class="btn primary" id="upload-btn">⬆ Upload documents</button></div>
    <div id="doc-list"></div>`.s;
  render();
  $('#doc-search').oninput = (e) => render(e.target.value);
  $('#upload-btn').onclick = () => uploadModal(data);
}

function visibilityOptions(me) {
  return me.visibilityOptions.map((v) => html`<option value="${v}">${v === 'all' ? 'Everyone in the vault' : v === 'listing' ? 'Listing side only (agent, team, sellers)' : "Buyer side only (agent, team, buyers, lender)"}</option>`);
}

function uploadModal(data, existing) {
  let getFiles;
  modal({
    title: existing ? `Upload new version of “${existing.name}”` : 'Upload documents',
    body: html`
      ${dropzoneHtml(existing ? 'Drop the new version here or click to browse' : 'Drop files here or click to browse', !existing)}
      ${existing ? '' : html`<div class="form-grid">
        <div class="field"><label>Folder</label><select name="folder">${state.meta.folders.filter((f) => f !== 'Offers').map((f) => html`<option>${f}</option>`)}</select></div>
        <div class="field"><label>Who can see it</label><select name="visibility">${visibilityOptions(data.me)}</select></div></div>`}
      <div class="field"><label>Note (optional)</label><input type="text" name="note" placeholder="e.g. Seller initialed page 3"></div>
      <label class="check"><input type="checkbox" name="executed" value="true"> This is the fully executed (signed by all parties) copy<span class="hint" style="display:block">Everyone who can see it will be notified that it's signed.</span></label>
      ${existing?.signature?.status === 'pending' ? html`<div class="banner amber small" style="margin-top:12px">Uploading a new version cancels the open signature request on this document.</div>` : ''}`,
    submitLabel: 'Upload',
    onOpen: (form) => { getFiles = dropzone(form, { multiple: !existing }); },
    onSubmit: async (form, close) => {
      const files = getFiles();
      if (!files.length) throw new Error('Choose a file to upload.');
      const fd = new FormData(form);
      files.forEach((f) => fd.append('files', f));
      if (existing) fd.append('documentId', existing.id);
      await api('POST', `/vaults/${data.vault.id}/documents`, fd);
      close(); toast(existing ? 'New version uploaded.' : `${files.length} document${files.length > 1 ? 's' : ''} uploaded.`, 'ok'); route();
    },
  });
}

// ---- Document detail ----

async function viewDocument(vaultId, docId, ticket) {
  const [vd, dd] = await Promise.all([api('GET', `/vaults/${vaultId}`), api('GET', `/documents/${docId}`)]);
  if (stale(ticket)) return;
  const d = dd.document;
  const fileUrl = (ver, inline) => `/api/documents/${d.id}/versions/${ver}/file${inline ? '?inline=1' : ''}`;
  const canPreview = d.file && (d.file.mime === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(d.file.mime));
  const pending = dd.requests.find((r) => r.status === 'pending');
  const sigStatus = { pending: ['Awaiting signatures', 'amber'], completed: ['Completed', 'green'], declined: ['Declined', 'red'], cancelled: ['Cancelled', ''], void: ['Voided', ''] };
  const signerStatus = { pending: ['Waiting', 'amber'], signed: ['Signed', 'green'], declined: ['Declined', 'red'] };

  view(html`
    <p><a href="#/vault/${vaultId}/documents">← ${vd.vault.address}</a></p>
    <div class="section-head">
      <div><h1>${d.name}</h1><div class="row">${pill(VIS[d.visibility])}${docStatusPill(d)}<span class="muted small">${d.folder} · version ${d.version} · ${d.file ? size(d.file.size) : ''}</span></div></div>
      <div class="row">
        ${d.signature?.awaitingMe ? html`<a class="btn gold" href="#/sign/${d.signature.requestId}">✍️ Review & sign</a>` : ''}
        <a class="btn" href="${fileUrl(d.version)}">⬇ Download</a>
        ${dd.canUpload ? html`<button class="btn" id="new-version">⬆ New version</button>` : ''}
        ${dd.canRequestSignatures && !pending ? html`<button class="btn primary" id="req-sig">Request signatures</button>` : ''}
      </div>
    </div>
    <div class="doc-layout">
      <div>${canPreview ? (d.file.mime === 'application/pdf'
    ? html`<iframe class="preview" src="${fileUrl(d.version, true)}" title="Document preview"></iframe>`
    : html`<img class="preview-img" src="${fileUrl(d.version, true)}" alt="${d.name}">`)
    : html`<div class="card empty"><div class="big">📄</div><p>Preview isn't available for this file type.</p><a class="btn" href="${fileUrl(d.version)}">Download ${d.file?.filename}</a></div>`}</div>
      <aside>
        <div class="card"><h3>Signatures</h3>
          ${dd.requests.length ? dd.requests.slice(0, 3).map((r) => html`<div style="margin-bottom:14px">
            <div class="row between">${pill(sigStatus[r.status])}<span class="muted small">v${r.version} · ${ago(r.createdAt)}</span></div>
            <div class="small muted" style="margin:4px 0">Requested by ${r.requestedBy}${r.dueDate ? ` · due ${plainDate(r.dueDate)}` : ''}</div>
            ${r.message ? html`<div class="small" style="margin-bottom:6px">“${r.message}”</div>` : ''}
            ${r.signers.map((s) => html`<div class="row between small" style="padding:4px 0"><span>${s.name}${s.isMe ? ' (you)' : ''}</span><span>${pill(signerStatus[s.status])}${s.signedAt ? html` <span class="muted">${ago(s.signedAt)}</span>` : ''}</span></div>${s.declineReason ? html`<div class="small muted">“${s.declineReason}”</div>` : ''}`)}
            ${r.status === 'pending' ? html`<button class="btn sm danger" data-cancel="${r.id}" style="margin-top:6px">Cancel request</button>` : ''}
          </div>`) : html`<p class="muted small">No signatures requested yet.${dd.canRequestSignatures ? ' Use “Request signatures” to send it out — everyone is notified the moment it’s fully signed.' : ''}</p>`}
        </div>
        <div class="card"><h3>Versions</h3>
          ${dd.versions.map((v) => html`<div class="row between small" style="padding:6px 0;border-bottom:1px solid var(--line)"><div><b>v${v.version}</b> · ${v.uploaded_by || 'ClosingVault'}<div class="muted">${dateTime(v.created_at)}${v.note ? ` · ${v.note}` : ''}</div></div><a href="${fileUrl(v.version)}">Download</a></div>`)}
          <p class="small muted" style="margin-top:8px;word-break:break-all">SHA-256: ${d.file?.sha256}</p>
        </div>
        ${dd.access.length ? html`<div class="card"><h3>Access log</h3>${dd.access.slice(0, 15).map((a) => html`<div class="small" style="padding:3px 0">${a.name} ${a.action === 'document.viewed' ? 'viewed' : 'downloaded'} <span class="muted">· ${ago(a.created_at)}</span></div>`)}</div>` : ''}
        ${dd.canArchive ? html`<button class="btn danger sm" id="archive" style="margin-top:14px">Remove document</button>` : ''}
      </aside>
    </div>`);

  $('#new-version')?.addEventListener('click', () => uploadModal(vd, d));
  $('#req-sig')?.addEventListener('click', () => signatureModal(d, dd.signable));
  $$('[data-cancel]').forEach((b) => { b.onclick = () => confirmModal('Cancel signature request?', 'Signers will be told their signature is no longer needed.', 'Cancel request', 'danger solid', async () => { await api('POST', `/signature-requests/${b.dataset.cancel}/cancel`); route(); }); });
  $('#archive')?.addEventListener('click', () => confirmModal('Remove this document?', 'It will disappear from the vault for everyone. A record is kept in the audit log.', 'Remove', 'danger solid', async () => { await api('DELETE', `/documents/${d.id}`); go(`#/vault/${vaultId}/documents`); }));
}

function signatureModal(d, signable) {
  modal({
    title: 'Request signatures',
    body: html`<p class="muted small">Only people who can see <b>${d.name}</b> are listed. Each signer is notified now, and everyone with access is notified once all have signed.</p>
      <div class="field"><label>Signers</label>${signable.map((s) => html`<label class="check" style="margin:6px 0"><input type="checkbox" name="signers" value="${s.userId}"><span>${s.name} <span class="muted small">· ${s.role}</span></span></label>`)}</div>
      <div class="form-grid"><div class="field"><label>Due date (optional)</label><input type="date" name="dueDate"></div></div>
      <div class="field"><label>Message (optional)</label><textarea name="message" placeholder="Please initial each page and sign on page 8."></textarea></div>`,
    submitLabel: 'Send for signature',
    onSubmit: async (form, close) => {
      const signers = $$('input[name=signers]:checked', form).map((i) => i.value);
      if (!signers.length) throw new Error('Choose at least one signer.');
      const fd = Object.fromEntries(new FormData(form));
      await api('POST', `/documents/${d.id}/signature-requests`, { signers, dueDate: fd.dueDate, message: fd.message });
      close(); toast('Signature request sent.', 'ok'); route();
    },
  });
}

// ---- Sign ----

async function viewSign(id, ticket) {
  const r = await api('GET', `/signature-requests/${id}`);
  if (stale(ticket)) return;
  const { request: req, document: doc } = r;
  const fileUrl = `/api/documents/${doc.id}/versions/${req.version}/file?inline=1`;
  const isPdf = doc.mime === 'application/pdf';
  const canSign = r.myStatus === 'pending' && req.status === 'pending';
  view(html`
    <p><a href="#/vault/${doc.vaultId}/doc/${doc.id}">← Back to document</a></p>
    <div class="section-head"><div><h1>${doc.name}</h1><p class="muted">${doc.property} · requested by ${req.requestedBy} ${ago(req.createdAt)}${req.dueDate ? ` · due ${plainDate(req.dueDate)}` : ''}</p></div></div>
    ${req.message ? html`<div class="banner blue"><div class="grow">“${req.message}” — ${req.requestedBy}</div></div>` : ''}
    <div class="doc-layout">
      <div>${isPdf ? html`<iframe class="preview" src="${fileUrl}" title="Document to sign"></iframe>` : /^image\//.test(doc.mime) ? html`<img class="preview-img" src="${fileUrl}" alt="">` : html`<div class="card empty"><p>Download and review <b>${doc.filename}</b> before signing.</p><a class="btn" href="/api/documents/${doc.id}/versions/${req.version}/file">Download</a></div>`}</div>
      <aside>
        <div class="card" id="sign-card">
          ${canSign ? html`
            <h2>Sign this document</h2>
            <form id="sign-form"><div class="error" hidden></div>
              <div class="field"><label>Type your full legal name</label><input type="text" name="signedName" value="${state.me.name}" autocomplete="name" required></div>
              <div class="sig-preview" id="sig-preview">${state.me.name}</div>
              <label class="check" style="margin:16px 0"><input type="checkbox" name="consent" value="1"> <span class="small">I have reviewed this document and agree to sign it electronically. I understand my typed name is my legally binding signature.</span></label>
              <button class="btn green" type="submit" style="width:100%;justify-content:center">Adopt & sign</button>
              <p class="center small" style="text-align:center;margin-top:12px"><button type="button" class="btn link small" id="decline">Decline to sign</button></p>
            </form>` : html`
            <h2>${req.status === 'completed' ? '✅ Fully signed by all parties' : r.myStatus === 'signed' ? '✅ You signed this document' : req.status === 'pending' ? 'Waiting on other signers' : 'This request is closed'}</h2>
            <p class="muted small">${req.status === 'pending' ? "You'll be notified when everyone has signed." : `Status: ${req.status}.`}</p>`}
        </div>
        <div class="card"><h3>Signers</h3>${r.signers.map((s) => html`<div class="row between small" style="padding:4px 0"><span>${s.name}${s.isMe ? ' (you)' : ''}</span>${pill(s.status === 'signed' ? ['Signed', 'green'] : s.status === 'declined' ? ['Declined', 'red'] : ['Waiting', 'amber'])}</div>`)}
          <p class="small muted" style="margin-top:10px;word-break:break-all">Document fingerprint (SHA-256): ${req.sha256}</p></div>
      </aside>
    </div>`);
  const form = $('#sign-form');
  if (!form) return;
  $('input[name=signedName]', form).oninput = (e) => { $('#sig-preview').textContent = e.target.value; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const err = $('.error', form);
    try {
      const res = await api('POST', `/signature-requests/${id}/sign`, { signedName: d.signedName, consent: !!d.consent });
      toast(res.completed ? 'Signed! Everyone has now signed — all parties have been notified.' : 'Signed! The requester has been notified.', 'ok');
      route();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  $('#decline').onclick = () => modal({
    title: 'Decline to sign', body: html`<div class="field"><label>Reason (shared with the requester)</label><textarea name="reason" placeholder="e.g. Closing date on page 2 is wrong"></textarea></div>`,
    submitLabel: 'Decline', submitClass: 'danger solid',
    onSubmit: async (f, close) => { await api('POST', `/signature-requests/${id}/decline`, Object.fromEntries(new FormData(f))); close(); toast('Declined. The requester has been notified.'); route(); },
  });
}

// ---- Offers tab ----

async function tabOffers(body, data, ticket) {
  const { offers } = await api('GET', `/vaults/${data.vault.id}/offers`);
  if (stale(ticket)) return;
  const v = data.vault;
  body.innerHTML = html`
    ${v.status === 'active' ? html`<div class="banner ${v.acceptingOffers ? 'blue' : 'amber'}"><div class="grow">${v.acceptingOffers ? html`<b>Taking offers.</b> Share your private offer link with buyer's agents. Each offer lands here and notifies your team instantly.` : html`<b>The offer link is paused.</b> Buyer's agents can't submit new offers right now.`}</div><button class="btn sm" id="share-link-2">Manage offer link</button></div>` : ''}
    ${offers.length ? html`<div class="table-wrap"><table class="data">
      <thead><tr><th>Price</th><th>Buyers</th><th>Buyer's agent</th><th>Financing</th><th>EMD</th><th>Close</th><th>Contingencies</th><th>Expires</th><th>Status</th></tr></thead>
      <tbody>${offers.map((o) => html`<tr class="clickable" data-href="#/vault/${v.id}/offers/${o.id}">
        <td class="price">${money(o.price)}${v.listPrice ? html`<div class="small muted">${pctVsList(o.price, v.listPrice)}</div>` : ''}</td>
        <td>${o.buyerNames}</td><td>${o.agent.name}<div class="small muted">${o.agent.brokerage || ''}</div></td>
        <td>${o.financing || '—'}${o.downPaymentPct ? html`<div class="small muted">${o.downPaymentPct}% down</div>` : ''}</td>
        <td>${money(o.earnestMoney)}</td><td>${plainDate(o.closingDate)}</td><td class="small">${o.contingencies || 'None'}</td>
        <td class="small">${o.expiresAt ? dateTime(o.expiresAt) : '—'}</td><td>${pill(OFFER_STATUS[o.status])}</td></tr>`)}</tbody></table></div>`
    : html`<div class="card empty"><div class="big">📨</div><p>No offers yet. When a buyer's agent submits one through your offer link, you'll be notified here, in the app, and by email.</p></div>`}`.s;
  $$('tr[data-href]', body).forEach((tr) => { tr.onclick = () => go(tr.dataset.href); });
  $('#share-link-2')?.addEventListener('click', () => shareOfferLink(v));
}

function pctVsList(price, listPrice) {
  const pct = (price / listPrice - 1) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs list`;
}

function offerTerms(o, listPrice) {
  return html`<div class="grid cols-2" style="gap:6px 24px">
    ${[['Offer price', html`<span class="price big">${money(o.price)}</span>${listPrice ? html` <span class="muted small">${pctVsList(o.price, listPrice)}</span>` : ''}`],
    ['Buyers', o.buyerNames], ['Financing', `${o.financing || '—'}${o.downPaymentPct ? ` · ${o.downPaymentPct}% down` : ''}`], ['Earnest money', money(o.earnestMoney)],
    ['Proposed closing', plainDate(o.closingDate)], ['Offer expires', o.expiresAt ? dateTime(o.expiresAt) : '—'], ['Contingencies', o.contingencies || 'None'],
    ["Buyer's agent", html`${o.agent.name}${o.agent.brokerage ? ` · ${o.agent.brokerage}` : ''}<div class="small muted">${o.agent.email}${o.agent.phone ? ` · ${o.agent.phone}` : ''}</div>`]]
    .map(([k, val]) => html`<div style="padding:8px 0;border-bottom:1px solid var(--line)"><div class="small muted">${k}</div><div>${val}</div></div>`)}
  </div>${o.notes ? html`<div style="margin-top:14px"><div class="small muted">Notes from the buyer's agent</div><div style="white-space:pre-line">${o.notes}</div></div>` : ''}`;
}
const EVENT_LABEL = { submitted: 'Offer submitted', countered: 'Counter offer sent', revised: 'Offer revised', rejected: 'Offer declined', accepted: 'Offer accepted 🎉', withdrawn: 'Offer withdrawn', not_selected: 'Another offer was accepted' };
const offerTimeline = (o) => html`<ul class="timeline">${o.events.map((e) => html`<li><b>${EVENT_LABEL[e.kind] || e.kind}</b> <span class="when">· ${e.name || ''} · ${dateTime(e.created_at)}</span>${e.note ? html`<div class="small" style="white-space:pre-line">${e.note}</div>` : ''}</li>`)}</ul>`;
const offerDocs = (o, vaultId) => html`<div class="list">${o.documents.map((d) => html`<a class="list-row" href="${vaultId ? `#/vault/${vaultId}/doc/${d.id}` : `/api/documents/${d.id}/versions/${d.version}/file`}">${fileIcon(d.file)}<div class="grow"><div class="name">${d.name}</div><div class="muted small">${d.uploadedBy} · ${ago(d.updatedAt)}</div></div></a>`)}</div>`;

async function viewOfferDetail(vaultId, offerId, ticket) {
  const r = await api('GET', `/offers/${offerId}`);
  if (stale(ticket)) return;
  const o = r.offer;
  view(html`
    <p><a href="#/vault/${vaultId}/offers">← Offers on ${r.property.address}</a></p>
    <div class="section-head"><div><div class="row">${pill(OFFER_STATUS[o.status])}<span class="muted small">Received ${dateTime(o.createdAt)}</span></div><h1 style="margin-top:8px">Offer from ${o.agent.name}</h1></div>
      ${r.canRespond ? html`<div class="row"><button class="btn green" id="accept">✓ Accept offer</button><button class="btn" id="counter">Counter</button><button class="btn danger" id="reject">Decline</button></div>` : ''}</div>
    <div class="doc-layout"><div class="card">${offerTerms(o, r.property.listPrice)}</div>
      <aside><div class="card"><h3>Offer documents</h3>${offerDocs(o, vaultId)}</div><div class="card"><h3>History</h3>${offerTimeline(o)}</div></aside></div>`);
  if (!r.canRespond) return;
  $('#accept').onclick = () => modal({
    title: 'Accept this offer?',
    body: html`<p>Accepting <b>${money(o.price)}</b> from <b>${o.buyerNames}</b> will:</p>
      <ul><li>Move the property to <b>Under contract</b></li><li>Give <b>${o.agent.name}</b> (buyer's agent) access to the vault so they can invite their buyers, lender, and team</li><li>Share this offer's documents with everyone in the vault as the purchase agreement</li><li>Notify every other buyer's agent that another offer was accepted</li></ul>
      <div class="field"><label>Note to the buyer's agent (optional)</label><textarea name="note" placeholder="Congratulations! Please send EMD receipt to title by Friday."></textarea></div>`,
    submitLabel: 'Accept offer', submitClass: 'green',
    onSubmit: async (f, close) => { await api('POST', `/offers/${o.id}/respond`, { action: 'accept', note: f.note.value }); close(); toast('Offer accepted. The buyer’s agent now has vault access.', 'ok'); go(`#/vault/${vaultId}/documents`); },
  });
  $('#counter').onclick = () => {
    let getFiles;
    modal({
      title: 'Send a counter offer',
      body: html`<div class="field"><label>Counter terms / message</label><textarea name="note" required placeholder="Seller counters at $655,000, closing on or before 11/30, all else per offer."></textarea></div>${dropzoneHtml('Attach the counter offer document (optional)')}`,
      submitLabel: 'Send counter', onOpen: (f) => { getFiles = dropzone(f); },
      onSubmit: async (f, close) => {
        if (!f.note.value.trim()) throw new Error('Describe the counter terms.');
        const fd = new FormData(); fd.append('action', 'counter'); fd.append('note', f.note.value); getFiles().forEach((x) => fd.append('files', x));
        await api('POST', `/offers/${o.id}/respond`, fd); close(); toast('Counter sent to the buyer’s agent.', 'ok'); route();
      },
    });
  };
  $('#reject').onclick = () => modal({
    title: 'Decline this offer', body: html`<div class="field"><label>Message to the buyer's agent (optional)</label><textarea name="note"></textarea></div>`,
    submitLabel: 'Decline offer', submitClass: 'danger solid',
    onSubmit: async (f, close) => { await api('POST', `/offers/${o.id}/respond`, { action: 'reject', note: f.note.value }); close(); toast('Offer declined.'); route(); },
  });
}

// ---- Submit offer (buyer's agent) ----

async function viewSubmitOffer(token, ticket) {
  const p = await api('GET', `/offer-link/${token}`);
  if (stale(ticket)) return;
  const listingAgent = p.listingAgent;
  const header = html`<div class="card"><div class="row between"><div>
      <div class="muted small">Submit an offer on</div><h1>${p.address}</h1><div class="muted">${[p.city, p.state, p.zip].filter(Boolean).join(', ')}${p.mlsNumber ? ` · MLS ${p.mlsNumber}` : ''}</div></div>
      <div style="text-align:right"><div class="muted small">List price</div><div class="price big">${money(p.listPrice)}</div></div></div>
      ${listingAgent ? html`<p class="small muted" style="margin:12px 0 0">Listing agent: <b>${listingAgent.name}</b>${listingAgent.brokerage ? ` · ${listingAgent.brokerage}` : ''}${listingAgent.phone ? ` · ${listingAgent.phone}` : ''}</p>` : ''}</div>`;
  const prior = p.myOffers.length ? html`<div class="banner blue"><div class="grow">You've submitted ${p.myOffers.length} offer${p.myOffers.length > 1 ? 's' : ''} on this property.</div>${p.myOffers.map((o) => html`<a class="btn sm" href="#/offer-status/${o.id}">${money(o.price)} · ${OFFER_STATUS[o.status][0]}</a>`)}</div>` : '';
  if (!p.open) { view(html`${header}${prior}<div class="card empty"><div class="big">⏸</div><p>The listing agent isn't accepting offers through this link right now${p.status === 'under_contract' ? ' — the property is under contract' : ''}.</p></div>`); return; }
  if (!state.me.emailVerified) { view(html`${header}${verifyBanner()}`); bindVerifyBanner(); return; }

  view(html`${header}${prior}
    <form class="card" id="offer-form" style="margin-top:16px"><div class="error" hidden></div>
      <h2>Offer terms</h2>
      <div class="form-grid">
        <div class="field"><label>Buyer name(s)</label><input type="text" name="buyerNames" placeholder="Jordan & Casey Rivera" required></div>
        <div class="field"><label>Offer price</label><input type="text" name="price" inputmode="numeric" placeholder="$650,000" required></div>
        <div class="field"><label>Earnest money</label><input type="text" name="earnestMoney" inputmode="numeric" placeholder="$10,000"></div>
      </div>
      <div class="form-grid">
        <div class="field"><label>Financing</label><select name="financing"><option>Conventional</option><option>FHA</option><option>VA</option><option>USDA</option><option>Cash</option><option>Jumbo</option><option>Seller financing</option><option>Other</option></select></div>
        <div class="field"><label>Down payment %</label><input type="number" name="downPaymentPct" min="0" max="100" step="0.5"></div>
        <div class="field"><label>Proposed closing date</label><input type="date" name="closingDate"></div>
        <div class="field"><label>Offer expires</label><input type="datetime-local" name="expiresAt"></div>
      </div>
      <div class="field"><label>Contingencies</label><div class="checks">${['Inspection', 'Appraisal', 'Financing', 'Sale of buyer’s home', 'HOA document review', 'Survey'].map((c) => html`<label class="check"><input type="checkbox" name="contingencies" value="${c}"> ${c}</label>`)}</div></div>
      <div class="field"><label>Notes for the listing agent</label><textarea name="notes" placeholder="Pre-approved with First Bank, flexible on leaseback, love letter attached…"></textarea></div>
      <h2 style="margin-top:8px">Offer documents</h2>
      <p class="muted small">Attach the signed purchase agreement, pre-approval or proof of funds, and any addenda. Only the listing side can see them unless your offer is accepted.</p>
      ${dropzoneHtml()}
      <button class="btn primary" type="submit">Submit offer</button>
    </form>`);
  const form = $('#offer-form');
  const getFiles = dropzone(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('.error', form);
    err.hidden = true;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const files = getFiles();
      if (!files.length) throw new Error('Attach the signed offer / purchase agreement.');
      const fd = new FormData(form);
      files.forEach((f) => fd.append('files', f));
      const r = await api('POST', `/offer-link/${token}/offers`, fd);
      toast('Offer submitted. The listing agent has been notified.', 'ok');
      go(`#/offer-status/${r.id}`);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; window.scrollTo(0, 0); } finally { btn.disabled = false; }
  };
}

async function viewOfferStatus(id, ticket) {
  const r = await api('GET', `/offers/${id}`);
  if (stale(ticket)) return;
  const o = r.offer;
  if (!o.isMine && r.isMember) return go(`#/vault/${r.property.id}/offers/${o.id}`);
  const banners = {
    accepted: html`<div class="banner green"><div class="grow"><b>🎉 Your offer was accepted!</b> You now have access to the transaction vault. Invite your buyers, lender, and team to start exchanging documents.</div>${r.isMember ? html`<a class="btn green" href="#/vault/${r.property.id}">Open transaction vault</a>` : ''}</div>`,
    countered: html`<div class="banner amber"><div class="grow"><b>The seller countered.</b> Review the counter below, then submit a revised offer or withdraw.</div></div>`,
    rejected: html`<div class="banner amber"><div class="grow">The seller declined this offer.</div></div>`,
    not_selected: html`<div class="banner amber"><div class="grow">The seller accepted another offer. Your documents remain private to you and the listing side.</div></div>`,
    submitted: html`<div class="banner blue"><div class="grow">Your offer is with the listing team. You'll be notified the moment they respond.</div></div>`,
  };
  view(html`
    <p><a href="#/">← Dashboard</a></p>
    <div class="section-head"><div><div class="row">${pill(OFFER_STATUS[o.status])}</div><h1 style="margin-top:8px">Your offer on ${r.property.address}</h1><p class="muted">${[r.property.city, r.property.state].filter(Boolean).join(', ')}</p></div>
      ${r.canRevise ? html`<div class="row"><button class="btn primary" id="revise">Revise offer</button><button class="btn danger" id="withdraw">Withdraw</button></div>` : ''}</div>
    ${banners[o.status] || ''}
    <div class="doc-layout"><div class="card">${offerTerms(o, r.property.listPrice)}</div>
      <aside><div class="card"><h3>Documents</h3>${offerDocs(o, r.isMember ? r.property.id : null)}</div><div class="card"><h3>History</h3>${offerTimeline(o)}</div></aside></div>`);
  $('#revise')?.addEventListener('click', () => {
    let getFiles;
    modal({
      title: 'Revise your offer',
      body: html`<div class="form-grid"><div class="field"><label>New price</label><input type="text" name="price" value="${o.price}"></div><div class="field"><label>Closing date</label><input type="date" name="closingDate" value="${o.closingDate || ''}"></div></div>
        <div class="field"><label>Offer expires</label><input type="datetime-local" name="expiresAt" value="${o.expiresAt || ''}"></div>
        <div class="field"><label>Message to the listing agent</label><textarea name="note" placeholder="Buyers accept the counter at $655,000."></textarea></div>${dropzoneHtml('Attach revised / signed counter documents')}`,
      submitLabel: 'Submit revision', onOpen: (f) => { getFiles = dropzone(f); },
      onSubmit: async (f, close) => { const fd = new FormData(f); getFiles().forEach((x) => fd.append('files', x)); await api('POST', `/offers/${o.id}/revise`, fd); close(); toast('Revision sent. The listing team has been notified.', 'ok'); route(); },
    });
  });
  $('#withdraw')?.addEventListener('click', () => confirmModal('Withdraw this offer?', 'The listing team will be notified.', 'Withdraw offer', 'danger solid', async () => { await api('POST', `/offers/${o.id}/withdraw`, {}); route(); }));
}

// ---- People tab ----

function tabPeople(body, data) {
  const { members, me, vault } = data;
  const roles = state.meta.roles;
  const canRemove = (m) => m.role !== 'listing_agent' && !m.isMe && (me.isListingAgent ? m.role !== 'buyer_agent' : me.manager && m.side === me.side && m.role !== 'buyer_agent');
  const canResend = (m) => m.status === 'invited' && me.manager && (m.side === me.side || m.side === 'neutral');
  const sides = ['listing', 'buyer', 'neutral'];
  body.innerHTML = html`
    <div class="section-head"><p class="muted" style="margin:0">Everyone below can sign in to this vault. Documents marked “side only” are visible to that side alone.</p>
      ${me.invitableRoles.length ? html`<button class="btn primary" id="invite">+ Invite someone</button>` : ''}</div>
    ${vault.status === 'active' && me.side === 'listing' ? html`<div class="banner blue"><div class="grow">The buyer's agent joins automatically when you accept their offer.</div></div>` : ''}
    <div class="grid cols-3">${sides.map((side) => html`
      <div class="card"><h3 class="side-title">${SIDES[side]}</h3>
        ${members.filter((m) => m.side === side).length ? members.filter((m) => m.side === side).map((m) => html`
          <div class="person" style="padding:10px 0;border-top:1px solid var(--line)">
            <div class="avatar" style="display:grid;place-items:center">${initials(m.name || m.email)}</div>
            <div class="grow" style="flex:1;min-width:0"><b>${m.name || m.email}</b>${m.isMe ? ' (you)' : ''}
              <div class="small muted">${m.roleLabel}${m.brokerage ? ` · ${m.brokerage}` : ''}</div>
              <div class="small" style="overflow-wrap:anywhere"><a href="mailto:${m.email}">${m.email}</a>${m.phone ? html` · <a href="tel:${m.phone}">${m.phone}</a>` : ''}</div>
              ${m.status === 'invited' ? html`<span class="pill amber" style="margin-top:4px">Invitation pending</span>` : ''}
              <div class="row" style="margin-top:4px">${canResend(m) ? html`<button class="btn link small" data-resend="${m.id}">Resend invite</button>` : ''}${canRemove(m) ? html`<button class="btn link small" style="color:var(--red)" data-remove="${m.id}" data-name="${m.name || m.email}">Remove</button>` : ''}</div>
            </div>
          </div>`) : html`<p class="muted small">${side === 'buyer' && vault.status === 'active' ? 'Joins when an offer is accepted.' : 'No one yet.'}</p>`}
      </div>`)}</div>`.s;

  $('#invite')?.addEventListener('click', () => modal({
    title: 'Invite to this vault',
    body: html`<div class="field"><label>Email</label><input type="email" name="email" required></div>
      <div class="field"><label>Name</label><input type="text" name="name"></div>
      <div class="field"><label>Role</label><select name="role">${me.invitableRoles.map((r) => html`<option value="${r}">${roles[r].label} — ${SIDES[roles[r].side]}</option>`)}</select>
      <div class="hint">They'll get an email invitation and see documents shared with everyone plus their side's private documents.</div></div>`,
    submitLabel: 'Send invitation',
    onSubmit: async (f, close) => {
      const r = await api('POST', `/vaults/${vault.id}/members`, Object.fromEntries(new FormData(f)));
      close(); toast(r.status === 'active' ? 'Added. They already have an account and have been notified.' : 'Invitation sent.', 'ok'); route();
    },
  }));
  $$('[data-resend]', body).forEach((b) => { b.onclick = async () => { await api('POST', `/vaults/${vault.id}/members/${b.dataset.resend}/resend`); toast('Invitation re-sent.', 'ok'); }; });
  $$('[data-remove]', body).forEach((b) => {
    b.onclick = () => confirmModal(`Remove ${b.dataset.name}?`, 'They will immediately lose access to this vault and its documents.', 'Remove', 'danger solid', async () => { await api('DELETE', `/vaults/${vault.id}/members/${b.dataset.remove}`); toast('Removed.'); route(); });
  });
}

// ---- Activity tab ----

async function tabActivity(body, data, ticket) {
  const { activity } = await api('GET', `/vaults/${data.vault.id}/activity`);
  if (stale(ticket)) return;
  body.innerHTML = html`<div class="card"><p class="muted small">A tamper-evident record of who did what, and when. ${data.me.manager ? 'IP addresses are shown to agents and team members.' : ''}</p>
    ${activity.length ? html`<ul class="timeline">${activity.map((a) => html`<li><div>${(a.detail || a.action).replace(/\s\[[0-9a-f-]{36}\]/, '')}</div><div class="when">${dateTime(a.createdAt)}${a.ip ? ` · ${a.ip}` : ''}</div></li>`)}</ul>` : html`<div class="empty">No activity yet.</div>`}</div>`.s;
}

// ---------- Boot ----------

(async function boot() {
  try {
    [state.meta] = await Promise.all([api('GET', '/meta'), refreshMe()]);
  } catch {
    app.innerHTML = '<div class="card empty">Unable to reach the server. Please refresh.</div>';
    return;
  }
  if (state.me) app.classList.add('container');
  route();
}());
