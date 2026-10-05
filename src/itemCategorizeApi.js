// ════════════════════════════════════════════════════════════════════════════
// itemCategorizeApi.js — browser client for /api/item-categorize.
//
// Thin on purpose: the batching, prompting and confidence rules all live server
// side (functions/item-categorize.mjs) where the Groq key is. This just asks,
// and guarantees the caller an array the same length as the items it sent —
// nulls where there is no usable answer — so the split screen never has to
// reason about a partial response.
// ════════════════════════════════════════════════════════════════════════════

const ITEM_CATEGORIZE_URL = '/api/item-categorize';

/** Give up rather than hold the review screen: the user can pick faster. */
const TIMEOUT_MS = 12000;

/**
 * @param items      [{ name }] — the leftovers memory and keywords couldn't place
 * @param examples   [{ name, category }] — this user's past filings at this vendor
 * @returns array of { category, confidence } | null, aligned to `items`
 */
export async function categorizeItemsWithLLM({ vendor, items, categories, examples = [], accessToken }) {
  const empty = items.map(() => null);
  if (!items.length || !categories.length || !accessToken) return empty;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ITEM_CATEGORIZE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendor, items: items.map(i => i.name), categories, examples }),
      signal: controller.signal,
    });
    if (!res.ok) return empty;
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    // Realign defensively — a short array here would silently shift every
    // suggestion onto the wrong item.
    return items.map((_, i) => {
      const r = results[i];
      return r && categories.includes(r.category)
        ? { category: r.category, confidence: Number(r.confidence) || 0 }
        : null;
    });
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
  }
}
