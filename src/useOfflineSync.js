import { useState, useEffect } from 'react';
import { getQueue, dequeue, updateRetries } from './offlineQueue.js';
import { addOrUpdateExpense } from './useExpense.js';

export function useOfflineSync({ user, selectedSheetId, refresh, setSessionExpired }) {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const up = () => {
      setIsOnline(true);
      if (user.isOfflineSession || (user.expiresAt && Date.now() > user.expiresAt - 60_000)) {
        setSessionExpired(true);
      }
    };
    const down = () => setIsOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, [user]);

  // Queue processor — runs when we come back online
  useEffect(() => {
    if (!isOnline || !user.accessToken) return;
    const queue = getQueue();
    if (queue.length === 0) return;
    (async () => {
      for (const item of queue) {
        if (item.type !== 'add_expense') continue;
        try {
          const { categoryName, vendorName, amount, monthName, source } = item.payload;
          await addOrUpdateExpense(categoryName, vendorName, amount, user.accessToken, selectedSheetId, monthName, source);
          dequeue(item.id);
        } catch {
          updateRetries(item.id, item.retries + 1);
        }
      }
      refresh();
    })();
  }, [isOnline]);

  return { isOnline };
}
