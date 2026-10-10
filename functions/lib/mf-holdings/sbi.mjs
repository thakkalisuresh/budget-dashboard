/** SBI monthly portfolio workbook → per-fund parse results (percent weights by default). */
import { parseHouseWorkbook } from './_workbook.mjs';

export const DEFAULT_UNIT = 'percent';

export function parseSbiWorkbook(buf, opts = {}) {
  return parseHouseWorkbook(buf, 'sbi', { defaultUnit: DEFAULT_UNIT, ...opts });
}
