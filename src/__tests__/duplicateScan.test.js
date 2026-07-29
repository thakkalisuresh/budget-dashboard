import { describe, it, expect, vi, beforeEach } from 'vitest';

const { detailMock, updateAmountsMock } = vi.hoisted(() => ({
  detailMock: vi.fn(),
  updateAmountsMock: vi.fn(),
}));

vi.mock('../sheetDetail.js', () => ({ fetchDetailRows: detailMock }));
vi.mock('../sheetExpenses.js', () => ({ updateVendorAmounts: updateAmountsMock }));

const { flattenTransactions, scanDuplicates, suggestKeeper, deleteTransactions } =
  await import('../duplicateScan.js');

const row = (rowIndex, description, amounts, opts = {}) => ({
  rowIndex, description, amounts,
  uuids: opts.uuids || amounts.map((_, i) => `u${rowIndex}_${i}`),
  date: opts.date ?? '2026-05-10',
  paymentMethod: opts.paymentMethod || '',
  _v2: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  updateAmountsMock.mockResolvedValue(undefined);
  detailMock.mockResolvedValue([]);
});

describe('flattenTransactions', () => {
  it('emits one entry per amount, not per row', async () => {
    // A row holds several charges for one vendor; each is separately dupable.
    detailMock.mockImplementation(async (cat) => (cat === 'Grocery' ? [row(2, 'Costco', [50, 30])] : []));
    const out = await flattenTransactions(['Grocery'], 't', 's');
    expect(out).toHaveLength(2);
    expect(out.map(e => e.amtIndex)).toEqual([0, 1]);
    expect(out.map(e => e.key)).toEqual(['Grocery:2:0', 'Grocery:2:1']);
  });

  it('skips zero and non-numeric amounts', async () => {
    detailMock.mockImplementation(async (cat) => (cat === 'Grocery' ? [row(2, 'Costco', [0, null, 25])] : []));
    const out = await flattenTransactions(['Grocery'], 't', 's');
    expect(out.map(e => e.amount)).toEqual([25]);
  });

  it('skips a category that fails instead of losing the scan', async () => {
    detailMock.mockImplementation(async (cat) => {
      if (cat === 'Grocery') throw new Error('403');
      return [row(2, 'Shell', [40])];
    });
    const out = await flattenTransactions(['Grocery', 'Travel'], 't', 's');
    expect(out.map(e => e.vendor)).toEqual(['Shell']);
  });
});

describe('scanDuplicates', () => {
  it('clusters the same purchase filed under two categories', async () => {
    // The real case this exists for: wallet logs to Misc, receipt to Grocery.
    detailMock.mockImplementation(async (cat) => {
      if (cat === 'Misc')    return [row(4, 'Costco', [89.5])];
      if (cat === 'Grocery') return [row(2, 'Costco Wholesale', [89.5], { paymentMethod: 'Bilt Blue Card' })];
      return [];
    });
    const clusters = await scanDuplicates(['Misc', 'Grocery'], 't', 's');
    expect(clusters).toHaveLength(1);
    expect(clusters[0].map(e => e.category).sort()).toEqual(['Grocery', 'Misc']);
  });

  it('returns nothing when there are no duplicates', async () => {
    detailMock.mockImplementation(async (cat) => (cat === 'Grocery' ? [row(2, 'Costco', [50]), row(3, 'Shell', [40])] : []));
    expect(await scanDuplicates(['Grocery'], 't', 's')).toEqual([]);
  });
});

describe('suggestKeeper', () => {
  it('prefers the entry that has a card', () => {
    // A carded row can be attributed to a person and is usually the
    // receipt-backed copy rather than the bare wallet notification.
    const cluster = [
      { key: 'a', paymentMethod: '',              date: '2026-05-10' },
      { key: 'b', paymentMethod: 'Bilt Blue Card', date: '2026-05-11' },
    ];
    expect(suggestKeeper(cluster).key).toBe('b');
  });

  it('falls back to the earliest date when neither has a card', () => {
    const cluster = [
      { key: 'a', paymentMethod: '', date: '2026-05-12' },
      { key: 'b', paymentMethod: '', date: '2026-05-10' },
    ];
    expect(suggestKeeper(cluster).key).toBe('b');
  });

  it('does not mutate the cluster it was given', () => {
    const cluster = [
      { key: 'a', paymentMethod: '',  date: '2026-05-12' },
      { key: 'b', paymentMethod: 'X', date: '2026-05-10' },
    ];
    suggestKeeper(cluster);
    expect(cluster.map(c => c.key)).toEqual(['a', 'b']);
  });
});

describe('deleteTransactions', () => {
  const entry = (category, rowIndex, amtIndex, amounts, uuids) => ({
    key: `${category}:${rowIndex}:${amtIndex}`,
    category, rowIndex, amtIndex, amounts, uuids,
    vendor: 'Costco', _v2: true, amount: amounts[amtIndex],
  });

  it('rewrites the row without the deleted amount', async () => {
    await deleteTransactions([entry('Grocery', 2, 1, [50, 30, 20], ['a', 'b', 'c'])], 't', 's');
    const [cat, rowIndex, amounts, , , vendor, prevTotal, uuids] = updateAmountsMock.mock.calls[0];
    expect(cat).toBe('Grocery');
    expect(rowIndex).toBe(2);
    expect(amounts).toEqual([50, 20]);
    expect(uuids).toEqual(['a', 'c']);
    expect(prevTotal).toBe(100);
    expect(vendor).toBe('Costco');
  });

  it('removes two amounts from one row in a single write', async () => {
    // Deleting them one at a time would shift the indices under the second
    // delete and remove the wrong charge.
    await deleteTransactions([
      entry('Grocery', 2, 0, [50, 30, 20], ['a', 'b', 'c']),
      entry('Grocery', 2, 1, [50, 30, 20], ['a', 'b', 'c']),
    ], 't', 's');

    expect(updateAmountsMock).toHaveBeenCalledOnce();
    const [, , amounts, , , , , uuids] = updateAmountsMock.mock.calls[0];
    expect(amounts).toEqual([20]);
    expect(uuids).toEqual(['c']);
  });

  it('writes once per row when the deletes span rows', async () => {
    await deleteTransactions([
      entry('Grocery', 2, 0, [50], ['a']),
      entry('Misc', 7, 0, [50], ['z']),
    ], 't', 's');
    expect(updateAmountsMock).toHaveBeenCalledTimes(2);
  });

  it('clears the row entirely when every amount goes', async () => {
    await deleteTransactions([entry('Grocery', 2, 0, [50], ['a'])], 't', 's');
    expect(updateAmountsMock.mock.calls[0][2]).toEqual([]);
  });

  it('keeps going after a failure and reports which rows survived', async () => {
    updateAmountsMock.mockImplementationOnce(async () => { throw new Error('locked'); });
    const res = await deleteTransactions([
      entry('Grocery', 2, 0, [50], ['a']),
      entry('Misc', 7, 0, [50], ['z']),
    ], 't', 's');

    expect(updateAmountsMock).toHaveBeenCalledTimes(2);
    expect(res.deleted).toEqual(['Misc:7']);
    expect(res.failed).toEqual([{ rowKey: 'Grocery:2', error: 'locked' }]);
  });

  it('reports progress per row', async () => {
    const seen = [];
    await deleteTransactions([
      entry('Grocery', 2, 0, [50], ['a']),
      entry('Misc', 7, 0, [50], ['z']),
    ], 't', 's', (done, total) => seen.push(`${done}/${total}`));
    expect(seen).toEqual(['1/2', '2/2']);
  });
});
