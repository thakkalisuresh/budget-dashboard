import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { codedError, withCode, userMessage } from '../errorCodes.js';
import { ERROR_CODES } from '../../functions/lib/_error-codes.mjs';

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');
// Any code that appears literally in the file: bracketed in a user-facing
// string, quoted as an argument, or as a fallback default.
const CODE_RE = /\[([A-Z]{2,4}-\d{3})\]|['"]([A-Z]{2,4}-\d{3})['"]/g;

describe('codedError / userMessage', () => {
  it('carries the code through a throw and catch', () => {
    try {
      throw codedError('SHT-003', 'Unknown category: Pets');
    } catch (e) {
      expect(e.code).toBe('SHT-003');
      expect(userMessage(e)).toBe('Unknown category: Pets [SHT-003]');
    }
  });

  it('falls back to the registry title when no message is given', () => {
    expect(codedError('WAL-002').message).toBe(ERROR_CODES['WAL-002'].title);
  });

  it('does not overwrite a more specific code set deeper in the stack', () => {
    const e = codedError('SHT-003', 'specific');
    withCode(e, 'WEB-002');
    expect(e.code).toBe('SHT-003');
  });

  it('leaves a codeless error unlabelled rather than guessing', () => {
    // A wrong code is worse than none — it sends you to the wrong catalogue entry.
    expect(userMessage(new Error('plain boom'))).toBe('plain boom');
    expect(userMessage(new Error('plain boom'), 'WEB-002')).toBe('plain boom [WEB-002]');
  });
});

describe('codes reach the user, not just the logs', () => {
  const surfaces = {
    'functions/lib/_bot-core.mjs': 'Telegram bot replies',
    'functions/wallet-webhook.mjs': 'wallet webhook responses',
    'src/main.jsx': 'crash screen / unhandled rejections',
  };

  for (const [file, what] of Object.entries(surfaces)) {
    it(`${what} reference at least one code`, () => {
      const src = read(file);
      const found = [...src.matchAll(CODE_RE)].map(m => m[1] || m[2]);
      expect(found.length, `no codes found in ${file}`).toBeGreaterThan(0);
    });
  }

  it('every code shown to a user is a registered code', () => {
    // A code on screen that isn't in the catalogue is worse than no code:
    // it sends you looking for a page that does not exist.
    for (const file of [...Object.keys(surfaces), 'src/sheetApi.js', 'src/sheetExpenses.js', 'src/receiptHelpers.js', 'src/HistoryTab.jsx', 'src/LedgerTab.jsx']) {
      const src = read(file);
      for (const m of src.matchAll(CODE_RE)) {
        const code = m[1] || m[2];
        expect(ERROR_CODES[code], `${code} shown in ${file} but not registered`).toBeDefined();
      }
    }
  });

  it('no bot failure message is left without a code', () => {
    const src = read('functions/lib/_bot-core.mjs');
    const failures = [...src.matchAll(/ctx\.send\((['"])((?:Failed|Could not|Cannot)[^'"]*)\1/g)];
    expect(failures.length, 'expected to find bot failure messages').toBeGreaterThan(5);
    for (const m of failures) {
      expect(m[2], `uncoded bot message: "${m[2]}"`).toMatch(/\[[A-Z]{2,4}-\d{3}\]/);
    }
  });
});

/* ── Asking the bot what a code means ── */

describe('bot error-code lookup', () => {
  it('answers a bare code with the catalogue entry', async () => {
    const { findErrorCodeInText, explainErrorCode } =
      await import('../../functions/lib/_error-codes.mjs');

    expect(findErrorCodeInText('SHT-009')).toBe('SHT-009');
    const reply = explainErrorCode('SHT-009');
    expect(reply).toContain('SHT-009 — Expense write failed');
    expect(reply).toContain('Severity: fatal');
    expect(reply).toContain('What to do:');
  });

  it('understands the question phrased naturally, and lowercase', async () => {
    const { findErrorCodeInText } = await import('../../functions/lib/_error-codes.mjs');
    for (const q of [
      'what does SHT-009 mean',
      'WAL-002?',
      'what is wal-002',
      'help with SHT-002',
      'how do I fix DRV-002',
    ]) {
      expect(findErrorCodeInText(q), `should match: "${q}"`).toMatch(/^[A-Z]{2,4}-\d{3}$/);
    }
  });

  it('does not hijack a message that merely contains code-like text', async () => {
    const { findErrorCodeInText } = await import('../../functions/lib/_error-codes.mjs');
    // A receipt or note must still route normally.
    expect(findErrorCodeInText('AMZ-001 STORE 45.20 grocery')).toBeNull();
    expect(findErrorCodeInText('Costco 89.50 Grocery')).toBeNull();
    expect(findErrorCodeInText('x'.repeat(120) + ' SHT-009')).toBeNull();
  });

  it('says so plainly for a code that does not exist', async () => {
    const { explainErrorCode } = await import('../../functions/lib/_error-codes.mjs');
    expect(explainErrorCode('ZZZ-999')).toContain("isn't a known error code");
  });

  it('can explain every registered code without throwing', async () => {
    const { explainErrorCode } = await import('../../functions/lib/_error-codes.mjs');
    for (const code of Object.keys(ERROR_CODES)) {
      const reply = explainErrorCode(code);
      expect(reply, `${code} reply`).toContain(code);
      expect(reply.length, `${code} reply too short`).toBeGreaterThan(60);
    }
  });
});
