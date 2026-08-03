import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Budgets are not stored as a value anywhere in the spreadsheet.
 *
 * `Totals!C` holds the FORMULA `=<budget>-B<row>`; the budget literal exists
 * only inside that string, and `getTotals` recovers it as `spent + remaining`.
 * Write a bare number to C instead and the arithmetic inverts: `remaining`
 * stops shrinking, so the *derived budget* grows by exactly as much as you
 * spend. Nothing errors and the dashboard looks fine — the month just never
 * goes over budget.
 *
 * `writeBudgetAmounts` (the NewMonthDialog path) was the one writer doing this.
 */

const writeCell = vi.fn();
vi.mock('../sheetApi.js', () => ({
  apiFetch: vi.fn(),
  writeCell: (...a) => writeCell(...a),
}));
vi.mock('../sheetHistory.js', () => ({ appendHistoryEntry: vi.fn() }));

const { writeBudgetAmounts, updateCategoryBudget } = await import('../sheetTotals.js');

beforeEach(() => { writeCell.mockClear(); });

/** writeCell(sheetId, tab, row, col, value, token) */
const valueWritten = (call) => call[4];
const rowWritten   = (call) => call[2];
const colWritten   = (call) => call[3];

describe('writeBudgetAmounts', () => {
  it('writes the budget FORMULA to col C, not the raw number', async () => {
    await writeBudgetAmounts('SHEET', [{ rowNum: 4, amount: 1200 }], 'tok');

    expect(writeCell).toHaveBeenCalledTimes(1);
    const call = writeCell.mock.calls[0];
    expect(colWritten(call)).toBe(2);           // col C
    expect(rowWritten(call)).toBe(4);
    expect(valueWritten(call)).toBe('=1200-B4');
    // The bug, stated as an assertion: a bare number here makes the derived
    // budget grow as the month is spent.
    expect(typeof valueWritten(call)).not.toBe('number');
  });

  it('references each category own row, so budgets do not cross-wire', async () => {
    await writeBudgetAmounts('SHEET', [
      { rowNum: 2, amount: 500 },
      { rowNum: 7, amount: 80.5 },
    ], 'tok');
    expect(valueWritten(writeCell.mock.calls[0])).toBe('=500-B2');
    expect(valueWritten(writeCell.mock.calls[1])).toBe('=80.5-B7');
  });

  it('coerces junk to 0 rather than writing a broken formula', async () => {
    await writeBudgetAmounts('SHEET', [{ rowNum: 3, amount: undefined }], 'tok');
    expect(valueWritten(writeCell.mock.calls[0])).toBe('=0-B3');
  });

  it('matches the shape updateCategoryBudget already writes', async () => {
    await updateCategoryBudget('SHEET', 'tok', { rowNum: 5, budget: 300, categoryName: 'Grocery' });
    const single = valueWritten(writeCell.mock.calls[0]);
    writeCell.mockClear();
    await writeBudgetAmounts('SHEET', [{ rowNum: 5, amount: 300 }], 'tok');
    // Two paths writing the same cell must agree, or which dialog you used
    // decides whether the month's budget is trustworthy.
    expect(valueWritten(writeCell.mock.calls[0])).toBe(single);
  });
});
