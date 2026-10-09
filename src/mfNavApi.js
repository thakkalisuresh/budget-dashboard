// ════════════════════════════════════════════════════════════════════════════
// mfNavApi.js — thin client for POST /api/mf-nav (history NAV, INR/USD rate).
// `fetchImpl`/`sleep` are injectable so tests never touch the network. The
// endpoint answers 503/502 with {retryable:true} while AMFI data is loading or
// history sources are down; those (and network failures) are retried.
// ════════════════════════════════════════════════════════════════════════════

const ENDPOINT = '/api/mf-nav';
const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

function mfError(message, retryable) {
  return Object.assign(new Error(message), { retryable });
}

async function call(body, { accessToken, fetchImpl = fetch, sleep = defaultSleep, maxTries = 4 }) {
  let last;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    if (attempt) await sleep(Math.min(8000, 1000 * 2 ** (attempt - 1)));
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      last = mfError(e?.message || 'Network error', true);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    last = mfError(json?.error || `NAV service error (${res.status})`, !!json?.retryable);
    if (!last.retryable) throw last;
  }
  throw last;
}

/** NAV for a scheme on a date → { schemeCode, date, resolvedDate, fellBack, nav, source }. */
export async function fetchMfHistory({ code, date, ...opts }) {
  const json = await call({ action: 'history', code, date }, opts);
  if (!(Number(json?.nav) > 0)) throw mfError('No NAV available for that date', false);
  return json;
}

/** Live INR per 1 USD, or null when unavailable (never throws). */
export async function fetchInrPerUsd(opts) {
  try {
    const json = await call({ action: 'fx' }, { maxTries: 2, ...opts });
    const rate = Number(json?.fx?.rate);
    return rate > 0 ? rate : null;
  } catch {
    return null;
  }
}
