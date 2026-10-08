/**
 * Cloud Function — bi-weekly HYSA rate watch.
 *
 * On the 1st and 15th it reads the household's Invest sheet, asks Gemini (with
 * Google Search grounding) two things — what the best HYSA rates on the market
 * are right now, and whether each HELD bank's advertised APY has moved from the
 * rate we have stored — writes the findings to the RateWatch tab, and sends one
 * short digest to Telegram + push.
 *
 * It NEVER changes an account's APY. A detected advertised change is recorded
 * as a *proposal* on the RateWatch row; the Invest tab surfaces a one-tap
 * "update?" nudge, and only the user's confirmation writes it (the advertised
 * new-customer rate is not necessarily the user's rate — promo tiers,
 * grandfathering). See docs/INVEST.md.
 *
 * Non-fatal by construction: a scan failure reports INV-001 and returns; the
 * next cadence tries again. Like the other scheduled jobs it needs
 * cloudscheduler.googleapis.com enabled AND roles/cloudscheduler.admin on the
 * deploying principal, or the job goes ACTIVE but never fires.
 *
 * Deployment note (secrets): GEMINI_API_KEY already exists (the bot uses it).
 * No new secret is introduced — the digest reuses the Telegram + VAPID push
 * secrets the error digest / wallet webhook already bind.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getInvestSheetId, fetchInvestAccounts, appendRateWatchRow } from './lib/_invest-sheets.mjs';
import { sendMessage, resolveTelegramChatId } from './lib/_telegram.mjs';
import { sendPushToEmail } from './lib/_push.mjs';
import { reportError } from './lib/_error-log.mjs';
import {
  GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_EMAIL_MAP,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL, SHEETS_DRIVE_SECRETS,
} from './lib/secrets.mjs';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = 'gemini-2.5-flash';

/** A rate below this delta from the stored value is "unchanged" — float noise, not a move. */
const MIN_DELTA = 0.01;

const isoDay = (d) => d.toISOString().slice(0, 10);

/* ── Pure helpers (unit-tested) ─────────────────────────────────────────── */

/**
 * Turn the scan's advertised-rate readings into held-bank change proposals.
 * Matches each reading to a held account by the id we handed Gemini, and keeps
 * only the ones whose advertised APY actually differs from what we have stored.
 * Never mutates anything — a proposal is a suggestion the user confirms.
 */
export function detectProposals(accounts, advertised, { now = isoDay(new Date()), minDelta = MIN_DELTA } = {}) {
  const byId = new Map((accounts || []).map(a => [a.id, a]));
  const out = [];
  for (const adv of advertised || []) {
    const acct = byId.get(adv?.id);
    if (!acct) continue;
    const proposedApy = Number(adv.advertisedApy);
    if (!Number.isFinite(proposedApy) || proposedApy <= 0) continue;
    if (Math.abs(proposedApy - acct.apy) < minDelta) continue;   // unchanged
    out.push({
      accountId: acct.id,
      bank: acct.name,
      currentApy: acct.apy,
      proposedApy,
      effectiveDate: adv.effectiveDate || now,
    });
  }
  return out;
}

/**
 * The short digest. Returns null when there is nothing worth a message — no
 * market rate that beats the user's best and no held-bank change to confirm —
 * so silence means "nothing to do" (the same discipline as the error digest).
 */
export function buildRateWatchDigest({ bestBank, bestApy = 0, yourBestApy = 0, delta = 0, proposals = [] } = {}) {
  const hasBetter = delta > 0 && !!bestBank;
  if (!hasBetter && proposals.length === 0) return null;

  const lines = ['📈 Rate watch'];
  if (hasBetter) {
    lines.push(`Best HYSA now: ${bestBank} at ${bestApy.toFixed(2)}% — beats your ${yourBestApy.toFixed(2)}% by +${delta.toFixed(2)}%.`);
  } else {
    lines.push(`Your ${yourBestApy.toFixed(2)}% is still at the top of the market. Nothing to move. 🎉`);
  }
  for (const p of proposals) {
    lines.push(`${p.bank} now advertises ${p.proposedApy.toFixed(2)}% (you have ${p.currentApy.toFixed(2)}%, eff. ${p.effectiveDate}) — confirm in the app to log it.`);
  }
  return lines.join('\n');
}

/** One-line push body (notifications are glanceable, not a wall of text). */
export function buildPushBody({ bestBank, bestApy = 0, delta = 0, proposals = [] } = {}) {
  if (proposals.length > 0) {
    const n = proposals.length;
    return `${n} held-bank rate change${n > 1 ? 's' : ''} to confirm`;
  }
  if (delta > 0 && bestBank) return `${bestBank} pays ${bestApy.toFixed(2)}% — beats your best by +${delta.toFixed(2)}%`;
  return '';
}

