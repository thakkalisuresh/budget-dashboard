/**
 * Firestore-backed reimplementation of the Netlify Blobs store API that the bot
 * relies on. `_bot-core.mjs` and the webhook were written against Netlify Blobs
 * (`getStore('whatsapp-receipts')`); this adapter exposes the exact same surface
 * so that ported code runs unchanged:
 *
 *   get(key, { type: 'json' }) -> parsed object, or null if missing
 *   setJSON(key, value)        -> upsert
 *   delete(key)                -> remove (no-op if missing)
 *   list({ prefix })           -> { blobs: [{ key }] }  (doc-id prefix match)
 *
 * State lives in one collection (`bot_state`), document id = the blob key.
 * Bot keys use ':' / '_' / alphanumerics only (e.g. `confirm:<userId>:<uuid>`,
 * `rate:<userId>:<date>`) — all valid Firestore document ids, no '/'.
 *
 * The stored value is wrapped as `{ v: <value> }` so any JSON shape (including
 * primitives/arrays) round-trips cleanly through a Firestore document.
 *
 * Expiry is managed by the bot itself via timestamps inside the stored objects
 * (same as under Blobs). A native Firestore TTL on `expireAt` (below) is only
 * garbage collection for the few docs that carry that field; nothing depends on it.
 */
import { FieldPath, Timestamp } from 'firebase-admin/firestore';

const COLLECTION = 'bot_state';

// R1 idempotency markers (`seen:<update_id>`), the wallet duplicate-guard
// claims (`wdup:` / `wdup-log:`) and setJSON(..., { ttlMs }) blobs (`dup_skipped:`)
// get an `expireAt` Firestore Timestamp so a native TTL policy auto-purges them;
// no other bot_state doc carries this field, so the policy only ever deletes
// those. Telegram retries land within seconds–minutes, so an hour is a safe
// margin for `seen:`. One-time setup (see ENV.md):
//   gcloud firestore fields ttls update expireAt \
//     --collection-group=bot_state --enable-ttl
const SEEN_TTL_MS = 60 * 60 * 1000;
// Claim docs only need to outlive the 2-minute window; the window and takeover
// checks read `ts` in code, so this is cleanup, not correctness.
const CLAIM_TTL_MS = 10 * 60 * 1000;

// High private-use code point: an id that starts with `prefix` always sorts
// before `prefix + PREFIX_END`, so [prefix, prefix+PREFIX_END] is the exact
// prefix range. ( is the standard Firestore prefix-query sentinel.)
const PREFIX_END = String.fromCharCode(0xF8FF);

export function createBotStore(db) {
  const col = db.collection(COLLECTION);

  return {
    async get(key, opts = {}) {
      const snap = await col.doc(key).get();
      if (!snap.exists) return null;
      const data = snap.data();
      const value = data ? data.v : null;
      // The bot always reads with { type: 'json' }; value is already an object.
      // (opts kept for API compatibility with Netlify Blobs.)
      void opts;
      return value ?? null;
    },

    // ttlMs (optional) also stamps `expireAt` so the TTL policy can purge the doc.
    async setJSON(key, value, { ttlMs } = {}) {
      const doc = { v: value };
      if (ttlMs) doc.expireAt = Timestamp.fromMillis(Date.now() + ttlMs);
      await col.doc(key).set(doc);
    },

    async delete(key) {
      await col.doc(key).delete();
    },

    async list({ prefix = '', limit } = {}) {
      let q = col.orderBy(FieldPath.documentId());
      if (prefix) {
        q = q.startAt(prefix).endAt(prefix + PREFIX_END);
      }
      // R6: callers that only read blobs[0] pass limit:1 to avoid scanning the
      // whole prefix range.
      if (limit != null) q = q.limit(limit);
      const snap = await q.get();
      return { blobs: snap.docs.map(d => ({ key: d.id })) };
    },

    /**
     * R1 (idempotency): atomically claim a key exactly once. Returns true the
     * first time it's seen, false on any subsequent call — used to dedupe
     * Telegram webhook retries by `update_id`. The claim marker lives in the
     * same collection under a `seen:` prefix and carries an `expireAt` Timestamp
     * so a Firestore TTL policy purges it automatically (see SEEN_TTL_MS above).
     */
    async claimOnce(key) {
      const ref = col.doc(key);
      const expireAt = Timestamp.fromMillis(Date.now() + SEEN_TTL_MS);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) return false;
        tx.set(ref, { v: { ts: Date.now() }, expireAt });
        return true;
      });
    },

    /**
     * Windowed claim for the wallet duplicate guard: atomically take `key` unless
     * a claim is live. Live = settled ('done') within `windowMs` of the FIRST
     * claim, or still 'claimed' (in flight) within `takeoverMs`; a 'claimed' doc
     * older than that is an abandoned attempt (crash / function timeout) and is
     * taken over. A blocked call writes nothing, so it never extends the window.
     * Returns { claimed: true, token } or { claimed: false, vendor, ageMs }.
     */
    async claimWindow(key, { windowMs, takeoverMs, vendor = '' }) {
      const ref = col.doc(key);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const now = Date.now();
        const cur = snap.exists ? snap.data()?.v : null;
        if (cur) {
          const age = now - cur.ts;
          const live = cur.status === 'done' ? age < windowMs : age < takeoverMs;
          if (live) return { claimed: false, vendor: cur.vendor || '', ageMs: age };
        }
        const token = `${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
        tx.set(ref, {
          v: { ts: now, status: 'claimed', vendor, token },
          expireAt: Timestamp.fromMillis(now + CLAIM_TTL_MS),
        });
        return { claimed: true, token };
      });
    },

    /** Mark our claim settled (charge written or parked); stale tokens are ignored. */
    async settleClaim(key, token) {
      const ref = col.doc(key);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const doc = snap.exists ? snap.data() : null;
        if (!doc?.v || doc.v.token !== token) return;
        tx.set(ref, { ...doc, v: { ...doc.v, status: 'done' } });
      });
    },

    /** Drop our claim (the write failed) so a retry or second source can log. */
    async releaseClaim(key, token) {
      const ref = col.doc(key);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data()?.v?.token !== token) return;
        tx.delete(ref);
      });
    },

    /**
     * R4 (rate limiting): atomically increment a counter iff it is still below
     * `limit`, returning { allowed, count }. Replaces the old read-then-write
     * pair, closing the race where two quick messages both read N and both write
     * N+1.
     */
    async incrementIfBelow(key, limit) {
      const ref = col.doc(key);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const count = snap.exists ? (snap.data()?.v?.count || 0) : 0;
        if (count >= limit) return { allowed: false, count };
        tx.set(ref, { v: { count: count + 1 } });
        return { allowed: true, count: count + 1 };
      });
    },
  };
}
