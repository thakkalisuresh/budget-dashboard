// Vitest stub for firebase-functions/v2/https (aliased in vite.config.js `test`).
// The Cloud Functions runtime + its deps aren't installed in the root test env;
// the handler logic is what we test, so onRequest just returns the bare handler
// (callable as (req, res)). Options (region/secrets/cors/…) are ignored.
export const onRequest = (_optsOrHandler, handler) =>
  (typeof _optsOrHandler === 'function' ? _optsOrHandler : handler);
