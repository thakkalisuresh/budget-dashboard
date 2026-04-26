import { useState, useEffect, useCallback } from 'react';

const API_KEY = import.meta.env.VITE_SHEETS_API_KEY;

function parseCell(cell) {
  if (cell === undefined || cell === '') return null;
  const cleaned = String(cell).replace(/[$,%]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? cell : num;
}

export function use503020(sheetId, accessToken) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!sheetId) return;
    try {
      const range = encodeURIComponent("'50/30/20'!A1:K20");
      const url = accessToken
        ? `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`
        : `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${API_KEY}`;
      const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
      const res = await fetch(url, { headers });
      const json = await res.json();
      const rows = (json.values || []).map(row =>
        Array(11).fill(null).map((_, i) => parseCell(row[i]))
      );

      const parseItems = (descCol, amtCol) =>
        rows.slice(1, 10)
          .filter(r => r[descCol] && typeof r[descCol] === 'string')
          .map(r => ({ name: r[descCol], amount: r[amtCol] ?? 0 }));

      const normPct = v => (v != null && v > 1 ? v / 100 : v) || 0;

      setData({
        needs:   { items: parseItems(0, 1), total: rows[10]?.[1] || 0, pct: normPct(rows[11]?.[1]), target: rows[13]?.[1] || 0, diff: rows[14]?.[1] || 0 },
        wants:   { items: parseItems(3, 4), total: rows[10]?.[4] || 0, pct: normPct(rows[11]?.[4]), target: rows[13]?.[4] || 0, diff: rows[14]?.[4] || 0 },
        savings: { items: parseItems(6, 7), total: rows[10]?.[7] || 0, pct: normPct(rows[11]?.[7]), target: rows[13]?.[7] || 0, diff: rows[14]?.[7] || 0 },
      });
    } catch (e) {
      console.error('503020 fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, [sheetId, accessToken]);

  // Reset when sheet changes
  useEffect(() => {
    setLoading(true);
    setData(null);
  }, [sheetId]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 30000);
    return () => clearInterval(id);
  }, [fetchData]);

  return { data, loading };
}
