const QUEUE_KEY = 'budget_offline_queue';

function requestBackgroundSync() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  navigator.serviceWorker.ready
    .then(reg => reg.sync?.register('budget-sync-expenses'))
    .catch(() => {});
}

export function getQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch { return []; }
}

function saveQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

export function enqueue(item) {
  const q = getQueue();
  q.push({ ...item, id: crypto.randomUUID(), queuedAt: Date.now(), retries: 0 });
  saveQueue(q);
  requestBackgroundSync();
}

export function dequeue(id) {
  saveQueue(getQueue().filter(i => i.id !== id));
}

export function clearQueue() {
  localStorage.removeItem(QUEUE_KEY);
}

export function updateRetries(id, count) {
  saveQueue(getQueue().map(i => i.id === id ? { ...i, retries: count } : i));
}
