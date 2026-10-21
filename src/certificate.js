// Appends a "Certificate of Completion" page to a signed PDF, recording who signed, when,
// from where, and the SHA-256 of the exact document they signed.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// Standard PDF fonts only cover WinAnsi; replace anything else so drawing never throws.
const safe = (s) => String(s ?? '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

async function stampCertificate(pdfBytes, { document, property, request, signers, requestedBy }) {
  const pdf = await PDFDocument.load(pdfBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const script = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  let page = pdf.addPage([612, 792]);
  let y = 740;
  const text = (t, { size = 10, f = font, x = 54, color = rgb(0.15, 0.17, 0.22) } = {}) => {
    if (y < 60) { page = pdf.addPage([612, 792]); y = 740; }
    page.drawText(safe(t), { x, y, size, font: f, color });
    y -= size + 6;
  };

  page.drawRectangle({ x: 0, y: 762, width: 612, height: 30, color: rgb(0.09, 0.2, 0.36) });
  page.drawText('ClosingVault', { x: 54, y: 772, size: 12, font: bold, color: rgb(1, 1, 1) });
  text('Certificate of Completion', { size: 20, f: bold });
  y -= 6;
  text(`Document: ${document}`);
  text(`Property: ${property}`);
  text(`Requested by: ${requestedBy} on ${new Date(request.created_at).toUTCString()}`);
  text(`Completed: ${new Date().toUTCString()}`);
  text(`Original document SHA-256: ${request.doc_sha256}`, { size: 8 });
  y -= 10;
  text('Signers', { size: 13, f: bold });
  for (const s of signers) {
    if (y < 160) { page = pdf.addPage([612, 792]); y = 740; }
    page.drawLine({ start: { x: 54, y: y + 4 }, end: { x: 558, y: y + 4 }, thickness: 0.5, color: rgb(0.8, 0.82, 0.86) });
    y -= 22;
    text(s.signed_name, { size: 18, f: script, color: rgb(0.09, 0.2, 0.36) });
    text(`${s.name} <${s.email}>`, { f: bold });
    text(`Signed ${new Date(s.signed_at).toUTCString()}  |  IP ${s.ip || 'unknown'}`, { size: 9 });
    text(`Device: ${(s.user_agent || 'unknown').slice(0, 110)}`, { size: 7 });
  }
  y -= 14;
  text('Each signer authenticated to ClosingVault with their verified email account, reviewed the document,', { size: 8 });
  text('consented to do business electronically, and adopted the typed name above as their signature.', { size: 8 });
  return Buffer.from(await pdf.save());
}

module.exports = { stampCertificate };
