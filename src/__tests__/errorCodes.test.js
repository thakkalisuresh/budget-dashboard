import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ERROR_CODES, describeError, errorLabel, codesByDomain,
} from '../../functions/lib/_error-codes.mjs';
import { renderDoc } from '../../scripts/generate-error-codes-doc.mjs';

const CODE_SHAPE = /^[A-Z]{2,4}-\d{3}$/;
const SEVERITIES = new Set(['fatal', 'degraded', 'config']);

describe('error code registry', () => {
  it('every code has the required shape and fields', () => {
    for (const [code, entry] of Object.entries(ERROR_CODES)) {
      expect(code, `${code} shape`).toMatch(CODE_SHAPE);
      expect(SEVERITIES.has(entry.severity), `${code} severity "${entry.severity}"`).toBe(true);
      // A catalogue entry with no fix is a code you can look up and still not
      // know what to do — the whole point is the answer, not the label.
      expect(entry.title?.length, `${code} title`).toBeGreaterThan(5);
      expect(entry.cause?.length, `${code} cause`).toBeGreaterThan(20);
      expect(entry.fix?.length, `${code} fix`).toBeGreaterThan(20);
    }
  });

  it('has no duplicate titles, which would make two codes indistinguishable', () => {
    const titles = Object.values(ERROR_CODES).map(e => e.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('numbers each domain contiguously from 001, so gaps mean a retired code', () => {
    for (const [domain, entries] of Object.entries(codesByDomain())) {
      const nums = entries.map(e => Number(e.code.split('-')[1])).sort((a, b) => a - b);
      expect(nums[0], `${domain} starts at 001`).toBe(1);
      expect(new Set(nums).size, `${domain} has no duplicate numbers`).toBe(nums.length);
    }
  });

  it('looks a code up, and returns null rather than throwing on an unknown one', () => {
    expect(describeError('SHT-002').title).toMatch(/No sheet found/i);
    expect(describeError('NOPE-999')).toBeNull();
  });

  it('labels a code for log lines, degrading to the bare code if unknown', () => {
    expect(errorLabel('WAL-002')).toBe('WAL-002 — Wallet transaction write failed');
    expect(errorLabel('NOPE-999')).toBe('NOPE-999');
  });
});

describe('generated catalogue', () => {
  it('docs/ERROR_CODES.md matches the registry', () => {
    // The doc is generated. If this fails someone added a code without running
    // `npm run errdoc`, and the catalogue would ship stale.
    const onDisk = readFileSync(resolve(process.cwd(), 'docs/ERROR_CODES.md'), 'utf8');
    expect(onDisk).toBe(renderDoc());
  });

  it('documents every registered code', () => {
    const doc = renderDoc();
    for (const code of Object.keys(ERROR_CODES)) {
      expect(doc, `${code} missing from doc`).toContain(`### ${code}`);
    }
  });
});

/* ── The codes actually being used ── */

describe('codes referenced in source all exist', () => {
  it('every reportError code is a registered code', async () => {
    const { execSync } = await import('node:child_process');
    const out = execSync(`grep -rho "reportError('[A-Z]\\{2,4\\}-[0-9]\\{3\\}'" functions/ || true`, { encoding: 'utf8' });
    const used = [...new Set([...out.matchAll(/reportError\('([A-Z]{2,4}-\d{3})'/g)].map(m => m[1]))];
    expect(used.length, 'expected reportError to be wired somewhere').toBeGreaterThan(5);
    for (const code of used) {
      expect(ERROR_CODES[code], `${code} is used in source but not registered`).toBeDefined();
    }
  });
});
