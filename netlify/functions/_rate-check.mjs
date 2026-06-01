/**
 * Monthly card-rate auto-check — core logic.
 * Files starting with "_" are NOT deployed as functions by Netlify; the
 * deployed scheduled wrapper is rate-check.mjs, which injects the real Claude,
 * Telegram, and Sheets implementations into runRateCheck().
 *
 * Flow (per card): web-search the issuer / Bankrate page via Claude, compare the
 * proposed rate table against the current effective table, and — only on a
 * HIGH-confidence change — store a proposal blob and notify the household.
 * Nothing is auto-applied; the user replies APPLY RATES (or IGNORE) via Telegram.
 */

// Human-readable labels for the MCC keys we track (for notification text).
export const MCC_LABELS = {
  '5812': 'Dining', '5813': 'Dining', '5814': 'Dining',
  '4511': 'Airlines', '7011': 'Hotels', 'CHASE_PORTAL': 'Chase Travel portal',
  '5411': 'US Supermarkets', '5422': 'Specialty food',
  '5300': 'Wholesale clubs', '5310': 'Superstores', '5311': 'Superstores',
  '7372': 'Streaming', '5541': 'Gas stations', '5542': 'Gas stations',
  '4121': 'Rideshare/Transit', '4111': 'Transit', '4131': 'Bus',
  '4784': 'Tolls', '7523': 'Parking', '5912': 'Pharmacy',
};

function mccLabel(key) {
  if (key === 'default') return 'Everything else';
  return MCC_LABELS[key] || `MCC ${key}`;
}

/** Render a single rate node (number | {portal,direct} | {rate,cap}) for display. */
export function rateDisplay(type, v) {
  if (v == null) return '—';
  const suffix = type === 'cashback' ? '%' : 'x';
  if (typeof v === 'number') return `${v}${suffix}`;
  if (typeof v === 'object' && 'portal' in v) return `${v.portal}x portal / ${v.direct}x direct`;
  if (typeof v === 'object' && 'rate' in v) return `${v.rate}${suffix}`;
  return String(v);
}

/**
 * Diff two rate configs for one card. Compares every MCC node + the default.
 * @returns array of { key, label, from, to } for changed nodes only.
 */
export function diffRateTable(oldCfg, newCfg) {
  if (!oldCfg || !newCfg) return [];
  const type = newCfg.type || oldCfg.type;
  const keys = new Set([
    ...Object.keys(oldCfg.mccs || {}),
    ...Object.keys(newCfg.mccs || {}),
  ]);

  const diffs = [];
  for (const key of keys) {
    const a = oldCfg.mccs?.[key];
    const b = newCfg.mccs?.[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      diffs.push({ key, label: mccLabel(key), from: rateDisplay(type, a), to: rateDisplay(type, b) });
    }
  }
  if (JSON.stringify(oldCfg.default) !== JSON.stringify(newCfg.default)) {
    diffs.push({ key: 'default', label: mccLabel('default'), from: rateDisplay(type, oldCfg.default), to: rateDisplay(type, newCfg.default) });
  }
  return diffs;
}

/** Telegram/in-app notification text for a detected change. */
export function buildRateChangeMessage(card, diffs, source, confidence) {
  const lines = [
    `📊 Rate change detected — ${card}`,
    '',
    ...diffs.map(d => `${d.label}: ${d.from} → ${d.to}`),
  ];
  if (source) lines.push(`Source: ${source}`);
  if (confidence) lines.push(`Confidence: ${confidence.charAt(0).toUpperCase() + confidence.slice(1)}`);
  lines.push('', 'Reply APPLY RATES to update, or IGNORE to keep current rates.');
  return lines.join('\n');
}

/**
 * Parse Claude's response into { mccs, default, source, confidence }.
 * Tolerates ```json fences and surrounding prose by extracting the last JSON
 * object in the text. Returns null if nothing parseable / shape is wrong.
 */
