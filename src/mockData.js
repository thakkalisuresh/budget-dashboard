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

// ── Indian mutual funds (nro-mf): flexi + ITI mapped, the other two left unmapped ──
// Three monthly INR 5,000 SIPs per fund at a drifting INR/USD (0.0118 → 0.0113).
const MF_SIPS = [
  { plan: 'BIRLA-FLEXI',        navs: [98.2, 101.6, 104.9] },
  { plan: 'BIRLA-CONGLOMERATE', navs: [310.5, 318.2, 322.0] },
  { plan: 'SBI-RETIREMENT',     navs: [24.1, 24.6, 24.4] },
  { plan: 'ITI-SMALL-CAP',      navs: [21.4, 20.9, 22.3] },
];
const MF_MONTHS = [['2026-07-05', 0.0118], ['2026-08-05', 0.01155], ['2026-09-05', 0.0113]];
export const MOCK_MF_ACTIVITIES = MF_MONTHS.flatMap(([date, fx], m) => [
  { date, accountId: 'nro-mf', type: 'DEPOSIT', symbol: '', qty: null, price: null, amount: 250, note: '', uuid: `act_mfd${m}`, currency: 'USD', fxToUsd: 1 },
  { date, accountId: 'nro-mf', type: 'INR_RECEIVED', symbol: '', qty: null, price: null, amount: 20000 + 100 * m, note: `settles:act_mfd${m}`, uuid: `act_mfr${m}`, currency: 'INR', fxToUsd: fx },
  ...MF_SIPS.map(({ plan, navs }, i) => ({
    date, accountId: 'nro-mf', type: 'BUY', symbol: plan, qty: Math.round((5000 / navs[m]) * 1000) / 1000, price: navs[m],
    amount: 5000, note: '', uuid: `act_mfb${m}${i}`, currency: 'INR', fxToUsd: fx,
  })),
]);
// In-transit USD deposit (this month, no INR_RECEIVED yet) so the "INR received?" nudge,
// the transfer planner and — with no BUY yet this month — pending SIP cards all render.
const MOCK_MF_IN_TRANSIT = {
  date: `${new Date().toISOString().slice(0, 7)}-02`, accountId: 'nro-mf', type: 'DEPOSIT', symbol: '', qty: null, price: null,
  amount: 250, note: '', uuid: 'act_mfd_transit', currency: 'USD', fxToUsd: 1,
};
export const MOCK_SIP_PLANS = [
  { rowIndex: 2, id: 'birla-flexi',        schemeCode: '120564',   mapped: true,  name: 'Aditya Birla Sun Life Flexi Cap Fund - Direct Plan - Growth', amc: 'Aditya Birla Sun Life', amountInr: 5000, day: null, accountId: 'nro-mf', active: true },
  { rowIndex: 3, id: 'birla-conglomerate', schemeCode: 'unmapped', mapped: false, name: 'Birla Conglomerate Fund',   amc: 'Aditya Birla Sun Life', amountInr: 5000, day: null, accountId: 'nro-mf', active: true },
  { rowIndex: 4, id: 'sbi-retirement',     schemeCode: 'unmapped', mapped: false, name: 'SBI Retirement Fund',       amc: 'SBI',                   amountInr: 5000, day: null, accountId: 'nro-mf', active: true },
  { rowIndex: 5, id: 'iti-small-cap',      schemeCode: '147919',   mapped: true,  name: 'ITI Small Cap Fund - Direct Plan - Growth', amc: 'ITI', amountInr: 5000, day: null, accountId: 'nro-mf', active: true },
];
// Stand-ins for /api/mf-nav in mock mode (no backend, no auth).
export const MOCK_MF_NAV = {
  navs: {
    120564: { schemeCode: '120564', name: 'Aditya Birla Sun Life Flexi Cap Fund - Direct Plan - Growth', amc: 'Aditya Birla Sun Life Mutual Fund', plan: 'direct', option: 'growth', nav: 108.74, date: '2026-10-08' },
    147919: { schemeCode: '147919', name: 'ITI Small Cap Fund - Direct Plan - Growth', amc: 'ITI Mutual Fund', plan: 'direct', option: 'growth', nav: 21.18, date: '2026-10-08' },
  },
  fx: { currency: 'INR', rate: 88.4, updatedAt: '2026-10-09T06:00:00Z' },
};
export const MOCK_MF_SEARCH = [
  { code: '153124', name: 'Aditya Birla Sun Life Conglomerate Fund - Direct Plan - Growth', amc: 'Aditya Birla Sun Life Mutual Fund', plan: 'direct', option: 'growth', nav: 14.32, date: '2026-10-08' },
  { code: '153120', name: 'Aditya Birla Sun Life Conglomerate Fund - Regular Plan - Growth', amc: 'Aditya Birla Sun Life Mutual Fund', plan: 'regular', option: 'growth', nav: 13.91, date: '2026-10-08' },
  { code: '153125', name: 'Aditya Birla Sun Life Conglomerate Fund - Direct Plan - IDCW', amc: 'Aditya Birla Sun Life Mutual Fund', plan: 'direct', option: 'idcw', nav: 14.32, date: '2026-10-08' },
  { code: '148683', name: 'SBI Retirement Benefit Fund - Aggressive Plan - Direct Plan - Growth', amc: 'SBI Mutual Fund', plan: 'direct', option: 'growth', nav: 18.4, date: '2026-10-08' },
  { code: '148685', name: 'SBI Retirement Benefit Fund - Aggressive Hybrid Plan - Direct Plan - Growth', amc: 'SBI Mutual Fund', plan: 'direct', option: 'growth', nav: 17.2, date: '2026-10-08' },
  { code: '148688', name: 'SBI Retirement Benefit Fund - Conservative Plan - Direct Plan - Growth', amc: 'SBI Mutual Fund', plan: 'direct', option: 'growth', nav: 15.9, date: '2026-10-08' },
  { code: '148690', name: 'SBI Retirement Benefit Fund - Conservative Hybrid Plan - Direct Plan - Growth', amc: 'SBI Mutual Fund', plan: 'direct', option: 'growth', nav: 16.1, date: '2026-10-08' },
];

