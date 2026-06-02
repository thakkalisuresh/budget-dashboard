/**
 * Scheduled monthly card-rate auto-check (1st of each month, 09:00 UTC).
 * Thin transport wrapper around _rate-check.mjs — injects the real Claude
 * (web_search), Telegram, and Sheets implementations.
 */

import { getStore } from '@netlify/blobs';
import { runRateCheck, parseClaudeRates, buildClaudePrompt } from './_rate-check.mjs';
import { CARD_REWARDS, getEffectiveRates } from './_card-rewards.mjs';
import { getUserSettings, getAllowedEmails, updateUserSettingsFor } from './_sheets.mjs';
import { sendMessage } from './_telegram.mjs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const SONNET_MODEL      = 'claude-sonnet-4-6';

const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USERS || '')
  .split(',').map(u => u.trim()).filter(Boolean);

// Primary research source per card (issuer page first; Bankrate fallback in prompt).
const SOURCE_HINTS = {
  'Chase Sapphire Reserve':                'https://www.chase.com/personal/credit-cards/sapphire/reserve',
  'Chase Freedom Unlimited':               'https://www.chase.com/personal/credit-cards/freedom/unlimited',
  'Capital One Quicksilver':               'https://www.capitalone.com/credit-cards/quicksilver/',
  'American Express Blue Cash Preferred':  'https://www.bankrate.com/credit-cards/reviews/blue-cash-preferred-card-from-american-express/',
};

async function callClaude(card, cfg) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const prompt = buildClaudePrompt(card, cfg, SOURCE_HINTS[card] || 'the official issuer page');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Claude ${res.status}: ${err?.error?.message || 'unknown'}`);
  }

  const data = await res.json();
  // Concatenate every text block (web_search prepends tool_use/tool_result blocks).
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  return parseClaudeRates(text);
}

async function notifyTelegram(message) {
  for (const chatId of ALLOWED_USERS) {
    try { await sendMessage(chatId, message); }
    catch (e) { console.warn('rate-check: telegram send failed', e.message); }
  }
}

async function notifyInApp(card, message) {
  const emails = getAllowedEmails();
  for (const email of emails) {
    try {
      await updateUserSettingsFor(email, (s) => {
        const msg = {
          id: `rate_${Date.now()}_${card.replace(/\W/g, '').slice(0, 8)}`,
          type: 'rate-change',
          title: `Rate change — ${card}`,
          body: message,
          timestamp: new Date().toISOString(),
          read: false,
        };
        s.messages = [msg, ...(Array.isArray(s.messages) ? s.messages : [])].slice(0, 50);
        return s;
      });
    } catch (e) {
      console.warn('rate-check: in-app notify failed for', email, e.message);
    }
  }
}

export default async function handler() {
  if (!ANTHROPIC_API_KEY) {
    console.warn('rate-check: ANTHROPIC_API_KEY not configured — skipping');
    return new Response('AI not configured', { status: 200 });
  }

  let currentRates = CARD_REWARDS;
  try {
    const settings = await getUserSettings();
    currentRates = getEffectiveRates(settings);
  } catch (e) {
    console.warn('rate-check: could not load settings, using defaults', e.message);
  }

  const store = getStore('rate-proposals');

  try {
    const result = await runRateCheck({
      currentRates, callClaude, store, notifyTelegram, notifyInApp,
    });
    console.log(`rate-check: ${result.changed.length} card(s) changed, proposalStored=${result.proposalStored}`);
    return new Response(JSON.stringify({
      changed: result.changed.map(c => c.card),
      proposalStored: result.proposalStored,
    }), { status: 200 });
  } catch (e) {
    console.error('rate-check: run failed', e.message);
    return new Response('rate-check failed', { status: 200 });
  }
}

export const config = {
  schedule: '0 9 1 * *',  // 09:00 UTC on the 1st of every month
};
