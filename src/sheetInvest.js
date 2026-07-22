// ════════════════════════════════════════════════════════════════════════════
// sheetInvest.js — CRUD for the dedicated "Fundient Investments" spreadsheet.
//
// One spreadsheet (NOT tabs in the monthly template — that sheet is copied
// every month by createMonth, so anything added there would leak into every
// month). Provisioned lazily on first Invest-tab open; its ID lives in
// UserSettings (settings.investSheetId) so both the client and the serverless
// rate-watch function can find it.
//
// Tabs:
//   Accounts   — id | name | type | institution | apy | balance | balanceAsOf | goal
//   Activities — date | accountId | type | symbol | qty | price | amount | note | uuid
//   Snapshots  — date | accountId | balance
//   RateWatch  — scanDate | bestBank | bestApy | yourBestApy | delta | detailsJson
// ════════════════════════════════════════════════════════════════════════════
import { apiFetch } from './sheetApi.js';
import { safeText } from './sheetHelpers.js';
import { shareSheetWithUsers } from './useMonths.js';
import { requestDriveToken } from './driveAuth.js';
import { FDIC_MAX } from './investMath.js';

export const INVEST_TABS = {
  Accounts:   ['id', 'name', 'type', 'institution', 'apy', 'balance', 'balanceAsOf', 'goal'],
  Activities: ['date', 'accountId', 'type', 'symbol', 'qty', 'price', 'amount', 'note', 'uuid'],
  Snapshots:  ['date', 'accountId', 'balance'],
  RateWatch:  ['scanDate', 'bestBank', 'bestApy', 'yourBestApy', 'delta', 'detailsJson'],
};

export const ACTIVITY_TYPES = ['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAW', 'INTEREST', 'FEE'];

// Seed rows for the household's known accounts — editable afterwards in the UI.
const SEED_ACCOUNTS = [
  ['amex-hysa',   'Amex Savings', 'hysa',      'American Express', 0, 0, '', FDIC_MAX],
  ['happen-hysa', 'Happen Bank',  'hysa',      'Happen Bank',      0, 0, '', FDIC_MAX],
  ['fidelity',    'Fidelity',     'brokerage', 'Fidelity',         '', '', '', ''],
];

const activityUUID = () => `act_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const todayIso = () => new Date().toISOString().slice(0, 10);

const authJson = (accessToken) => ({
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
});

/**
 * Create the Investments spreadsheet with all tabs + headers + seed accounts
 * in a single spreadsheets.create call, then best-effort share it with the
 * household. Returns the new spreadsheetId.
 */
export async function createInvestSheet(accessToken, allowedEmails = []) {
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: authJson(accessToken),
    body: JSON.stringify({
      properties: { title: 'Fundient Investments' },
      sheets: Object.entries(INVEST_TABS).map(([title, headers]) => ({
        properties: { title },
        data: [{
          startRow: 0, startColumn: 0,
          rowData: [
            { values: headers.map(h => ({ userEnteredValue: { stringValue: h } })) },
            ...(title === 'Accounts'
              ? SEED_ACCOUNTS.map(row => ({
                  values: row.map(v => ({
                    userEnteredValue: typeof v === 'number'
                      ? { numberValue: v }
                      : { stringValue: String(v) },
                  })),
                }))
              : []),
          ],
        }],
      })),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || 'Failed to create the Investments sheet.');
  }
  const { spreadsheetId } = await res.json();

  // Sharing needs the Drive scope (separate consent, like month creation).
  // Non-fatal: the sheet still works for the creator; re-share from Settings.
  try {
    const driveToken = await requestDriveToken();
    await shareSheetWithUsers(spreadsheetId, allowedEmails, driveToken);
  } catch (e) {
    console.warn('Investments sheet created but sharing failed (re-share from Settings):', e?.message);
  }

  return spreadsheetId;
}

/**
 * Return settings.investSheetId, provisioning the spreadsheet on first use and
 * persisting the id through updateSettings. Callers pass the whole settings
 * hook surface so this stays storage-agnostic.
 */
export async function ensureInvestSheet({ settings, updateSettings, accessToken, allowedEmails = [] }) {
  if (settings.investSheetId) return settings.investSheetId;
  const id = await createInvestSheet(accessToken, allowedEmails);
  updateSettings(prev => ({ ...prev, investSheetId: id }));
  return id;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export async function fetchAccounts(sheetId, accessToken) {
  const range = encodeURIComponent("'Accounts'!A2:H50");
  const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return (json.values || [])
    .map((r, i) => ({
      rowIndex: i + 2,
      id: String(r[0] || ''),
      name: String(r[1] || ''),
      type: String(r[2] || ''),
      institution: String(r[3] || ''),
      apy: Number(r[4]) || 0,
      balance: Number(r[5]) || 0,
      balanceAsOf: String(r[6] || ''),
      goal: Number(r[7]) || 0,
    }))
    .filter(a => a.id);
}

/**
 * Update an account's balance and/or APY. A balance change also appends a
 * Snapshot row so history accrues for future charts.
 */
export async function updateAccount(sheetId, accessToken, accountId, { balance, apy } = {}) {
  const accounts = await fetchAccounts(sheetId, accessToken);
  const acct = accounts.find(a => a.id === accountId);
  if (!acct) throw new Error(`Unknown account: ${accountId}`);

  const newApy = apy ?? acct.apy;
  const newBalance = balance ?? acct.balance;
  const range = encodeURIComponent(`'Accounts'!E${acct.rowIndex}:G${acct.rowIndex}`);
  await apiFetch(sheetId, `/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: authJson(accessToken),
    body: JSON.stringify({ values: [[newApy, newBalance, todayIso()]] }),
  });

  if (balance != null && balance !== acct.balance) {
    await appendSnapshot(sheetId, accessToken, { accountId, balance });
  }
  return { ...acct, apy: newApy, balance: newBalance, balanceAsOf: todayIso() };
}

