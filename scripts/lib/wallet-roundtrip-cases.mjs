/**
 * Cases, safety rails and expectation logic for scripts/wallet-roundtrip.mjs.
 * Pure (no network, no env reads) so it can be unit-tested; see
 * src/__tests__/walletRoundtrip.test.js.
 *
 * The webhook is LIVE production (there is no staging project). Every case that
 * can write carries `sheetId: testSheetId`; the one deliberate exception is
 * month_not_found, which uses a far-future date no real month sheet matches so
 * it can only ever 422. Real emails are never hardcoded here (public repo): the
 * caller supplies the denylist.
 */
import { DEFAULT_SPLIT_VENDORS } from '../../src/itemCategorizer.js';

export const FAR_FUTURE_DATE = '2031-01-15';
export const SOURCE_TAG = 'roundtrip-test';

const splitEmails = (s) => String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * Validate the environment. Returns { errors, config }. `config` is only usable
 * when errors is empty.
 */
export function validateConfig(env) {
  const errors = [];
  const need = (k) => { if (!String(env[k] || '').trim()) errors.push(`${k} is required`); };
  ['WALLET_WEBHOOK_SECRET', 'WALLET_URL', 'TEST_SHEET_ID', 'TEST_EMAIL', 'REAL_EMAILS'].forEach(need);

  const testSheetId = String(env.TEST_SHEET_ID || '').trim();
  if (testSheetId && !/^[A-Za-z0-9_-]{20,}$/.test(testSheetId)) {
    errors.push('TEST_SHEET_ID must be the bare spreadsheet id (the long token between /d/ and /edit), not a URL');
  }
  const url = String(env.WALLET_URL || '').trim();
  if (url && !/^https:\/\//i.test(url)) errors.push('WALLET_URL must be an https:// URL');

  const testEmail = String(env.TEST_EMAIL || '').trim();
  if (testEmail && !testEmail.includes('@')) errors.push('TEST_EMAIL must be an email address');
  const realEmails = splitEmails(env.REAL_EMAILS);
  if (testEmail && realEmails.includes(testEmail.toLowerCase())) {
    errors.push('TEST_EMAIL is in REAL_EMAILS: use a distinct test address (e.g. a +alias), never a real phone email');
  }

  const settingsEmail = String(env.SETTINGS_EMAIL || '').trim();
  const primaryEmail = String(env.PRIMARY_EMAIL || '').trim();
  if (settingsEmail) {
    if (!primaryEmail) errors.push('SETTINGS_EMAIL requires PRIMARY_EMAIL to be set');
    else if (!same(settingsEmail, primaryEmail)) {
      errors.push('SETTINGS_EMAIL must equal PRIMARY_EMAIL (a test post would refresh another phone\'s heartbeat and mask a silent phone)');
    }
    if (same(settingsEmail, testEmail)) errors.push('SETTINGS_EMAIL and TEST_EMAIL must differ');
  }

  const split = String(env.SPLIT_VENDOR || '').trim() || DEFAULT_SPLIT_VENDORS[0].name;
  return {
    errors,
    config: {
      secret: env.WALLET_WEBHOOK_SECRET,
      url,
      testSheetId,
      testEmail,
      settingsEmail: settingsEmail || null,
      splitVendor: split,
      disabledVendor: String(env.DISABLED_VENDOR || '').trim() || null,
      realEmails,
    },
  };
}

/** last-4 only, so the run output never carries a full sheet id. */
export const tail = (id) => `…${String(id).slice(-4)}`;

const lc = (v) => String(v ?? '').toLowerCase();
const msgHas = (res, s) => String(res.json?.message || '').includes(s);
const isWritten = (res) => res.status === 200 && res.json?.ok && !res.json.skipped && !res.json.pendingCategory && !res.json.split;
const isParked = (res) => res.status === 200 && res.json?.pendingCategory === true;

const pass = (note = '') => ({ verdict: 'PASS', note });
const warn = (note) => ({ verdict: 'WARN', note });
const fail = (note) => ({ verdict: 'FAIL', note });

/** written, or parked pending a Telegram answer, with the exact amount */
function writtenOrParkedWithAmount(res, amount) {
  if (res.status !== 200 || !res.json?.ok) return fail(`expected 200 ok, got ${res.status} ${res.json?.code || ''}`);
  if (res.json.skipped) return fail(`skipped (${res.json.reason}); expected a purchase`);
  if (res.json.amount !== amount) return fail(`amount ${res.json.amount} != ${amount}`);
  if (isParked(res)) return warn('parked: Groq unsure; tap a category in Telegram (writes to the TEST sheet)');
  return pass();
}

/**
 * The case list. Amounts are unique cents per (email, run) so the 2-minute
 * duplicate guard never fires by accident; only the dup_* cases repeat one on
 * purpose. Each case: { id, title, emailKind, writes, body, needs?, expect(res) }.
 */
export function buildCases(cfg, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const base = (extra) => ({
    email: cfg.testEmail, sheetId: cfg.testSheetId, source: SOURCE_TAG, date: today, ...extra,
  });
  const nonPurchase = (id, text) => ({
    id, title: `non-purchase: ${id.replace('np_', '')}`, emailKind: 'test', writes: false,
    body: base({ text }),
    expect: (res) => {
      if (res.status === 200 && res.json?.skipped && res.json.reason === 'not_a_purchase') return pass(`kind=${res.json.kind}`);
      if (isWritten(res) || isParked(res)) return fail('LOGGED a non-purchase (row went to the TEST sheet)');
      return fail(`expected 200 skipped not_a_purchase, got ${res.status} ${res.json?.code || res.json?.reason || ''}`);
    },
  });

  const cases = [
    {
      id: 'purchase_structured', title: 'structured purchase', emailKind: 'test', writes: true,
      body: base({ merchant: "Trader Joe's", amount: 32.47, card: 'Test Card' }),
      expect: (res) => {
        if (isWritten(res) && msgHas(res, '✅') && res.json.amount === 32.47) return pass();
        if (isParked(res)) return warn('parked instead of written (Groq unsure about a grocery vendor?)');
        return fail(`expected written ✅ 32.47, got ${res.status} ${JSON.stringify(res.json)}`);
      },
    },
    {
      id: 'raw_amex_oddfellows', title: 'raw text: Amex Wallet', emailKind: 'test', writes: true,
      body: base({ text: 'Little Oddfellows, Portland, OR\n$17.58' }),
      expect: (res) => {
        const r = writtenOrParkedWithAmount(res, 17.58);
        if (r.verdict === 'PASS' && !/oddfellow/i.test(res.json.vendor || '')) return warn(`vendor "${res.json.vendor}"`);
        return r;
      },
    },
    {
      id: 'raw_capone_realdebrid', title: 'raw text: Capital One', emailKind: 'test', writes: true,
      body: base({ text: 'Your purchase for $23.10 at REAL-DEBRID*17886754 was approved.' }),
      expect: (res) => {
        const r = writtenOrParkedWithAmount(res, 23.1);
        if (r.verdict === 'FAIL') return r;
        const v = String(res.json.vendor || '');
        if (!/real.?debrid/i.test(v)) return fail(`vendor "${v}" lost the merchant`);
        if (/\d{6,}/.test(v) || v.includes('*')) return warn(`vendor not normalized: "${v}"`);
        return r;
      },
    },
    {
      id: 'ugly_float', title: 'float noise rounded', emailKind: 'test', writes: true,
      // Different cents from raw_amex (17.58): same email+cents inside 2 min is a duplicate.
      body: base({ merchant: 'Chipotle', amount: 8.229999999999999 }),
      expect: (res) => {
        if (res.status !== 200 || !res.json?.ok || res.json.skipped) return fail(`got ${res.status} ${JSON.stringify(res.json)}`);
        if (res.json.amount !== 8.23) return fail(`amount ${res.json.amount} not rounded to 8.23`);
        if (/\d\.\d{3,}/.test(res.json.message || '')) return fail('message shows unrounded amount');
        return isParked(res) ? warn('parked; amount rounded') : pass();
      },
    },
    ...[
      ['ambiguous_sq_bloom', 'SQ *Bloom', 14.19],
      ['ambiguous_amzn', 'AMZN Mktp US*2K4', 19.83],
    ].map(([id, merchant, amount]) => ({
      id, title: `ambiguous vendor ${merchant}`, emailKind: 'test', writes: true,
      body: base({ merchant, amount }),
      expect: (res) => {
        if (isParked(res) && msgHas(res, '🤔')) return pass('Telegram prompt sent: tap a category (goes to the TEST sheet)');
        if (isWritten(res)) return warn(`Groq was confident: written as ${res.json.category}`);
        return fail(`got ${res.status} ${JSON.stringify(res.json)}`);
      },
    })),
    {
      id: 'dup_first', title: 'dup pair: first', emailKind: 'test', writes: true,
      body: base({ merchant: 'Blue Bottle Coffee', amount: 12.34 }),
      expect: (res) => (res.status === 200 && res.json?.ok && !res.json.skipped ? pass() : fail(`got ${res.status} ${JSON.stringify(res.json)}`)),
    },
    {
      id: 'dup_second', title: 'dup pair: second (<2 min)', emailKind: 'test', writes: false,
      body: base({ merchant: 'Blue Bottle Coffee', amount: 12.34 }),
      expect: (res) => {
        if (res.status === 200 && res.json?.skipped && res.json.reason === 'duplicate_recent' && msgHas(res, '⏭')) {
          return pass('Telegram note arrives with "Log it anyway" (writes to the TEST sheet)');
        }
        return fail(`expected skipped duplicate_recent, got ${res.status} ${JSON.stringify(res.json)}`);
      },
    },
    {
      id: 'dup_notice_seed', title: '±3-day dup: seed row', emailKind: 'test', writes: true,
      body: base({ merchant: "Peet's Coffee", amount: 41.11 }),
      expect: (res) => (res.status === 200 && res.json?.ok && !res.json.skipped ? pass() : fail(`got ${res.status} ${JSON.stringify(res.json)}`)),
    },
    {
      id: 'dup_notice', title: '±3-day dup: near-match', emailKind: 'test', writes: true,
      // 41.13 vs 41.11: within AMOUNT_EPSILON (0.05) but different cents, so the 2-minute guard stays out of it.
      body: base({ merchant: "Peet's Coffee", amount: 41.13 }),
      expect: (res) => {
        if (isWritten(res) && msgHas(res, '⚠️')) return pass('written with ⚠️; Telegram note sent');
        if (isWritten(res)) return fail('written but no ⚠️ duplicate notice (History read/match problem?)');
        return fail(`got ${res.status} ${JSON.stringify(res.json)}`);
      },
    },
    nonPurchase('np_declined', 'Your purchase of $58.20 at BEST BUY was declined.'),
    nonPurchase('np_statement', 'Your March statement is ready. Minimum payment due $35.00 by April 5.'),
    nonPurchase('np_deposit', 'A deposit of $1,250.00 was received in your checking account.'),
    nonPurchase('np_autopay', 'Your autopay payment of $412.66 was received. Thank you!'),
    nonPurchase('np_refund', 'A refund of $27.45 from AMAZON.COM has been credited to your card.'),
    nonPurchase('np_otp', 'Your verification code is 482913. Do not share it with anyone.'),
    {
      id: 'unreadable_amount', title: 'unreadable amount', emailKind: 'test', writes: false,
      // Structured, so it is deterministic (a raw text might be skipped as a non-purchase instead).
      body: base({ merchant: 'Amount Check', amount: 'n/a' }),
      expect: (res) => (res.status === 400 && res.json?.code === 'WAL-001' && msgHas(res, '⚠️')
        ? pass('reports WAL-001 to tomorrow\'s digest (expected)')
        : fail(`expected 400 WAL-001 ⚠️, got ${res.status} ${JSON.stringify(res.json)}`)),
    },
    {
      id: 'month_not_found', title: 'month not found', emailKind: 'test', writes: false,
      // Deliberately NO sheetId: this is the one case that resolves via the registry.
      // The far-future date matches no real month, so it can only 422.
      noSheetId: true,
      body: { email: cfg.testEmail, source: SOURCE_TAG, merchant: 'Rails Check', amount: 5.55, date: FAR_FUTURE_DATE },
      expect: (res) => (res.status === 422 && res.json?.code === 'SHT-002' ? pass() : fail(`expected 422 SHT-002, got ${res.status} ${JSON.stringify(res.json)}`)),
    },
    {
      id: 'auth_bad', title: 'bad secret', emailKind: 'test', writes: false, badAuth: true,
      body: base({ merchant: 'Auth Check', amount: 6.06 }),
      expect: (res) => (res.status === 401 ? pass() : fail(`expected 401, got ${res.status}`)),
    },
  ];

  if (cfg.settingsEmail) {
    cases.push({
      id: 'split_vendor', title: `split vendor (${cfg.splitVendor})`, emailKind: 'settings', writes: false,
      // The split_pending blob carries no sheetId, so a SKIP tap resolves the REAL
      // month sheet from the txDate. A far-future date makes SKIP find no month
      // (SHT-002, blob deleted, nothing written). Tap SKIP; NEVER upload a receipt.
      farFuture: true,
      body: { ...base({ merchant: cfg.splitVendor, amount: 87.61 }), email: cfg.settingsEmail, date: FAR_FUTURE_DATE },
      expect: (res) => {
        if (res.status === 200 && res.json?.split && msgHas(res, '🧾')) return pass('tap SKIP in Telegram now; never upload a receipt');
        if (isParked(res)) return warn('parked as category_pending instead (Groq unsure): tap a category');
        return fail(`expected split 🧾, got ${res.status} ${JSON.stringify(res.json)}`);
      },
    });
    if (cfg.disabledVendor) {
      cases.push({
        id: 'disabled_vendor', title: 'disabled vendor', emailKind: 'settings', writes: false,
        body: { ...base({ merchant: cfg.disabledVendor, amount: 6.66 }), email: cfg.settingsEmail },
        expect: (res) => (res.status === 200 && res.json?.skipped && res.json.reason === 'vendor_disabled'
          ? pass() : fail(`expected skipped vendor_disabled, got ${res.status} ${JSON.stringify(res.json)}`)),
      });
    }
  }
  return cases;
}

/**
 * One case that posts a pasted REAL notification/SMS text (--raw). Same rails as
 * every other case: sheetId is always the TEST copy, the email is the test email
 * (or, with useSettings, the household primary so that person's card list resolves
 * the card; the row still goes to the TEST copy). `card` mimics the phone sending
 * the notification Title as an explicit card field next to `text`. The expectation is descriptive:
 * any well-formed answer passes, the point is to eyeball vendor/category/message.
 */
export function buildRawCase(cfg, text, { useSettings = false, card = '', today = new Date().toISOString().slice(0, 10) } = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('--raw needs the notification text');
  if (useSettings && !cfg.settingsEmail) throw new Error('--raw-as-primary needs PRIMARY_EMAIL and SETTINGS_EMAIL');
  return {
    id: 'raw_paste', title: 'pasted real text', emailKind: useSettings ? 'settings' : 'test', writes: true,
    body: {
      email: useSettings ? cfg.settingsEmail : cfg.testEmail,
      sheetId: cfg.testSheetId,
      source: SOURCE_TAG,
      date: today,
      text: clean,
      ...(String(card || '').trim() ? { card: String(card).trim() } : {}),
    },
    expect: (res) => {
      if (res.status !== 200 || !res.json?.ok) return fail(`expected 200 ok, got ${res.status} ${res.json?.code || ''}`);
      if (res.json.skipped) return warn(`skipped: ${res.json.reason}${res.json.kind ? ` (${res.json.kind})` : ''}`);
      if (isParked(res)) return warn('parked for a category: tap one in Telegram (writes to the TEST sheet)');
      return pass();
    },
  };
}

/**
 * Safety rails, asserted over the whole case list before anything is sent.
 * Returns a list of violations (empty = safe).
 */
export function checkRails(cases, cfg) {
  const v = [];
  const seenCents = new Map();
  for (const c of cases) {
    const b = c.body || {};
    const expectedEmail = c.emailKind === 'settings' ? cfg.settingsEmail : cfg.testEmail;
    if (!same(b.email, expectedEmail)) v.push(`${c.id}: email is not the ${c.emailKind} email`);
    if (cfg.realEmails.includes(lc(b.email)) && !(c.emailKind === 'settings' && same(b.email, cfg.settingsEmail))) {
      v.push(`${c.id}: uses a real email`);
    }
    if (c.noSheetId) {
      if (b.sheetId !== undefined) v.push(`${c.id}: month-not-found case must omit sheetId`);
      if (b.date !== FAR_FUTURE_DATE) v.push(`${c.id}: month-not-found case must use ${FAR_FUTURE_DATE}`);
      if (c.writes) v.push(`${c.id}: month-not-found case must not write`);
    } else if (b.sheetId !== cfg.testSheetId) {
      v.push(`${c.id}: missing or wrong sheetId`);
    }
    if (c.emailKind === 'settings' && !cfg.settingsEmail) v.push(`${c.id}: settings case without SETTINGS_EMAIL`);
    if (c.farFuture && b.date !== FAR_FUTURE_DATE) v.push(`${c.id}: must use ${FAR_FUTURE_DATE}`);
    if (b.source !== SOURCE_TAG) v.push(`${c.id}: missing source tag`);
    // Unique cents per email, except the intentional duplicate pair.
    if (typeof b.amount === 'number') {
      const key = `${lc(b.email)}:${Math.round(b.amount * 100)}`;
      if (seenCents.has(key) && c.id !== 'dup_second') v.push(`${c.id}: same cents as ${seenCents.get(key)}`);
      seenCents.set(key, c.id);
    }
  }
  return v;
}

/** Compact "key fields" cell for the results table. */
export function keyFields(res) {
  const j = res.json || {};
  const parts = [];
  for (const k of ['ok', 'code', 'reason', 'kind', 'category', 'vendor', 'amount', 'pendingCategory', 'split', 'skipped']) {
    if (j[k] !== undefined && j[k] !== null && j[k] !== false) parts.push(`${k}=${j[k]}`);
  }
  return parts.join(' ');
}
