/**
 * ITI Mutual Fund — monthly portfolio disclosure (one .xlsx, ~1.8 MB, ~22 scheme
 * sheets; Small Cap = ITISCF). Fraction weights.
 *
 * SEMI-MANUAL: the file name carries the upload epoch
 * (/admin/pdf/<epoch>-ITIMF_Monthly_Portfolio_<DDMMYYYY>.xlsx) and the AMC's
 * listing API is client-side-encrypted, which we deliberately do not reverse. So
 * the scheduled job cannot discover the file; the owner pastes the link (copied
 * from the AMC's disclosures page) into POST /api/mf-holdings
 * {action:'ingest', house:'iti', url} (or passes it as `itiUrl` to `refresh`).
 * The URL is validated strictly (https, ITI host, exact path shape, date matching
 * the target month-end), redirects are not followed, the body is size-capped and
 * must carry the zip/.xlsx signature, all before anything is parsed.
 */
import { makeClient } from './_http.mjs';
import { MfFetchError } from './_errors.mjs';
import { parseHouseWorkbook } from './_workbook.mjs';

export const DEFAULT_UNIT = 'fraction';

const HOSTS = ['itiamc.com', 'www.itiamc.com'];
const PATH_RE = /^\/admin\/pdf\/(\d{6,12})-ITIMF_Monthly_Portfolio_(\d{8})\.xlsx$/;
const MAX_BYTES = 6_000_000;

/**
 * Strictly validate a pasted ITI file link. With `asOf` the filename date must
 * equal it; without, the filename date is returned (ISO) as `asOf`.
 * @returns {{ok:true, asOf?:string}|{ok:false, reason:string}}
 */
export function validateItiUrl(raw, asOf) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return { ok: false, reason: 'itiUrl is not a valid URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'itiUrl must be https' };
  if (u.username || u.password) return { ok: false, reason: 'itiUrl must not contain credentials' };
  if (!HOSTS.includes(u.hostname)) return { ok: false, reason: `itiUrl host must be itiamc.com (got ${u.hostname})` };
  if (u.search || u.hash) return { ok: false, reason: 'itiUrl must not have a query or fragment' };
  const m = PATH_RE.exec(u.pathname);
  if (!m) return { ok: false, reason: 'itiUrl must look like /admin/pdf/<epoch>-ITIMF_Monthly_Portfolio_<DDMMYYYY>.xlsx' };
  const fileDate = `${m[2].slice(4)}-${m[2].slice(2, 4)}-${m[2].slice(0, 2)}`;
  if (asOf === undefined) return { ok: true, asOf: fileDate };
  const [y, mo, d] = asOf.split('-');
  if (m[2] !== `${d}${mo}${y}`) return { ok: false, reason: `itiUrl is for ${m[2]}, expected ${d}${mo}${y}` };
  return { ok: true };
}

export async function fetchIti({ asOf, itiUrl, fetchImpl, sleep } = {}) {
  if (!itiUrl) {
    throw new MfFetchError('missing', 'awaiting manual link: ITI\'s listing is encrypted; POST /api/mf-holdings {action:\'ingest\', house:\'iti\', url}');
  }
  const v = validateItiUrl(itiUrl, asOf);
  if (!v.ok) throw new MfFetchError('failed', v.reason);
  const client = makeClient({ fetchImpl, sleep, allowedHosts: HOSTS });
  const { buffer } = await client.get(itiUrl, { maxBytes: MAX_BYTES, follow: false, accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*' });
  // An .xlsx is a zip: reject HTML error pages / other content before the parser sees it.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    throw new MfFetchError('failed', 'ITI download is not an .xlsx (bad file signature)');
  }
  return { fileName: new URL(itiUrl).pathname.split('/').pop(), buffer };
}

export function parseItiWorkbook(buf, opts = {}) {
  return parseHouseWorkbook(buf, 'iti', { defaultUnit: DEFAULT_UNIT, ...opts });
}

export const ITI = { fetch: fetchIti, parse: parseItiWorkbook };
