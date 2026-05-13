/**
 * CSV parsers for bank statement reconciliation.
 * Supported: Chase, Amex, Generic (auto-detected by headers).
 * All output transactions follow the same shape:
 *   { id, date, vendor, rawVendor, amount, type, bank, sourceFile }
 */

// ── Raw CSV text → 2D array ───────────────────────────────────────────────────

export function parseCSVText(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  return lines.map(line => {
    const result = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cell += '"'; i++; } // escaped quote
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(cell.trim());
        cell = '';
      } else {
        cell += ch;
      }
    }
    result.push(cell.trim());
    return result;
  }).filter(row => row.some(c => c !== ''));
}

// ── Bank detection ────────────────────────────────────────────────────────────

export function detectBank(headers) {
  const h = headers.map(s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim());
  if (h.includes('transaction date') && h.includes('post date')) return 'chase';
  if (h.includes('date') && h.includes('description') && h.includes('amount') &&
      (h.includes('card member') || h.includes('extended details') || h.includes('reference'))) return 'amex';
  return 'generic';
}

// ── Date normalisation ────────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null;
  // MM/DD/YYYY
  const m1 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) return `${m1[3]}-${m1[1].padStart(2,'0')}-${m1[2].padStart(2,'0')}`;
  // YYYY-MM-DD
  const m2 = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return str;
  return null;
}

// ── Vendor name cleaning ──────────────────────────────────────────────────────

function cleanVendor(raw) {
  if (!raw) return '';
  let v = raw
    .replace(/\*[A-Z0-9]+/g, '')             // remove asterisk codes  e.g. AMZN*AB12C
    .replace(/\s+#\d+/g, '')                  // remove store numbers   e.g. WHOLEFDS #1234
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Remove trailing US city/state fragments like "SAN FRANCISCO CA"
  v = v.replace(/\s+[A-Z]{2}$/, '').trim();
  // Title-case
  return v.replace(/\b\w/g, c => c.toUpperCase());
}

// ── Transfer / payment detection ─────────────────────────────────────────────

const TRANSFER_PATTERNS = [
  /transfer/i, /\bzelle\b/i, /venmo/i, /paypal transfer/i,
  /ach/i, /direct deposit/i, /autopay/i, /online payment/i,
  /wire/i, /\bpayment\b/i,
];

function isTransfer(description, chaseType = '') {
  if (chaseType.toLowerCase() === 'payment') return true;
  return TRANSFER_PATTERNS.some(re => re.test(description));
}

// ── Transaction type ──────────────────────────────────────────────────────────

function resolveType(amount, rawAmount, description, chaseType = '') {
  if (isTransfer(description, chaseType)) return 'transfer';
  if (amount < 0) return 'credit';        // refund / credit
  return 'purchase';
}

// ── ID generator ──────────────────────────────────────────────────────────────

let _seq = 0;
function uid() { return `tx-${Date.now()}-${++_seq}`; }

// ── Chase parser ──────────────────────────────────────────────────────────────
// Headers: Transaction Date, Post Date, Description, Category, Type, Amount, Memo

export function parseChase(rows, fileName) {
  const [headerRow, ...dataRows] = rows;
  const h = headerRow.map(s => s.toLowerCase().trim());
  const col = key => h.indexOf(key);

  const dateIdx   = col('transaction date');
  const descIdx   = col('description');
  const typeIdx   = col('type');
  const amountIdx = col('amount');

  if (dateIdx < 0 || descIdx < 0 || amountIdx < 0) return [];

  return dataRows.map(row => {
    const rawAmount  = parseFloat((row[amountIdx] || '0').replace(/[$,]/g, ''));
    const rawVendor  = (row[descIdx] || '').trim();
    const chaseType  = (row[typeIdx] || '').trim();
    const amount     = Math.abs(rawAmount);
    const type       = resolveType(rawAmount, rawAmount, rawVendor, chaseType);

    return {
      id: uid(),
      date:       parseDate(row[dateIdx]),
      vendor:     cleanVendor(rawVendor),
      rawVendor,
      amount,
      type,
      bank:       'chase',
      sourceFile: fileName,
    };
  }).filter(t => t.date && t.amount > 0);
}

// ── Amex parser ───────────────────────────────────────────────────────────────
// Old format: Date, Description, Amount
// New format: Date, Description, Amount, Extended Details, ..., Card Member, ..., Category

export function parseAmex(rows, fileName) {
  const [headerRow, ...dataRows] = rows;
  const h = headerRow.map(s => s.toLowerCase().trim());
  const col = key => h.indexOf(key);

  const dateIdx   = col('date');
  const descIdx   = col('description');
  const amountIdx = col('amount');

  if (dateIdx < 0 || descIdx < 0 || amountIdx < 0) return [];

  return dataRows.map(row => {
    // Amex: positive = charge, negative = credit
    const rawAmount = parseFloat((row[amountIdx] || '0').replace(/[$,]/g, ''));
    const rawVendor = (row[descIdx] || '').trim();
    const amount    = Math.abs(rawAmount);
    const type      = resolveType(rawAmount, rawAmount, rawVendor);

    return {
      id: uid(),
      date:       parseDate(row[dateIdx]),
      vendor:     cleanVendor(rawVendor),
      rawVendor,
      amount,
      type,
      bank:       'amex',
      sourceFile: fileName,
    };
  }).filter(t => t.date && t.amount > 0);
}

// ── Generic parser ────────────────────────────────────────────────────────────
// Best-effort: find date-like, description-like, and amount-like columns by name.

export function parseGeneric(rows, fileName) {
  const [headerRow, ...dataRows] = rows;
  const h = headerRow.map(s => s.toLowerCase().trim());

  // Find best-guess columns
  const dateIdx = h.findIndex(c =>
    c.includes('date') || c.includes('time') || c.includes('posted'));
  const amountIdx = h.findIndex(c =>
    c === 'amount' || c === 'debit' || c === 'charge' || c.includes('amount'));
  const descIdx = h.findIndex(c =>
    c === 'description' || c === 'memo' || c === 'payee' ||
    c === 'merchant' || c === 'name' || c.includes('desc'));

  if (dateIdx < 0 || amountIdx < 0 || descIdx < 0) return [];

  return dataRows.map(row => {
    const rawAmount = parseFloat((row[amountIdx] || '0').replace(/[$,()]/g, ''));
    const rawVendor = (row[descIdx] || '').trim();
    const amount    = Math.abs(rawAmount);
    const type      = resolveType(rawAmount, rawAmount, rawVendor);

    return {
      id: uid(),
      date:       parseDate(row[dateIdx]),
      vendor:     cleanVendor(rawVendor),
      rawVendor,
      amount,
      type,
      bank:       'generic',
      sourceFile: fileName,
    };
  }).filter(t => t.date && t.amount > 0);
}

// ── Main entry — parse a single file's text ───────────────────────────────────

export function parseStatementFile(text, fileName) {
  const rows = parseCSVText(text);
  if (rows.length < 2) return { transactions: [], bank: 'unknown', error: 'File appears empty or unreadable.' };

  const bank = detectBank(rows[0]);

  let transactions = [];
  try {
    if (bank === 'chase')   transactions = parseChase(rows, fileName);
    else if (bank === 'amex') transactions = parseAmex(rows, fileName);
    else                    transactions = parseGeneric(rows, fileName);
  } catch (e) {
    return { transactions: [], bank, error: `Failed to parse: ${e.message}` };
  }

  return { transactions, bank, error: null };
}
