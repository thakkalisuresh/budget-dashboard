import { apiFetch, fetchRaw, writeCell, clearRowRange } from './sheetApi.js';
import {
  getEffectiveSheetMap, colLetter, safeText, parseAmounts, buildFormula,
  generateTransactionUUID, uuidStart, detectV2, coerceTxDate,
} from './sheetHelpers.js';
import { invalidateDetailCache } from './sheetDetail.js';
import { appendHistoryEntry } from './sheetHistory.js';
import { enqueue } from './offlineQueue.js';
import { codedError } from './errorCodes.js';

export async function addOrUpdateExpense(
  categoryName, vendorName, amount, accessToken, sheetId, monthName,
  source = 'manual', txDate = null, paymentMethod = '', bookingMethod = '',
) {
  if (!navigator.onLine) {
    enqueue({ type: 'add_expense', payload: { categoryName, vendorName, amount, monthName, source, txDate, paymentMethod } });
    return { queued: true };
  }

  const config = getEffectiveSheetMap()[categoryName];
  if (!config) throw codedError('SHT-003', `Unknown category: ${categoryName}`);

  const values   = await fetchRaw(sheetId, config.sheet, accessToken);
  const dataRows = values.slice(1);
  const isV2     = detectV2(values, monthName);

  let month, year;
  if (monthName) {
    const parts = monthName.split(' ');
    month = parts[0];
    year  = parseInt(parts[1]) || new Date().getFullYear();
  } else {
    const now = new Date();
    month = now.toLocaleString('en-US', { month: 'short' });
    year  = now.getFullYear();
  }

  const newUUID = generateTransactionUUID(amount);

  if (isV2) {
    const dateVal      = coerceTxDate(txDate);
    const descColV2    = 3;
    const amtColV2     = 4;
    const pmColV2      = 5;
    // Booking Method only on Travel/Holiday; UUID is always the last column
    const isTravelCat  = categoryName === 'Travel' || categoryName === 'Holiday';
    const bmColV2      = isTravelCat ? 6 : -1;
    const uuidColV2    = isTravelCat ? 7 : 6;

    const newRow = Array(uuidColV2 + 1).fill('');
    newRow[0]         = month;
    newRow[1]         = year;
    newRow[2]         = dateVal;
    newRow[descColV2] = safeText(vendorName);
    newRow[amtColV2]  = amount;
    newRow[pmColV2]   = safeText(paymentMethod || '');
    if (bmColV2 >= 0) newRow[bmColV2] = safeText(bookingMethod || '');
    newRow[uuidColV2] = newUUID;

    // Find the last row that has actual data (vendor or amount) rather than using
    // values.length, which counts formula-only rows returned by the FORMULA render
    // mode even when they appear visually empty (e.g. =SUM(...) in a totals row).
    let lastDataIdx = 0;
    for (let i = values.length - 1; i >= 1; i--) {
      const r = values[i];
      if (r && (r[3] || r[4])) { lastDataIdx = i; break; }
    }
    const nextRow  = lastDataIdx + 2;
    const endCol   = colLetter(uuidColV2);
    const rowRange = encodeURIComponent(`'${config.sheet}'!A${nextRow}:${endCol}${nextRow}`);
    // RAW preserves the date string as text so Sheets doesn't convert it to a serial number.
    await apiFetch(sheetId, `/values/${rowRange}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [newRow] }),
    });
    await appendHistoryEntry(sheetId, accessToken, {
      action: source === 'scan' ? 'Receipt Scan' : source === 'import' ? 'Import' : 'Added',
      category: categoryName, vendor: vendorName, amount, uuid: newUUID, txDate: dateVal,
      paymentMethod, bookingMethod,
    });
  } else {
    const uuidCol = uuidStart(config);

    let foundIndex = -1;
    for (let i = 0; i < dataRows.length; i++) {
      const desc = dataRows[i][config.descCol];
      if (desc && String(desc).trim().toLowerCase() === vendorName.trim().toLowerCase()) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex >= 0) {
      const sheetRow     = foundIndex + 2;
      const currentValue = dataRows[foundIndex][config.amtCol] ?? '';
      const existing     = parseAmounts(currentValue);
      await writeCell(sheetId, config.sheet, sheetRow, config.amtCol, buildFormula([...existing, amount]), accessToken);
      await writeCell(sheetId, config.sheet, sheetRow, uuidCol + existing.length, newUUID, accessToken);
      await appendHistoryEntry(sheetId, accessToken, {
        action: 'Updated', category: categoryName, vendor: vendorName, amount, uuid: newUUID,
      });
    } else {
      const newRow = Array(uuidCol + 1).fill('');
      newRow[0]              = month;
      newRow[1]              = year;
      newRow[config.descCol] = safeText(vendorName);
      newRow[config.amtCol]  = amount;
      newRow[uuidCol]        = newUUID;

      let lastDataIdxV1 = 0;
      for (let i = values.length - 1; i >= 1; i--) {
        const r = values[i];
        if (r && (r[config.descCol] || r[config.amtCol])) { lastDataIdxV1 = i; break; }
      }
      const nextRowV1 = lastDataIdxV1 + 2;
      const endColV1  = colLetter(uuidCol);
      const rangeV1   = encodeURIComponent(`'${config.sheet}'!A${nextRowV1}:${endColV1}${nextRowV1}`);
      await apiFetch(sheetId, `/values/${rangeV1}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [newRow] }),
      });
      await appendHistoryEntry(sheetId, accessToken, {
        action: source === 'scan' ? 'Receipt Scan' : source === 'import' ? 'Import' : 'Added',
        category: categoryName, vendor: vendorName, amount, uuid: newUUID,
      });
    }
  }

  invalidateDetailCache(sheetId, categoryName);
}

