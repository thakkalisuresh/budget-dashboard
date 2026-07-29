// ════════════════════════════════════════════════════════════════════════════
// useBudgetSummary.js — derive the headline budget numbers from raw sheet data.
// Despite the `use` name, this is a plain pure function (no React state): give it
// the sheet rows + parsed expenses and it returns the totals the dashboard shows.
// ════════════════════════════════════════════════════════════════════════════
export function useBudgetSummary(data, expenses, nonMonthlyItems) {
  // Helper: find the sheet row whose cell at `colIndex` equals `label`.
  const findRowByLabel = (label, colIndex = 0) => data.find(d => d.row[colIndex] === label);

  // Salary marked received this month — summary label sits in col 5, value in col 6.
  // parseFloat(undefined) is NaN, and `NaN || 0` becomes 0, so missing data → 0.
  const salaryReceived      = parseFloat(findRowByLabel('Salary Received', 5)?.row[6]) || 0;
  // The sheet stores a special "Balance without random non-monthly..." note in col 8.
  const nonRecurringRow     = data.find(d => typeof d.row[8] === 'string' && d.row[8].includes('Balance without random'));
  const nonRecurringRemaining = parseFloat(nonRecurringRow?.row[9]) || 0;
  // "Difference between budgeted and actual spent" note (label col 8, value col 9).
  const potentialDiffRow    = findRowByLabel('Difference between budgeted and actual spent', 8);
  const potentialDifference = parseFloat(potentialDiffRow?.row[9]) || 0;

  // Sum the per-category actual spend and budget. `.reduce` walks the array,
  // accumulating a running total `s` (starting at 0).
  const totalActual        = expenses.reduce((s, d) => s + d.actual, 0);
  const totalBudget        = expenses.reduce((s, d) => s + d.budget, 0);
  const overallRemaining   = totalBudget - totalActual;     // budget left for the month

  // One-off (non-monthly) items, and the balance once you set those aside.
  const nonMonthlyTotal          = nonMonthlyItems.reduce((s, r) => s + r.amount, 0);
  const balanceWithoutNonMonthly = overallRemaining + nonMonthlyTotal;

  // Return every computed figure as one object for the UI to read.
  return {
    salaryReceived, nonRecurringRemaining, potentialDifference,
    totalActual, totalBudget, overallRemaining,
    nonMonthlyTotal, balanceWithoutNonMonthly,
  };
}
