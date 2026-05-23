import { useState, useEffect } from 'react';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && !!VAPID_PUBLIC_KEY;

export function usePush(userEmail, preferredHour, accessToken) {
  const authHeader = () => accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {};
  const [subscribed,   setSubscribed]   = useState(false);
  const [permission,   setPermission]   = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [loading, setLoading] = useState(false);

  // Check current subscription on mount
  useEffect(() => {
    if (!pushSupported()) return;
    navigator.serviceWorker.ready.then(reg =>
      reg.pushManager.getSubscription().then(sub => setSubscribed(!!sub))
    );
  }, []);

  const subscribe = async () => {
    if (!pushSupported()) return;
    setLoading(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') return;

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });

      await fetch('/api/push-subscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          subscription:    sub.toJSON(),
          preferredHour:   preferredHour ?? 20,
          timezoneOffset:  -(new Date().getTimezoneOffset() / 60), // positive = east of UTC
        }),
      });
      setSubscribed(true);
    } catch (e) {
      console.error('usePush subscribe error:', e);
    } finally {
      setLoading(false);
    }
  };

  const unsubscribe = async () => {
    if (!pushSupported()) return;
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      await fetch('/api/push-unsubscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body:    JSON.stringify({}),
      });
      setSubscribed(false);
    } catch (e) {
      console.error('usePush unsubscribe error:', e);
    } finally {
      setLoading(false);
    }
  };

  // Update server-side preferred hour when it changes (if already subscribed)
  const updatePreferredHour = async (hour) => {
    if (!subscribed || !pushSupported()) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      await fetch('/api/push-subscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          subscription:   sub.toJSON(),
          preferredHour:  hour,
          timezoneOffset: -(new Date().getTimezoneOffset() / 60),
        }),
      });
    } catch (e) {
      console.error('usePush updatePreferredHour error:', e);
    }
  };

  return {
    supported:   pushSupported(),
    subscribed,
    permission,
    loading,
    subscribe,
    unsubscribe,
    updatePreferredHour,
  };
}
