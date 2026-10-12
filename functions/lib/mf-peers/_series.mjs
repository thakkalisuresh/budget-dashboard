/**
 * One scheme's NAV history from mfapi.in, validated before anything is derived
 * from it (research §6 / the validation checklist):
 *   1. the body must parse completely (mfapi silently truncated 2 of 125 first
 *      downloads: HTTP 200 with the JSON cut mid-record);
 *   2. data[0].date must be >= the NAVAll date for that code; otherwise one
 *      retry after a pause, then the caller keeps the last good row and marks it stale;
 *   3. the code must still be live in NAVAll (so a closed/merged code fails loudly).
 * Returns { series, navAllDate } or throws SeriesError(kind: 'stale'|'failed').
 */
import { cleanSeries } from './_metrics.mjs';
import { PeersFetchError } from './_http.mjs';

const MFAPI = 'https://api.mfapi.in/mf';
export const RETRY_PAUSE_MS = 5000;

export class SeriesError extends Error {
  constructor(kind, message) { super(message); this.name = 'SeriesError'; this.kind = kind; }
}

const dmyToIso = (s) => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

/** Parse an mfapi body. Throws a plain Error('truncated or invalid JSON') on anything incomplete. */
export function parseMfapiBody(text) {
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('truncated or invalid JSON body'); }
  if (!json || !Array.isArray(json.data)) throw new Error('response has no data array');
  const series = cleanSeries(json.data.map((r) => ({ date: dmyToIso(r?.date), nav: parseFloat(r?.nav) })));
  if (!series.length) throw new Error('no usable NAV rows');
  return { series, meta: json.meta || null };
}

/**
 * @param {string} code
 * @param {{ navAll: Map<string,{date:string|null}>, client: {getText:Function}, sleep: Function }} ctx
 */
export async function fetchHistory(code, { navAll, client, sleep }) {
  const na = navAll.get(String(code));
  if (!na) throw new SeriesError('failed', `phase=nav-check code ${code} is not in AMFI NAVAll (closed, merged or renamed?)`);
  let lastProblem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(RETRY_PAUSE_MS);
    let parsed;
    try {
      const { text } = await client.getText(`${MFAPI}/${code}`, { phase: 'nav-fetch', accept: 'application/json' });
      parsed = parseMfapiBody(text);
    } catch (e) {
      lastProblem = e instanceof PeersFetchError ? e.message : `phase=nav-fetch host=api.mfapi.in ${e.message}`;
      continue;
    }
    const newest = parsed.series[parsed.series.length - 1].date;
    if (na.date && newest < na.date) { lastProblem = `phase=nav-fetch host=api.mfapi.in newest NAV ${newest} is older than AMFI NAVAll ${na.date}`; continue; }
    return { series: parsed.series, navAllDate: na.date || null };
  }
  const lag = /older than AMFI NAVAll/.test(lastProblem);
  throw new SeriesError(lag ? 'stale' : 'failed', `${lastProblem} (after 1 retry)`);
}
