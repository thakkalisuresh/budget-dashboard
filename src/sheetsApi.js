// Barrel re-export — preserves all existing import paths.
// The actual implementations live in focused modules under sheet*.js.

// ─── Constants & helpers ─────────────────────────────────────────────────────
export {
  SHEET_MAP,
  CATEGORIES,
  getEffectiveSheetMap,
  getAllCategoryNames,
  safeText,
  escapeSheetRef,
  escapeFormulaString,
  todayIso,
  formatTxDate,
  normalizeStatementDate,
  parseAmounts,
  buildFormula,
  fuzzyNamesMatch,
} from './sheetHelpers.js';

// ─── Detail rows & cache ─────────────────────────────────────────────────────
export {
  invalidateDetailCache,
  fetchDetailRows,
  checkExistingExpense,
  fetchAllLoggedTransactions,
} from './sheetDetail.js';

// ─── History ─────────────────────────────────────────────────────────────────
export {
  appendHistoryEntry,
  fetchHistory,
  updateHistoryPaymentMethod,
} from './sheetHistory.js';

// ─── Undo ────────────────────────────────────────────────────────────────────
export { undoHistoryEntry } from './sheetUndo.js';

// ─── Cards Summary Sheet ──────────────────────────────────────────────────────
export { ensureCardsSummarySheet } from './sheetCards.js';

// ─── By Person split sheet ────────────────────────────────────────────────────
export { ensurePersonSplitSheet } from './sheetSplit.js';

// ─── Totals ──────────────────────────────────────────────────────────────────
export {
  fetchTotalsForEdit,
  writeSalary,
  updateCategoryBudget,
  writeBudgetAmounts,
  appendRandomExpenseNote,
  removeRandomExpenseNote,
  renameRandomExpenseNote,
} from './sheetTotals.js';

// ─── Expense CRUD ────────────────────────────────────────────────────────────
export {
  addOrUpdateExpense,
  updateTransactionDate,
  updateVendorName,
  updateVendorAmounts,
  updatePaymentMethod,
  moveTransactionCategory,
} from './sheetExpenses.js';

// ─── Non-monthly expenses ────────────────────────────────────────────────────
export {
  fetchNonMonthlyItems,
  markNonMonthly,
  unmarkNonMonthly,
  renameNonMonthly,
  migrateNonMonthlyFromI4,
} from './sheetNonMonthly.js';

// ─── Category management ─────────────────────────────────────────────────────
export {
  deleteCategory,
  renameCategory,
  createCategoryDetailSheet,
  linkCategoryToDetailSheet,
  addCategoryTo503020,
  addCategoryToTotals,
} from './sheetCategories.js';
