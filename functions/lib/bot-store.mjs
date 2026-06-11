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
import { FieldPath } from 'firebase-admin/firestore';

const COLLECTION = 'bot_state';

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

    async list({ prefix = '' } = {}) {
      let q = col.orderBy(FieldPath.documentId());
      if (prefix) {
        q = q.startAt(prefix).endAt(prefix + PREFIX_END);
      }
      const snap = await q.get();
      return { blobs: snap.docs.map(d => ({ key: d.id })) };
    },
  };
}
