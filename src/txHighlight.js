// ════════════════════════════════════════════════════════════════════════════
// txHighlight.js — find the transaction a ledger row is pointing at.
//
// Tapping a row in the Ledger opens that category's detail panel and scrolls to
// the charge you tapped. Matching is by UUID, which is exact — but rows written
// before UUIDs existed have none, so there's a vendor+amount fallback using the
// same tolerance buildLedger uses when it reconciles History against the sheet.
// ════════════════════════════════════════════════════════════════════════════

/** Same tolerance as buildLedger's History reconciliation. */
const AMOUNT_EPSILON = 0.05;

const norm = (s) => (s || '').trim().toLowerCase();

/**
 * Which vendor group owns this transaction?
 *
 * @param groups  [{ vendor, key, members: [{ description, uuids, amounts }] }]
 * @param target  { uuid, vendor, amount } — uuid preferred, the rest is fallback
 * @returns the owning group, or null
 */
export function findHighlightTarget(groups, target) {
  if (!Array.isArray(groups) || !target) return null;

  const { uuid, vendor, amount } = target;

  // Exact: the uuid is stored per-amount on the sheet row.
  if (uuid) {
    const byUuid = groups.find(g => g.members?.some(m => (m.uuids || []).includes(uuid)));
    if (byUuid) return byUuid;
    // A uuid that matches nothing here means the panel is showing a different
    // month or the row was deleted — fall through rather than guessing wrongly.
  }

  // Fallback for pre-UUID rows: vendor name plus an amount on that row.
  if (!vendor || typeof amount !== 'number' || Number.isNaN(amount)) return null;
  return groups.find(g =>
    norm(g.vendor) === norm(vendor) &&
    g.members?.some(m => (m.amounts || []).some(a => Math.abs(a - amount) < AMOUNT_EPSILON))
  ) || null;
}

/**
 * CSS selector for the card holding a given uuid. Cards carry every uuid on the
 * row in a space-separated `data-tx-uuid`, so `~=` matches any one of them.
 */
export function uuidSelector(uuid) {
  return `[data-tx-uuid~="${CSS.escape(uuid)}"]`;
}
