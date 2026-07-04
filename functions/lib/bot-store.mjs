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
 * (same as under Blobs), so no Firestore TTL is needed.
 */
import { FieldPath, Timestamp } from 'firebase-admin/firestore';

const COLLECTION = 'bot_state';

// R1 idempotency markers (`seen:<update_id>`) get an `expireAt` Firestore
// Timestamp so a native TTL policy auto-purges them; no other bot_state doc
// carries this field, so the policy only ever deletes seen markers. Telegram
// retries land within seconds–minutes, so an hour is a safe margin.
// One-time setup (see ENV.md):
//   gcloud firestore fields ttls update expireAt \
//     --collection-group=bot_state --enable-ttl
const SEEN_TTL_MS = 60 * 60 * 1000;

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

    async setJSON(key, value) {
      await col.doc(key).set({ v: value });
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