// ── Invest tab (accounts + activity log + a rate-watch scan) ─────────────────
export const MOCK_INVEST = {
  accounts: [
    { rowIndex: 2, id: 'amex-hysa',   name: 'Amex Savings', type: 'hysa',      institution: 'American Express', apy: 3.7, balance: 28400, balanceAsOf: '2026-07-01', goal: 250000 },
    { rowIndex: 3, id: 'happen-hysa', name: 'Happen Bank',  type: 'hysa',      institution: 'Happen Bank',      apy: 4.4, balance: 41250, balanceAsOf: '2026-07-01', goal: 250000 },
    { rowIndex: 4, id: 'fidelity',    name: 'Fidelity',     type: 'brokerage', institution: 'Fidelity',         apy: 0,   balance: 0,     balanceAsOf: '',            goal: 0 },
    { rowIndex: 5, id: 'nro-mf',      name: 'India MF (NRO)', type: 'mf_in',   institution: 'NRO account',      apy: 0,   balance: 0,     balanceAsOf: '',            goal: 0, currency: 'INR' },
  ],
  activities: [
    { rowIndex: 2, date: '2026-01-06', accountId: 'fidelity', type: 'BUY', symbol: 'VOO',  qty: 10, price: 478.2,  amount: 4782,    note: '', uuid: 'act_m1' },
    { rowIndex: 3, date: '2026-03-04', accountId: 'fidelity', type: 'BUY', symbol: 'VOO',  qty: 8,  price: 496.5,  amount: 3972,    note: '', uuid: 'act_m2' },
    { rowIndex: 4, date: '2026-02-11', accountId: 'fidelity', type: 'BUY', symbol: 'AAPL', qty: 25, price: 210,    amount: 5250,    note: '', uuid: 'act_m3' },
    { rowIndex: 5, date: '2026-04-18', accountId: 'fidelity', type: 'BUY', symbol: 'NVDA', qty: 32, price: 149.8,  amount: 4793.6,  note: '', uuid: 'act_m4' },
    { rowIndex: 6, date: '2026-05-07', accountId: 'fidelity', type: 'BUY', symbol: 'VTI',  qty: 15, price: 268.4,  amount: 4026,    note: '', uuid: 'act_m5' },
    { rowIndex: 7, date: '2026-06-12', accountId: 'fidelity', type: 'BUY', symbol: 'MSFT', qty: 8,  price: 431.9,  amount: 3455.2,  note: '', uuid: 'act_m6' },
    { rowIndex: 8, date: '2026-06-10', accountId: 'fidelity', type: 'DIVIDEND', symbol: 'VOO', qty: null, price: null, amount: 17.42, note: '', uuid: 'act_m7' },
    { rowIndex: 9, date: '2026-07-01', accountId: 'happen-hysa', type: 'DEPOSIT',  symbol: '', qty: null, price: null, amount: 1000, note: '', uuid: 'act_m8' },
    { rowIndex: 10, date: '2026-07-01', accountId: 'amex-hysa',  type: 'DEPOSIT',  symbol: '', qty: null, price: null, amount: 1000, note: '', uuid: 'act_m9' },
    { rowIndex: 11, date: '2026-07-01', accountId: 'happen-hysa', type: 'INTEREST', symbol: '', qty: null, price: null, amount: 151.25, note: '', uuid: 'act_m10' },
    ...MOCK_MF_ACTIVITIES,
    MOCK_MF_IN_TRANSIT,
  ],
  sipPlans: MOCK_SIP_PLANS,
  rateWatch: [
    { scanDate: '2026-07-08', bestBank: 'Openbank', bestApy: 4.75, yourBestApy: 4.4, delta: 0.35, rowIndex: 2, details: [{ bank: 'Openbank', apy: 4.75 }, { bank: 'Pibank', apy: 4.6 }, { bank: 'BrioDirect', apy: 4.55 }], proposals: [{ accountId: 'amex-hysa', bank: 'Amex Savings', currentApy: 3.7, proposedApy: 3.85, effectiveDate: '2026-07-01' }] },
  ],
  quotes: {
    VOO:  { price: 512.4,  prevClose: 509.3,  dayChangePct: 0.61,  high: 514.1, low: 508.2, open: 509.9 },
    AAPL: { price: 233.6,  prevClose: 231.02, dayChangePct: 1.12,  high: 234.9, low: 230.8, open: 231.4 },
    NVDA: { price: 171.9,  prevClose: 172.62, dayChangePct: -0.42, high: 173.5, low: 170.9, open: 173.1 },
    VTI:  { price: 282.1,  prevClose: 280.75, dayChangePct: 0.48,  high: 282.9, low: 280.1, open: 280.9 },
    MSFT: { price: 445.2,  prevClose: 441.14, dayChangePct: 0.92,  high: 446.8, low: 440.6, open: 441.5 },
  },
};