/**
 * Update the Payment Method (card) of an existing V2 transaction.
 * Writes to col F (index 5) of the category sheet row, logs to History,
 * and invalidates the detail cache.
 */
export async function updatePaymentMethod(categoryName, rowIndex, newCard, accessToken, sheetId) {
  const config = getEffectiveSheetMap()[categoryName];
  if (!config) throw codedError('SHT-003', `Unknown category: ${categoryName}`);
  await writeCell(sheetId, config.sheet, rowIndex, 5, safeText(newCard || ''), accessToken);
  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Card Updated',
    category: categoryName,
    details: newCard || '(removed)',
  });
  invalidateDetailCache(sheetId, categoryName);
}

export async function updateTransactionDate(categoryName, rowIndex, newDate, accessToken, sheetId) {
  const config = getEffectiveSheetMap()[categoryName];
  if (!config) throw codedError('SHT-003', `Unknown category: ${categoryName}`);
  await writeCell(sheetId, config.sheet, rowIndex, 2, newDate, accessToken);
  invalidateDetailCache(sheetId, categoryName);
}

export async function updateVendorName(categoryName, rowIndex, newName, accessToken, sheetId, oldName = '', v2 = false) {
  const config   = getEffectiveSheetMap()[categoryName];
  if (!config) throw codedError('SHT-003', `Unknown category: ${categoryName}`);
  const descCol  = v2 ? 3 : config.descCol;
  await writeCell(sheetId, config.sheet, rowIndex, descCol, safeText(newName), accessToken);
  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Renamed', category: categoryName, vendor: newName,
    details: oldName ? `${oldName} → ${newName}` : '',
  });
  invalidateDetailCache(sheetId, categoryName);
}

/**
 * Move transaction(s) to a different category — i.e. a different sheet tab.
 *
 * Category is not a cell on the row; it is which tab the row lives on. So a
 * category change is a cross-tab move: write the row into the destination tab
 * (in that tab's schema), then clear it from the source. The destination is
 * written FIRST so a mid-failure duplicates rather than loses data. UUIDs are
 * preserved (not regenerated) so History matching, ledger method badges, and
 * bot delete-by-UUID keep working across the move.
 *
 * row: { rowIndex, description, amounts[], uuids[], date, paymentMethod, bookingMethod, _v2 }
 * amtIndex === null → move the whole row (all amounts)
 * amtIndex === n    → move only amounts[n], leaving the rest in place
 */
