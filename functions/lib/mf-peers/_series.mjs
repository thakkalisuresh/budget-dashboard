/**
 * One scheme's NAV history from mfapi.in, validated before anything is derived
 * from it (research §6 / the validation checklist):
 *   1. the body must parse completely (mfapi silently truncated 2 of 125 first
 *      downloads: HTTP 200 with the JSON cut mid-record);
 *   2. freshness is a LAG TOLERANCE, not equality: mfapi.in trails AMFI's NAVAll by 1-3 days
 *      (weekends, its own refresh schedule), so the newest NAV is accepted when it is at most
 *      MAX_NAV_LAG_DAYS (5 calendar days) older than the NAVAll date; a larger lag is `stale`.
 *      A lag is never retried (it does not fix itself in 5 seconds); only truncated/invalid
 *      bodies and network errors get the one retry;
 *   3. the code must still be live in NAVAll (so a closed/merged code fails loudly).
 * Returns { series, navAllDate, lagDays } or throws SeriesError(kind: 'stale'|'failed').
 */
import { cleanSeries, daysBetween } from './_metrics.mjs';
import { PeersFetchError } from './_http.mjs';

const MFAPI = 'https://api.mfapi.in/mf';
export const RETRY_PAUSE_MS = 5000;
export const MAX_NAV_LAG_DAYS = 5;

export class SeriesError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = 'SeriesError'; this.kind = kind; Object.assign(this, extra); }
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
 * @param {{ navAll: Map<string,{date:string|null}>, client: {getText:Function}, sleep: Function, maxLagDays?: number }} ctx
 */
export async function fetchHistory(code, { navAll, client, sleep, maxLagDays = MAX_NAV_LAG_DAYS }) {
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
    const lagDays = na.date && newest < na.date ? daysBetween(newest, na.date) : 0;
    if (lagDays > maxLagDays) {
      throw new SeriesError('stale', `phase=nav-fetch host=api.mfapi.in newest NAV ${newest} is ${lagDays} days older than AMFI NAVAll ${na.date} (tolerance ${maxLagDays})`, { lagDays });
    }
    return { series: parsed.series, navAllDate: na.date || null, lagDays };
  }
  throw new SeriesError('failed', `${lastProblem} (after 1 retry)`);
}
