// Framework-free state machine behind useSettings, so the load/queue/save rules
// can be unit-tested without a DOM.
//
// Rules: nothing is persisted until the initial load has SUCCEEDED (otherwise the
// in-memory defaults would overwrite the stored row). Updates made earlier are
// queued and replayed, in order, on top of the loaded settings. Saves are
// serialized; while one is in flight only the latest payload is kept.

export function createSettingsController({
  defaults, load, save, onApply = () => {}, status = 'loading', persist = true,
}) {
  let state = { settings: defaults, status, loadError: null };
  let queue = [];            // updaters received before the load succeeded
  let loadInFlight = false;
  let saving = false;
  let pending = null;        // latest payload awaiting save (last write wins)
  const listeners = new Set();

  const set = (patch) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  const run = (updater, prev) => (typeof updater === 'function' ? updater(prev) : { ...prev, ...updater });

  async function flush() {
    if (saving) return;
    saving = true;
    try {
      while (pending) {
        const next = pending;
        pending = null;
        try { await save(next); } catch (e) { console.error('saveUserSettings:', e); }
      }
    } finally { saving = false; }
  }

  function persistNow(next) {
    if (!persist) return;
    pending = next;
    flush();
  }

  async function start() {
    if (state.status === 'ready' || loadInFlight) return;
    loadInFlight = true;
    set({ status: 'loading', loadError: null });
    try {
      const loaded = await load();
      const replay = queue;
      queue = [];
      const next = replay.reduce((acc, u) => run(u, acc), loaded);
      onApply(next);
      set({ settings: next, status: 'ready' });
      if (replay.length) persistNow(next);
    } catch (e) {
      set({ status: 'error', loadError: e }); // keep defaults in memory; never save
    } finally { loadInFlight = false; }
  }

  function update(updater) {
    const next = run(updater, state.settings);
    onApply(next);
    if (state.status === 'ready') {
      set({ settings: next });
      persistNow(next);
    } else {
      queue.push(updater);
      set({ settings: next }); // optimistic, in memory only
    }
  }

  return {
    start, update,
    retry: start,
    getState: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    idle: async () => { while (saving || loadInFlight) await new Promise(r => setTimeout(r, 0)); },
  };
}