export async function moveTransactionCategory(
  fromCategory, toCategory, row, accessToken, sheetId, monthName, amtIndex = null,
) {
  if (fromCategory === toCategory) return;
  // v1: block moves offline — the offline queue only knows add_expense, and a
  // half-queued cross-tab move could lose data.
  if (!navigator.onLine) throw codedError('WEB-003', 'You are offline — category changes need a connection.');

  const map        = getEffectiveSheetMap();
  const fromConfig = map[fromCategory];
  const toConfig   = map[toCategory];
  if (!fromConfig) throw codedError('SHT-003', `Unknown category: ${fromCategory}`);
  if (!toConfig)   throw codedError('SHT-003', `Unknown category: ${toCategory}`);

  const movingAmounts = amtIndex == null ? row.amounts : [row.amounts[amtIndex]];
  // Preserve existing UUIDs; only mint one for legacy rows that never had any.
  const movingUuids   = movingAmounts.map((amt, i) => {
    const srcIdx = amtIndex == null ? i : amtIndex;
    return row.uuids?.[srcIdx] || generateTransactionUUID(amt);
  });
  const movingTotal   = movingAmounts.reduce((a, b) => a + b, 0);

  let month, year;
  if (monthName) {
    const parts = monthName.split(' ');
    month = parts[0];
    year  = parseInt(parts[1]) || new Date().getFullYear();
  } else {
    const now = new Date();
    month = now.toLocaleString('en-US', { month: 'short' });
    year  = now.getFullYear();
  }

  // ── 1) Write to destination first ─────────────────────────────────────────
  const destValues = await fetchRaw(sheetId, toConfig.sheet, accessToken);
  const destIsV2   = detectV2(destValues, monthName);

  if (destIsV2) {
    const isTravelCat = toCategory === 'Travel' || toCategory === 'Holiday';
    const bmCol       = isTravelCat ? 6 : -1;
    const uuidCol     = isTravelCat ? 7 : 6;

    // One V2 row per moving amount (V2 = one transaction per row).
    const newRows = movingAmounts.map((amt, i) => {
      const r = Array(uuidCol + 1).fill('');
      r[0] = month;
      r[1] = year;
      r[2] = row.date || '';
      r[3] = safeText(row.description);
      r[4] = amt;
      r[5] = safeText(row.paymentMethod || '');
      if (bmCol >= 0) r[bmCol] = safeText(row.bookingMethod || '');
      r[uuidCol] = movingUuids[i];
      return r;
    });

    // Same last-data scan as addOrUpdateExpense: skip formula-only totals rows.
    let lastDataIdx = 0;
    for (let i = destValues.length - 1; i >= 1; i--) {
      const r = destValues[i];
      if (r && (r[3] || r[4])) { lastDataIdx = i; break; }
    }
    const startRow = lastDataIdx + 2;
    const endCol   = colLetter(uuidCol);
    const range    = encodeURIComponent(`'${toConfig.sheet}'!A${startRow}:${endCol}${startRow + newRows.length - 1}`);
    // RAW preserves the date string as text so Sheets doesn't convert it to a serial number.
    await apiFetch(sheetId, `/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: newRows }),
    });
  } else {
    // V1 destination: amounts live as a formula on the vendor's single row.
    const uuidCol  = uuidStart(toConfig);
    const dataRows = destValues.slice(1);
    let foundIndex = -1;
    for (let i = 0; i < dataRows.length; i++) {
      const desc = dataRows[i][toConfig.descCol];
      if (desc && String(desc).trim().toLowerCase() === row.description.trim().toLowerCase()) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex >= 0) {
      const sheetRow = foundIndex + 2;
      const existing = parseAmounts(dataRows[foundIndex][toConfig.amtCol] ?? '');
      await writeCell(sheetId, toConfig.sheet, sheetRow, toConfig.amtCol, buildFormula([...existing, ...movingAmounts]), accessToken);
      const uuidRange = encodeURIComponent(
        `'${toConfig.sheet}'!${colLetter(uuidCol + existing.length)}${sheetRow}:${colLetter(uuidCol + existing.length + movingUuids.length - 1)}${sheetRow}`
      );
      await apiFetch(sheetId, `/values/${uuidRange}?valueInputOption=RAW`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [movingUuids] }),
      });
    } else {
      const newRow = Array(uuidCol + movingUuids.length).fill('');
      newRow[0] = month;
      newRow[1] = year;
      newRow[toConfig.descCol] = safeText(row.description);
      newRow[toConfig.amtCol]  = buildFormula(movingAmounts);
      movingUuids.forEach((u, i) => { newRow[uuidCol + i] = u; });

      let lastDataIdx = 0;
      for (let i = destValues.length - 1; i >= 1; i--) {
        const r = destValues[i];
        if (r && (r[toConfig.descCol] || r[toConfig.amtCol])) { lastDataIdx = i; break; }
      }
      const nextRow = lastDataIdx + 2;
      const endCol  = colLetter(uuidCol + movingUuids.length - 1);
      const range   = encodeURIComponent(`'${toConfig.sheet}'!A${nextRow}:${endCol}${nextRow}`);
      await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [newRow] }),
      });
    }
  }

  // ── 2) Clear from source (no 'Deleted' entry — the move logs one 'Moved') ──
  const srcIsTravel = fromCategory === 'Travel' || fromCategory === 'Holiday';
  const srcUuidCol  = row._v2 ? (srcIsTravel ? 7 : 6) : uuidStart(fromConfig);
  const remaining      = amtIndex == null ? [] : row.amounts.filter((_, i) => i !== amtIndex);
  const remainingUuids = amtIndex == null ? [] : (row.uuids || []).filter((_, i) => i !== amtIndex);

  if (remaining.length === 0) {
    // Cap at Z — colLetter only handles single letters (A–Z).
    await clearRowRange(sheetId, fromConfig.sheet, row.rowIndex, Math.min(srcUuidCol + 19, 25), accessToken);
  } else {
    const amtCol = row._v2 ? 4 : fromConfig.amtCol;
    await writeCell(sheetId, fromConfig.sheet, row.rowIndex, amtCol, row._v2 ? remaining[0] : buildFormula(remaining), accessToken);
    // Rewrite the UUID block with trailing blanks so removed UUIDs don't linger
    // (same convention as updateVendorAmounts).
    const maxCols    = Math.max(remainingUuids.length + 2, 5);
    const uuidValues = Array(maxCols).fill('').map((_, i) => remainingUuids[i] || '');
    const uuidRange  = encodeURIComponent(
      `'${fromConfig.sheet}'!${colLetter(srcUuidCol)}${row.rowIndex}:${colLetter(srcUuidCol + maxCols - 1)}${row.rowIndex}`
    );
    await apiFetch(sheetId, `/values/${uuidRange}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [uuidValues] }),
    });
  }

  // ── 3) One 'Moved' history entry (from → to) ───────────────────────────────
  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Moved',
    category: toCategory,
    vendor: row.description,
    amount: movingTotal,
    details: `${fromCategory} → ${toCategory}`,
    uuid: movingUuids[0] || '',
    txDate: row.date || '',
    paymentMethod: row.paymentMethod || '',
    bookingMethod: row.bookingMethod || '',
  });

  // ── 4) Both tabs changed ───────────────────────────────────────────────────
  invalidateDetailCache(sheetId, fromCategory);
  invalidateDetailCache(sheetId, toCategory);
}

