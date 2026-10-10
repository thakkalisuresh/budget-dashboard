import { useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { createSettingsController } from './settingsController.js';
import { DEFAULT_CARD_OWNERS, DEFAULT_PEOPLE } from './cardOwners.js';
import { DEFAULT_SPLIT_VENDORS } from './itemCategorizer.js';
import { DEFAULT_MF_THRESHOLDS, sanitizeMfThresholds } from './mfInsights.js';

const DEV_MOCK = import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === 'true';

const TEMPLATE_ID = import.meta.env.VITE_TEMPLATE_SHEET_ID;
const SETTINGS_SHEET = 'UserSettings';

// Session cache — sheet only needs to be verified once per page load
let _sheetReady = false;

export const DEFAULT_LAYOUT = [
  { i: 'stat-cards',    x: 0, y: 0,  w: 12, h: 3,  minH: 2, minW: 4  },
  { i: 'expense-table', x: 0, y: 3,  w: 8,  h: 12, minH: 5, minW: 4  },
  { i: 'donut-chart',   x: 8, y: 3,  w: 4,  h: 8,  minH: 4, minW: 3  },
  { i: 'bar-chart',     x: 8, y: 11, w: 4,  h: 7,  minH: 3, minW: 3  },
  { i: 'insight-cards', x: 0, y: 15, w: 8,  h: 5,  minH: 3, minW: 4  },
  { i: 'non-monthly',   x: 0, y: 20, w: 8,  h: 3,  minH: 2, minW: 3  },
  { i: 'budget-rules',  x: 0, y: 23, w: 12, h: 8,  minH: 3, minW: 6  },
];

export const DEFAULT_CATEGORY_ORDER = [
  'Grocery', 'Eating Out', 'Misc', 'Thakkali', 'Entertainment',
  'Investment', 'Travel', 'Utilities', 'Car Payments', 'Rent',
  'Health', 'Furniture', 'Holiday', 'Wi-Fi',
];

export const DEFAULT_SETTINGS = {
  visibility: {
    statCards:      true,
    donutChart:     true,
    barChart:       true,
    insightCards:   true,
    nonMonthlyTile: true,
    budgetRules:    true,
    heatmap:        true,
    map:            true,
  },
  geoTagEnabled:         false,
  geoPrivacyBlur:        true,
  donutLegendCount:  5,
  barSortOrder:     'amount',
  categoryColors:   {},
  categoryOrder:    DEFAULT_CATEGORY_ORDER,
  layout:           null,
  currency:          'USD',
  categoryIcons:     {},  // { categoryName: emoji }
  customCategories:  [],  // [categoryName, ...]
  recurringExpenses: [],  // [{ category, vendor, amount }]
  nonMonthlyItems:   {},  // { 'April 2026': ['Vendor1', 'Vendor2', ...] }
  transactionNotes:  {},  // { 'sheetId_category_vendor': { note: '', tags: [], location?: {lat,lng} } }
  disabledWalletVendors: [], // [{ name, patterns: [lowercase strings] }] — skipped by wallet-webhook
  splitReceiptVendors: DEFAULT_SPLIT_VENDORS, // [{ name, patterns }] — receipts split per-category (Costco, Amazon)
  cards: [
    'Chase Sapphire Reserve',
    'American Express Blue Cash Preferred',
    'Capital One Quicksilver',
    'Chase Freedom Unlimited',
    'Chase Freedom Rise',
    'Bilt Blue Card',
    'Chase Debit Card - Anu',
    'Chase Debit Card - Sabarish',
    'Chase Bank Account - Anu',
    'Chase Bank Account - Sabarish',
    'Cash',
  ],
  cardOwners:        DEFAULT_CARD_OWNERS, // { [cardName]: 'me' | 'wife' } — splits spending by person
  people:            DEFAULT_PEOPLE,      // { me: 'Sabarish', wife: 'Anu' } — display names for the split
  cardRules:               [],  // [{ id, vendorPattern, category, card }]
  cardRewardRates:         null, // null = use hardcoded CARD_REWARDS; set by rate auto-check / Settings
  smartRules:              [],  // [{ id, pattern, category }]
  messages:                [],  // [{ id, type, title, body, timestamp, read }]
  pushHour:                20,  // preferred local hour for daily push (18-22)
  reconciledFingerprints:  [],  // ["vendor_amount", ...] — tracks imported reconciliation tx
  // ── Invest tab ──
  investSheetId:     null, // "Fundient Investments" spreadsheet id (provisioned on first open)
  investAccountRules: [    // Investment-category expense vendor → invest account (flow-through)
    { pattern: 'fidelity', accountId: 'fidelity' },
    { pattern: 'amex',     accountId: 'amex-hysa' },
    { pattern: 'happen',   accountId: 'happen-hysa' },
  ],
  investEtfSymbols:  [],   // extra symbols to treat as ETFs beyond the built-in set
  mfDisplayCurrency: 'INR', // Indian MF section display currency: 'INR' | 'USD'
  itemizeDismissed:  [],   // brokerage DEPOSIT uuids the user chose not to itemize (nudge dismissed)
  mfBufferPct:       2,    // Indian-MF monthly transfer buffer over the live FX rate (%)
  mfInrDismissed:    [],   // mf_in USD deposit uuids whose "INR received" nudge was dismissed
  mfSipSkipped:      [],   // "planId:YYYY-MM" SIP months the user chose to skip
  mfInsightThresholds: DEFAULT_MF_THRESHOLDS, // Portfolio-health markers (see mfInsights.js); no editing UI yet
  preBuyThresholds:  { concentrationPct: 25, near52wkPct: 5, overlapPct: 60, sectorCapPct: 80 }, // Candidate Check rule-check flags (Phase 2)
  colorScheme:             'default',
  titleBarColor:           null,   // PWA/browser chrome <meta theme-color>; null = match app dark bg
  hasSeenOnboarding:       false,
  keyboardShortcuts: {
    addExpense:   'alt+n',
    scanReceipt:  'alt+r',
    openSettings: 'alt+,',
    openChat:     'alt+.',
  },
};

// ─── Sheets helpers ───────────────────────────────────────────────────────────

// Every helper throws on a failed response. A throttled/failed read must never be
// mistaken for "no data" (that made load return defaults and save append rows).
class SheetsError extends Error {
  constructor(status, message) { super(message || `Sheets request failed (${status})`); this.status = status; }
}

async function sheetsFetch(path, accessToken, init = {}) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${TEMPLATE_ID}${path}`,
    {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    }
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.error) {
    throw new SheetsError(res.status ?? json?.error?.code, json?.error?.message);
  }
  return json;
}

const sheetsGet  = (path, accessToken) => sheetsFetch(path, accessToken);
const sheetsPut  = (path, body, accessToken) => sheetsFetch(path, accessToken, { method: 'PUT', body: JSON.stringify(body) });
const sheetsPost = (path, body, accessToken) => sheetsFetch(path, accessToken, { method: 'POST', body: JSON.stringify(body) });

// Transient = worth retrying: throttled, server-side, or the network itself failed.
const isTransient = (e) => !(e instanceof SheetsError) || e.status === 429 || e.status >= 500;
const LOAD_RETRY_DELAYS = [500, 1500, 3000];

async function withRetry(fn, delays) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= delays.length || !isTransient(e)) throw e;
      await new Promise(r => setTimeout(r, delays[i]));
    }
  }
}

// ─── Ensure the UserSettings tab exists ───────────────────────────────────────

async function ensureSettingsSheet(accessToken) {
  if (_sheetReady) return;
  const meta = await sheetsGet('?fields=sheets.properties.title', accessToken);
  const exists = (meta.sheets || []).some(s => s.properties?.title === SETTINGS_SHEET);
  if (!exists) {
    await sheetsPost(':batchUpdate', {
      requests: [{ addSheet: { properties: { title: SETTINGS_SHEET } } }],
    }, accessToken);
    // Write header row
    const range = encodeURIComponent(`'${SETTINGS_SHEET}'!A1:B1`);
    await sheetsPut(`/values/${range}?valueInputOption=RAW`, {
      values: [['UserID', 'Settings']],
    }, accessToken);
  }
  _sheetReady = true;
}

// ─── Read all rows from UserSettings ─────────────────────────────────────────

async function fetchRows(accessToken) {
  const range = encodeURIComponent(`'${SETTINGS_SHEET}'!A:B`);
  const json = await sheetsGet(`/values/${range}`, accessToken);
  return json.values || [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

// Resolves to defaults only when there is genuinely no stored row. Any failure
// (after retrying transient ones) rejects so callers can refuse to save.
export function loadUserSettings(userId, accessToken, { delays = LOAD_RETRY_DELAYS } = {}) {
  return withRetry(() => loadOnce(userId, accessToken), delays);
}

async function loadOnce(userId, accessToken) {
  {
    await ensureSettingsSheet(accessToken);
    const rows = await fetchRows(accessToken);
    const row = rows.find(r => r[0] === userId);
    if (!row || !row[1]) return { ...DEFAULT_SETTINGS, hasSeenOnboarding: localStorage.getItem('budget_onboarding_done') === 'true', visibility: { ...DEFAULT_SETTINGS.visibility } };
    const parsed = JSON.parse(row[1]);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      visibility:       { ...DEFAULT_SETTINGS.visibility, ...(parsed.visibility || {}) },
      categoryColors:   { ...(parsed.categoryColors || {}) },
      categoryOrder:    parsed.categoryOrder || DEFAULT_CATEGORY_ORDER,
      layout:           parsed.layout || null,
      currency:          parsed.currency || 'USD',
      categoryIcons:     { ...(parsed.categoryIcons || {}) },
      customCategories:  parsed.customCategories || [],
      recurringExpenses: parsed.recurringExpenses || [],
      nonMonthlyItems:   parsed.nonMonthlyItems   || {},
      transactionNotes:  parsed.transactionNotes  || {},
      disabledWalletVendors: parsed.disabledWalletVendors || [],
      splitReceiptVendors:   parsed.splitReceiptVendors   || DEFAULT_SPLIT_VENDORS,
      smartRules:              parsed.smartRules              || [],
      cardRewardRates:         parsed.cardRewardRates         || null,
      messages:                parsed.messages                || [],
      itemizeDismissed:        parsed.itemizeDismissed        || [],
      mfBufferPct:             Number.isFinite(parsed.mfBufferPct) ? parsed.mfBufferPct : DEFAULT_SETTINGS.mfBufferPct,
      mfInrDismissed:          parsed.mfInrDismissed          || [],
      mfSipSkipped:            parsed.mfSipSkipped            || [],
      mfDisplayCurrency:       parsed.mfDisplayCurrency === 'USD' ? 'USD' : 'INR',
      mfInsightThresholds:     sanitizeMfThresholds(parsed.mfInsightThresholds),
      // Merge so a saved copy from before the Candidate Check keys shipped still
      // gains overlapPct / sectorCapPct (saved partial overrides the defaults).
      preBuyThresholds:        { ...DEFAULT_SETTINGS.preBuyThresholds, ...(parsed.preBuyThresholds || {}) },
      // Append any new default cards the user doesn't already have (preserves user order)
      cards: (() => {
        const saved = parsed.cards || DEFAULT_SETTINGS.cards;
        const newDefaults = DEFAULT_SETTINGS.cards.filter(c => !saved.includes(c));
        return newDefaults.length ? [...saved, ...newDefaults] : saved;
      })(),
      reconciledFingerprints:  parsed.reconciledFingerprints  || [],
      hasSeenOnboarding:       parsed.hasSeenOnboarding || localStorage.getItem('budget_onboarding_done') === 'true',
      keyboardShortcuts: (() => {
        const saved = parsed.keyboardShortcuts || {};
        // Migrate any ctrl+ defaults to alt+ if the user never customised them
        const defaults = DEFAULT_SETTINGS.keyboardShortcuts;
        const OLD_DEFAULTS = { addExpense: 'ctrl+n', scanReceipt: 'ctrl+r', openSettings: 'ctrl+,', openChat: 'ctrl+.' };
        const migrated = {};
        for (const [k, newDefault] of Object.entries(defaults)) {
          const stored = saved[k];
          migrated[k] = (!stored || stored === OLD_DEFAULTS[k]) ? newDefault : stored;
        }
        return migrated;
      })(),
    };
    // Hydrate localStorage so synchronous callers (fetchDetail, dialogs) stay in sync
    try {
      localStorage.setItem('budget_category_icons', JSON.stringify(merged.categoryIcons));
      const customMap = {};
      (merged.customCategories || []).forEach(n => {
        customMap[n] = { sheet: n, descCol: 2, amtCol: 3, uuidStartCol: 4 };
      });
      localStorage.setItem('budget_custom_categories', JSON.stringify(customMap));
    } catch {}
    return merged;
  }
}

export async function saveUserSettings(userId, settings, accessToken) {
  await ensureSettingsSheet(accessToken);
  const rows = await fetchRows(accessToken); // throws on failure: never append on a failed read
  const rowIndex = rows.findIndex(r => r[0] === userId);
  const json = JSON.stringify(settings);

  if (rowIndex >= 0) {
    const range = encodeURIComponent(`'${SETTINGS_SHEET}'!A${rowIndex + 1}:B${rowIndex + 1}`);
    await sheetsPut(`/values/${range}?valueInputOption=RAW`, {
      values: [[userId, json]],
    }, accessToken);
  } else {
    const range = encodeURIComponent(`'${SETTINGS_SHEET}'!A:B`);
    await sheetsPost(
      `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values: [[userId, json]] },
      accessToken
    );
  }
  if (settings.hasSeenOnboarding) {
    try { localStorage.setItem('budget_onboarding_done', 'true'); } catch {}
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

// Keep localStorage in sync so synchronous callers (fetchDetail, dialogs) stay up to date.
function syncLocalCaches(next) {
  try {
    localStorage.setItem('budget_category_icons', JSON.stringify(next.categoryIcons || {}));
    const customMap = {};
    (next.customCategories || []).forEach(n => {
      customMap[n] = { sheet: n, descCol: 2, amtCol: 3, uuidStartCol: 4 };
    });
    localStorage.setItem('budget_custom_categories', JSON.stringify(customMap));
  } catch {}
}

export function useSettings(userId, accessToken) {
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;

  const ctrl = useMemo(() => createSettingsController({
    defaults: DEV_MOCK ? { ...DEFAULT_SETTINGS, hasSeenOnboarding: true } : DEFAULT_SETTINGS,
    status:   DEV_MOCK ? 'ready' : 'loading',
    persist:  !DEV_MOCK,
    load: () => loadUserSettings(userId, tokenRef.current),
    save: (next) => saveUserSettings(userId, next, tokenRef.current),
    onApply: syncLocalCaches,
  }), [userId]);

  const { settings, status, loadError } = useSyncExternalStore(ctrl.subscribe, ctrl.getState);

  useEffect(() => {
    if (DEV_MOCK || !userId || !accessToken) return;
    ctrl.start(); // no-op once ready or while a load is in flight
  }, [ctrl, userId, accessToken]);

  const updateSettings = useCallback((updater) => ctrl.update(updater), [ctrl]);

  // `loading` stays true while the load has failed so Invest provisioning and the
  // onboarding wizard (both gated on it) can't act on defaults.
  return { settings, loading: status !== 'ready', loadError, retryLoad: ctrl.retry, updateSettings };
}
