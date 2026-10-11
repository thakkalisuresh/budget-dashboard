import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildMfPeers } from '../mfPeers.js';
import { MOCK_MF_PEERS } from '../mockMfPeers.js';

// Neutral wording only: ranks, medians, gaps. No verdicts, no calls to action.
const FORBIDDEN = /\b(buy|sell|switch(?:ing)?|better|worse|best|worst|outperform\w*|underperform\w*|lagg\w*|winner|loser|good|bad|poor|strong|weak performance|recommend(?:ed|s)?|should|avoid|top performer|ideal)\b/i;
const ALLOWED_PHRASES = [/nothing here is a recommendation/gi, /not investment advice/gi];

function strings(src) {
  // quoted/template text plus JSX text nodes; crude but wide enough to catch wording.
  const out = [];
  for (const m of src.matchAll(/'([^'\n]{3,})'|"([^"\n]{3,})"|`([^`\n]{3,})`|>([^<>{}\n]{3,})</g)) out.push(m[1] || m[2] || m[3] || m[4]);
  for (const m of src.matchAll(/^\s*<p[^>]*>([^<{]{3,})/gm)) out.push(m[1]);
  return out.join('\n');
}

describe('wording', () => {
  it('source text of the engine and the card has no verdict or advice words', () => {
    for (const f of ['../mfPeers.js', '../MfPeersCard.jsx']) {
      let text = strings(readFileSync(new URL(f, import.meta.url), 'utf8'));
      // identifiers/imports are not user text
      text = text.split('\n').filter(l => !/^(\.\/|lucide|react|node:)/.test(l.trim())).join('\n');
      for (const a of ALLOWED_PHRASES) text = text.replace(a, '');
      const hit = FORBIDDEN.exec(text);
      expect(hit && `${f}: "${hit[0]}"`).toBeNull();
    }
  });
  it('generated notes for the mock data have no verdict words', () => {
    const funds = [['absl-flexi-cap'], ['iti-small-cap'], ['absl-conglomerate'], ['sbi-retirement-aggressive-hybrid']].map(([fundKey]) => ({ planId: fundKey, name: fundKey, fundKey, plan: 'direct' }));
    const res = buildMfPeers({ funds, ...MOCK_MF_PEERS });
    const all = JSON.stringify({ notes: res.notes, fundNotes: res.funds.map(f => f.notes), disclaimer: res.disclaimer });
    expect(FORBIDDEN.test(all.replace(/not investment advice/gi, ''))).toBe(false);
  });
});