/** Lenient JSON extraction — grounded responses wrap JSON in prose or fences. */
function parseLooseJson(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/* ── Gemini scan (network; mocked in tests) ─────────────────────────────── */

/**
 * Ask Gemini, grounded in Google Search, for (a) the best current HYSA rates
 * and (b) each held bank's current advertised APY (echoing back the account id
 * we passed, so detectProposals can match). Returns { alternatives, advertised }.
 */
export async function scanRates(hysaAccounts, { fetchImpl = fetch } = {}) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const held = hysaAccounts.map(a => ({ id: a.id, name: a.name, institution: a.institution, currentApy: a.apy }));
  const prompt = [
    'You are a savings-rate researcher. Use Google Search to find CURRENT, advertised',
    'US high-yield savings account (HYSA) APYs as of today. Be factual; do not estimate.',
    '',
    'Return STRICT JSON only (no prose, no markdown) with this exact shape:',
    '{',
    '  "alternatives": [{ "bank": "<bank name>", "apy": <number, percent> }],',
    '  "advertised": [{ "id": "<account id>", "advertisedApy": <number, percent>, "effectiveDate": "YYYY-MM-DD" }]',
    '}',
    '',
    '"alternatives": the 3-5 best nationally-available HYSA rates right now, highest first.',
    '"advertised": for EACH held account below, the bank\'s current advertised standard APY.',
    'Echo back the "id" exactly. Use effectiveDate = the date the rate took effect if you can',
    'find it, else today. Omit an account from "advertised" only if you truly cannot find a rate.',
    '',
    `Held accounts: ${JSON.stringify(held)}`,
  ].join('\n');

  const url = `${GEMINI_URL}/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gemini API (${GEMINI_MODEL}): ${err?.error?.message || `HTTP ${res.status}`}`);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  const parsed = parseLooseJson(text);
  return {
    alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives : [],
    advertised: Array.isArray(parsed.advertised) ? parsed.advertised : [],
  };
}

/* ── Orchestration ──────────────────────────────────────────────────────── */

export async function runRateWatch({ email, now = new Date() }) {
  const sheetId = await getInvestSheetId();
  if (!sheetId) {
    console.warn('rate-watch: no invest sheet provisioned; skipping');
    return { scanned: false, reason: 'no_invest_sheet' };
  }

  const accounts = await fetchInvestAccounts(sheetId);
  const hysa = accounts.filter(a => a.type === 'hysa');
  if (hysa.length === 0) return { scanned: false, reason: 'no_hysa' };

  const today = isoDay(now);
  let scan;
  try {
    scan = await scanRates(hysa);
  } catch (e) {
    // Non-fatal: a scan that can't reach Gemini / can't parse a result just
    // means no digest this cadence. Record it and bail without throwing.
    await reportError('INV-001', e, { hysa: hysa.length });
    return { scanned: false, reason: 'scan_failed' };
  }

  const alternatives = (scan.alternatives || [])
    .map(a => ({ bank: String(a.bank || ''), apy: Number(a.apy) || 0 }))
    .filter(a => a.bank && a.apy > 0)
    .sort((a, b) => b.apy - a.apy);
  const best = alternatives[0] || null;
  const yourBest = Math.max(0, ...hysa.map(a => a.apy));
  const bestApy = best?.apy || 0;
  const delta = Math.max(0, bestApy - yourBest);
  const proposals = detectProposals(hysa, scan.advertised, { now: today });

  // Always write the scan row (even an all-clear one) so the card has a date.
  try {
    await appendRateWatchRow(sheetId, {
      scanDate: today, bestBank: best?.bank || '', bestApy, yourBestApy: yourBest, delta, alternatives, proposals,
    });
  } catch (e) {
    await reportError('INV-001', e, { stage: 'write', sheetId });
    // keep going — the digest is still worth sending
  }

  const text = buildRateWatchDigest({ bestBank: best?.bank || '', bestApy, yourBestApy: yourBest, delta, proposals });
  if (!text) {
    return { scanned: true, best: best?.bank || null, delta, proposals: proposals.length, digested: false };
  }

  const chatId = resolveTelegramChatId(email);
  if (chatId) {
    try { await sendMessage(chatId, text); } catch (e) { console.warn('rate-watch: telegram send failed', e?.message); }
  }
  const body = buildPushBody({ bestBank: best?.bank || '', bestApy, delta, proposals });
  if (body) {
    try { await sendPushToEmail(email, { title: 'Rate watch', body, url: '/' }); } catch (e) { console.warn('rate-watch: push failed', e?.message); }
  }

  return { scanned: true, best: best?.bank || null, delta, proposals: proposals.length, digested: true };
}

export const rateWatch = onSchedule(
  {
    // 1st and 15th, 06:00 PT — bi-weekly, matching the Invest tab's copy.
    schedule: '0 13 1,15 * *',
    timeZone: 'America/Los_Angeles',
    region: 'us-central1',
    secrets: [
      GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_EMAIL_MAP,
      VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL, ...SHEETS_DRIVE_SECRETS,
    ],
    maxInstances: 1,
    timeoutSeconds: 120,
  },
  async () => {
    const email = (process.env.ALLOWED_EMAILS || '').split(',')[0]?.trim();
    if (!email) {
      console.warn('rate-watch: ALLOWED_EMAILS not configured; skipping');
      return;
    }
    try {
      await runRateWatch({ email });
    } catch (e) {
      console.error('rate-watch: run failed', e?.message);
      await reportError('INV-001', e, { stage: 'run' });
    }
  }
);
