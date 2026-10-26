// Vitest stub for firebase-functions/v2/scheduler (aliased in vite.config.js `test`).
// onSchedule returns the bare handler so tests can invoke the job directly; the
// schedule options (cron, timezone, secrets, memory…) are ignored. Aliasing (rather
// than only vi.mock) keeps this working when functions/node_modules is installed
// locally and would otherwise resolve the real package under a different id.
export const onSchedule = (_opts, handler) => handler;
