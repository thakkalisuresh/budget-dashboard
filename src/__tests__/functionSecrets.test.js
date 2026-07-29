import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every process.env.X a Cloud Function reads must be declared in its `secrets`
 * array, or X is simply undefined at runtime.
 *
 * This exists because errorDigest shipped reading process.env.ALLOWED_EMAILS
 * without binding it. The function deployed clean, went ACTIVE, ran on
 * schedule, and returned at `if (!email)` every single time — so the error
 * digest could never have sent anything. Nothing failed loudly; it just
 * silently did nothing, which is the worst way for a monitoring feature to
 * break. Unit tests couldn't catch it (they stub the env) and neither could a
 * deploy (the binding is valid, just incomplete).
 */

const FN_DIR = resolve(process.cwd(), 'functions');

/** Env vars the platform provides, or that are read defensively with a fallback. */
const PLATFORM_PROVIDED = new Set([
  'NODE_ENV', 'FUNCTION_TARGET', 'FUNCTION_SIGNATURE_TYPE', 'K_SERVICE',
  'K_REVISION', 'PORT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT',
  'FIREBASE_CONFIG', 'FIREBASE_DEBUG_MODE',
]);

/** Entry-point files: those that actually export an onRequest/onSchedule handler. */
function entryPoints() {
  return readdirSync(FN_DIR)
    .filter(f => f.endsWith('.mjs'))
    .map(f => ({ file: f, src: readFileSync(resolve(FN_DIR, f), 'utf8') }))
    .filter(({ src }) => /onRequest\s*\(|onSchedule\s*\(/.test(src));
}

/** The identifiers listed in the handler's `secrets: [...]` array. */
function declaredSecrets(src) {
  const m = /secrets:\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) return null;
  return m[1]
    .split(',')
    .map(s => s.replace(/\.\.\./, '').trim())
    .filter(Boolean);
}

/** Expand a `...GROUP_SECRETS` spread by reading the group's definition. */
function expandGroups(names) {
  const secretsSrc = readFileSync(resolve(FN_DIR, 'lib/secrets.mjs'), 'utf8');
  const out = new Set();
  for (const n of names) {
    const g = new RegExp(`export const ${n}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(secretsSrc);
    if (g) g[1].split(',').map(s => s.trim()).filter(Boolean).forEach(x => out.add(x));
    else out.add(n);
  }
  return out;
}

describe('Cloud Function secret bindings', () => {
  const fns = entryPoints();

  it('finds the function entry points', () => {
    expect(fns.length).toBeGreaterThan(5);
  });

  for (const { file, src } of fns) {
    it(`${file}: every process.env read is bound`, () => {
      const declared = declaredSecrets(src);
      const reads = [...src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(m => m[1]);
      const needed = [...new Set(reads)].filter(v => !PLATFORM_PROVIDED.has(v));
      if (needed.length === 0) return;

      // A handler that reads secrets must declare a secrets array at all.
      expect(declared, `${file} reads ${needed.join(', ')} but declares no secrets`).not.toBeNull();

      const bound = expandGroups(declared);
      const missing = needed.filter(v => !bound.has(v));
      expect(
        missing,
        `${file} reads process.env.${missing.join(', ')} but does not bind ${missing.length > 1 ? 'them' : 'it'} — ` +
        `at runtime ${missing.length > 1 ? 'they are' : 'it is'} undefined`
      ).toEqual([]);
    });
  }
});
