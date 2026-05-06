/**
 * PDF statement parser using PDF.js.
 * Extracts text from PDFs in reading order, then applies the same
 * bank-specific logic as csvParsers.js. Returns the same shape:
 *   { transactions, bank, error }
 *
 * Falls back gracefully — if we extract 0 transactions, the caller
 * (ReconcileDialog) routes to the Claude API fallback.
 */

import * as pdfjsLib from 'pdfjs-dist';

// Point the worker at the bundled copy so it works without a CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

// ── Text extraction ───────────────────────────────────────────────────────────

/**
 * Extract text lines from a PDF File in top-to-bottom, left-to-right order.
 * PDF.js gives us individual text items with XY coordinates — we bucket them
 * into lines by Y position (±4px tolerance) then sort each line by X.
 */
export async function extractPdfLines(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const allLines = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent();

    // Group items into lines by Y coordinate
    const buckets = new Map(); // rounded-Y → [{x, str}]
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      if (!buckets.has(y)) buckets.set(y, []);
      buckets.get(y).push({ x, str: item.str });
    }

    // Sort buckets top→bottom (higher Y = higher on page in PDF coords)
    const sortedYs = [...buckets.keys()].sort((a, b) => b - a);
    for (const y of sortedYs) {
      const items = buckets.get(y).sort((a, b) => a.x - b.x);
      allLines.push(items.map(i => i.str).join(' ').trim());
    }
  }

  return allLines.filter(Boolean);
}

// ── Bank detection from PDF text ──────────────────────────────────────────────

function detectBankFromLines(lines) {
  const sample = lines.slice(0, 30).join(' ').toLowerCase();
  if (sample.includes('chase') || sample.includes('transaction date') && sample.includes('post date')) return 'chase';
  if (sample.includes('american express') || sample.includes('amex') || sample.includes('card member')) return 'amex';
  return 'generic';
}

// ── Shared helpers ────────────────────────────────────────────────────────────

let _seq = 0;
function uid() { return `pdf-${Date.now()}-${++_seq}`; }

function cleanVendor(raw) {
  return raw
    .replace(/\*[A-Z0-9]+/g, '')
    .replace(/\s+#\d+/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+[A-Z]{2}$/, '')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function isTransfer(desc) {
  return /transfer|zelle|venmo|paypal transfer|autopay|online payment|wire|\bpayment\b|direct deposit|ach/i.test(desc);
}

function parseAmount(str) {
  // strip $, commas, handle parenthetical negatives like (12.99)
  const s = str.replace(/[$,]/g, '').replace(/\((.+)\)/, '-$1');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ── Chase PDF parser ──────────────────────────────────────────────────────────
// Chase statement PDFs print transactions as:
//   MM/DD  MM/DD  Description ...  Amount
// where the first date is transaction date, second is post date.

const CHASE_TX_RE = /^(\d{2}\/\d{2})\s+\d{2}\/\d{2}\s+(.+?)\s+(-?\$?[\d,]+\.\d{2})$/;
const CHASE_TX_SIMPLE = /^(\d{2}\/\d{2})\s+(.+?)\s+(-?\$?[\d,]+\.\d{2})$/;

function parseChaseFromLines(lines, fileName) {
  const transactions = [];
  for (const line of lines) {
    const m = line.match(CHASE_TX_RE) || line.match(CHASE_TX_SIMPLE);
    if (!m) continue;
    const [, date, rawDesc, rawAmt] = m;
    const amount = parseAmount(rawAmt);
    if (amount === null || amount <= 0) continue; // skip credits/payments
    const vendor = cleanVendor(rawDesc);
    if (!vendor || isTransfer(vendor)) continue;
    transactions.push({ id: uid(), date, vendor, amount, type: 'purchase', source: fileName });
  }
  return transactions;
}

// ── Amex PDF parser ───────────────────────────────────────────────────────────
// Amex statement PDFs print:
//   MM/DD/YY  Description  $Amount
// or  MM/DD/YYYY  Description  Amount

const AMEX_TX_RE = /^(\d{2}\/\d{2}\/\d{2,4})\s+(.+?)\s+\$?(-?[\d,]+\.\d{2})$/;

function parseAmexFromLines(lines, fileName) {
  const transactions = [];
  for (const line of lines) {
    const m = line.match(AMEX_TX_RE);
    if (!m) continue;
    const [, date, rawDesc, rawAmt] = m;
    const amount = parseAmount(rawAmt);
    if (amount === null || amount <= 0) continue;
    const vendor = cleanVendor(rawDesc);
    if (!vendor || isTransfer(vendor)) continue;
    transactions.push({ id: uid(), date, vendor, amount, type: 'purchase', source: fileName });
  }
  return transactions;
}

// ── Generic PDF parser ────────────────────────────────────────────────────────
// Catches common patterns: any line with a date-like prefix and a dollar amount.

const GENERIC_TX_RE = /^(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)\s+(.+?)\s+\$?([\d,]+\.\d{2})$/;

function parseGenericFromLines(lines, fileName) {
  const transactions = [];
  for (const line of lines) {
    const m = line.match(GENERIC_TX_RE);
    if (!m) continue;
    const [, date, rawDesc, rawAmt] = m;
    const amount = parseAmount(rawAmt);
    if (amount === null || amount <= 0) continue;
    const vendor = cleanVendor(rawDesc);
    if (!vendor || isTransfer(vendor)) continue;
    transactions.push({ id: uid(), date, vendor, amount, type: 'purchase', source: fileName });
  }
  return transactions;
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Parse a PDF bank statement file.
 * Returns { transactions, bank, error, lines } — same shape as parseStatementFile,
 * plus `lines` so the Claude fallback can reuse the extracted text.
 */
export async function parsePdfStatement(file) {
  let lines = [];
  try {
    lines = await extractPdfLines(file);
  } catch (e) {
    return { transactions: [], bank: 'unknown', error: `PDF extraction failed: ${e.message}`, lines };
  }

  if (lines.length === 0) {
    // Likely a scanned/image PDF — signal to caller to try Claude
    return { transactions: [], bank: 'unknown', error: 'scanned', lines };
  }

  const bank = detectBankFromLines(lines);
  let transactions = [];

  try {
    if (bank === 'chase')      transactions = parseChaseFromLines(lines, file.name);
    else if (bank === 'amex')  transactions = parseAmexFromLines(lines, file.name);
    else                       transactions = parseGenericFromLines(lines, file.name);
  } catch (e) {
    return { transactions: [], bank, error: `Parse failed: ${e.message}`, lines };
  }

  return { transactions, bank, error: null, lines };
}
