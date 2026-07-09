// Vitest stub for firebase-functions/params (aliased in vite.config.js `test`).
// secrets.mjs declares defineSecret(NAME) / defineString(NAME) params; the ported
// modules read secret values from process.env (injected at cold start) and string
// params via .value(). The stub returns benign objects whose .value() reads
// process.env (with the string param's default as a fallback) so the secrets:[...]
// arrays construct and tests can drive values via vi.stubEnv.
export const defineSecret = (name) => ({ name, value: () => process.env[name] });
export const defineString = (name, opts = {}) => ({
  name,
  value: () => process.env[name] ?? opts.default ?? '',
});
