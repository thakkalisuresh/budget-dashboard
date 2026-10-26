/**
 * AMFI TER feed (www.amfiindia.com/api, undocumented UI backend) → per-scheme
 * TER for the tracked codes.
 *
 * The feed has one row per scheme per DAY (Regular R_* and Direct D_* side by
 * side), 100 rows/page, sorted by scheme name then date, and no AMFI scheme
 * code: it is joined to our codes by NORMALISED SCHEME NAME and must match
 * exactly one scheme (else matched=FALSE with a reason, never a guess). A
 * failure to reach the feed is per-scheme matched=FALSE + reason, never a job failure.
 */
import { PeersFetchError } from './_http.mjs';
import { TER_NAME_ALIAS, KNOWN_NO_TER } from './_seed.mjs';

const API = 'https://www.amfiindia.com/api';
/** Hardcoded fallbacks (Oct 2026): Small Cap 77, Flexi Cap 78, Retirement 48, Thematic 84. */
export const FALLBACK_CATEGORY_IDS = [77, 78, 48, 84];
const PARENTS = ['Equity Schemes', 'Equity Scheme', 'Solution Oriented Scheme', 'Solution Oriented Schemes'];
const WANTED_SUBS = new Set(['small cap fund', 'flexi cap fund', 'retirement fund', 'thematic fund', 'sectoral/ thematic']);
const MAX_PAGES = 15;

export const normName = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\b(fund|plan|scheme)\b/g, ' ').replace(/\s+/g, ' ').trim();

/** rows → Map(normName → [latest row per distinct NSDLSchemeCode]); rows dated after `today` are ignored. */
export function indexTerRows(rows, today) {
  const best = new Map();
  for (const r of rows || []) {
    const d = String(r.TER_Date || '').slice(0, 10);
    if (!r.NSDLSchemeCode || !d || d > today) continue;
    const cur = best.get(r.NSDLSchemeCode);
    if (!cur || d > String(cur.TER_Date).slice(0, 10)) best.set(r.NSDLSchemeCode, r);
  }
  const by = new Map();
  for (const r of best.values()) { const k = normName(r.Scheme_Name); by.set(k, [...(by.get(k) || []), r]); }
  return by;
}

const pct = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/**
 * Join one scheme plan to the feed. `directCode` selects the alias; the join must
 * be one-to-one (an alias that collides with another scheme is ambiguous too).
 * @returns {{matched:boolean, terPct:number|null, berPct:number|null, matchedName:string, terDate:string, reason:string}}
 */
export function matchTer(index, { name, directCode }, plan) {
  const key = normName(TER_NAME_ALIAS[directCode] || name);
  const hits = index.get(key) || [];
  const none = (reason) => ({ matched: false, terPct: null, berPct: null, matchedName: '', terDate: '', reason });
  if (hits.length === 0) return none(KNOWN_NO_TER.has(String(directCode)) ? 'not in the AMFI TER feed (known gap)' : 'no scheme with this name in the AMFI TER feed');
  if (hits.length > 1) return none(`ambiguous: ${hits.length} feed schemes share this name`);
  const r = hits[0]; const p = plan === 'direct' ? 'D' : 'R';
  const terPct = pct(r[`${p}_TER`]);
  if (terPct == null) return none('feed row has no TER value');
  return { matched: true, terPct, berPct: pct(r[`${p}_BER`]), matchedName: r.Scheme_Name, terDate: String(r.TER_Date).slice(0, 10), reason: '' };
}

async function getJson(client, path) {
  const { text } = await client.getText(`${API}/${path}`, { phase: 'ter', accept: 'application/json' });
  try { return JSON.parse(text); } catch { throw new PeersFetchError({ phase: 'ter', host: 'www.amfiindia.com', detail: 'response was not valid JSON' }); }
}

/** Resolve the strCat ids for the wanted sub-categories under both AMFI label families; fall back to constants. */
export async function resolveCategoryIds(client, notes) {
  const ids = new Set();
  for (const parent of PARENTS) {
    try {
      const list = await getJson(client, `populate-sub-category?category=${encodeURIComponent(parent)}`);
      for (const c of Array.isArray(list) ? list : []) {
        if (WANTED_SUBS.has(String(c.SubCat_Desc || '').trim().toLowerCase()) && Number.isFinite(Number(c.SchemeCat_Id))) ids.add(Number(c.SchemeCat_Id));
      }
    } catch (e) { notes.push(`category lookup "${parent}": ${e.message}`); }
  }
  if (!ids.size) { notes.push('category ids unresolved; using the fallback ids'); return [...FALLBACK_CATEGORY_IDS]; }
  return [...ids];
}

/** All feed rows for one month across the given category ids. A failing category is noted and skipped. */
export async function fetchTerMonth(client, month, ids, notes) {
  const rows = [];
  for (const id of ids) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const j = await getJson(client, `populate-te-rdata-revised?MF_ID=All&Month=${month}&strCat=${id}&strType=1&page=${page}&pageSize=100`);
        rows.push(...(Array.isArray(j?.data) ? j.data : []));
        if (page >= (Number(j?.meta?.pageCount) || 0)) break;
      } catch (e) { notes.push(`${month} category ${id} page ${page}: ${e.message}`); break; }
    }
  }
  return rows;
}

export const monthKey = (iso) => `${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
export function prevMonthKey(iso) {
  const [y, m] = iso.split('-').map(Number);
  return m === 1 ? `12-${y - 1}` : `${String(m - 1).padStart(2, '0')}-${y}`;
}

/**
 * Pull the feed for `today` (IST ISO date) and return { index, notes }.
 * The previous month is added only when a tracked scheme found no row in the current one.
 * @param {Array<{name:string, directCode:string}>} schemes  distinct tracked schemes
 */
export async function loadTerIndex(client, today, schemes) {
  const notes = [];
  const ids = await resolveCategoryIds(client, notes);
  let rows = await fetchTerMonth(client, monthKey(today), ids, notes);
  let index = indexTerRows(rows, today);
  const missing = schemes.filter((s) => !KNOWN_NO_TER.has(String(s.directCode)) && !matchTer(index, s, 'direct').matched);
  if (missing.length && rows.length) {
    rows = rows.concat(await fetchTerMonth(client, prevMonthKey(today), ids, notes));
    index = indexTerRows(rows, today);
  }
  return { index, notes, rowCount: rows.length };
}
