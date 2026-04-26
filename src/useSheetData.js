import { useState, useEffect, useCallback } from 'react';

const API_KEY = import.meta.env.VITE_SHEETS_API_KEY;
const RANGE = 'Totals!A1:J30';
const POLL_MS = 30000;

function parseCell(cell) {
  if (cell === undefined || cell === '') return null;
  const cleaned = cell.replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? cell : num;
}

function parseValues(values) {
  return values.map((row, index) => ({
    index_: index,
    row: Array(10).fill(null).map((_, i) => parseCell(row[i])),
  }));
}

export function useSheetData(sheetId, accessToken) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchData = useCallback(async () => {
    if (!sheetId) return;
    try {
      const url = accessToken
        ? `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${RANGE}`
        : `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${RANGE}?key=${API_KEY}`;
      const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(parseValues(json.values || []));
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [sheetId, accessToken]);

  // Reset loading state when sheet changes
  useEffect(() => {
    setLoading(true);
    setData(null);
    setLastUpdated(null);
    setError(null);
  }, [sheetId]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  return { data, loading, error, lastUpdated, refresh: fetchData };
}
