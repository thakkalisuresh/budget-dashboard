#!/usr/bin/env node
/**
 * Scripted round-trip against the LIVE wallet webhook, with safety rails.
 * There is no staging project, so every write targets a throwaway COPY of a
 * month sheet (TEST_SHEET_ID) and a distinct test email. See
 * docs/wallet-verification.md for the setup and the manual checklist.
 *
 *   node scripts/wallet-roundtrip.mjs --list          # dry: cases only, no network
 *   node scripts/wallet-roundtrip.mjs [--only a,b] [--pause 3] [--yes] [--json]
 *
 * Env (all read from the process environment; nothing is printed except the
 * last 4 chars of the sheet id):
 *   WALLET_WEBHOOK_SECRET  bearer secret          WALLET_URL     full webhook URL
 *   TEST_SHEET_ID          bare id of the COPY    TEST_EMAIL     e.g. you+wallettest@gmail.com
 *   REAL_EMAILS            comma list of the real phone emails (TEST_EMAIL must not be one)
 *   optional: PRIMARY_EMAIL + SETTINGS_EMAIL (must be equal) enable the split /
 *   disabled-vendor cases, SPLIT_VENDOR, DISABLED_VENDOR.
 */
import readline from 'node:readline/promises';
import { validateConfig, buildCases, checkRails, keyFields, tail, FAR_FUTURE_DATE } from './lib/wallet-roundtrip-cases.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const { errors, config } = validateConfig(process.env);
const listOnly = flag('--list');

// --list needs no secrets or network, but still shows the cases with placeholder config.
const cfg = listOnly && errors.length
  ? { ...config, testSheetId: 'LISTMODE'.padEnd(24, 'x'), testEmail: 'test+list@example.invalid', settingsEmail: config.settingsEmail, realEmails: [] }
  : config;

if (errors.length && !listOnly) {
  console.error('Refusing to run:\n' + errors.map(e => `  - ${e}`).join('\n'));
  process.exit(2);
}

let cases = buildCases(cfg);
const only = opt('--only', '');
if (only) {
  const ids = only.split(',').map(s => s.trim());
  cases = cases.filter(c => ids.includes(c.id));
}

const violations = checkRails(cases, cfg);
if (violations.length) {
  console.error('Safety rail violations (bug in the kit, nothing sent):\n' + violations.map(v => `  - ${v}`).join('\n'));
  process.exit(3);
}

if (listOnly) {
  console.log(`${cases.length} cases (dry run, no network):\n`);
  for (const c of cases) {
    const b = c.body;
    const what = b.text ? `text=${JSON.stringify(b.text).slice(0, 60)}` : `merchant=${b.merchant} amount=${b.amount}`;
    console.log(`  ${c.id.padEnd(22)} ${c.emailKind.padEnd(8)} ${c.writes ? 'WRITES' : 'no-write'}  sheetId=${c.noSheetId ? 'OMITTED(422 case)' : 'TEST'}  ${what}`);
  }
  if (!cfg.settingsEmail) console.log('\n(split_vendor and disabled_vendor need SETTINGS_EMAIL + PRIMARY_EMAIL)');
  process.exit(0);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pauseMs = Math.max(0, Number(opt('--pause', '3'))) * 1000;

console.log(`
WALLET ROUND-TRIP against ${cfg.url}
  test sheet : ${tail(cfg.testSheetId)}   test email: ${cfg.testEmail}   ${cfg.settingsEmail ? 'settings email: (set)' : 'settings email: none'}
  cases      : ${cases.length}

Heads-up before you continue:
  * Real Telegram messages will arrive in the primary chat (ambiguous vendors, duplicate note, ±3-day warning${cfg.settingsEmail ? ', split prompt' : ''}).
  * Taps on category prompts / "Log it anyway" write to the TEST sheet copy. Tap them in this session so tomorrow's 12h nudge stays quiet.
${cfg.settingsEmail ? `  * SPLIT PROMPT: tap SKIP immediately. NEVER upload a receipt for it. It is dated ${FAR_FUTURE_DATE} on purpose so SKIP
    finds no month and writes nothing; a SHT-002 line in tomorrow's digest from that tap is expected.
` : ''}  * The unreadable_amount case lands one WAL-001 in tomorrow's error digest. Expected.
  * Nothing is ever sent without sheetId=TEST except month_not_found (${FAR_FUTURE_DATE}, can only 422).
`);

if (!flag('--yes')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`Is the sheet ending ${tail(cfg.testSheetId)} the COPY (not an original)? Type "yes" to run: `)).trim().toLowerCase();
  rl.close();
  if (ans !== 'yes') { console.log('Aborted.'); process.exit(1); }
}

const results = [];
for (const c of cases) {
  await sleep(pauseMs);
  let res;
  try {
    const r = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${c.badAuth ? 'wrong-secret-on-purpose' : cfg.secret}`,
      },
      body: JSON.stringify(c.body),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    res = { status: r.status, json };
  } catch (e) {
    res = { status: 0, json: null, error: e.message };
  }
  const ev = res.error ? { verdict: 'FAIL', note: `network: ${res.error}` } : c.expect(res);
  results.push({ id: c.id, status: res.status, fields: keyFields(res), message: res.json?.message || '', ...ev });
  console.log(`${ev.verdict.padEnd(4)} ${c.id.padEnd(22)} ${res.status}  ${keyFields(res)}`);
}

if (flag('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('\n' + '─'.repeat(100));
  console.log('case'.padEnd(22), 'HTTP', 'verdict', 'key fields / message / note');
  for (const r of results) {
    console.log(`${r.id.padEnd(22)} ${String(r.status).padEnd(4)} ${r.verdict.padEnd(7)} ${r.fields}`);
    if (r.message) console.log(`${' '.repeat(35)}message: ${r.message}`);
    if (r.note) console.log(`${' '.repeat(35)}note: ${r.note}`);
  }
}
const n = (v) => results.filter(r => r.verdict === v).length;
console.log(`\nPASS ${n('PASS')}  WARN ${n('WARN')}  FAIL ${n('FAIL')}`);
console.log('Next: verify rows in the TEST sheet, then work through docs/wallet-verification.md.');
process.exit(n('FAIL') ? 1 : 0);
