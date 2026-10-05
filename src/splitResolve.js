// ════════════════════════════════════════════════════════════════════════════
// splitResolve.js — decide a category for every line item on a split receipt.
//
// Layers, most trusted first:
//   1. learned  — what this user did with this exact item at this vendor last
//                 time. Beats the keyword tables deliberately: a remembered
//                 decision is evidence about THIS shopper, a keyword table is a
//                 guess about shoppers in general.
//   2. keyword  — itemCategorizer.js, unchanged.
//   3. llm      — one batched call for whatever is left (see itemCategorizeApi).
//
// Every item ends up in one flat list with the source that decided it, and
// every one stays editable on the review screen. That last part matters more
// than it looks: the old screen showed keyword-sorted items as a read-only
// "auto-sorted" summary, so when the keyword table was wrong the user had no
// way to say so — and a learning system that cannot observe its own mistakes
// never improves.
//
// Pure: no network, no React. The I/O lives in useReceiptScanner.
// ════════════════════════════════════════════════════════════════════════════

import { categorizeItem } from './itemCategorizer.js';
import { lookupLearned } from './itemMemory.js';

/**
 * MIRROR of CONFIDENCE_THRESHOLD in functions/lib/_categorize.mjs.
 * Above this an LLM answer pre-selects the dropdown; below it the item is left
 * blank so the user is asked instead of quietly guessed at.
 */
export const SPLIT_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Layers 1 and 2 — everything decidable without a network call.
 *
 * @returns [{ name, amount, category, source, suggestion, confidence }]
 *          `source` is 'learned' | 'keyword' | null (null = still unknown)
 */
export function resolveKnownItems(items = [], { memory, vendor } = {}) {
  const out = [];
  for (const item of items) {
    if (!item || typeof item.amount !== 'number') continue;
    const name = item.name;

    const learned = lookupLearned(memory, vendor, name);
    if (learned) {
      out.push({ name, amount: item.amount, category: learned, source: 'learned', suggestion: null, confidence: 1 });
      continue;
    }

    const keyword = categorizeItem(item);
    if (keyword) {
      out.push({ name, amount: item.amount, category: keyword, source: 'keyword', suggestion: null, confidence: 1 });
      continue;
    }

    // The extractor's own per-item hint stays what it has always been: a
    // non-binding pre-selection, never an auto-assignment.
    const hint = typeof item.item_category === 'string' && item.item_category ? item.item_category : null;
    out.push({ name, amount: item.amount, category: '', source: null, suggestion: hint, confidence: 0 });
  }
  return out;
}

/** Items still needing an answer after layers 1–2, with their positions. */
export function pendingItems(resolved = []) {
  return resolved
    .map((it, index) => ({ index, item: it }))
    .filter(({ item }) => !item.category);
}

/**
 * Layer 3 — fold batched LLM answers back into the list.
 *
 * @param results  aligned to `pending`, each { category, confidence } or null
 */
export function applyLlmSuggestions(resolved, pending, results, threshold = SPLIT_CONFIDENCE_THRESHOLD) {
  const next = [...resolved];
  pending.forEach(({ index }, i) => {
    const r = results?.[i];
    if (!r?.category) return;
    // The user may have answered this one while the call was in flight. Their
    // pick always wins — every entry in `pending` was blank when we asked.
    if (next[index]?.category) return;
    if (r.confidence >= threshold) {
      next[index] = { ...next[index], category: r.category, source: 'llm', confidence: r.confidence };
    } else {
      // Not confident enough to fill in — offer it, but keep the item blocking
      // the save so the user has to look.
      next[index] = { ...next[index], suggestion: r.category, source: 'llm-low', confidence: r.confidence };
    }
  });
  return next;
}

/**
 * Per-category totals for the live preview and the eventual sheet writes.
 * Unassigned items contribute nothing (the save is blocked until they aren't).
 */
export function groupItems(items = []) {
  const groups = {};
  for (const it of items) {
    if (!it.category) continue;
    groups[it.category] = Math.round(((groups[it.category] || 0) + it.amount) * 100) / 100;
  }
  return groups;
}

/**
 * Fold the tax/fees/discount remainder into the largest category so the split
 * sums to the receipt total. Unchanged behaviour, moved here so the whole
 * money calculation is testable in one place.
 */
export function foldRemainder(groups, total) {
  const cats = Object.keys(groups);
  if (cats.length === 0) return { groups, remainder: 0, remainderCategory: null };
  const sum = Math.round(cats.reduce((s, c) => s + groups[c], 0) * 100) / 100;
  const remainder = Math.round((total - sum) * 100) / 100;
  const folded = { ...groups };
  let remainderCategory = null;
  if (Math.abs(remainder) >= 0.01) {
    remainderCategory = cats.reduce((a, b) => (folded[b] > folded[a] ? b : a), cats[0]);
    folded[remainderCategory] = Math.round((folded[remainderCategory] + remainder) * 100) / 100;
  }
  return { groups: folded, remainder, remainderCategory };
}
