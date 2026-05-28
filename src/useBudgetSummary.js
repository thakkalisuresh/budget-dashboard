export function useBudgetSummary(data, expenses, nonMonthlyItems) {
  const findRowByLabel = (label, colIndex = 0) => data.find(d => d.row[colIndex] === label);

  const salaryReceived      = parseFloat(findRowByLabel('Salary Received', 5)?.row[6]) || 0;
  const nonRecurringRow     = data.find(d => typeof d.row[8] === 'string' && d.row[8].includes('Balance without random'));
  const nonRecurringRemaining = parseFloat(nonRecurringRow?.row[9]) || 0;
  const potentialDiffRow    = findRowByLabel('Difference between budgeted and actual spent', 8);
  const potentialDifference = parseFloat(potentialDiffRow?.row[9]) || 0;

  const totalActual        = expenses.reduce((s, d) => s + d.actual, 0);
  const totalBudget        = expenses.reduce((s, d) => s + d.budget, 0);
  const overallRemaining   = totalBudget - totalActual;

  const nonMonthlyTotal          = nonMonthlyItems.reduce((s, r) => s + r.amount, 0);
  const balanceWithoutNonMonthly = overallRemaining + nonMonthlyTotal;

  return {
    salaryReceived, nonRecurringRemaining, potentialDifference,
    totalActual, totalBudget, overallRemaining,
    nonMonthlyTotal, balanceWithoutNonMonthly,
  };
}
