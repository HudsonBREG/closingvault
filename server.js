// ClosingVault: a secure transaction vault for listing agents, buyer's agents, clients, and every party to a deal.
process.removeAllListeners('warning'); // silence node:sqlite's experimental notice
const path = require('path');
const express = require('express');
const multer = require('multer');
const { loadUser, router: authRouter } = require('./src/auth');
const api = require('./src/api');

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // File responses are only ever served inline as PDF/images (otherwise as attachments), so they skip the page CSP.
  if (!req.path.endsWith('/file')) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; object-src 'self'; frame-ancestors 'self'");
  }
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(loadUser);

// CSRF defence: state-changing API calls must carry a custom header, which browsers
// will not attach to cross-site requests without a CORS preflight we never grant.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'ClosingVault') {
    return res.status(403).json({ error: 'Missing request header.' });
  }
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Files must be 50 MB or smaller.' : err.message });
  }
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`ClosingVault running at http://localhost:${port}`));
