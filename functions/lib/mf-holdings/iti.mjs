/** ITI monthly portfolio workbook → per-fund parse results (fraction weights by default). */
import { parseHouseWorkbook } from './_workbook.mjs';

export const DEFAULT_UNIT = 'fraction';

export function parseItiWorkbook(buf, opts = {}) {
  return parseHouseWorkbook(buf, 'iti', { defaultUnit: DEFAULT_UNIT, ...opts });
}
