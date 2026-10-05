// ════════════════════════════════════════════════════════════════════════════
// sheetItemMemory.js — Sheets I/O for the append-only item-category log.
//
// Lives in the TEMPLATE spreadsheet next to UserSettings, NOT in the month
// workbook: each month is its own spreadsheet (selectedSheetId changes every
// month), so anything stored there would forget everything each January. The
// tab is shared across users, hence the UserID column.
//
// Deliberately NOT part of settings. Settings serialize into a single
// spreadsheet cell, which Sheets caps at 50,000 characters, and splitNotes.js
// is already rationing that budget. A weekly Costco trip is ~50 items; as rows
// that is nothing, as JSON in one cell it would eventually fail the whole
// settings save — taking unrelated settings down with it.
// ════════════════════════════════════════════════════════════════════════════

import { MEMORY_SHEET, MEMORY_HEADER, reduceMemoryRows, itemsInSplit, buildMemoryRows } from './itemMemory.js';

const TEMPLATE_ID = import.meta.env.VITE_TEMPLATE_SHEET_ID;

// The tab only needs to be verified once per page load.
let _sheetReady = false;
// Raw rows cached per load: the reduce is cheap, the round-trip is not, and a
// multi-receipt scan would otherwise refetch between every file.
let _rowsCache = null;

const url = path => `https://sheets.googleapis.com/v4/spreadsheets/${TEMPLATE_ID}${path}`;

async function ensureMemorySheet(accessToken) {
  if (_sheetReady) return;
  const res = await fetch(url('?fields=sheets.properties.title'), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const meta = await res.json();
  const exists = (meta.sheets || []).some(s => s.properties?.title === MEMORY_SHEET);
  if (!exists) {
    await fetch(url(':batchUpdate'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: MEMORY_SHEET } } }] }),
    });
    const range = encodeURIComponent(`'${MEMORY_SHEET}'!A1:F1`);
    await fetch(url(`/values/${range}?valueInputOption=RAW`), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [MEMORY_HEADER] }),
    });
  }
  _sheetReady = true;
}

/**
 * Every row in the log, header included, in sheet order. Cached per page load.
 * Returns [] on any failure — a missing memory must degrade to "ask the user",
 * never to a broken scan.
 */
export async function fetchItemMemoryRows(accessToken) {
  if (_rowsCache) return _rowsCache;
  if (!accessToken || !TEMPLATE_ID) return [];
  try {
    await ensureMemorySheet(accessToken);
    const range = encodeURIComponent(`'${MEMORY_SHEET}'!A:F`);
    const res = await fetch(url(`/values/${range}`), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = await res.json();
    _rowsCache = json.values || [];
    return _rowsCache;
  } catch {
    return [];
  }
}

/** Rows collapsed to a newest-wins lookup map for one user. */
export async function fetchItemMemory(userId, accessToken) {
  return reduceMemoryRows(await fetchItemMemoryRows(accessToken), userId);
}

/**
 * Append rows to the log. One API call regardless of item count.
 *
 * Never throws: losing a memory write costs the user one extra tap next time,
 * while failing the split would cost them the transaction they just logged.
 */
export async function appendItemMemory(rows, accessToken) {
  if (!rows?.length || !accessToken || !TEMPLATE_ID) return false;
  try {
    await ensureMemorySheet(accessToken);
    const range = encodeURIComponent(`'${MEMORY_SHEET}'!A:F`);
    await fetch(
      url(`/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: rows }),
      }
    );
    // Keep the cache truthful rather than dropping it — the next scan in this
    // session should see what this one just learned.
    if (_rowsCache) _rowsCache.push(...rows);
    return true;
  } catch {
    return false;
  }
}

/**
 * The user moved a whole split-derived transaction to another category. Every
 * line item that went into it should learn the new answer.
 *
 * This is the strongest correction signal there is — it happens after the
 * receipt is filed and forgotten, when the user is looking at their real
 * budget and decides the split was wrong. Without this, moving "Costco
 * Grocery $84" to Misc fixes the month but teaches nothing, and the next
 * Costco receipt confidently repeats the mistake.
 *
 * The item list comes from the memory log via splitId, not from the note text:
 * notes are truncated to 10 items and a character cap, so parsing them back
 * would silently relearn only part of the basket.
 *
 * @returns number of items re-taught (0 when there's nothing to learn from)
 */
export async function relearnMovedSplit({ userId, accessToken, splitId, fromCategory, toCategory }) {
  if (!splitId || !toCategory || fromCategory === toCategory) return 0;
  const rows = await fetchItemMemoryRows(accessToken);
  const items = itemsInSplit(rows, { userId, splitId, category: fromCategory });
  if (!items.length) return 0;

  const vendor = items[0].vendor;
  const ok = await appendItemMemory(
    buildMemoryRows({
      userId,
      vendor,
      items: items.map(i => ({ name: i.name, category: toCategory })),
      // Same split, so a later move of the same transaction still finds them.
      splitId,
    }),
    accessToken
  );
  return ok ? items.length : 0;
}

/** Test seam / sign-out: forget the per-load caches. */
export function resetItemMemoryCache() {
  _sheetReady = false;
  _rowsCache = null;
}
