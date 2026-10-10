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

// The "Monthly Portfolio" accordion id (found as data-accordian-api on the portfolio page).
// `&month=&year=0` is required: without it the endpoint answers HTTP 500.
const BASE = 'https://mutualfund.adityabirlacapital.com';
const ACCORDION_ID = '3ccab227-9de5-4494-b78d-2b4f7c0c054a';
const CTYPE = '%2Fsitecore%2Fcontent%2FRoot%2FBSL%2FLibrary%2FLists%2FFAQ%2FCustomer%20Types%2FIndividual';
const accordionUrl = (id) => `${BASE}/postlogin/CustomApi/Resources/FactsheetAccordionById?id=${id}&ctype=${CTYPE}&month=&year=0`;
export const ABSL_LISTING_URL = accordionUrl(ACCORDION_ID);
const PORTFOLIO_PAGE_URL = `${BASE}/forms-and-downloads/portfolio`;

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

const isMonthly = (i) => itemDate(i?.ResourceLink) !== null;

/** One accordion listing → its items, or an MfFetchError('failed') naming the cause. */
async function loadListing(client, url) {
  let res;
  try {
    res = await client.get(url, { maxBytes: 2_000_000, accept: 'application/json' });
  } catch (e) {
    if (e instanceof MfFetchError) throw new MfFetchError('failed', `ABSL listing: ${e.message}`);
    throw e;
  }
  let items;
  try {
    items = JSON.parse(res.buffer.toString('utf8'))?.AccordionList;
  } catch {
    throw new MfFetchError('failed', 'ABSL listing is not JSON (endpoint changed?)');
  }
  if (!Array.isArray(items)) throw new MfFetchError('failed', 'ABSL listing has no AccordionList (endpoint changed?)');
  return items;
}

/**
 * Fallback if the hard-coded accordion id stops working: read the portfolio page's
 * static HTML for its data-accordian-api links and try each (at most 4) until one
 * lists "Monthly Portfolios as on …" items.
 */
async function discoverListing(client) {
  const page = await client.get(PORTFOLIO_PAGE_URL, { maxBytes: 2_000_000, accept: 'text/html' });
  const ids = [...new Set([...page.buffer.toString('utf8').matchAll(/data-accordian-api="[^"]*FactsheetAccordionById\?id=([0-9a-f-]{36})/gi)].map(m => m[1].toLowerCase()))]
    .filter(id => id !== ACCORDION_ID).slice(0, 4);
  for (const id of ids) {
    try {
      const items = await loadListing(client, accordionUrl(id));
      if (items.some(isMonthly)) return items;
    } catch { /* try the next accordion */ }
  }
  throw new MfFetchError('failed', 'ABSL: no accordion on the portfolio page lists monthly portfolios (page changed?)');
}

/** @returns {Promise<{fileName:string, buffer:Buffer}>} */
export async function fetchAbsl({ asOf, fetchImpl, sleep, maxUnzipBytes = MAX_UNZIP_BYTES } = {}) {
  const client = makeClient({ fetchImpl, sleep, allowedHosts: ALLOWED_HOSTS });

  let items = null;
  let primaryError = null;
  try {
    items = await loadListing(client, ABSL_LISTING_URL);
  } catch (e) {
    if (!(e instanceof MfFetchError)) throw e;
    primaryError = e;
  }
  if (!items || !items.some(isMonthly)) {
    try { items = await discoverListing(client); } catch (e) { throw primaryError || e; }   // report the primary failure first
  }

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
