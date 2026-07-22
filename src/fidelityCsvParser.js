// ════════════════════════════════════════════════════════════════════════════
// fidelityCsvParser.js — turn Fidelity CSV exports into Activities rows.
//
// Two export shapes are supported, auto-detected by header:
//   • Positions ("Portfolio_Positions_*.csv"): Symbol, Quantity, Average Cost
//     Basis … → one synthetic opening BUY per symbol (lot date = as-of date),
//     used for first-time seeding when full history isn't at hand.
//   • Activity/History ("History_for_Account_*.csv" / Accounts_History.csv):
//     Run Date, Action, Symbol, Quantity, Price, Amount … → real BUY / SELL /
//     DIVIDEND / DEPOSIT / INTEREST rows.
//
// Fidelity files carry junk: disclaimer paragraphs after the data, blank
// lines, "Pending Activity" rows, quoted fields with commas. The parser is
// deliberately tolerant — rows it can't understand are skipped and counted.
// ════════════════════════════════════════════════════════════════════════════
import { parseCSVText } from './csvParsers.js';

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[$,()]/g, ''));
  return isNaN(n) ? 0 : n;
};

/** 'MM/DD/YYYY' → 'YYYY-MM-DD'; passes ISO through; '' when unparseable. */
function isoDate(v) {
  const s = String(v || '').trim();
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return '';
}

const clean = (h) => String(h || '').toLowerCase().replace(/[^a-z ]/g, '').trim();

function headerIndex(headers) {
  const h = headers.map(clean);
  const find = (...names) => h.findIndex(c => names.some(n => c === n || c.startsWith(n)));
  return { h, find };
}

/** Classify a Fidelity Action string into an Activities type, or null to skip. */
export function classifyAction(action) {
  const a = String(action || '').toUpperCase();
  if (!a) return null;
  if (a.includes('YOU BOUGHT') || a.includes('REINVESTMENT')) return 'BUY';
  if (a.includes('YOU SOLD')) return 'SELL';
  if (a.includes('DIVIDEND')) return 'DIVIDEND';
  if (a.includes('INTEREST')) return 'INTEREST';
  if (a.includes('ELECTRONIC FUNDS TRANSFER RECEIVED') || a.includes('DEPOSIT') ||
      a.includes('CONTRIBUTION') || a.includes('TRANSFER OF ASSETS')) return 'DEPOSIT';
  if (a.includes('ELECTRONIC FUNDS TRANSFER PAID') || a.includes('WITHDRAWAL')) return 'WITHDRAW';
  if (a.includes('FEE')) return 'FEE';
  return null;
}

function parseActivityRows(rows, headerRowIdx, accountId) {
  const headers = rows[headerRowIdx];
  const { find } = headerIndex(headers);
  const iDate = find('run date', 'date');
  const iAction = find('action');
  const iSymbol = find('symbol');
  const iQty = find('quantity');
  const iPrice = find('price');
  const iAmount = find('amount');

  const activities = [];
  let skipped = 0;

  for (const row of rows.slice(headerRowIdx + 1)) {
    const date = isoDate(row[iDate]);
    if (!date) { if (row.some(c => c)) skipped++; continue; } // disclaimer/blank tail
    const type = classifyAction(row[iAction]);
    if (!type) { skipped++; continue; }

    const symbol = String(row[iSymbol] || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
    const qty = Math.abs(num(row[iQty]));
    const price = num(row[iPrice]);
    const amount = Math.abs(num(row[iAmount]));

    if ((type === 'BUY' || type === 'SELL') && (!symbol || qty <= 0)) { skipped++; continue; }

    activities.push({
      date, accountId, type,
      symbol: (type === 'BUY' || type === 'SELL' || type === 'DIVIDEND') ? symbol : '',
      qty: (type === 'BUY' || type === 'SELL') ? qty : '',
      price: (type === 'BUY' || type === 'SELL') ? price : '',
      amount: amount || (qty && price ? +(qty * price).toFixed(2) : ''),
      note: String(row[iAction] || '').trim().slice(0, 120),
    });
  }
  return { kind: 'activity', activities, skipped };
}

function parsePositionRows(rows, headerRowIdx, accountId, asOfDate) {
  const headers = rows[headerRowIdx];
  const { find } = headerIndex(headers);
  const iSymbol = find('symbol');
  const iQty = find('quantity');
  const iAvg = find('average cost basis', 'average cost');
  const iCostTotal = find('cost basis total', 'cost basis');

  const activities = [];
  let skipped = 0;
  const date = asOfDate || new Date().toISOString().slice(0, 10);

  for (const row of rows.slice(headerRowIdx + 1)) {
    const symbol = String(row[iSymbol] || '').trim().toUpperCase().replace(/[^A-Z0-9.]/g, '');
    const qty = num(row[iQty]);
    // Skip cash sweep (SPAXX**), "Pending Activity", totals, and disclaimer tail
    if (!symbol || symbol.includes('PENDING') || /\*\*$/.test(String(row[iSymbol] || '').trim()) || qty <= 0) {
      if (row.some(c => c)) skipped++;
      continue;
    }
    let price = num(row[iAvg]);
    if (price <= 0 && iCostTotal >= 0) {
      const totalCost = num(row[iCostTotal]);
      if (totalCost > 0) price = +(totalCost / qty).toFixed(4);
    }
    activities.push({
      date, accountId, type: 'BUY', symbol, qty,
      price, amount: +(qty * price).toFixed(2),
      note: 'Seeded from Fidelity positions export',
    });
  }
  return { kind: 'positions', activities, skipped };
}

/**
 * Parse a Fidelity CSV export (text) into Activities rows.
 * Returns { kind: 'activity'|'positions', activities, skipped, error }.
 */
export function parseFidelityCsv(text, { accountId = 'fidelity', asOfDate } = {}) {
  const rows = parseCSVText(String(text || ''));
  if (rows.length < 2) return { kind: 'unknown', activities: [], skipped: 0, error: 'File appears empty.' };

  // The header row isn't always first — Fidelity sometimes prepends title lines.
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const h = rows[i].map(clean);
    const hasSymbol = h.some(c => c === 'symbol');
    if (hasSymbol && h.some(c => c.startsWith('run date') || c === 'action')) {
      return parseActivityRows(rows, i, accountId);
    }
    if (hasSymbol && h.some(c => c.startsWith('quantity')) &&
        h.some(c => c.includes('cost basis') || c.includes('current value'))) {
      return parsePositionRows(rows, i, accountId, asOfDate);
    }
  }
  return { kind: 'unknown', activities: [], skipped: 0, error: 'Not a recognised Fidelity export (need a positions or activity CSV).' };
}
