import { useState, useEffect, useCallback } from 'react';

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
  cards: [
    'Chase Sapphire Reserve',
    'American Express Blue Cash Preferred',
    'Capital One Quicksilver',
    'Chase Freedom Unlimited',
    'Bilt Blue Card',
    'Chase Debit Card - Anu',
    'Chase Debit Card - Sabarish',
    'Chase Bank Account - Anu',
    'Chase Bank Account - Sabarish',
    'Cash',
  ],
  cardRules:               [],  // [{ id, vendorPattern, category, card }]
  cardRewardRates:         null, // null = use hardcoded CARD_REWARDS; set by rate auto-check / Settings
  smartRules:              [],  // [{ id, pattern, category }]
  messages:                [],  // [{ id, type, title, body, timestamp, read }]
  pushHour:                20,  // preferred local hour for daily push (18-22)
  reconciledFingerprints:  [],  // ["vendor_amount", ...] — tracks imported reconciliation tx
  colorScheme:             'amber',
  hasSeenOnboarding:       false,
  keyboardShortcuts: {
    addExpense:   'alt+n',
    scanReceipt:  'alt+r',
    openSettings: 'alt+,',
    openChat:     'alt+.',
  },
};

// ─── Sheets helpers ───────────────────────────────────────────────────────────

async function sheetsGet(path, accessToken) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${TEMPLATE_ID}${path}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return res.json();
}

async function sheetsPut(path, body, accessToken) {
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${TEMPLATE_ID}${path}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

async function sheetsPost(path, body, accessToken) {
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${TEMPLATE_ID}${path}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
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

export async function loadUserSettings(userId, accessToken) {
  try {
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
      smartRules:              parsed.smartRules              || [],
      cardRewardRates:         parsed.cardRewardRates         || null,
      messages:                parsed.messages                || [],
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
  } catch {
    return { ...DEFAULT_SETTINGS, visibility: { ...DEFAULT_SETTINGS.visibility } };
  }
}

export async function saveUserSettings(userId, settings, accessToken) {
  try {
    await ensureSettingsSheet(accessToken);
    const rows = await fetchRows(accessToken);
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
  } catch (e) {
    console.error('saveUserSettings:', e);
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSettings(userId, accessToken) {
  const [settings, setSettings] = useState(() =>
    DEV_MOCK ? { ...DEFAULT_SETTINGS, hasSeenOnboarding: true } : DEFAULT_SETTINGS
  );
  const [loading, setLoading]   = useState(!DEV_MOCK);

  useEffect(() => {
    if (DEV_MOCK) return;
    if (!userId || !accessToken) return;
    loadUserSettings(userId, accessToken).then(s => {
      setSettings(s);
      setLoading(false);
    });
  }, [userId, accessToken]);

  const updateSettings = useCallback((updater) => {
    setSettings(prev => {
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
      // Keep localStorage in sync so synchronous callers stay up to date
      try {
        localStorage.setItem('budget_category_icons', JSON.stringify(next.categoryIcons || {}));
        const customMap = {};
        (next.customCategories || []).forEach(n => {
          customMap[n] = { sheet: n, descCol: 2, amtCol: 3, uuidStartCol: 4 };
        });
        localStorage.setItem('budget_custom_categories', JSON.stringify(customMap));
      } catch {}
      if (!DEV_MOCK) saveUserSettings(userId, next, accessToken); // fire-and-forget
      return next;
    });
  }, [userId, accessToken]);

  return { settings, loading, updateSettings };
}

