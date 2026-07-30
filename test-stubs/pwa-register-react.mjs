// Test stub for vite-plugin-pwa's `virtual:pwa-register/react`.
//
// The real module is generated during a Vite build and can't resolve under
// vitest, so vite.config.js aliases this in (same pattern as the
// firebase-functions stubs). It reports "no update, no worker" — the update
// logic worth testing lives in versionCheck.js, which imports nothing.
export function useRegisterSW() {
  return {
    offlineReady: [false, () => {}],
    needRefresh:  [false, () => {}],
    updateServiceWorker: async () => {},
  };
}
