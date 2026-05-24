import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = {};
const localStorageMock = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
vi.stubGlobal('localStorage', localStorageMock);

const { getQueue, enqueue, dequeue, clearQueue, updateRetries } = await import('../offlineQueue.js');

beforeEach(() => {
  Object.keys(store).forEach(k => delete store[k]);
});

describe('offlineQueue', () => {
  it('starts with an empty queue', () => {
    expect(getQueue()).toEqual([]);
  });

  it('enqueues an item with id, queuedAt, retries', () => {
    enqueue({ type: 'addRow', payload: { cat: 'Grocery' } });
    const q = getQueue();
    expect(q).toHaveLength(1);
    expect(q[0].type).toBe('addRow');
    expect(q[0].id).toBeTruthy();
    expect(q[0].queuedAt).toBeGreaterThan(0);
    expect(q[0].retries).toBe(0);
  });

  it('dequeues by id', () => {
    enqueue({ type: 'a' });
    enqueue({ type: 'b' });
    const q = getQueue();
    dequeue(q[0].id);
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].type).toBe('b');
  });

  it('clearQueue empties everything', () => {
    enqueue({ type: 'x' });
    enqueue({ type: 'y' });
    clearQueue();
    expect(getQueue()).toEqual([]);
  });

  it('updateRetries bumps the count for a specific item', () => {
    enqueue({ type: 'a' });
    const id = getQueue()[0].id;
    updateRetries(id, 3);
    expect(getQueue()[0].retries).toBe(3);
  });

  it('handles corrupted localStorage gracefully', () => {
    store['budget_offline_queue'] = 'not json';
    expect(getQueue()).toEqual([]);
  });
});
