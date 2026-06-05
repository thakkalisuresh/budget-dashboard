import { apiFetch, fetchRaw, writeCell, clearRowRange } from './sheetApi.js';
import {
  getEffectiveSheetMap, colLetter, safeText, parseAmounts, buildFormula,
  generateTransactionUUID, uuidStart, detectV2, coerceTxDate,
} from './sheetHelpers.js';
import { invalidateDetailCache } from './sheetDetail.js';
import { appendHistoryEntry } from './sheetHistory.js';
import { enqueue } from './offlineQueue.js';

export async function addOrUpdateExpense(
  categoryName, vendorName, amount, accessToken, sheetId, monthName,
  source = 'manual', txDate = null, paymentMethod = '', bookingMethod = '',
) {
  if (!navigator.onLine) {
    enqueue({ type: 'add_expense', payload: { categoryName, vendorName, amount, monthName, source, txDate, paymentMethod } });
    return { queued: true };
  }

  const config = getEffectiveSheetMap()[categoryName];
  if (!config) throw new Error(`Unknown category: ${categoryName}`);

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

    // Write directly to the next row after existing data — avoids the :append
    // API skipping past named table bounds (RentTable, GroceryTable, etc.)
    const nextRow  = values.length + 1;
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

      const nextRowV1 = values.length + 1;
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
  if (!config) throw new Error(`Unknown category: ${categoryName}`);
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
  if (!config) throw new Error(`Unknown category: ${categoryName}`);
  await writeCell(sheetId, config.sheet, rowIndex, 2, newDate, accessToken);
  invalidateDetailCache(sheetId, categoryName);
}

export async function updateVendorName(categoryName, rowIndex, newName, accessToken, sheetId, oldName = '', v2 = false) {
  const config   = getEffectiveSheetMap()[categoryName];
  if (!config) throw new Error(`Unknown category: ${categoryName}`);
  const descCol  = v2 ? 3 : config.descCol;
  await writeCell(sheetId, config.sheet, rowIndex, descCol, safeText(newName), accessToken);
  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Renamed', category: categoryName, vendor: newName,
    details: oldName ? `${oldName} → ${newName}` : '',
  });
  invalidateDetailCache(sheetId, categoryName);
}

export async function updateVendorAmounts(
  categoryName, rowIndex, amounts, accessToken, sheetId, vendorName = '', previousTotal = null, uuids = [], v2 = false,
) {
  const config  = getEffectiveSheetMap()[categoryName];
  if (!config) throw new Error(`Unknown category: ${categoryName}`);
  const amtCol       = v2 ? 4 : config.amtCol;
  const isTravelCat  = categoryName === 'Travel' || categoryName === 'Holiday';
  const uuidCol      = v2 ? (isTravelCat ? 7 : 6) : uuidStart(config);

  if (amounts.length === 0) {
    await clearRowRange(sheetId, config.sheet, rowIndex, uuidCol + 19, accessToken);
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
