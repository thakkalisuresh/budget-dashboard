// Vitest stub for firebase-functions/params (aliased in vite.config.js `test`).
// secrets.mjs declares defineSecret(NAME) params; the ported modules read values
// from process.env (injected at cold start), never via .value(). So the stub just
// needs to return a benign object so the secrets:[...] arrays construct.
export const defineSecret = (name) => ({ name, value: () => process.env[name] });
