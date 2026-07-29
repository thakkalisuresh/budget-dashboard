// ════════════════════════════════════════════════════════════════════════════
// errorCodes.js — frontend access to the SAME error code registry the backend
// uses.
//
// Note this is a real re-export, not a mirror. functions/lib/_error-codes.mjs
// has no imports at all — it is pure data and pure functions — so Vite can
// bundle it directly. Unlike the card resolver or the duplicate matcher, there
// is nothing to keep in sync and no parity test to write.
// ════════════════════════════════════════════════════════════════════════════
export { ERROR_CODES, describeError, errorLabel } from '../functions/lib/_error-codes.mjs';
import { describeError } from '../functions/lib/_error-codes.mjs';

/**
 * Create an Error that carries a code.
 *
 * `err.code` survives being thrown and caught, so a throw deep in the sheet
 * layer still arrives at the UI knowing what it was.
 */
export function codedError(code, message) {
  const err = new Error(message || describeError(code)?.title || code);
  err.code = code;
  return err;
}

/**
 * Attach a code to an error that doesn't have one, without clobbering a more
 * specific code set further down the stack.
 */
export function withCode(error, code) {
  if (error && !error.code) error.code = code;
  return error;
}

/**
 * The string to actually show a user: what happened, then the code to look up.
 *
 * Codeless errors are left alone rather than labelled with a guess — a wrong
 * code is worse than none, because it sends you to the wrong page of the
 * catalogue.
 */
export function userMessage(error, fallbackCode = null) {
  const message = error?.message || String(error || 'Something went wrong');
  const code = error?.code || fallbackCode;
  return code ? `${message} [${code}]` : message;
}
