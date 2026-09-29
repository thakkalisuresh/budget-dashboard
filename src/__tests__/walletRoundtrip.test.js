// Pure-helper tests for scripts/wallet-roundtrip.mjs: the safety rails (the
// script talks to LIVE production) and the per-case expectation logic.
import { describe, it, expect } from 'vitest';
import {
  validateConfig, buildCases, checkRails, keyFields, FAR_FUTURE_DATE, SOURCE_TAG,
} from '../../scripts/lib/wallet-roundtrip-cases.mjs';

const SHEET = 'x'.repeat(10) + 'TESTSHEET' + '1234';
const env = {
  WALLET_WEBHOOK_SECRET: 's', WALLET_URL: 'https://example.test/api/wallet',
  TEST_SHEET_ID: SHEET, TEST_EMAIL: 'me+wallettest@example.com',
  REAL_EMAILS: 'me@example.com, wife@example.com',
};
const cfgOf = (e = env) => validateConfig(e).config;
const withSettings = { ...env, PRIMARY_EMAIL: 'me@example.com', SETTINGS_EMAIL: 'me@example.com' };

describe('validateConfig rails', () => {
  it('accepts a complete config', () => expect(validateConfig(env).errors).toEqual([]));
  it.each(['WALLET_WEBHOOK_SECRET', 'WALLET_URL', 'TEST_SHEET_ID', 'TEST_EMAIL', 'REAL_EMAILS'])('requires %s', (k) => {
    expect(validateConfig({ ...env, [k]: '' }).errors.join()).toContain(k);
  });
  it('refuses a real email as TEST_EMAIL (case-insensitive)', () => {
    expect(validateConfig({ ...env, TEST_EMAIL: 'Wife@Example.com' }).errors.join()).toContain('REAL_EMAILS');
  });
  it('refuses a pasted sheet URL', () => {
    expect(validateConfig({ ...env, TEST_SHEET_ID: 'https://docs.google.com/spreadsheets/d/abc/edit' }).errors.join()).toContain('bare spreadsheet id');
  });
  it('requires https', () => expect(validateConfig({ ...env, WALLET_URL: 'http://x' }).errors.join()).toContain('https'));
  it('SETTINGS_EMAIL must equal PRIMARY_EMAIL, and PRIMARY_EMAIL must exist', () => {
    expect(validateConfig({ ...env, SETTINGS_EMAIL: 'me@example.com' }).errors.join()).toContain('PRIMARY_EMAIL');
    expect(validateConfig({ ...env, PRIMARY_EMAIL: 'me@example.com', SETTINGS_EMAIL: 'wife@example.com' }).errors.join()).toContain('must equal PRIMARY_EMAIL');
    expect(validateConfig(withSettings).errors).toEqual([]);
  });
});

describe('checkRails over every case', () => {
  for (const [label, e] of [['without settings email', env], ['with settings email + disabled vendor', { ...withSettings, DISABLED_VENDOR: 'netflix' }]]) {
    it(`is clean ${label}`, () => {
      const cfg = cfgOf(e);
      expect(checkRails(buildCases(cfg), cfg)).toEqual([]);
    });
  }

  it('every case carries the test sheetId; only month_not_found omits it, on the far-future date', () => {
    const cfg = cfgOf(withSettings);
    for (const c of buildCases(cfg)) {
      if (c.id === 'month_not_found') {
        expect(c.body.sheetId).toBeUndefined();
        expect(c.body.date).toBe(FAR_FUTURE_DATE);
        expect(c.writes).toBe(false);
      } else {
        expect(c.body.sheetId, c.id).toBe(SHEET);
      }
      expect(c.body.source).toBe(SOURCE_TAG);
    }
  });

  it('the split case is far-future dated (SKIP cannot reach a real month sheet)', () => {
    const cfg = cfgOf(withSettings);
    expect(buildCases(cfg).find(c => c.id === 'split_vendor').body.date).toBe(FAR_FUTURE_DATE);
  });

  it('test-email cases never use a real email; split/disabled only the settings email', () => {
    const cfg = cfgOf({ ...withSettings, DISABLED_VENDOR: 'netflix' });
    for (const c of buildCases(cfg)) {
      const em = c.body.email.toLowerCase();
      if (c.emailKind === 'settings') expect(em).toBe('me@example.com');
      else expect(cfg.realEmails).not.toContain(em);
    }
  });

  it('catches a case that drops sheetId, or reuses cents', () => {
    const cfg = cfgOf();
    const cases = buildCases(cfg);
    cases.find(c => c.id === 'purchase_structured').body.sheetId = undefined;
    cases.find(c => c.id === 'ambiguous_amzn').body.amount = 14.19;
    const v = checkRails(cases, cfg).join('\n');
    expect(v).toContain('purchase_structured: missing or wrong sheetId');
    expect(v).toContain('ambiguous_amzn: same cents');
  });

  it('omits split/disabled cases without a settings email', () => {
    const ids = buildCases(cfgOf()).map(c => c.id);
    expect(ids).not.toContain('split_vendor');
    expect(ids).not.toContain('disabled_vendor');
  });
});

