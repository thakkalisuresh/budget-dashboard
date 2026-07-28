import { describe, it, expect, vi, beforeEach } from 'vitest';

const { detailMock, updatePmMock, updateHistoryMock } = vi.hoisted(() => ({
  detailMock: vi.fn(),
  updatePmMock: vi.fn(),
  updateHistoryMock: vi.fn(),
}));

vi.mock('../sheetDetail.js', () => ({ fetchDetailRows: detailMock }));
vi.mock('../sheetExpenses.js', () => ({ updatePaymentMethod: updatePmMock }));
vi.mock('../sheetHistory.js', () => ({ updateHistoryPaymentMethod: updateHistoryMock }));

const { collectMethodlessRows, saveAssignments, buildCardOptions, CASH_OPTION } =
  await import('../backfillPaymentMethod.js');

const detailRow = (rowIndex, description, amounts, paymentMethod = '', uuids = ['u1'], date = '2026-05-10') =>
  ({ rowIndex, description, amounts, uuids, paymentMethod, date });

beforeEach(() => {
  vi.clearAllMocks();
  updatePmMock.mockResolvedValue(undefined);
  updateHistoryMock.mockResolvedValue(undefined);
  detailMock.mockResolvedValue([]);
});

describe('buildCardOptions', () => {
  it('always offers Cash', () => {
    expect(buildCardOptions(['Chase Sapphire Reserve'])).toEqual(['Chase Sapphire Reserve', CASH_OPTION]);
  });

  it('does not duplicate Cash when the user already has it', () => {
    expect(buildCardOptions(['Cash', 'Bilt Blue Card'])).toEqual(['Cash', 'Bilt Blue Card']);
  });

  it('copes with no cards configured', () => {
    expect(buildCardOptions()).toEqual([CASH_OPTION]);
    expect(buildCardOptions([null, ''])).toEqual([CASH_OPTION]);
  });
});

describe('collectMethodlessRows', () => {
  it('returns only rows with no payment method', () => {
    detailMock.mockResolvedValue([
      detailRow(2, 'Costco', [50], ''),
      detailRow(3, 'Target', [20], 'Chase Sapphire Reserve'),
      detailRow(4, 'Trader Joes', [30], '   '),  // whitespace counts as missing
    ]);
    return collectMethodlessRows(['Grocery'], 'tok', 'sheet').then(rows => {
      expect(rows.map(r => r.description)).toEqual(['Costco', 'Trader Joes']);
    });
  });

  it('sums multi-amount rows and keeps every uuid', async () => {
    detailMock.mockResolvedValue([detailRow(2, 'Costco', [50, 25.5], '', ['u1', 'u2'])]);
    const [row] = await collectMethodlessRows(['Grocery'], 'tok', 'sheet');
    expect(row.amount).toBeCloseTo(75.5);
    expect(row.uuids).toEqual(['u1', 'u2']);
  });

  it('skips placeholder rows that carry no money', async () => {
    detailMock.mockResolvedValue([detailRow(2, '', [], ''), detailRow(3, 'Blank', [0], '')]);
    expect(await collectMethodlessRows(['Grocery'], 'tok', 'sheet')).toEqual([]);
  });

  it('tags each row with its category and a unique key', async () => {
    detailMock.mockImplementation(async (cat) =>
      cat === 'Grocery' ? [detailRow(2, 'Costco', [50], '')] : [detailRow(2, 'Shell', [40], '')]
    );
    const rows = await collectMethodlessRows(['Grocery', 'Travel'], 'tok', 'sheet');
    // Same rowIndex in two tabs must not collide.
    expect(rows.map(r => r.key).sort()).toEqual(['Grocery:2', 'Travel:2']);
  });

  it('orders biggest first', async () => {
    detailMock.mockResolvedValue([
      detailRow(2, 'Small', [5], ''),
      detailRow(3, 'Big', [500], ''),
      detailRow(4, 'Mid', [50], ''),
    ]);
    const rows = await collectMethodlessRows(['Grocery'], 'tok', 'sheet');
    expect(rows.map(r => r.description)).toEqual(['Big', 'Mid', 'Small']);
  });

  it('skips a category that fails rather than losing the whole scan', async () => {
    detailMock.mockImplementation(async (cat) => {
      if (cat === 'Grocery') throw new Error('403');
      return [detailRow(2, 'Shell', [40], '')];
    });
    const rows = await collectMethodlessRows(['Grocery', 'Travel'], 'tok', 'sheet');
    expect(rows.map(r => r.description)).toEqual(['Shell']);
  });
});

