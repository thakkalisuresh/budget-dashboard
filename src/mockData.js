// Mock data for VITE_DEV_MOCK=true dev mode — no Google auth or API calls needed.
// Budget states: Eating Out + Entertainment over, Grocery/Utilities/Rent under, Travel at limit.

export const MOCK_USER = {
  email: 'demo@fundient.app',
  name: 'Anupa',
  picture: null,
  role: 'owner',
  allowedEmails: ['demo@fundient.app'],
  accessToken: 'mock-token',
  expiresAt: Date.now() + 3600 * 1000,
};

export const MOCK_MONTHS = [
  { name: 'June 2026',  sheetId: 'mock-june-2026'  },
  { name: 'May 2026',   sheetId: 'mock-may-2026'   },
  { name: 'April 2026', sheetId: 'mock-april-2026' },
];

// Row format: [name, actual, remaining, ...7 nulls] matching Totals!A1:J30
const JUNE_CATEGORIES = [
  { name: 'Rent',          actual: 2200, remaining:  200 }, // under: $2400 budget
  { name: 'Grocery',       actual:  380, remaining:  220 }, // under: $600 budget
  { name: 'Eating Out',    actual:  420, remaining: -120 }, // OVER: $300 budget
  { name: 'Utilities',     actual:  145, remaining:   55 }, // under: $200 budget
  { name: 'Car Payments',  actual:  650, remaining:    0 }, // at budget: $650
  { name: 'Entertainment', actual:  190, remaining:  -40 }, // OVER: $150 budget
  { name: 'Travel',        actual:  500, remaining:    0 }, // at limit: $500 budget
  { name: 'Health',        actual:   60, remaining:   40 }, // under: $100 budget
  { name: 'Investment',    actual:  500, remaining:    0 }, // at budget: $500
  { name: 'Misc',          actual:  115, remaining:   85 }, // under: $200 budget
];

// Salary row: row[5] = 'Salary Received', row[6] = value (read by useBudgetSummary)
const JUNE_SALARY_ROW = {
  index_: JUNE_CATEGORIES.length,
  row: [null, null, null, null, null, 'Salary Received', 7500, null, null, null],
};

const JUNE_DATA = [
  ...JUNE_CATEGORIES.map((c, i) => ({
    index_: i,
    row: [c.name, c.actual, c.remaining, null, null, null, null, null, null, null],
  })),
  JUNE_SALARY_ROW,
];

// Older months: identical shape, slightly different numbers
const MAY_CATEGORIES = [
  { name: 'Rent',          actual: 2400, remaining:    0 },
  { name: 'Grocery',       actual:  510, remaining:   90 },
  { name: 'Eating Out',    actual:  270, remaining:   30 },
  { name: 'Utilities',     actual:  180, remaining:   20 },
  { name: 'Car Payments',  actual:  650, remaining:    0 },
  { name: 'Entertainment', actual:  100, remaining:   50 },
  { name: 'Travel',        actual:    0, remaining:  500 },
  { name: 'Health',        actual:   90, remaining:   10 },
  { name: 'Investment',    actual:  500, remaining:    0 },
  { name: 'Misc',          actual:   80, remaining:  120 },
];

const MAY_DATA = [
  ...MAY_CATEGORIES.map((c, i) => ({
    index_: i,
    row: [c.name, c.actual, c.remaining, null, null, null, null, null, null, null],
  })),
  { index_: MAY_CATEGORIES.length, row: [null, null, null, null, null, 'Salary Received', 7500, null, null, null] },
];

export function getMockSheetData(sheetId) {
  if (sheetId === 'mock-may-2026') return MAY_DATA;
  return JUNE_DATA; // default to June for any other mock sheetId
}

// Mock history rows for HistoryTab / LedgerTab (format: [month, year, date, vendor, amount, paymentMethod, uuid])
export const MOCK_HISTORY_ROWS = [
  ['June', '2026', '2026-06-01', 'Whole Foods', 85.40, 'Chase Sapphire Reserve', 'tx_001'],
  ['June', '2026', '2026-06-02', 'Chipotle',    18.75, 'Chase Freedom Unlimited', 'tx_002'],
  ['June', '2026', '2026-06-03', 'Netflix',     15.99, 'American Express Blue Cash Preferred', 'tx_003'],
  ['June', '2026', '2026-06-04', 'Shell Gas',   62.10, 'Chase Debit Card - Sabarish', 'tx_004'],
  ['June', '2026', '2026-06-05', 'Trader Joes', 94.20, 'Chase Sapphire Reserve', 'tx_005'],
  ['June', '2026', '2026-06-06', 'Delta Air',  500.00, 'Chase Sapphire Reserve', 'tx_006'],
  ['June', '2026', '2026-06-07', 'Costco',     120.55, 'Chase Freedom Unlimited', 'tx_007'],
  ['June', '2026', '2026-06-08', 'Shake Shack', 32.40, 'Chase Freedom Unlimited', 'tx_008'],
  ['June', '2026', '2026-06-09', 'Con Edison',  82.00, 'Chase Debit Card - Sabarish', 'tx_009'],
  ['June', '2026', '2026-06-10', 'Spotify',     10.99, 'American Express Blue Cash Preferred', 'tx_010'],
  ['June', '2026', '2026-06-11', 'AMC Theaters', 38.00, 'Chase Sapphire Reserve', 'tx_011'],
  ['June', '2026', '2026-06-12', 'Whole Foods', 110.30, 'Chase Sapphire Reserve', 'tx_012'],
  ['June', '2026', '2026-06-13', 'Sweetgreen',  22.50, 'Chase Freedom Unlimited', 'tx_013'],
  ['June', '2026', '2026-06-14', 'CVS Pharmacy', 28.40, 'Chase Freedom Unlimited', 'tx_014'],
  ['June', '2026', '2026-06-15', 'Ramen Noodles', 45.00, 'Chase Sapphire Reserve', 'tx_015'],
  ['June', '2026', '2026-06-16', 'Google Play',  9.99, 'Chase Freedom Unlimited', 'tx_016'],
  ['June', '2026', '2026-06-17', 'Trader Joes', 89.75, 'Chase Sapphire Reserve', 'tx_017'],
  ['June', '2026', '2026-06-18', 'Pizza Palace', 54.80, 'Chase Freedom Unlimited', 'tx_018'],
  ['June', '2026', '2026-06-19', 'Duane Reade',  18.20, 'Chase Debit Card - Sabarish', 'tx_019'],
  ['June', '2026', '2026-06-20', 'Thai Garden',  72.00, 'Chase Sapphire Reserve', 'tx_020'],
];

// 50/30/20 buckets. Deliberately arranged so the Budget Rules card shows all
// three footer states at once: Needs under target but clamped by remaining
// income, Wants overspent, Savings invested past target.
export const MOCK_503020 = {
  needs:   { items: [{ name: 'Rent', amount: 700 }, { name: 'Grocery', amount: 300 }],
             total: 1000, pct: 0.1333, target: 3750, diff: 2750 },
  wants:   { items: [{ name: 'Eating Out', amount: 1800 }, { name: 'Travel', amount: 1000 }],
             total: 2800, pct: 0.3733, target: 2250, diff: -550 },
  savings: { items: [{ name: 'Investment', amount: 2000 }],
             total: 2000, pct: 0.2667, target: 1500, diff: -500 },
};