export async function updateVendorAmounts(
  categoryName, rowIndex, amounts, accessToken, sheetId, vendorName = '', previousTotal = null, uuids = [], v2 = false,
) {
  const config  = getEffectiveSheetMap()[categoryName];
  if (!config) throw codedError('SHT-003', `Unknown category: ${categoryName}`);
  const amtCol       = v2 ? 4 : config.amtCol;
  const isTravelCat  = categoryName === 'Travel' || categoryName === 'Holiday';
  const uuidCol      = v2 ? (isTravelCat ? 7 : 6) : uuidStart(config);

  if (amounts.length === 0) {
    await clearRowRange(sheetId, config.sheet, rowIndex, Math.min(uuidCol + 19, 25), accessToken);
    await appendHistoryEntry(sheetId, accessToken, {
      action: 'Deleted', category: categoryName, vendor: vendorName,
      amount: previousTotal,
    });
  } else {
    await writeCell(sheetId, config.sheet, rowIndex, amtCol, v2 ? amounts[0] : buildFormula(amounts), accessToken);
    if (uuids.length > 0) {
      const maxCols   = Math.max(uuids.length + 2, 5);
      const uuidValues = Array(maxCols).fill('').map((_, i) => uuids[i] || '');
      const uuidRange  = encodeURIComponent(
        `'${config.sheet}'!${colLetter(uuidCol)}${rowIndex}:${colLetter(uuidCol + maxCols - 1)}${rowIndex}`
      );
      await apiFetch(sheetId, `/values/${uuidRange}?valueInputOption=RAW`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [uuidValues] }),
      });
    }
    const newTotal = amounts.reduce((a, b) => a + b, 0);
    await appendHistoryEntry(sheetId, accessToken, {
      action: 'Edited', category: categoryName, vendor: vendorName, amount: newTotal,
      details: previousTotal != null ? `was: $${previousTotal.toFixed(2)}` : '',
    });
  }
  invalidateDetailCache(sheetId, categoryName);
}
