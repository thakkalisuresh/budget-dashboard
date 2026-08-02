import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as client from '../itemMemory.js';
import * as server from '../../functions/lib/_item-memory.mjs';

/**
 * Drift-guard: src/itemMemory.js and functions/lib/_item-memory.mjs duplicate
 * the item-key normalization rules, because the Cloud Functions bot cannot
 * import client modules.
 *
 * Drift here is worse than the usual copy-paste bug. The normalized name IS the
 * storage key: if the bot strips pack sizes and the dashboard doesn't, the two
 * write "spindrift" and "spindrift 12ct" as different products into the same
 * log. Nothing errors — the memory just stops recognising half of what the
 * other surface taught it, which looks like the feature forgetting at random.
 *
 * The bodies are compared verbatim below the header comment, so the two files
 * can explain themselves differently but can never behave differently.
 */

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');
/** Everything after the closing line of the leading banner comment. */
const body = (src) => src.slice(src.indexOf('export const MEMORY_SHEET'));

describe('itemMemory client/server parity', () => {
  it('the implementations are byte-identical below the header', () => {
    expect(body(read('functions/lib/_item-memory.mjs'))).toBe(body(read('src/itemMemory.js')));
  });

  it('exports the same surface', () => {
    expect(Object.keys(server).sort()).toEqual(Object.keys(client).sort());
  });

  it('normalizes the awkward real-world names identically', () => {
    const NAMES = [
      'KS ORG PNT BTR', '1234567 SPINDRIFT 24ct', 'KIRKLAND SIGNATURE Paper Towels',
      "Ben & Jerry's", 'OLIVE OIL 2 L', 'MILK 1 gal', '7UP', '  ', 'ROTISSERIE CHICKEN',
      'GREAT VALUE BREAD 20 oz', 'BANANAS 3 lbs', 'A1 STEAK SAUCE',
    ];
    for (const n of NAMES) {
      expect(server.normalizeItemName(n), n).toBe(client.normalizeItemName(n));
    }
  });

  it('keys vendors identically', () => {
    for (const v of ['Costco', 'COSTCO WHOLESALE #1234', "Sam's Club", 'amzn mktp', '']) {
      expect(server.vendorKey(v), v).toBe(client.vendorKey(v));
    }
  });

  it('reduces the same rows to the same answers', () => {
    const rows = [
      client.MEMORY_HEADER,
      ['me@x.com', 'Costco', 'KS ORG PNT BTR', 'Grocery', '2026-01-01', 'sp-1'],
      ['me@x.com', 'Costco', 'PAPER TOWELS', 'Misc', '2026-01-02', 'sp-1'],
      ['me@x.com', 'Costco', 'PAPER TOWELS', 'Health', '2026-02-02', 'sp-2'],
    ];
    const c = client.reduceMemoryRows(rows, 'me@x.com');
    const s = server.reduceMemoryRows(rows, 'me@x.com');
    for (const name of ['ORG PNT BTR 16oz', 'Paper Towels', 'unknown thing']) {
      expect(server.lookupLearned(s, 'Costco', name), name)
        .toBe(client.lookupLearned(c, 'Costco', name));
    }
  });
});
