// ════════════════════════════════════════════════════════════════════════════
// useAppUpdate.js — detect a new deploy and hand the app a way to adopt it.
//
// Two independent detectors, because neither is sufficient alone:
//
//  1. The service worker (primary). vite-plugin-pwa's useRegisterSW flips
//     `needRefresh` when a new worker reaches the `waiting` state, and
//     updateServiceWorker(true) posts the SKIP_WAITING message that sw.js has
//     always listened for but that nothing ever sent — which is why every deploy
//     used to need a manual "clear cache". Cheap: swaps the worker, keeps caches.
//
//  2. A /version.json poll (fallback). Installed iOS PWAs are killed when
//     backgrounded and can resume from the page cache without re-checking, and
//     Safari's registration.update() is unreliable. When the poll spots a commit
//     mismatch the worker never reported, we fall back to the nuclear reset.
//
// Wake signals are deliberately redundant (visibilitychange + focus + pageshow):
// on iOS standalone no single one of them fires dependably.
// ════════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { fetchRemoteVersion, isNewerBuild, POLL_INTERVAL_MS } from './versionCheck.js';
import { resetAndReload } from './resetAppCaches.js';

export function useAppUpdate() {
  // Declared before useRegisterSW so onRegisteredSW closes over a live binding
  // rather than one still in its temporal dead zone at call time.
  const registrationRef = useRef(null);

  const {
    needRefresh: [swNeedsRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      registrationRef.current = registration || null;
    },
    onRegisterError(err) {
      console.warn('[Budget] service worker registration failed:', err);
    },
  });

  // Set only by the version poll. Kept separate from the SW's own signal so
  // `updateNow` knows which of the two adoption paths to take.
  const [pollSawUpdate, setPollSawUpdate] = useState(false);
  const [remote, setRemote] = useState(null);
  const [updating, setUpdating] = useState(false);

  const currentCommit = typeof __COMMIT_SHA__ !== 'undefined' ? __COMMIT_SHA__ : 'dev';

  // ── Check both detectors ───────────────────────────────────────────────────
  const check = useCallback(async () => {
    // Nudge the service worker first — on Chrome/Android this is what actually
    // finds the new build, and it costs nothing when there isn't one.
    try { await registrationRef.current?.update(); } catch { /* Safari may no-op */ }

    const payload = await fetchRemoteVersion();
    if (!payload) return;                       // offline / dev server / 404 — stay quiet
    setRemote(payload);
    if (isNewerBuild(currentCommit, payload)) setPollSawUpdate(true);
  }, [currentCommit]);

  // ── Wake signals + interval ────────────────────────────────────────────────
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === 'hidden') return;
      check();
    };

    // First check is deferred rather than run inline: mount is the busiest moment
    // in the app's life and this is the least urgent thing happening. Cancelled on
    // unmount so a fast mount/unmount can't leave it running.
    //
    // Deliberately calls check() and not onWake(): the visibility guard exists to
    // stop a *backgrounded* tab polling on a timer, but a cold start is the single
    // most important moment to notice a deploy — and an app restored straight into
    // a hidden state (iOS resuming into the app switcher) would otherwise skip it.
    const initialCheck = setTimeout(check, 0);
    // pageshow fires on bfcache/page-cache restore, which is the iOS standalone
    // resume path where visibilitychange alone can't be relied on.
    const onPageShow = (e) => { if (e.persisted) onWake(); };

    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('pageshow', onPageShow);

    // Only tick while visible — a hidden tab polling every 15 minutes is pure
    // battery cost on mobile, and it re-checks on wake anyway.
    let timer = null;
    const startTimer = () => {
      if (timer || document.visibilityState === 'hidden') return;
      timer = setInterval(onWake, POLL_INTERVAL_MS);
    };
    const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => (document.visibilityState === 'hidden' ? stopTimer() : startTimer());
    document.addEventListener('visibilitychange', onVisibility);
    startTimer();

    return () => {
      clearTimeout(initialCheck);
      document.removeEventListener('visibilitychange', onWake);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('pageshow', onPageShow);
      stopTimer();
    };
  }, [check]);

  // ── Adopt the update ───────────────────────────────────────────────────────
  const updateNow = useCallback(async () => {
    setUpdating(true);
    if (swNeedsRefresh) {
      // Posts SKIP_WAITING; the new worker activates, fires controllerchange,
      // and the listener in main.jsx reloads us.
      updateServiceWorker(true);
      return;
    }
    // The poll found a deploy the worker didn't. Nothing is waiting to be
    // skipped, so throw the caches away and come back on the new build.
    await resetAndReload();
  }, [swNeedsRefresh, updateServiceWorker]);

  return {
    updateAvailable: swNeedsRefresh || pollSawUpdate,
    updateNow,
    updating,
    currentVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
    nextVersion: remote?.version || '',
  };
}
