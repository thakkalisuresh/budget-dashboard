import { describe, it, expect } from 'vitest';
import {
  parseVersionPayload,
  isNewerBuild,
  fetchRemoteVersion,
  VERSION_URL,
} from '../versionCheck.js';
import { markBusy, getBusySnapshot, subscribeBusy, _resetBusy } from '../busyRegistry.js';

const ok = (body) => ({ ok: true, json: async () => body });

describe('parseVersionPayload', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseVersionPayload({ version: '1.4.0', commit: 'abc1234', buildTime: 'T' }))
      .toEqual({ version: '1.4.0', commit: 'abc1234', buildTime: 'T' });
  });

  it('trims the commit', () => {
    expect(parseVersionPayload({ commit: '  abc1234\n' }).commit).toBe('abc1234');
  });

  it('rejects anything without a usable commit', () => {
    // commit is the only field we compare on, so a payload without one is useless.
    for (const bad of [null, undefined, 'nope', 42, [], {}, { commit: '' }, { commit: '   ' }, { commit: 7 }]) {
      expect(parseVersionPayload(bad)).toBeNull();
    }
  });

  it('tolerates missing optional fields', () => {
    expect(parseVersionPayload({ commit: 'abc1234' }))
      .toEqual({ commit: 'abc1234', version: '', buildTime: '' });
  });
});

describe('isNewerBuild', () => {
  it('flags a different commit', () => {
    expect(isNewerBuild('abc1234', { commit: 'def5678' })).toBe(true);
  });

  it('does not flag the same commit', () => {
    expect(isNewerBuild('abc1234', { commit: 'abc1234' })).toBe(false);
  });

  it('never prompts on a dev build', () => {
    // __COMMIT_SHA__ is the literal 'dev' outside CI; the local bundle always
    // differs from what's deployed, and prompting would make `vite dev` unusable.
    expect(isNewerBuild('dev', { commit: 'def5678' })).toBe(false);
  });

  it('stays quiet when either side is missing', () => {
    expect(isNewerBuild('', { commit: 'def5678' })).toBe(false);
    expect(isNewerBuild('abc1234', null)).toBe(false);
    expect(isNewerBuild('abc1234', {})).toBe(false);
  });
});

describe('fetchRemoteVersion', () => {
  it('fetches the manifest with no-store', async () => {
    let seenUrl, seenInit;
    const spy = async (url, init) => { seenUrl = url; seenInit = init; return ok({ commit: 'def5678' }); };

    const result = await fetchRemoteVersion(spy);

    expect(result).toEqual({ commit: 'def5678', version: '', buildTime: '' });
    expect(seenUrl).toBe(VERSION_URL);
    // Without no-store the poll would read a cached manifest and report the old
    // commit forever — the header in firebase.json is only half the fix.
    expect(seenInit).toEqual({ cache: 'no-store' });
  });

  it('returns null on a non-ok response', async () => {
    expect(await fetchRemoteVersion(async () => ({ ok: false, status: 404 }))).toBeNull();
  });

  it('returns null instead of throwing when the network fails', async () => {
    // A flaky network must be indistinguishable from "no update" — a rejection
    // here would surface as an unhandled rejection on every poll.
    expect(await fetchRemoteVersion(async () => { throw new Error('offline'); })).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    expect(await fetchRemoteVersion(async () => ({
      ok: true, json: async () => { throw new SyntaxError('bad json'); },
    }))).toBeNull();
  });

  it('returns null when the manifest parses but has no commit', async () => {
    expect(await fetchRemoteVersion(async () => ok({ version: '1.4.0' }))).toBeNull();
  });
});

describe('busyRegistry', () => {
  it('reports busy while any claim is held', () => {
    _resetBusy();
    expect(getBusySnapshot()).toBe(false);
    const release = markBusy();
    expect(getBusySnapshot()).toBe(true);
    release();
    expect(getBusySnapshot()).toBe(false);
  });

  it('stays busy until the last of several claims is released', () => {
    // A receipt scan can be running underneath an open dialog; whichever
    // unmounts first must not clear the other's claim.
    _resetBusy();
    const a = markBusy();
    const b = markBusy();
    a();
    expect(getBusySnapshot()).toBe(true);
    b();
    expect(getBusySnapshot()).toBe(false);
  });

  it('ignores a double release', () => {
    // StrictMode double-invokes effects, so a release can fire twice; without
    // the guard the count would go negative and busy would latch off.
    _resetBusy();
    const a = markBusy();
    const b = markBusy();
    a();
    a();
    expect(getBusySnapshot()).toBe(true);
    b();
    expect(getBusySnapshot()).toBe(false);
  });

  it('notifies subscribers on change', () => {
    _resetBusy();
    let calls = 0;
    const unsub = subscribeBusy(() => { calls += 1; });
    const release = markBusy();
    expect(calls).toBe(1);
    release();
    expect(calls).toBe(2);
    unsub();
    markBusy();
    expect(calls).toBe(2);
  });
});
