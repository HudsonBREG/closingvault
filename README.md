# ClosingVault

A secure document vault for real estate transactions. Contracts, disclosures, and signed paperwork stay in one encrypted place that every party signs in to, so nothing has to go back and forth by email.

## How a deal flows

1. **The listing agent opens a vault** for the property, then invites their sellers and team and uploads listing documents and disclosures.
2. **The listing agent shares the private offer link** with buyer's agents. Each agent signs in, enters the offer terms (price, earnest money, financing, closing date, expiration, contingencies), and attaches the signed offer.
3. **The listing side is notified right away** in the app, with a live pop-up, and by email. Offers appear side by side, and each competing agent sees only their own offer.
4. **The listing agent counters, declines, or accepts.** A counter goes back to the buyer's agent, who can revise the offer or withdraw it.
5. **When an offer is accepted:**
   - the property moves to *Under contract*;
   - the buyer's agent is added to the vault;
   - the winning offer's documents become the shared *Purchase Agreement*;
   - every other agent is told another offer was accepted.
6. **Both teams work in the vault.** The buyer's agent invites their buyers, lender, inspector, and team. Either side can invite title/escrow or attorneys.
7. **E-signatures.** Anyone running the deal can send a document out for signature. Each signer is notified, and when the last one signs, **everyone who can see the document is notified that it's fully signed**. PDFs also get a new "executed" version with a Certificate of Completion page. You can also upload a copy signed elsewhere (DocuSign, wet ink) and mark it fully executed, which sends the same notice.
8. **Close it out.** The listing agent marks the deal *Closed* or *Withdrawn*. If the deal falls apart, they can release the contract to put the property back on the market. The buyer side then loses access automatically.

## Who sees what

| Role | Side | Can invite | Sees |
|---|---|---|---|
| Listing Agent | Listing | Listing team, sellers, neutral parties | Everything shared + listing-only + all offers |
| Listing Team Member | Listing | same as above | same as above |
| Seller | Listing | — | Shared + listing-only + offers |
| Buyer's Agent | Buyer | Buyer team, buyers, lender, inspector, neutral parties | Shared + buyer-only |
| Buyer's Agent Team Member | Buyer | same as above | same as above |
| Buyer, Lender, Inspector | Buyer | — | Shared + buyer-only |
| Title/Escrow, Attorney, Appraiser | Neutral | — | Shared documents only |

Every upload is marked **Everyone in the vault**, **Listing side only**, or **Buyer side only**. Until an offer is accepted, its documents are visible only to the listing side and the agent who submitted it.

## Security

- **Encryption at rest:** each file version is sealed with AES-256-GCM, using its own key derived from a master key. Nothing is stored in plain text on disk.
- **Integrity:** every version is hashed (SHA-256). Signatures are tied to that hash, and a request is voided if the file changes.
- **Access control is enforced on the server** for every request. Users without access get "not found", so the app never confirms that a vault or document exists.
- **Audit trail:** uploads, views, downloads, invitations, offer actions, and signatures are logged with user, time, and IP address. Each document has an access log.
- **Accounts:**
  - passwords are hashed with scrypt;
  - session cookies are HttpOnly and SameSite;
  - logins, invitations, and offer submissions are rate-limited;
  - a person only gets vault access after proving their email, either by verification link or by the invitation link itself.
- **CSRF protection:** state-changing requests must carry a custom header. Strict security headers (CSP, nosniff, frame protection) are set.
- **No documents in email:** notifications link back to the app and never attach files.

## Running it

Requires Node.js 22.13 or newer. There are no native dependencies, and the database is SQLite.

```bash
npm install
npm start            # http://localhost:3000
npm test             # end-to-end test of the whole transaction lifecycle
```

Without `SMTP_URL`, outgoing email is captured in the **Dev mailbox** (user menu, or the link on the sign-in page), so you can click verification and invitation links locally. The dev mailbox is always off when `NODE_ENV=production`.

### Configuration

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `APP_URL` | Public URL used in email links, e.g. `https://vault.yourbrokerage.com`. An `https` URL turns on Secure cookies. |
| `SMTP_URL` | e.g. `smtps://user:pass@smtp.sendgrid.net:465`. Enables real email delivery. |
| `MAIL_FROM` | From address for notifications |
| `VAULT_MASTER_KEY` | 32-byte base64 key (`openssl rand -base64 32`). **Set this in production and back it up. Without it, the documents cannot be decrypted.** If it's unset, a key is generated in `data/master.key`. |
| `DATA_DIR` | Where the database and encrypted files live (default `./data`) |
| `TRUST_PROXY` | Set to `1` behind a load balancer or reverse proxy, so IP addresses in the audit log are correct |

### Render (recommended)

`render.yaml` sets up the whole service, including a persistent disk and a generated encryption key.

1. In Render: **New → Blueprint**, connect GitHub, and choose this repository.
2. Fill in `APP_URL`, `SMTP_URL`, and `MAIL_FROM` when prompted, then deploy.
3. Copy `VAULT_MASTER_KEY` from the service's Environment tab and store it somewhere safe (a password manager).

The disk requires a paid instance (Starter, about $7/month plus about $2.50/month for 10 GB).

### Docker

```bash
docker build -t closingvault .
docker run -p 3000:3000 -v closingvault-data:/data \
  -e APP_URL=https://vault.example.com -e VAULT_MASTER_KEY=... -e SMTP_URL=... closingvault
```

## Project layout

```
server.js            HTTP server, security headers, CSRF guard
src/db.js            SQLite schema
src/storage.js       Encrypted file storage
src/auth.js          Accounts, sessions, verification, password reset, invitations
src/domain.js        Roles, permissions, notifications, audit log
src/api.js           Vaults, people, offers, documents, signatures, notifications, live events
src/certificate.js   Signature certificate appended to executed PDFs
src/mail.js          Email delivery / dev mailbox
public/              Web app (no build step)
test/e2e.test.js     Full-lifecycle test
```

## Before going live

- **Legal review of e-signatures.** The built-in flow captures the elements ESIGN/UETA call for: intent, consent, attribution to an authenticated user, and a tamper-evident record. Have your broker or counsel confirm it's acceptable for the documents and states you use it for. Some documents, or some lenders, may still require DocuSign or another provider; the "fully executed" upload path covers that.
- **Hosting:** use a managed host with HTTPS, a persistent volume for `DATA_DIR`, backups for both the database and the files, and the master key in a secrets manager.
- **Recommended next steps:**
  - two-factor sign-in;
  - SMS or push notifications;
  - a retention policy for closed files (state rules often require keeping them 3–5 years);
  - virus scanning of uploads;
  - Postgres plus S3-compatible storage if you need more than one server.
