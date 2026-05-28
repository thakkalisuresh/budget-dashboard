import { useState, useEffect, useCallback } from 'react';
import { getQueue, dequeue, updateRetries } from './offlineQueue.js';
import { addOrUpdateExpense } from './useExpense.js';

export function useOfflineSync({ user, selectedSheetId, refresh, setSessionExpired }) {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [syncedCount, setSyncedCount] = useState(0);

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

    let successCount = 0;
    const drain = async () => {
      for (const item of items) {
        if (item.type !== 'add_expense') continue;
        try {
          const { categoryName, vendorName, amount, monthName, source } = item.payload;
          await addOrUpdateExpense(categoryName, vendorName, amount, user.accessToken, selectedSheetId, monthName, source);
          dequeue(item.id);
          successCount++;
        } catch {
          updateRetries(item.id, item.retries + 1);
        }
      }
      if (successCount > 0) {
        setSyncedCount(successCount);
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

  return { isOnline, syncedCount, clearSyncedCount: () => setSyncedCount(0) };
}
