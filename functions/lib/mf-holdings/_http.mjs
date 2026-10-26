/**
 * Polite, bounded HTTP for the AMC disclosure downloads: an honest identifying
 * User-Agent, at most one request per second per host, a timeout on every
 * request, and a hard cap on how many bytes are read (the body is streamed and
 * the read aborted at the cap — a hostile or runaway response cannot balloon
 * the function's memory). Fetch/sleep are injectable so tests never touch the
 * network.
 */
import { Buffer } from 'node:buffer';
import { MfFetchError } from './_errors.mjs';

export const USER_AGENT = 'FundientHouseholdDashboard/1.0 (private personal-finance tool; monthly portfolio disclosures; max 1 request/second)';
export const MIN_GAP_MS = 1000;
export const TIMEOUT_MS = 45_000;

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new MfFetchError('failed', `response too large (${declared} > ${maxBytes} bytes)`);
  const chunks = [];
  let total = 0;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new MfFetchError('failed', `response exceeded ${maxBytes} bytes`); }
        chunks.push(value);
      }
    } else {
      const ab = Buffer.from(await res.arrayBuffer());
      if (ab.length > maxBytes) throw new MfFetchError('failed', `response exceeded ${maxBytes} bytes`);
      chunks.push(ab); total = ab.length;
    }
  } catch (e) {
    if (e instanceof MfFetchError) throw e;
    // The connection dropped mid-body: say how far it got.
    throw new MfFetchError('failed', `body read failed after ${total} bytes: ${describeNetworkError(e)}`);
  }
  const buffer = Buffer.concat(chunks, total);
  if (Number.isFinite(declared) && declared > 0 && buffer.length < declared && !res.headers.get('content-encoding')) {
    throw new MfFetchError('failed', `truncated download (${buffer.length} of ${declared} bytes)`);
  }
  return buffer;
}

/**
 * undici reports every network problem as the useless "fetch failed" and keeps
 * the real reason on `err.cause` (ENOTFOUND, ECONNRESET, UND_ERR_CONNECT_TIMEOUT,
 * certificate errors, ...). Surface it, otherwise a deploy-only failure is
 * undiagnosable.
 */
export function describeNetworkError(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'request timed out';
  const cause = e?.cause;
  const code = cause?.code || e?.code;
  const detail = cause?.message && cause.message !== e?.message && cause.message !== code ? cause.message : '';
  return [e?.message || 'network error', code && `[${code}]`, detail].filter(Boolean).join(' ');
}

/**
 * @param {{fetchImpl?:Function, sleep?:Function, minGapMs?:number, timeoutMs?:number, allowedHosts?:string[]}} o
 */
export function makeClient({ fetchImpl = fetch, sleep = defaultSleep, minGapMs = MIN_GAP_MS, timeoutMs = TIMEOUT_MS, allowedHosts, retryDelayMs = 2000 } = {}) {
  const lastAt = new Map();
  /**
   * GET url → { buffer, headers }. 404 → MfFetchError('missing'); other non-2xx → 'failed'.
   * Failure messages carry the phase, host, status / network cause and bytes read.
   * `retries` retries transient problems (network error, timeout, 5xx, truncation)
   * with a growing backoff; 404s, redirects, size and allow-list violations never retry.
   */
  async function get(url, { maxBytes = 12_000_000, accept = '*/*', headers = {}, follow = true, phase = '', retries = 0 } = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new MfFetchError('failed', `refusing non-https URL ${u.origin}`);
    if (allowedHosts && !allowedHosts.includes(u.hostname)) throw new MfFetchError('failed', `host ${u.hostname} is not allowed`);
    const tag = phase ? `${phase} ${u.hostname}` : u.hostname;

    const once = async () => {
      const wait = (lastAt.get(u.hostname) ?? 0) + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt.set(u.hostname, Date.now());
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: accept, ...headers },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: follow ? 'follow' : 'manual',
        });
      } catch (e) {
        throw new MfFetchError('failed', `${tag}: ${describeNetworkError(e)}`);
      }
      if (res.url) {
        const final = new URL(res.url);
        if (final.protocol !== 'https:' || (allowedHosts && !allowedHosts.includes(final.hostname))) {
          throw new MfFetchError('failed', `${tag}: redirected to disallowed host ${final.hostname}`);
        }
      }
      if (res.status >= 300 && res.status < 400) throw new MfFetchError('failed', `${tag}: unexpected redirect (HTTP ${res.status}); redirects are not followed`);
      if (res.status === 404) throw new MfFetchError('missing', `${tag}${u.pathname.length > 60 ? '' : u.pathname}: not published yet (HTTP 404)`);
      if (!res.ok) throw new MfFetchError('failed', `${tag}: HTTP ${res.status}`);
      try {
        return { buffer: await readCapped(res, maxBytes), headers: res.headers };
      } catch (e) {
        throw e instanceof MfFetchError ? new MfFetchError(e.kind, `${tag}: ${e.message}`) : e;
      }
    };

    const transient = (e) => e instanceof MfFetchError && e.kind === 'failed'
      && !/too large|exceeded|redirect|not allowed|non-https/.test(e.message);
    for (let attempt = 0; ; attempt++) {
      try {
        return await once();
      } catch (e) {
        if (attempt >= retries || !transient(e)) {
          throw attempt > 0 && e instanceof MfFetchError ? new MfFetchError(e.kind, `${e.message} (after ${attempt + 1} attempts)`) : e;
        }
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
  }
  return { get };
}
