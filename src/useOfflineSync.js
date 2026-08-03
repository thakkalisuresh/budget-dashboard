import { useState, useEffect, useCallback } from 'react';
import { getQueue } from './offlineQueue.js';
import { addOrUpdateExpense } from './useExpense.js';
import { drainQueue } from './offlineReplay.js';

export function useOfflineSync({ user, selectedSheetId, refresh, setSessionExpired }) {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [syncedCount, setSyncedCount] = useState(0);
  const [stuckCount, setStuckCount] = useState(0);

  useEffect(() => {
    const up = () => {
      setIsOnline(true);
      // Offline sessions upgrade via useAuth's online listener — don't expire them here
      if (!user.isOfflineSession && user.expiresAt && Date.now() > user.expiresAt - 60_000) {
        setSessionExpired(true);
      }
    };
    const down = () => setIsOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, [user]);

  const processQueue = useCallback(async () => {
    if (!user.accessToken) return;
    const items = getQueue();
    if (items.length === 0) return;

    const drain = async () => {
      const { synced, stuck } = await drainQueue({
        items,
        accessToken: user.accessToken,
        sheetId: selectedSheetId,
        addExpense: addOrUpdateExpense,
      });
      setStuckCount(stuck);
      if (synced > 0) {
        setSyncedCount(synced);
        refresh();
      }
    };

    if (navigator.locks) {
      navigator.locks.request('budget_offline_queue', { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        await drain();
      });
    } else {
      await drain();
    }
  }, [user, selectedSheetId, refresh]);

  // Run queue when we come back online with a real token
  useEffect(() => {
    if (!isOnline || !user.accessToken) return;
    const queue = getQueue();
    if (queue.length === 0) return;
    processQueue();
  }, [isOnline]);

  // Background sync message from service worker (fires even when app is in background)
  useEffect(() => {
    const handler = (event) => {
      if (event.data?.type === 'DRAIN_OFFLINE_QUEUE') processQueue();
    };
    navigator.serviceWorker?.addEventListener('message', handler);
    return () => navigator.serviceWorker?.removeEventListener('message', handler);
  }, [processQueue]);

  return {
    isOnline, syncedCount, stuckCount,
    clearSyncedCount: () => setSyncedCount(0),
  };
}
