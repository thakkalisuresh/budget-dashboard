/**
 * Polite HTTP for the peers job: honest User-Agent, at most one request per
 * second per host, a timeout on every request, a response-size cap. Every
 * failure carries a diagnosable message: phase, host, HTTP status and the
 * underlying cause code (err.cause.code / message) — a bare "fetch failed" was
 * not diagnosable from Cloud Logging. fetch/sleep are injectable for tests.
 */
export const USER_AGENT = 'Fundient-household-dashboard/1.0 (private personal use)';
export const MIN_GAP_MS = 1000;
export const TIMEOUT_MS = 30_000;
export const MAX_BYTES = 8_000_000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PeersFetchError extends Error {
  /** @param {{phase:string, host:string, status?:number, cause?:string, detail?:string}} d */
  constructor(d) {
    const parts = [`phase=${d.phase}`, `host=${d.host}`];
    if (d.status) parts.push(`status=${d.status}`);
    if (d.cause) parts.push(`cause=${d.cause}`);
    if (d.detail) parts.push(d.detail);
    super(parts.join(' '));
    this.name = 'PeersFetchError';
    Object.assign(this, d);
  }
}

/** "ECONNRESET: read ECONNRESET" from a fetch TypeError('fetch failed') chain. */
export function causeOf(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const c = e?.cause;
  const code = c?.code || e?.code;
  const msg = c?.message || e?.message || 'network error';
  return code ? `${code}: ${msg}` : msg;
}

export function makeClient({ fetchImpl = fetch, sleep = defaultSleep, minGapMs = MIN_GAP_MS, timeoutMs = TIMEOUT_MS } = {}) {
  const lastAt = new Map();
  /** GET → { status, text }. Non-2xx and network errors throw PeersFetchError (404 included: callers decide). */
  async function getText(url, { phase, accept = '*/*', maxBytes = MAX_BYTES } = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new PeersFetchError({ phase, host: u.hostname, detail: 'refusing non-https URL' });
    const wait = (lastAt.get(u.hostname) ?? 0) + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt.set(u.hostname, Date.now());
    let res;
    try {
      res = await fetchImpl(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    } catch (e) {
      throw new PeersFetchError({ phase, host: u.hostname, cause: causeOf(e) });
    }
    if (!res.ok) throw new PeersFetchError({ phase, host: u.hostname, status: res.status });
    let text;
    try {
      text = await res.text();
    } catch (e) {
      throw new PeersFetchError({ phase, host: u.hostname, status: res.status, cause: causeOf(e), detail: 'body read failed' });
    }
    if (text.length > maxBytes) throw new PeersFetchError({ phase, host: u.hostname, status: res.status, detail: `response exceeded ${maxBytes} bytes` });
    return { status: res.status, text };
  }
  return { getText };
}
