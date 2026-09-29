// Minimal in-memory Firestore double for the bot store's transactions.
//
// runTransaction serializes callers through a queue, which is what Firestore's
// optimistic concurrency achieves (a conflicting transaction retries after the
// winner commits). With `interleave`, tx.get() yields before returning so that a
// NON-transactional read-then-write (a naive claim) would let two callers both
// see "missing" — the test that proves the atomicity claim depends on this.
export function createFakeDb() {
  const docs = new Map();
  const state = { failTransactions: false, transactions: 0 };
  let queue = Promise.resolve();

  const ref = (id) => ({
    id,
    async get() { await Promise.resolve(); return snap(id); },
    async set(value) { await Promise.resolve(); docs.set(id, structuredClone(value)); },
    async delete() { await Promise.resolve(); docs.delete(id); },
  });
  const snap = (id) => ({
    exists: docs.has(id),
    id,
    data: () => (docs.has(id) ? structuredClone(docs.get(id)) : undefined),
  });

  return {
    docs,
    state,
    collection: () => ({ doc: ref }),
    runTransaction(fn) {
      const run = async () => {
        if (state.failTransactions) throw new Error('firestore unavailable');
        state.transactions += 1;
        const writes = [];
        const tx = {
          async get(r) { await Promise.resolve(); return snap(r.id); },
          set(r, value) { writes.push(() => docs.set(r.id, structuredClone(value))); },
          delete(r) { writes.push(() => docs.delete(r.id)); },
        };
        const result = await fn(tx);
        writes.forEach((w) => w());
        return result;
      };
      const p = queue.then(run, run);
      queue = p.catch(() => {});
      return p;
    },
  };
}
