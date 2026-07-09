// ════════════════════════════════════════════════════════════════════════════
// data.js — a hard-coded SAMPLE of one month's budget sheet.
// This is demo data shaped exactly like the rows we read from the real Google
// Sheet, so the app (and tests) can render something without a live connection.
// Each entry mirrors one spreadsheet row:
//   • index_ : the row's position in the original sheet. Note the jump 15 → 21 —
//              real sheets have gaps where rows were deleted, and the code must
//              cope with that, so the sample keeps the gap too.
//   • row    : the raw left-to-right cells. Roughly:
//              [0] category name   [1] amount spent   [2] budget remaining
//              [5] summary label   [6] summary value  [8] notes label/text
//              [9] notes value     (other columns are unused/null here)
// ════════════════════════════════════════════════════════════════════════════
export const sheetData = [
  { index_: 0, row: ['Expense', 'Amount', 'Budgeted Amount', null, null, 'Salary Received', 8356.61, null, null, null] },
  { index_: 1, row: ['Grocery', 692.77, -192.77, null, null, 'Total Expenses', 7300.68, null, null, null] },
  { index_: 2, row: ['Moving Exp', 0, 0, null, null, null, null, null, 'Balance without random non-monthly expenses', 1523.29] },
  { index_: 3, row: ['Furniture', 24.87, -24.87, null, null, 'Left from Salary for the Month', 1055.93, null, 'UPS Notary, UPS Chennai Courier, U Dub Tacoma Fee, Caroline Gift, Enrolment Fee, Uniqlo', null] },
  { index_: 4, row: ['Travel', 35.84, 264.16, null, null, null, null, null, null, null] },
  { index_: 5, row: ['Misc', 527.45, -327.45, null, null, null, null, null, null, null] },
  { index_: 6, row: ['Rent', 2407, 0, null, null, null, null, null, 'Difference between budgeted and actual spent', 467.36] },
  { index_: 7, row: ['Eating Out', 201.34, 98.66, null, null, null, null, null, null, null] },
  { index_: 8, row: ['Utilities', 201.08, 158.92, null, null, null, null, null, null, null] },
  { index_: 9, row: ['Investment', 2000, -800, null, null, null, null, null, null, null] },
  { index_: 10, row: ['Health', 0, 60, null, null, null, null, null, null, null] },
  { index_: 11, row: ['Car Payments', 1149.74, -110.74, null, null, null, null, null, null, null] },
  { index_: 12, row: ['Thakkali', 40.59, 109.41, null, null, null, null, null, null, null] },
  { index_: 13, row: ['Holiday', 0, 0, null, null, null, null, null, null, null] },
  { index_: 14, row: ['Wi-Fi', 20, 90, null, null, null, null, null, null, null] },
  { index_: 15, row: ['Entertainment', 0, 180, null, null, null, null, null, null, null] },
  { index_: 21, row: ['Total Expenses', 7300.68, -494.68, null, null, null, null, null, null, null] },
];
