import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The other half of functionSecrets.test.js.
 *
 * That test reads each function ENTRY FILE and checks the env vars it names
 * directly. `WAREHOUSE_ENABLED` is not read in any entry file — it is read deep
 * in `_warehouse.mjs`, several imports away — so it slips straight through.
 *
 * The consequence of missing the binding is the errorDigest failure exactly:
 * the deploy succeeds, the function goes ACTIVE, `warehouseEnabled()` reads
 * undefined, and every warehouse call becomes a silent no-op. Forever. Nothing
 * errors, nothing is logged, and the archive just stays empty — which looks
 * identical to "no writes happened yet".
 *
 * So this walks the import graph instead of trusting a single file.
 */

// Resolved from this file rather than from process.cwd(), so the test does not
// depend on which directory vitest was launched from.
const FN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../functions');

/** Follow relative imports from a function entry point, transitively. */
function reachableModules(entryFile) {
  const seen = new Set();
  const stack = [entryFile];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try { src = readFileSync(resolve(FN_DIR, file), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
      const target = m[1].startsWith('./')
        ? (dir ? `${dir}/${m[1].slice(2)}` : m[1].slice(2))
        : resolve('/', dir, m[1]).slice(1);
      stack.push(target);
    }
  }
  return seen;
}

function entryPoints() {
  return readdirSync(FN_DIR)
    .filter(f => f.endsWith('.mjs'))
    .map(f => ({ file: f, src: readFileSync(resolve(FN_DIR, f), 'utf8') }))
    .filter(({ src }) => /onRequest\s*\(|onSchedule\s*\(/.test(src));
}

describe('WAREHOUSE_ENABLED is bound wherever warehouse code can run', () => {
  const fns = entryPoints();

  it('finds the entry points and at least one that reaches the warehouse', () => {
    expect(fns.length).toBeGreaterThan(5);
    const reaching = fns.filter(f => reachableModules(f.file).has('lib/_warehouse.mjs'));
    expect(reaching.length, 'expected the warehouse to be wired into some function').toBeGreaterThan(3);
  });

  for (const { file, src } of entryPoints()) {
    it(`${file}: binds WAREHOUSE_SECRETS iff it can reach _warehouse.mjs`, () => {
      const reaches = reachableModules(file).has('lib/_warehouse.mjs');
      if (!reaches) return;
      expect(
        /WAREHOUSE_SECRETS/.test(src),
        `${file} can reach _warehouse.mjs but does not bind WAREHOUSE_SECRETS — ` +
        'at runtime WAREHOUSE_ENABLED is undefined and every warehouse write is ' +
        'silently skipped, exactly like the errorDigest bug',
      ).toBe(true);
    });
  }
});

describe('the legacy streaming API is never used', () => {
  /**
   * `bigquery.dataset(d).table(t).insert(rows)` is the ergonomic call in the
   * same client library as the Storage Write API, and it is a DIFFERENT
   * PRODUCT: $0.05/GB with a 1 KB minimum billed per row, and no free tier at
   * all. The Storage Write API has a 2 TiB/month free tier. Confusing the two
   * is the single way this design starts costing money, and nothing about the
   * code would look wrong.
   */
  it('no warehouse module calls insertAll or table().insert()', () => {
    const libs = readdirSync(resolve(FN_DIR, 'lib')).filter(f => f.startsWith('_warehouse'));
    expect(libs.length).toBeGreaterThan(4);
    for (const f of libs) {
      const src = readFileSync(resolve(FN_DIR, 'lib', f), 'utf8');
      // Strip comments — the modules explain at length why insertAll is banned.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, `${f} must not call insertAll`).not.toMatch(/\binsertAll\b/);
      expect(code, `${f} must not call table().insert()`).not.toMatch(/\.table\([^)]*\)\s*\.insert\b/);
    }
  });

  it('the client module writes through the managedwriter Storage Write API', () => {
    const src = readFileSync(resolve(FN_DIR, 'lib/_warehouse-client.mjs'), 'utf8');
    expect(src).toContain('@google-cloud/bigquery-storage');
    expect(src).toContain('managedwriter');
    expect(src).toContain('DefaultStream');
  });
});

describe('append-only is enforced in the SQL, not just in the prose', () => {
  it('no warehouse module emits MERGE, UPDATE or DELETE against a fact table', () => {
    const libs = readdirSync(resolve(FN_DIR, 'lib')).filter(f => f.startsWith('_warehouse'));
    for (const f of libs) {
      const src = readFileSync(resolve(FN_DIR, 'lib', f), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const verb of ['MERGE ', 'UPDATE ', 'DELETE FROM']) {
        expect(code, `${f} must not contain SQL ${verb.trim()}`).not.toContain(verb);
      }
    }
  });
});
