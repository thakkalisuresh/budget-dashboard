// Parsing and classification for several expenses in one message.
//
// The governing rule under test: ambiguity blocks only the items it touches.
// Clean items stay in `ready` even when a sibling raises a question — write-first
// is not suspended just because the message had three expenses in it.
//
// A question is raised only where guessing would write a wrong NUMBER. A shaky
// category is a fixable label and must never appear here.
import { describe, it, expect } from 'vitest';
import {
  splitExpenseSegments, extractStatedTotal, looksLikeMultiExpense,
  parseMultiExpense, classifyMulti, distributeGap, MAX_ITEMS,
} from '../../functions/lib/_multi-expense.mjs';
import { parseExpenseCommand } from '../../functions/lib/_bot-core.mjs';

// The amount parser the bot uses, exposed here through parseExpenseCommand.
const parseAmount = (s) => {
  const p = parseExpenseCommand(s);
  return p.amount != null ? { amount: p.amount } : null;
};
const parse = (text) => parseMultiExpense(text, parseExpenseCommand, parseAmount);

describe('splitExpenseSegments', () => {
  it('splits on the separators people actually list purchases with', () => {
    expect(splitExpenseSegments('walgreens 53.11 and shell 40, plus 25 at chipotle'))
      .toEqual(['walgreens 53.11', 'shell 40', '25 at chipotle']);
  });

  it('does not split inside a single clause', () => {
    // "at" and "for" belong to one expense — splitting on them would sever the
    // amount from its vendor.
    expect(splitExpenseSegments('spent 40 at shell')).toEqual(['spent 40 at shell']);
  });
});

describe('looksLikeMultiExpense', () => {
  it('accepts a genuine list', () => {
    expect(looksLikeMultiExpense('walgreens 53.11 and shell 40', parseExpenseCommand)).toBe(true);
  });

  it('rejects a single expense', () => {
    expect(looksLikeMultiExpense('add walgreens 53.11', parseExpenseCommand)).toBe(false);
  });

  it('rejects chatter that happens to contain "and"', () => {
    expect(looksLikeMultiExpense('thanks and goodnight', parseExpenseCommand)).toBe(false);
  });
});

describe('classifyMulti — clean lists', () => {
  it('marks every complete item ready and asks nothing', () => {
    const { ready, questions } = classifyMulti(parse('walgreens 53.11 and shell 40'));
    expect(questions).toHaveLength(0);
    expect(ready.map(r => [r.vendor, r.amount])).toEqual([['walgreens', 53.11], ['shell', 40]]);
  });
});

describe('D1 — an item missing half the mandatory minimum', () => {
  it('holds only the incomplete item and still readies the others', () => {
    const { ready, questions } = classifyMulti(parse('walgreens 53.11 and shell, plus 25 at chipotle'));

    expect(ready.map(r => r.vendor)).toEqual(['walgreens', 'chipotle']);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ type: 'D1', missing: 'amount' });
    expect(questions[0].item.vendor).toBe('shell');
  });
});

describe('D2 — one amount, several vendors', () => {
  it('asks who the amount belongs to instead of guessing', () => {
    const { ready, questions } = classifyMulti(parse('walgreens and shell 93'));

    expect(ready).toHaveLength(0);          // both items are implicated
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ type: 'D2', amount: 93 });
    expect(questions[0].vendors).toEqual(['walgreens', 'shell']);
  });

  it('does not fire when the amount leads its own item', () => {
    // "walgreens 53.11 and shell" — the 53.11 is plainly Walgreens'. The only
    // open question is Shell's amount, which is an ordinary D1.
    const { ready, questions } = classifyMulti(parse('walgreens 53.11 and shell'));
    expect(ready.map(r => r.vendor)).toEqual(['walgreens']);
    expect(questions[0]).toMatchObject({ type: 'D1', missing: 'amount' });
  });

  it('covers the ambiguous-count case too', () => {
    // "coffee and lunch 25" — one $25 charge, or two?
    const { questions } = classifyMulti(parse('coffee and lunch 25'));
    expect(questions[0]).toMatchObject({ type: 'D2', amount: 25 });
  });
});

describe('D3 — a stated total that disagrees with the items', () => {
  it('spots the gap and holds the items', () => {
    const { ready, questions } = classifyMulti(parse('spent 100 on: walgreens 53, shell 40'));

    expect(ready).toHaveLength(0);
    expect(questions[0]).toMatchObject({ type: 'D3', statedTotal: 100, sum: 93, gap: 7 });
  });

  it('stays quiet when the items agree with the total', () => {
    const { ready, questions } = classifyMulti(parse('spent 93 on: walgreens 53, shell 40'));
    expect(questions).toHaveLength(0);
    expect(ready).toHaveLength(2);
  });

  it('does not read a leading amount as a total', () => {
    // "50 at costco and 20 at shell" — the 50 is the first item, not a grand total.
    expect(extractStatedTotal('50 at costco and 20 at shell', parseAmount)).toBeNull();
  });

  it('does not count the stated total as an item as well', () => {
    // "spent 100 on: walgreens 53, shell 40" — the 100 must be stripped before
    // segmenting, or the sum comes out as 140 and every total looks wrong.
    const parsed = parse('spent 100 on: walgreens 53, shell 40');
    expect(parsed.items.map(i => i.amount)).toEqual([53, 40]);
    expect(parsed.statedTotal).toBe(100);
  });
});

describe('D4 — the same purchase listed twice', () => {
  it('writes one and asks about the twin', () => {
    const { ready, questions } = classifyMulti(parse('shell 40 and shell 40'));

    expect(ready).toHaveLength(1);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ type: 'D4' });
  });

  it('leaves genuinely different amounts alone', () => {
    const { ready, questions } = classifyMulti(parse('shell 40 and shell 45'));
    expect(ready).toHaveLength(2);
    expect(questions).toHaveLength(0);
  });
});

describe('distributeGap', () => {
  it('spreads a shortfall in proportion and re-sums exactly', () => {
    const items = [{ vendor: 'a', amount: 53 }, { vendor: 'b', amount: 40 }];
    const out = distributeGap(items, 7);
    const total = out.reduce((s, i) => s + i.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(100);
    expect(out[0].amount).toBeGreaterThan(out[1].amount);   // bigger item absorbs more
  });
});

describe('bounds', () => {
  it('caps the batch and reports the overflow', () => {
    const text = Array.from({ length: 12 }, (_, i) => `store${i} ${i + 1}`).join(' and ');
    const parsed = parse(text);
    expect(parsed.items).toHaveLength(MAX_ITEMS);
    expect(parsed.overflow).toBeGreaterThan(0);
  });
});
