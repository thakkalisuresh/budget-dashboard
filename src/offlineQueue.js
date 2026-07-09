// ════════════════════════════════════════════════════════════════════════════
// offlineQueue.js — a "save it for later" queue for when the user is offline.
// If an expense can't reach the server right now (no connection), we stash it in
// localStorage and ask the browser to retry in the background once the network
// returns. This is what lets the app keep accepting entries on a flaky connection.
// ════════════════════════════════════════════════════════════════════════════

// localStorage key holding the queued items as a JSON array.
const QUEUE_KEY = 'budget_offline_queue';

// Ask the service worker to schedule a one-off "background sync". The browser
// runs it when connectivity comes back — even if this tab has since been closed.
// The `?.` and empty `.catch()` make it a harmless no-op where it's unsupported.
function requestBackgroundSync() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  navigator.serviceWorker.ready
    .then(reg => reg.sync?.register('budget-sync-expenses'))
    .catch(() => {});
}

// Read the current queue back as an array of pending items.
export function getQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch { return []; }    // corrupt data → treat the queue as empty
}

// Internal helper: write the whole queue back to localStorage as a string.
function saveQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

// Add one item to the queue, tagging it with a unique id, a timestamp, and a
// retry counter, then nudge the background sync to try sending it soon.
export function enqueue(item) {
  const q = getQueue();
  q.push({ ...item, id: crypto.randomUUID(), queuedAt: Date.now(), retries: 0 });
  saveQueue(q);
  requestBackgroundSync();
}

// Remove one item by id — e.g. once it has been delivered successfully.
export function dequeue(id) {
  saveQueue(getQueue().filter(i => i.id !== id));
}

// Empty the whole queue at once.
export function clearQueue() {
  localStorage.removeItem(QUEUE_KEY);
}

// Bump the retry count on a single item (used to back off, or give up after N tries).
export function updateRetries(id, count) {
  saveQueue(getQueue().map(i => i.id === id ? { ...i, retries: count } : i));
}