describe('expectations', () => {
  const cfg = cfgOf(withSettings);
  const get = (id) => buildCases(cfg).find(c => c.id === id);
  const r = (status, json) => ({ status, json });

  it('raw Amex: PASS on exact amount, FAIL on garbage amount, FAIL when skipped', () => {
    const c = get('raw_amex_oddfellows');
    expect(c.expect(r(200, { ok: true, vendor: 'Little Oddfellows', amount: 17.58, category: 'Eating Out', message: '✅' })).verdict).toBe('PASS');
    expect(c.expect(r(200, { ok: true, vendor: 'Little Oddfellows', amount: 1758, message: '✅' })).verdict).toBe('FAIL');
    expect(c.expect(r(200, { ok: true, skipped: true, reason: 'not_a_purchase' })).verdict).toBe('FAIL');
    expect(c.expect(r(200, { ok: true, pendingCategory: true, vendor: 'Little Oddfellows', amount: 17.58 })).verdict).toBe('WARN');
  });

  it('Capital One: warns on an un-normalized merchant, fails when the merchant is lost', () => {
    const c = get('raw_capone_realdebrid');
    expect(c.expect(r(200, { ok: true, vendor: 'Real-Debrid', amount: 23.1 })).verdict).toBe('PASS');
    expect(c.expect(r(200, { ok: true, vendor: 'REAL-DEBRID*17886754', amount: 23.1 })).verdict).toBe('WARN');
    expect(c.expect(r(200, { ok: true, vendor: 'Unknown', amount: 23.1 })).verdict).toBe('FAIL');
  });

  it('ugly float must come back rounded', () => {
    const c = get('ugly_float');
    expect(c.expect(r(200, { ok: true, amount: 8.23, message: '✅ $8.23' })).verdict).toBe('PASS');
    expect(c.expect(r(200, { ok: true, amount: 8.229999999999999 })).verdict).toBe('FAIL');
  });

  it('ambiguous: parked PASS, confident write WARN (not FAIL)', () => {
    const c = get('ambiguous_sq_bloom');
    expect(c.expect(r(200, { ok: true, pendingCategory: true, message: '🤔' })).verdict).toBe('PASS');
    expect(c.expect(r(200, { ok: true, category: 'Eating Out', message: '✅' })).verdict).toBe('WARN');
    expect(c.expect(r(500, { ok: false })).verdict).toBe('FAIL');
  });

  it('non-purchase: a logged row is a FAIL', () => {
    const c = get('np_declined');
    expect(c.expect(r(200, { ok: true, skipped: true, reason: 'not_a_purchase', kind: 'declined' })).verdict).toBe('PASS');
    expect(c.expect(r(200, { ok: true, category: 'Misc', vendor: 'x', amount: 1, message: '✅' })).verdict).toBe('FAIL');
  });

  it('dup pair, dup notice, unreadable, month, auth, split', () => {
    expect(get('dup_second').expect(r(200, { ok: true, skipped: true, reason: 'duplicate_recent', message: '⏭ dup' })).verdict).toBe('PASS');
    expect(get('dup_second').expect(r(200, { ok: true, category: 'Eating Out', message: '✅' })).verdict).toBe('FAIL');
    expect(get('dup_notice').expect(r(200, { ok: true, category: 'Eating Out', message: '✅ x ⚠️ Possible duplicate' })).verdict).toBe('PASS');
    expect(get('dup_notice').expect(r(200, { ok: true, category: 'Eating Out', message: '✅ x' })).verdict).toBe('FAIL');
    expect(get('unreadable_amount').expect(r(400, { code: 'WAL-001', message: '⚠️ Couldn\'t read the amount' })).verdict).toBe('PASS');
    expect(get('month_not_found').expect(r(422, { code: 'SHT-002' })).verdict).toBe('PASS');
    expect(get('auth_bad').expect(r(401, {})).verdict).toBe('PASS');
    expect(get('split_vendor').expect(r(200, { ok: true, split: true, message: '🧾 x' })).verdict).toBe('PASS');
  });

  it('keyFields is compact and omits the message', () => {
    expect(keyFields({ json: { ok: true, category: 'Misc', vendor: 'V', amount: 1, message: 'long', extra: 'x' } })).toBe('ok=true category=Misc vendor=V amount=1');
  });
});
