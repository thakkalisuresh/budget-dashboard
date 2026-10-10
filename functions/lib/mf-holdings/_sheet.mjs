/**
 * Shared parser for one AMC "monthly portfolio statement" sheet, already turned
 * into a grid (array of arrays) by SheetJS. Every Indian AMC uses the SEBI
 * template — a header row ("Name of the Instrument | ISIN | Industry/Rating |
 * Quantity | Market value | % to AUM"), section headings (Equity, Debt, TREPS,
 * Others...), per-section Total rows and a GRAND TOTAL — so one tolerant parser
 * serves ABSL, SBI and ITI; the per-AMC modules only locate the right sheet and
 * state the house's default weight unit.
 *
 * Asset class comes from the section headings (not ISIN patterns): the sheet
 * tells us whether a line is equity, debt or cash, an ISIN does not.
 *
 * The files are untrusted data: this module only reads cells; nothing here
 * evals, builds paths or formulas from them.
 */

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const TOTAL_RE = /^(sub\s*|derivatives\s*)?total$/i;
const GRAND_RE = /^grand\s*total/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const round = (n, dp) => { const f = 10 ** dp; return Math.round(n * f) / f; };
const text = (c) => (c == null ? '' : String(c).replace(/\s+/g, ' ').trim());

/** Excel 1900-system serial → ISO date (46295 → 2026-09-30). */
export function excelSerialToIso(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * One weight / value cell → number, or null when the cell carries no figure
 * ("NIL", "NA", blank, "-"). "$0.00%" (ABSL's "less than 0.01%" marker) → 0.
 */
export function parseWeightCell(c) {
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  const s = text(c);
  if (!s || /^(nil|na|n\.a\.?|-+)$/i.test(s)) return null;
  const n = Number(s.replace(/[%$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** The portfolio date printed in the sheet's first rows, as ISO, or null. */
export function findAsOf(grid) {
  const top = (grid || []).slice(0, 12);
  for (const row of top) {
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (typeof c === 'number' && c > 30000 && c < 80000 && /as\s+(on|at)/i.test(text(row[i - 1]))) {
        return excelSerialToIso(c);
      }
      if (typeof c !== 'string') continue;
      const m = /as\s+(?:on|at)\s*:?\s*([A-Za-z]+)\s+(\d{1,2})\s*,?\s*(\d{4})/i.exec(c);
      if (m) {
        const mi = MONTHS.indexOf(m[1].toLowerCase());
        if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
      }
      const n = /as\s+(?:on|at)\s*:?\s*(\d{1,2})[-./](\d{1,2})[-./](\d{4})/i.exec(c);
      if (n) return `${n[3]}-${n[2].padStart(2, '0')}-${n[1].padStart(2, '0')}`;
    }
  }
  return null;
}

/** First few rows' text, upper-cased, for scheme-title verification. */
export function headerText(grid) {
  return (grid || []).slice(0, 6).flat().map(text).filter(Boolean).join(' | ').toUpperCase();
}

/** Section heading → asset class (first match wins), or null for neutral headings. */
const SECTION_RULES = [
  [/^derivatives?\b/i, 'derivative'],
  [/treps|reverse repo|\bcblo\b|other current assets|net receivable|net current assets|short term deposit|term deposits? placed|fixed deposit/i, 'cash'],
  [/^equity\b|equity (&|and) equity|foreign securities|overseas/i, 'equity'],
  [/^debt\b|money market|government securit|non[- ]?convertible|treasury bill|commercial paper|certificate of deposit|securiti[sz]ed|\bstrips\b|bills re/i, 'debt'],
  [/mutual fund|exchange traded|alternative investment|\binvit\b|\breit\b|infrastructure investment|real estate investment|\bgold\b|^others?$/i, 'other'],
];

function sectionClass(label) {
  for (const [re, cls] of SECTION_RULES) if (re.test(label)) return cls;
  return null;
}

/** Line-level override: cash-like lines are cash wherever they sit; INF* ISINs are fund units. */
function lineClass(label, isin) {
  if (/treps|reverse repo|\bcblo\b|net receivable|net current assets|margin amount|other current assets/i.test(label)) return 'cash';
  if (isin.startsWith('INF')) return 'other';
  return null;
}

const COL_RULES = {
  name: /name of the instrument|issuer/i,
  isin: /^isin\b/i,
  industry: /industry|rating/i,
  qty: /^quantity/i,
  mv: /market|fair value/i,
  pct: /^%\s*to/i,
  side: /^long\s*\/\s*short/i,
};

/** A row is the header when it names the instrument column and a % column. */
function headerColumns(row) {
  const cells = row.map(text);
  if (!cells.some(c => COL_RULES.name.test(c)) || !cells.some(c => COL_RULES.pct.test(c))) return null;
  const cols = {};
  for (const [k, re] of Object.entries(COL_RULES)) {
    const idx = cells.findIndex(c => re.test(c));
    cols[k] = idx;
  }
  return cols;
}

/**
 * Parse one scheme sheet.
 * @param {Array<Array>} grid
 * @param {{ defaultUnit?: 'fraction'|'percent' }} opts  the house's usual weight unit;
 *   overridden when the sheet's own GRAND TOTAL shows the other (the cheapest
 *   defence against a silent fraction↔percent mix-up).
 * @returns {{ asOf, rows, unit, unitSource, sawGrandTotal, grandPct, unclassifiedPct, dropped }}
 */
export function parseHoldingsSheet(grid, { defaultUnit = 'percent' } = {}) {
  const asOf = findAsOf(grid);
  const raw = [];                // pre-normalisation, one per data line
  let cols = null;
  let section = null;            // current asset class from the latest classifying heading
  let live = true;               // false after the first GRAND TOTAL, until a DERIVATIVES heading
  let derivatives = false;
  let grandRaw = null;
  let dropped = 0;

  for (const row of grid || []) {
    if (!Array.isArray(row)) continue;
    const header = headerColumns(row);
    if (header) { cols = header; continue; }
    if (!cols) continue;

    const label = text(row[cols.name]);
    const pct = cols.pct >= 0 ? parseWeightCell(row[cols.pct]) : null;

    if (GRAND_RE.test(label)) {
      if (!derivatives && grandRaw == null && pct != null) grandRaw = pct;
      live = false;
      continue;
    }
    if (!label && pct == null) continue;
    if (TOTAL_RE.test(label)) continue;

    if (pct == null) {
      // A heading (or a "NIL" placeholder row).
      if (/^derivatives?$/i.test(label)) { derivatives = true; live = true; section = 'derivative'; continue; }
      if (!live) continue;
      const cls = sectionClass(label);
      if (cls) section = cls;
      continue;
    }
    if (!live) continue;

    const isinCell = text(row[cols.isin]).toUpperCase();
    const isin = ISIN_RE.test(isinCell) ? isinCell : '';
    if (pct === 0) { dropped++; continue; }

    let assetClass = derivatives ? 'derivative' : (lineClass(label, isin) || section);
    const unclassified = !assetClass;
    if (unclassified) assetClass = 'other';

    let weight = pct;
    if (derivatives && cols.side >= 0 && /short/i.test(text(row[cols.side]))) weight = -Math.abs(weight);

    const mv = cols.mv >= 0 ? parseWeightCell(row[cols.mv]) : null;
    const industry = cols.industry >= 0 && typeof row[cols.industry] === 'string' ? text(row[cols.industry]) : '';
    raw.push({ isin, name: label || isin, industry, assetClass, weight, mv, unclassified });
  }

  // Unit: trust the sheet's own grand total over the house default.
  let unit = defaultUnit;
  let unitSource = 'default';
  if (grandRaw != null) {
    if (grandRaw > 0.5 && grandRaw < 1.5) { unit = 'fraction'; unitSource = 'grand-total'; }
    else if (grandRaw > 50 && grandRaw < 150) { unit = 'percent'; unitSource = 'grand-total'; }
  }
  const scale = unit === 'fraction' ? 100 : 1;

  // Aggregate duplicate lines (same ISIN + class; ISIN-less lines by name + class).
  const agg = new Map();
  let unclassifiedPct = 0;
  for (const r of raw) {
    const w = r.weight * scale;
    if (r.unclassified) unclassifiedPct += Math.abs(w);
    const key = `${r.isin || `n:${r.name.toLowerCase()}`}|${r.assetClass}`;
    const hit = agg.get(key);
    if (!hit) {
      agg.set(key, { isin: r.isin, name: r.name, industry: r.industry, assetClass: r.assetClass, weightPct: w, marketValueInrLakh: r.mv });
      continue;
    }
    hit.weightPct += w;
    if (r.mv != null) hit.marketValueInrLakh = (hit.marketValueInrLakh ?? 0) + r.mv;
    if (!hit.name.split(' / ').includes(r.name)) hit.name += ` / ${r.name}`;
    if (!hit.industry && r.industry) hit.industry = r.industry;
  }
  const rows = [...agg.values()]
    .map(r => ({ ...r, weightPct: round(r.weightPct, 6), marketValueInrLakh: r.marketValueInrLakh == null ? null : round(r.marketValueInrLakh, 2) }))
    .filter(r => r.weightPct !== 0);

  return {
    asOf,
    rows,
    unit,
    unitSource,
    sawGrandTotal: grandRaw != null,
    grandPct: grandRaw == null ? null : round(grandRaw * scale, 6),
    unclassifiedPct: round(unclassifiedPct, 6),
    dropped,
  };
}
