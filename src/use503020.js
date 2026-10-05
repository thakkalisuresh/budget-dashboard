// ════════════════════════════════════════════════════════════════════════════
// use503020.js — load the "50/30/20" budgeting tab from the Google Sheet.
// 50/30/20 is a rule of thumb: 50% Needs, 30% Wants, 20% Savings. This hook reads
// that worksheet, parses its grid into needs/wants/savings buckets, and re-reads
// on a timer so the dashboard stays roughly in sync with edits made in the sheet.
// ════════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useCallback } from 'react';
import { MOCK_503020 } from './mockData.js';

const DEV_MOCK = import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === 'true';

// Turn a raw spreadsheet cell into a clean value: empty → null; "$1,200" → 1200;
// anything non-numeric is left as the original text.
function parseCell(cell) {
  if (cell === undefined || cell === '') return null;
  const cleaned = String(cell).replace(/[$,%]/g, '');   // strip $, commas, and %
  const num = parseFloat(cleaned);
  return isNaN(num) ? cell : num;     // use the number if it parsed, else keep the text
}

export function use503020(sheetId, accessToken) {
  const [data, setData] = useState(null);        // parsed buckets (null while loading)
  const [loading, setLoading] = useState(true);

  // useCallback memoizes this function so the effect below doesn't see a brand-new
  // function every render — it only changes when sheetId / accessToken change.
  const fetchData = useCallback(async () => {
    if (DEV_MOCK) { setData(MOCK_503020); setLoading(false); return; }
    if (!sheetId) return;
    try {
      // Ask Google Sheets for cells A1:K20 of the tab literally named "50/30/20".
      const range = encodeURIComponent("'50/30/20'!A1:K20");
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
      const headers = { Authorization: `Bearer ${accessToken}` };  // OAuth token = "who we are"
      const res = await fetch(url, { headers });
      const json = await res.json();
      // Normalize every row to exactly 11 cleaned cells (the API omits trailing blanks).
      const rows = (json.values || []).map(row =>
        Array(11).fill(null).map((_, i) => parseCell(row[i]))
      );

      // Read the line items for one bucket from its description + amount columns,
      // skipping blank rows. Rows 1–9 hold items (row 0 is the header).
      const parseItems = (descCol, amtCol) =>
        rows.slice(1, 10)
          .filter(r => r[descCol] && typeof r[descCol] === 'string')
          .map(r => ({ name: r[descCol], amount: r[amtCol] ?? 0 }));

      // A percentage might be stored as 50 or as 0.5 — normalize both to a fraction.
      const normPct = v => (v != null && v > 1 ? v / 100 : v) || 0;

      // Assemble the three buckets. The fixed row indices (10,11,13,14) and column
      // indices (1,4,7) mirror the fixed layout of this worksheet.
      setData({
        needs:   { items: parseItems(0, 1), total: rows[10]?.[1] || 0, pct: normPct(rows[11]?.[1]), target: rows[13]?.[1] || 0, diff: rows[14]?.[1] || 0 },
        wants:   { items: parseItems(3, 4), total: rows[10]?.[4] || 0, pct: normPct(rows[11]?.[4]), target: rows[13]?.[4] || 0, diff: rows[14]?.[4] || 0 },
        savings: { items: parseItems(6, 7), total: rows[10]?.[7] || 0, pct: normPct(rows[11]?.[7]), target: rows[13]?.[7] || 0, diff: rows[14]?.[7] || 0 },
      });
    } catch (e) {
      console.error('503020 fetch error:', e);   // log and keep whatever we had before
    } finally {
      setLoading(false);    // success or failure, we're no longer loading
    }
  }, [sheetId, accessToken]);

  // When the user switches month/sheet, reset back to the loading state.
  useEffect(() => {
    setLoading(true);
    setData(null);
  }, [sheetId]);

  // Fetch once now, then re-fetch every 60 seconds. The interval is cleared on
  // unmount (or when fetchData changes) so we never stack up overlapping timers.
  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 60000); // 60s — reduces quota pressure
    return () => clearInterval(id);
  }, [fetchData]);

  return { data, loading };
}
