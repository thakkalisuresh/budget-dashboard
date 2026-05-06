import { useState, useEffect, useCallback } from 'react';

const API_KEY = import.meta.env.VITE_SHEETS_API_KEY;
const RANGE = 'Totals!A1:J30';
const POLL_MS = 60000; // 60s — reduces quota pressure

const dataCacheKey = (sheetId) => `budget_data_cache_${sheetId}`;

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
  const [isFromCache, setIsFromCache] = useState(false);

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
      const parsed = parseValues(json.values || []);
      try { localStorage.setItem(dataCacheKey(sheetId), JSON.stringify(parsed)); } catch { /* ignore quota errors */ }
      setData(parsed);
      setIsFromCache(false);
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      // Fall back to cached data when offline or fetch fails
      try {
        const cached = localStorage.getItem(dataCacheKey(sheetId));
        if (cached) {
          setData(JSON.parse(cached));
          setIsFromCache(true);
        }
      } catch { /* ignore */ }
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [sheetId, accessToken]);

  // When sheet changes: show cached data immediately, fetch fresh in background
  useEffect(() => {
    setLoading(true);
    setLastUpdated(null);
    setError(null);

    // Warm-start: render from cache instantly so the UI isn't blank while fetching
    try {
      const cached = localStorage.getItem(dataCacheKey(sheetId));
      if (cached) {
        setData(JSON.parse(cached));
        setIsFromCache(true);
        setLoading(false); // cache is good enough to stop spinner
      } else {
        setData(null);
        setIsFromCache(false);
      }
    } catch {
      setData(null);
      setIsFromCache(false);
    }
  }, [sheetId]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  return { data, loading, error, lastUpdated, isFromCache, refresh: fetchData };
}
