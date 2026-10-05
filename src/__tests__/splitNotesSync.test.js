import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as clientSplit from '../splitNotes.js';
import * as serverSplit from '../../functions/lib/_split-notes.mjs';
import { txNoteKey as clientKey } from '../transactionNotes.js';
import { txNoteKey as serverKey } from '../../functions/lib/_transaction-notes.mjs';

/**
 * Drift-guard for the note format now that BOTH surfaces write notes: the
 * dashboard's split screen and the Telegram bot's split flow.
 *
 * The failure mode is silent, not loud. A note the bot writes under a key the
 * dashboard doesn't build the same way is simply never displayed — the user
 * sees a bare "Costco $84.12" and assumes the feature didn't run. Worse, the
 * splitId rides on that note, so a drifted key also quietly breaks re-teaching
 * items when the transaction is later moved.
 */

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');
const body = (src, marker) => src.slice(src.indexOf(marker));

describe('split-note client/server parity', () => {
  it('splitNotes implementations are byte-identical below the header', () => {
    expect(body(read('functions/lib/_split-notes.mjs'), '/** Items listed in full'))
      .toBe(body(read('src/splitNotes.js'), '/** Items listed in full'));
  });

  it('transactionNotes implementations are byte-identical below the header', () => {
    expect(body(read('functions/lib/_transaction-notes.mjs'), 'export function txNoteKey'))
      .toBe(body(read('src/transactionNotes.js'), 'export function txNoteKey'));
  });

  it('builds the same note key for the same transaction', () => {
    const cases = [
      ['sheet1', 'Grocery', 'Costco', 84.12],
      ['sheet1', 'Misc', '  Costco Wholesale ', 20],
      ['sheet2', 'Health', 'CVS', 9.5],
    ];
    for (const c of cases) {
      expect(serverKey(...c), c.join('|')).toBe(clientKey(...c));
    }
  });

  it('renders the same note text, caps included', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ name: `ITEM ${i}`, amount: i + 1 }));
    for (const remainder of [0, 2.5, -1.25]) {
      expect(serverSplit.buildSplitNote(items, { remainder }))
        .toEqual(clientSplit.buildSplitNote(items, { remainder }));
    }
    expect(serverSplit.buildSplitNote([], { remainder: 0 })).toBeNull();
  });

  it('groups items by category the same way', () => {
    const assigned = [
      { name: 'BANANAS', amount: 2, category: 'Grocery' },
      { name: 'TOWELS', amount: 9, category: 'Misc' },
      { name: 'UNSORTED', amount: 4, category: '' },
    ];
    expect(serverSplit.buildCategoryItems([], assigned))
      .toEqual(clientSplit.buildCategoryItems([], assigned));
  });

  it('shares the same size caps', () => {
    expect(serverSplit.MAX_LISTED_ITEMS).toBe(clientSplit.MAX_LISTED_ITEMS);
    expect(serverSplit.MAX_NOTE_CHARS).toBe(clientSplit.MAX_NOTE_CHARS);
    expect(serverSplit.SPLIT_TAG).toBe(clientSplit.SPLIT_TAG);
  });
});