export function parseClaudeRates(text) {
  if (!text || typeof text !== 'string') return null;
  // Grab the last {...} block (web_search responses prepend prose/tool chatter)
  const matches = text.match(/\{[\s\S]*\}/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(matches[i]);
      if (obj && typeof obj === 'object' && obj.mccs && typeof obj.mccs === 'object' && 'default' in obj) {
        return {
          mccs: obj.mccs,
          default: obj.default,
          source: obj.source || '',
          confidence: String(obj.confidence || '').toLowerCase(),
        };
      }
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Orchestrate the monthly check. All side effects are injected for testability.
 *
 * @param currentRates  effective rate table { cardName: cfg }
 * @param callClaude    async (card, cfg) => { mccs, default, source, confidence } | null
 * @param store         blob store with setJSON(key, value)
 * @param notifyTelegram async (message) => void   (sends to the whole household)
 * @param notifyInApp    async (card, message) => void  (appends read-only msg for all)
 * @param now           Date (defaults to new Date())
 * @returns { changed: [{card, diffs}], proposalStored: boolean }
 */
export async function runRateCheck({
  currentRates, callClaude, store, notifyTelegram, notifyInApp, now = new Date(),
}) {
  const cards = Object.keys(currentRates || {});
  const proposedRates = { ...currentRates };
  const changed = [];

  for (const card of cards) {
    const currentCfg = currentRates[card];
    let proposed;
    try {
      proposed = await callClaude(card, currentCfg);
    } catch (e) {
      console.warn(`rate-check: Claude failed for ${card}:`, e.message);
      continue;
    }
    if (!proposed) continue;

    // Low/medium confidence → stay silent (no false alarms)
    if (proposed.confidence !== 'high') continue;

    const proposedCfg = { ...currentCfg, mccs: proposed.mccs, default: proposed.default };
    const diffs = diffRateTable(currentCfg, proposedCfg);
    if (diffs.length === 0) continue;

    proposedRates[card] = proposedCfg;
    changed.push({ card, diffs, source: proposed.source, confidence: proposed.confidence });

    const message = buildRateChangeMessage(card, diffs, proposed.source, proposed.confidence);
    if (notifyTelegram) await notifyTelegram(message);
    if (notifyInApp)    await notifyInApp(card, message);
  }

  let proposalStored = false;
  if (changed.length > 0 && store) {
    await store.setJSON('latest', {
      proposedAt: now.toISOString(),
      rates: proposedRates,
      summary: changed.map(c => ({ card: c.card, diffs: c.diffs, source: c.source })),
    });
    proposalStored = true;
  }

  return { changed, proposalStored };
}

/** Prompt for Claude: hand it the current cfg, ask for the same shape back. */
export function buildClaudePrompt(card, cfg, sourceHint) {
  return [
    `You are auditing the current rewards earn rates for the credit card "${card}".`,
    `Use web search to find the OFFICIAL current earn rates from this primary source: ${sourceHint}`,
    `(fall back to bankrate.com if the issuer page is unavailable).`,
    '',
    'Here is the current rate table I have on file (MCC code → multiplier/percent):',
    '```json',
    JSON.stringify({ mccs: cfg.mccs, default: cfg.default }, null, 2),
    '```',
    '',
    'Rate semantics: for a points card the number is a multiplier (3 = 3x);',
    'for a cashback card it is a percent (6 = 6%). A {"portal":8,"direct":4} node',
    'means 8x when booked via the issuer travel portal, 4x when booked direct.',
    'A {"rate":6,"cap":{"annual":6000,"then":1}} node is a capped category.',
    '',
    'Return ONLY a JSON object with this exact shape and the SAME keys:',
    '{ "mccs": {...}, "default": <number>, "source": "<url you used>", "confidence": "high|medium|low" }',
    'Keep every key identical; change a value ONLY if the official source clearly',
    'contradicts it. Set confidence "high" only if you are certain from an official',
    'or authoritative source. If everything matches, return the table unchanged with',
    'confidence "high".',
  ].join('\n');
}
