#!/usr/bin/env node
/**
 * Generate docs/ERROR_CODES.md from the registry in
 * functions/lib/_error-codes.mjs.
 *
 * The registry is the source of truth; this file only renders it. A test
 * asserts the checked-in doc matches, so adding a code without regenerating
 * fails CI rather than quietly leaving the catalogue stale.
 *
 *   npm run errdoc          write the doc
 *   npm run errdoc -- --check   exit 1 if it would change
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, codesByDomain } from '../functions/lib/_error-codes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/ERROR_CODES.md');

const DOMAIN_NAMES = {
  CFG:  'Configuration & secrets',
  AUTH: 'Authentication & access',
  SHT:  'Google Sheets',
  DRV:  'Google Drive',
  EXTR: 'Receipt & text extraction',
  LLM:  'AI (Groq, agent, categorization)',
  TG:   'Telegram transport',
  BOT:  'Bot conversation flows',
  WAL:  'Wallet webhook',
  FX:   'Currency conversion',
  PUSH: 'Web push notifications',
  MCP:  'MCP server',
  WEB:  'Dashboard (frontend)',
};

const SEVERITY_NOTE = {
  fatal:    '🔴 fatal — the action did not happen; the user must retry',
  degraded: '🟡 degraded — the action happened but something was lost or skipped',
  config:   '⚙️ config — nothing will work until a setting or secret is changed',
};

export function renderDoc() {
  const byDomain = codesByDomain();
  const total = Object.keys(ERROR_CODES).length;

  const out = [];
  out.push('# Error codes');
  out.push('');
  out.push('> **Generated file — do not edit by hand.**');
  out.push('> Source of truth: `functions/lib/_error-codes.mjs`. Regenerate with `npm run errdoc`.');
  out.push('');
  out.push(`${total} codes across ${Object.keys(byDomain).length} domains.`);
  out.push('');
  out.push('Codes appear wherever the failure surfaces: in the bot\'s reply, on the');
  out.push('dashboard crash screen, in the wallet webhook response body, in Cloud Logging,');
  out.push('and in the daily Telegram digest.');
  out.push('');
  out.push('**You can also just ask the bot.** Send it a code — `SHT-009`, or');
  out.push('"what does SHT-009 mean" — and it replies with the entry below.');
  out.push('');

  out.push('## Severity');
  out.push('');
  for (const [, note] of Object.entries(SEVERITY_NOTE)) out.push(`- ${note}`);
  out.push('');

  out.push('## Index');
  out.push('');
  out.push('| Code | Severity | What it means |');
  out.push('|---|---|---|');
  for (const [code, e] of Object.entries(ERROR_CODES)) {
    out.push(`| [\`${code}\`](#${code.toLowerCase()}) | ${e.severity} | ${e.title} |`);
  }
  out.push('');

  for (const [domain, entries] of Object.entries(byDomain)) {
    out.push(`## ${domain} — ${DOMAIN_NAMES[domain] || domain}`);
    out.push('');
    for (const e of entries) {
      out.push(`### ${e.code}`);
      out.push('');
      out.push(`**${e.title}** · \`${e.severity}\``);
      out.push('');
      out.push(`**Why it happens.** ${e.cause}`);
      out.push('');
      out.push(`**What to do.** ${e.fix}`);
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  out.push('## Adding a code');
  out.push('');
  out.push('1. Add an entry to `ERROR_CODES` in `functions/lib/_error-codes.mjs`.');
  out.push('2. Use the next free number in that domain. **Never reuse a retired number** —');
  out.push('   an old log line should still resolve to what it meant when it was written.');
  out.push('3. Call it: `await reportError(\'SHT-011\', err, { sheetId, category })`.');
  out.push('4. Run `npm run errdoc` and commit the regenerated doc.');
  out.push('');
  return out.join('\n') + '\n';
}

// Only act when run directly. Importing this module (the drift test does) must
// have no side effects — otherwise the test regenerates the doc and then
// asserts it matches itself, which proves nothing.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const content = renderDoc();
  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== content) {
      console.error('docs/ERROR_CODES.md is out of date — run: npm run errdoc');
      process.exit(1);
    }
    console.log('docs/ERROR_CODES.md is up to date.');
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, content);
    console.log(`Wrote ${OUT} (${Object.keys(ERROR_CODES).length} codes).`);
  }
}
