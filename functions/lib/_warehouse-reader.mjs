/**
 * Read a whole month out of Sheets, in the shape the warehouse needs.
 *
 * Shared by the backfill and the reconciler so there is exactly one definition
 * of "what is in this month". Two of them would drift, and the reconciler would
 * start reporting differences that were only differences of opinion.
 *
 * ── The one rule ──────────────────────────────────────────────────────────
 *
 * **A partial read is a failed read.** If any range in the month fails, the
 * whole month is abandoned. The reconciler's job is to notice rows that have
 * vanished; handed an incomplete snapshot it would conclude that every row it
 * failed to read had been deleted, and write that permanently into an
 * append-only table. `readMonth` therefore throws rather than returning
 * whatever it managed to get.
 */
import { toCents } from './_warehouse.mjs';
import { headerMatchesV2 } from './_warehouse-verify.mjs';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Tabs that are never transactional. Skipped without comment or audit row. */
export const NON_TRANSACTIONAL_TABS = new Set([
  'Totals', '50/30/20', 'UserSettings', 'History', 'Non-Monthly Expenses',
  'Cards Summary', 'By Person', 'Months',
]);

export const TRAVEL_TABS = new Set(['Travel', 'Holiday']);

/** Travel/Holiday put Booking Method at G and the uuid at H; everything else G. */
export function uuidColumnFor(tab) {
  return TRAVEL_TABS.has(tab) ? 7 : 6;
}

/**
 * One V2 data row → the warehouse's view of it.
 *
 * A row is "data" if it has a vendor or an amount; the FORMULA render returns
 * formula-only rows (a `=SUM(...)` totals row) that look populated but are not.
 */
export function parseV2Row(cells, tab, rowIndex) {
  const c = cells || [];
  const vendor = c[3];
  const amountRaw = c[4];
  if ((vendor === undefined || vendor === '') && (amountRaw === undefined || amountRaw === '')) return null;
  return {
    rowIndex,
    budgetDate: typeof c[2] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c[2].trim()) ? c[2].trim() : null,
    vendor: vendor === undefined ? null : String(vendor),
    amountCents: toCents(amountRaw),
    paymentMethod: c[5] === undefined ? '' : String(c[5]),
    bookingMethod: TRAVEL_TABS.has(tab) ? (c[6] === undefined ? '' : String(c[6])) : '',
    uuid: c[uuidColumnFor(tab)] ? String(c[uuidColumnFor(tab)]) : null,
  };
}

/**
 * Turn a raw `Totals` grid into per-category spend and budget.
 *
 * Col C must be read at FORMULA render, not UNFORMATTED_VALUE: the budget
 * literal exists ONLY inside the string `=1200-B4`, and the evaluated value is
 * the remainder, which is a different number.
 */
export function parseTotals(rows) {
  const spentCents = {};
  const budgets = [];
  (rows || []).forEach((row, i) => {
    const name = String(row?.[0] ?? '').trim();
    if (!name) return;
    const rowNum = i + 2; // the grid starts at Totals!A2
    const spent = toCents(row?.[1]);
    spentCents[name] = spent ?? 0;
    budgets.push({ category: name, totalsRowNum: rowNum, formulaRaw: row?.[2] ?? null, spentCents: spent ?? 0 });
  });
  return { spentCents, budgets };
}

/**
 * Read every transactional tab plus Totals for one month.
 *
 * `fetchJson(path)` is injected so this can be unit-tested and so the caller
 * decides how it authenticates (the backend uses the Drive service token).
 *
 * Throws on ANY failed range — see the header.
 */
export async function readMonth({ spreadsheetId, budgetMonth, fetchJson }) {
  const meta = await fetchJson(`/${spreadsheetId}?fields=sheets.properties.title`);
  const tabs = (meta.sheets || [])
    .map(s => s.properties?.title)
    .filter(t => t && !NON_TRANSACTIONAL_TABS.has(t));

  const categories = [];
  for (const tab of tabs) {
    const range = encodeURIComponent(`'${tab}'!A1:H10000`);
    // No try/catch on purpose: a failed range must abort the month.
    const data = await fetchJson(`/${spreadsheetId}/values/${range}?valueRenderOption=FORMULA`);
    const grid = data.values || [];
    const header = grid[0] || [];

    // A tab whose header doesn't match the V2 contract is skipped rather than
    // guessed at. addCategory writes a 5-column header with no uuid, so custom
    // categories land here — and they are excluded from BOTH sides of the
    // month_sum gate, or the month could never balance.
    if (!headerMatchesV2(header, { travel: TRAVEL_TABS.has(tab) })) {
      categories.push({ category: tab, skipped: true, dataRowCount: 0, rows: [] });
      continue;
    }

    const rows = [];
    for (let i = 1; i < grid.length; i++) {
      const parsed = parseV2Row(grid[i], tab, i + 1);
      if (parsed) rows.push(parsed);
    }
    categories.push({ category: tab, skipped: false, dataRowCount: rows.length, rows });
  }

  const totalsRange = encodeURIComponent("'Totals'!A2:C21");
  const totalsData = await fetchJson(`/${spreadsheetId}/values/${totalsRange}?valueRenderOption=FORMULA`);
  const { spentCents, budgets } = parseTotals(totalsData.values || []);

  return { spreadsheetId, budgetMonth, categories, totalsSpentCents: spentCents, budgets };
}

/** `fetchJson` bound to the backend's Drive service token. */
export function serviceFetchJson(getAccessToken) {
  return async (path) => {
    const token = await getAccessToken();
    const res = await fetch(`${SHEETS_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Sheets API (${res.status}) on ${path}: ${err.error?.message || 'unknown'}`);
    }
    return res.json();
  };
}
