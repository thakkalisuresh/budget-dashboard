/**
 * SBI Mutual Fund — monthly portfolio disclosure. One all-schemes .xlsx (~2.6 MB,
 * ~120 sheets) at a predictable URL (confirmed for 13 months); a month that is
 * not out yet answers 404. Percent weights. Scheme sheets: SRBF-AHP / -AP /
 * -CHP / -CP (the four Retirement Benefit Fund sub-plans).
 */
import { makeClient } from './_http.mjs';
import { parseHouseWorkbook } from './_workbook.mjs';

export const DEFAULT_UNIT = 'percent';

const BASE = 'https://www.sbimf.com/docs/default-source/scheme-portfolios/all-schemes-monthly-portfolio---as-on-';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MAX_BYTES = 12_000_000;

const suffix = (d) => (d % 100 >= 11 && d % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[d % 10] || 'th');

/** 2026-09-30 → …-as-on-30th-september-2026.xlsx (day without leading zero, st/nd/rd/th). */
export function sbiUrl(asOf) {
  const [y, m, d] = asOf.split('-').map(Number);
  return `${BASE}${d}${suffix(d)}-${MONTHS[m - 1]}-${y}.xlsx`;
}

export async function fetchSbi({ asOf, fetchImpl, sleep } = {}) {
  const url = sbiUrl(asOf);
  const client = makeClient({ fetchImpl, sleep, allowedHosts: ['www.sbimf.com'] });
  const { buffer } = await client.get(url, { maxBytes: MAX_BYTES, accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*' });
  return { fileName: new URL(url).pathname.split('/').pop(), buffer };
}

export function parseSbiWorkbook(buf, opts = {}) {
  return parseHouseWorkbook(buf, 'sbi', { defaultUnit: DEFAULT_UNIT, ...opts });
}

export const SBI = { fetch: fetchSbi, parse: parseSbiWorkbook };
