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
//   Accounts    — id | name | type | institution | apy | balance | balanceAsOf | goal
//   Activities  — date | accountId | type | symbol | qty | price | amount | note | uuid
//   Snapshots   — date | accountId | balance
//   RateWatch   — scanDate | bestBank | bestApy | yourBestApy | delta | detailsJson
//   RateHistory — accountId | apy | effectiveDate | source   (source: manual|rate-watch)
// ════════════════════════════════════════════════════════════════════════════
import { apiFetch } from './sheetApi.js';
import { safeText } from './sheetHelpers.js';
import { shareSheetWithUsers } from './useMonths.js';
import { requestDriveToken } from './driveAuth.js';
import { FDIC_MAX } from './investMath.js';

export const INVEST_TABS = {
  Accounts:    ['id', 'name', 'type', 'institution', 'apy', 'balance', 'balanceAsOf', 'goal'],
  Activities:  ['date', 'accountId', 'type', 'symbol', 'qty', 'price', 'amount', 'note', 'uuid'],
  Snapshots:   ['date', 'accountId', 'balance'],
  RateWatch:   ['scanDate', 'bestBank', 'bestApy', 'yourBestApy', 'delta', 'detailsJson'],
  // HYSA APY is variable: every change is appended here with its effective date
  // (the old rate still governs interest accrued before it). source records how
  // the change got in — a manual gauge edit, or a confirmed rate-watch finding.
  RateHistory: ['accountId', 'apy', 'effectiveDate', 'source'],
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
 * Update an account's balance and/or APY.
 *   - a balance change appends a Snapshot row (balance history for charts)
 *   - an APY change appends a RateHistory row (variable-rate audit trail),
 *     tagged with `rateSource`: 'manual' for a gauge edit, 'rate-watch' for a
 *     user-confirmed rate-watch finding.
 * Both history appends are best-effort: the account write is what matters, so a
 * history hiccup (e.g. a pre-RateHistory sheet) never fails the update.
 */
export async function updateAccount(sheetId, accessToken, accountId, { balance, apy, rateSource = 'manual' } = {}) {
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
  if (apy != null && apy !== acct.apy) {
    try {
      await ensureRateHistoryTab(sheetId, accessToken);
      await appendRateHistory(sheetId, accessToken, { accountId, apy: newApy, source: rateSource });
    } catch (e) {
      console.warn('RateHistory append failed (non-fatal):', e?.message);
    }
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

// ── Rate history (every APY change, with its effective date) ────────────────

/** Append one APY change to RateHistory. source: 'manual' | 'rate-watch'. */
export async function appendRateHistory(sheetId, accessToken, { accountId, apy, effectiveDate, source = 'manual' }) {
  const range = encodeURIComponent("'RateHistory'!A1");
  await apiFetch(sheetId, `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: authJson(accessToken),
    body: JSON.stringify({
      values: [[String(accountId), Number(apy) || 0, effectiveDate || todayIso(), String(source || 'manual')]],
    }),
  });
}

export async function fetchRateHistory(sheetId, accessToken) {
  const range = encodeURIComponent("'RateHistory'!A2:D500");
  const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return (json.values || [])
    .map((r, i) => ({
      rowIndex: i + 2,
      accountId: String(r[0] || ''),
      apy: Number(r[1]) || 0,
      effectiveDate: String(r[2] || ''),
      source: String(r[3] || 'manual'),
    }))
    .filter(r => r.accountId);
}

/**
 * Idempotently make sure the RateHistory tab exists on an already-provisioned
 * sheet (sheets created before this tab shipped have everything else but this).
 * Fresh sheets get it from createInvestSheet. Returns true if it created it.
 */
export async function ensureRateHistoryTab(sheetId, accessToken) {
  const meta = await apiFetch(sheetId, '?fields=sheets.properties', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const exists = (meta.sheets || []).some(s => s.properties?.title === 'RateHistory');
  if (exists) return false;

  await apiFetch(sheetId, ':batchUpdate', {
    method: 'POST',
    headers: authJson(accessToken),
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: 'RateHistory' } } }] }),
  });
  const range = encodeURIComponent("'RateHistory'!A1");
  await apiFetch(sheetId, `/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: authJson(accessToken),
    body: JSON.stringify({ values: [INVEST_TABS.RateHistory] }),
  });
  return true;
}

// ── Rate watch (rows written by the scheduled function) ─────────────────────

export async function fetchRateWatch(sheetId, accessToken, limit = 12) {
  const range = encodeURIComponent("'RateWatch'!A2:F200");
  const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const rows = (json.values || [])
    .map((r, i) => {
      // detailsJson is either the legacy bare array of alternative rates, or an
      // object { alternatives, proposals } once the scan started recording
      // held-bank advertised-rate change proposals. Tolerate both.
      let details = [], proposals = [];
      try {
        const parsed = JSON.parse(r[5] || '[]');
        if (Array.isArray(parsed)) {
          details = parsed;
        } else if (parsed && typeof parsed === 'object') {
          details = parsed.alternatives || parsed.details || [];
          proposals = parsed.proposals || [];
        }
      } catch { /* keep [] */ }
      return {
        rowIndex: i + 2,
        scanDate: String(r[0] || ''),
        bestBank: String(r[1] || ''),
        bestApy: Number(r[2]) || 0,
        yourBestApy: Number(r[3]) || 0,
        delta: Number(r[4]) || 0,
        details,
        proposals,
      };
    })
    .filter(r => r.scanDate);
  return rows.slice(-limit).reverse(); // newest first
}

/**
 * Rewrite one RateWatch row's detailsJson (column F) — used to clear/dismiss a
 * held-bank proposal after the user confirms or rejects it, so the nudge drops
 * off the card. rowIndex comes from fetchRateWatch.
 */
export async function writeRateWatchDetails(sheetId, accessToken, rowIndex, { alternatives = [], proposals = [] } = {}) {
  const range = encodeURIComponent(`'RateWatch'!F${rowIndex}`);
  await apiFetch(sheetId, `/values/${range}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: authJson(accessToken),
    body: JSON.stringify({ values: [[JSON.stringify({ alternatives, proposals })]] }),
  });
}