describe('saveAssignments', () => {
  const row = (key = 'Grocery:2', uuids = ['u1']) =>
    ({ key, category: 'Grocery', rowIndex: 2, uuids, description: 'Costco', amount: 50 });

  it('writes the category tab and patches every History row', async () => {
    await saveAssignments([{ row: row('Grocery:2', ['u1', 'u2']), card: 'Bilt Blue Card' }], 'tok', 'sheet');

    expect(updatePmMock).toHaveBeenCalledWith('Grocery', 2, 'Bilt Blue Card', 'tok', 'sheet');
    // Both sides matter: the sheet is the source of truth, but the Split tab
    // reads History — without the patch the row stays missing from the split.
    expect(updateHistoryMock).toHaveBeenCalledTimes(2);
    expect(updateHistoryMock).toHaveBeenCalledWith('sheet', 'tok', 'u1', 'Bilt Blue Card');
    expect(updateHistoryMock).toHaveBeenCalledWith('sheet', 'tok', 'u2', 'Bilt Blue Card');
  });

  it('reports which rows saved and which failed', async () => {
    updatePmMock.mockImplementation(async (_cat, rowIndex) => {
      if (rowIndex === 3) throw new Error('sheet locked');
    });
    const res = await saveAssignments([
      { row: row('Grocery:2'), card: 'Cash' },
      { row: { ...row('Grocery:3'), rowIndex: 3 }, card: 'Cash' },
    ], 'tok', 'sheet');

    expect(res.saved).toEqual(['Grocery:2']);
    expect(res.failed).toEqual([{ key: 'Grocery:3', error: 'sheet locked' }]);
  });

  it('keeps going after a failure instead of aborting the batch', async () => {
    updatePmMock.mockImplementationOnce(async () => { throw new Error('boom'); });
    const res = await saveAssignments([
      { row: { ...row('Grocery:2'), rowIndex: 2 }, card: 'Cash' },
      { row: { ...row('Grocery:3'), rowIndex: 3 }, card: 'Cash' },
    ], 'tok', 'sheet');

    expect(updatePmMock).toHaveBeenCalledTimes(2);
    expect(res.saved).toEqual(['Grocery:3']);
  });

  it('still counts the row as saved when only the History patch fails', async () => {
    // The sheet is correct at that point; the split catches up on its own.
    updateHistoryMock.mockRejectedValue(new Error('history down'));
    const res = await saveAssignments([{ row: row(), card: 'Cash' }], 'tok', 'sheet');
    expect(res.saved).toEqual(['Grocery:2']);
    expect(res.failed).toEqual([]);
  });

  it('handles a row that has no uuid at all', async () => {
    const res = await saveAssignments([{ row: row('Grocery:2', []), card: 'Cash' }], 'tok', 'sheet');
    expect(updatePmMock).toHaveBeenCalledOnce();
    expect(updateHistoryMock).not.toHaveBeenCalled();
    expect(res.saved).toEqual(['Grocery:2']);
  });

  it('reports progress as it goes', async () => {
    const seen = [];
    await saveAssignments(
      [{ row: row('Grocery:2'), card: 'Cash' }, { row: { ...row('Grocery:3'), rowIndex: 3 }, card: 'Cash' }],
      'tok', 'sheet', (done, total) => seen.push(`${done}/${total}`)
    );
    expect(seen).toEqual(['1/2', '2/2']);
  });
});
