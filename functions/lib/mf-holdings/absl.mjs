/**
 * Aditya Birla Sun Life — monthly portfolio disclosure.
 *
 * Fetch: the portfolio page is JS-rendered, but it fills its accordion from a
 * plain JSON listing (no cookies/tokens). Each "Monthly Portfolios as on
 * <Month d, yyyy>" item links a ~2 MB zip holding ONE legacy .xls (BIFF, ~8 MB,
 * ~105 sheets, one per scheme). File names change almost every month, so the
 * link comes from the listing, never from a URL pattern. Fraction weights.
 */
import { Buffer } from 'node:buffer';
import { unzipSync } from 'fflate';
import { makeClient } from './_http.mjs';
import { MfFetchError } from './_errors.mjs';
import { parseHouseWorkbook } from './_workbook.mjs';

export const DEFAULT_UNIT = 'fraction';

// `&month=&year=0` is required: without it the endpoint answers HTTP 500.
export const ABSL_LISTING_URL = 'https://mutualfund.adityabirlacapital.com/postlogin/CustomApi/Resources/FactsheetAccordionById'
  + '?id=3ccab227-9de5-4494-b78d-2b4f7c0c054a'
  + '&ctype=%2Fsitecore%2Fcontent%2FRoot%2FBSL%2FLibrary%2FLists%2FFAQ%2FCustomer%20Types%2FIndividual'
  + '&month=&year=0';

const ALLOWED_HOSTS = ['mutualfund.adityabirlacapital.com', 'abcscprod.azureedge.net'];
const MAX_ZIP_BYTES = 12_000_000;
const MAX_UNZIP_BYTES = 40_000_000;
const MAX_ZIP_ENTRIES = 3;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ITEM_RE = /^Monthly Portfolios as on ([A-Za-z]+) (\d{1,2}), (\d{4})$/;

/** The listing item's date, as ISO, for "Monthly Portfolios as on <Month d, yyyy>" lines only. */
function itemDate(label) {
  const m = ITEM_RE.exec(String(label || '').trim());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  return mi < 0 ? null : `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Open the zip safely (entry-count and uncompressed-size caps) and return its single spreadsheet. */
function extractSpreadsheet(zip, maxUnzipBytes) {
  let entries;
  try {
    entries = [];
    unzipSync(new Uint8Array(zip), { filter: (f) => { entries.push(f); return false; } });
  } catch (e) {
    throw new MfFetchError('failed', `ABSL download is not a valid zip (${e?.message || 'unreadable'})`);
  }
  if (entries.length === 0 || entries.length > MAX_ZIP_ENTRIES) throw new MfFetchError('failed', `ABSL zip has ${entries.length} entries, expected 1-${MAX_ZIP_ENTRIES}`);
  const total = entries.reduce((s, f) => s + f.originalSize, 0);
  if (total > maxUnzipBytes) throw new MfFetchError('failed', `ABSL zip is ${total} bytes uncompressed (cap ${maxUnzipBytes})`);
  const sheet = entries.find(f => /\.xls[xm]?$/i.test(f.name));
  if (!sheet) throw new MfFetchError('failed', 'ABSL zip contains no spreadsheet');
  let data;
  try {
    data = unzipSync(new Uint8Array(zip), { filter: (f) => f.name === sheet.name })[sheet.name];
  } catch (e) {
    throw new MfFetchError('failed', `ABSL zip member is corrupt (${e?.message || 'unreadable'})`);
  }
  if (!data || data.byteLength > maxUnzipBytes) throw new MfFetchError('failed', 'ABSL spreadsheet is empty or too large');
  return { fileName: sheet.name.split(/[\\/]/).pop(), buffer: Buffer.from(data) };
}

/** @returns {Promise<{fileName:string, buffer:Buffer}>} */
export async function fetchAbsl({ asOf, fetchImpl, sleep, maxUnzipBytes = MAX_UNZIP_BYTES } = {}) {
  const client = makeClient({ fetchImpl, sleep, allowedHosts: ALLOWED_HOSTS });

  let listing;
  try {
    listing = await client.get(ABSL_LISTING_URL, { maxBytes: 2_000_000, accept: 'application/json' });
  } catch (e) {
    if (e instanceof MfFetchError) throw new MfFetchError('failed', `ABSL listing: ${e.message}`);
    throw e;
  }
  let items;
  try {
    items = JSON.parse(listing.buffer.toString('utf8'))?.AccordionList;
  } catch {
    throw new MfFetchError('failed', 'ABSL listing is not JSON (endpoint changed?)');
  }
  if (!Array.isArray(items)) throw new MfFetchError('failed', 'ABSL listing has no AccordionList (endpoint changed?)');

  const hit = items.find(i => itemDate(i?.ResourceLink) === asOf);
  if (!hit) throw new MfFetchError('missing', `ABSL listing has no "Monthly Portfolios as on" entry for ${asOf} yet`);

  let url;
  try { url = new URL(String(hit.pdfUrl || '')); } catch { throw new MfFetchError('failed', 'ABSL listing item has an unusable link'); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname)) throw new MfFetchError('failed', `ABSL link points at an unexpected host (${url.hostname})`);
  if (!/\.zip$/i.test(url.pathname)) throw new MfFetchError('failed', 'ABSL link is not a .zip');

  const zip = await client.get(url.href, { maxBytes: MAX_ZIP_BYTES, accept: 'application/zip,*/*' });
  return extractSpreadsheet(zip.buffer, maxUnzipBytes);
}

export function parseAbslWorkbook(buf, opts = {}) {
  return parseHouseWorkbook(buf, 'absl', { defaultUnit: DEFAULT_UNIT, ...opts });
}

export const ABSL = { fetch: fetchAbsl, parse: parseAbslWorkbook };