// ── Activities ───────────────────────────────────────────────────────────────

function activityRow(a) {
  return [
    a.date || todayIso(),
    String(a.accountId || ''),
    String(a.type || ''),
    String(a.symbol || '').toUpperCase(),
    a.qty === '' || a.qty == null ? '' : Number(a.qty),
    a.price === '' || a.price == null ? '' : Number(a.price),
    a.amount === '' || a.amount == null ? '' : Number(a.amount),
    safeText(String(a.note || '')),
    a.uuid || activityUUID(),
  ];
}

export async function appendActivity(sheetId, accessToken, activity) {
  return appendActivities(sheetId, accessToken, [activity]);
}

/** Bulk append (CSV import). Returns the uuids written, in input order. */
export async function appendActivities(sheetId, accessToken, activities) {
  if (!activities.length) return [];
  const rows = activities.map(activityRow);
  const range = encodeURIComponent("'Activities'!A1");
  await apiFetch(sheetId, `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: authJson(accessToken),
    body: JSON.stringify({ values: rows }),
  });
  return rows.map(r => r[8]);
}

export async function fetchActivities(sheetId, accessToken) {
  const range = encodeURIComponent("'Activities'!A2:I5000");
  const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return (json.values || [])
    .map((r, i) => ({
      rowIndex: i + 2,
      date: String(r[0] || ''),
      accountId: String(r[1] || ''),
      type: String(r[2] || ''),
      symbol: String(r[3] || ''),
      qty: r[4] === '' || r[4] == null ? null : Number(r[4]),
      price: r[5] === '' || r[5] == null ? null : Number(r[5]),
      amount: r[6] === '' || r[6] == null ? null : Number(r[6]),
      note: String(r[7] || ''),
      uuid: String(r[8] || ''),
    }))
    .filter(a => a.date && a.type);
}

/** Delete one activity row by uuid (mis-entry fix). Row delete keeps the log clean. */
export async function deleteActivityByUUID(sheetId, accessToken, uuid) {
  const all = await fetchActivities(sheetId, accessToken);
  const hit = all.find(a => a.uuid === uuid);
  if (!hit) throw new Error(`Activity ${uuid} not found`);
  const meta = await apiFetch(sheetId, '?fields=sheets.properties', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const tab = meta.sheets?.find(s => s.properties.title === 'Activities');
  if (!tab) throw new Error('Activities tab missing');
  await apiFetch(sheetId, ':batchUpdate', {
    method: 'POST',
    headers: authJson(accessToken),
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: {
            sheetId: tab.properties.sheetId,
            dimension: 'ROWS',
            startIndex: hit.rowIndex - 1,
            endIndex: hit.rowIndex,
          },
        },
      }],
    }),
  });
}

// ── Snapshots ────────────────────────────────────────────────────────────────

export async function appendSnapshot(sheetId, accessToken, { accountId, balance, date }) {
  const range = encodeURIComponent("'Snapshots'!A1");
  await apiFetch(sheetId, `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: authJson(accessToken),
    body: JSON.stringify({ values: [[date || todayIso(), String(accountId), Number(balance) || 0]] }),
  });
}

// ── Rate watch (rows written by the scheduled function) ─────────────────────

export async function fetchRateWatch(sheetId, accessToken, limit = 12) {
  const range = encodeURIComponent("'RateWatch'!A2:F200");
  const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const rows = (json.values || [])
    .map(r => {
      let details = [];
      try { details = JSON.parse(r[5] || '[]'); } catch { /* keep [] */ }
      return {
        scanDate: String(r[0] || ''),
        bestBank: String(r[1] || ''),
        bestApy: Number(r[2]) || 0,
        yourBestApy: Number(r[3]) || 0,
        delta: Number(r[4]) || 0,
        details,
      };
    })
    .filter(r => r.scanDate);
  return rows.slice(-limit).reverse(); // newest first
}
