import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withErrorContext, trail, setActor, currentErrorContext, describeActor, MAX_TRAIL,
} from '../../functions/lib/_error-context.mjs';

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('request-scoped error context', () => {
  it('collects channel, actor and the steps taken', async () => {
    const seen = await withErrorContext({ channel: 'bot' }, async () => {
      setActor('me@example.com');
      trail('sent a photo');
      trail('extracted 5 tx');
      trail('tapped YES');
      return currentErrorContext();
    });
    expect(seen).toEqual({
      channel: 'bot',
      actor: 'me@example.com',
      trail: 'sent a photo → extracted 5 tx → tapped YES',
    });
  });

  it('is empty outside a context, so library code stays callable anywhere', () => {
    expect(currentErrorContext()).toEqual({});
    expect(() => trail('orphan step')).not.toThrow();
    expect(() => setActor('nobody')).not.toThrow();
  });

  it('does NOT leak between concurrent requests', async () => {
    // The reason this uses AsyncLocalStorage rather than a module-level buffer:
    // Cloud Functions reuse instances, so two overlapping requests on one
    // instance would otherwise blend their trails — quietly, and only under
    // load, which is the worst way to discover it.
    const [a, b] = await Promise.all([
      withErrorContext({ channel: 'bot' }, async () => {
        setActor('alice@example.com');
        trail('alice step 1');
        await new Promise(r => setTimeout(r, 10));   // yield to the other request
        trail('alice step 2');
        return currentErrorContext();
      }),
      withErrorContext({ channel: 'wallet' }, async () => {
        setActor('bob@example.com');
        trail('bob step 1');
        await new Promise(r => setTimeout(r, 5));
        trail('bob step 2');
        return currentErrorContext();
      }),
    ]);
    expect(a.actor).toBe('alice@example.com');
    expect(a.trail).toBe('alice step 1 → alice step 2');
    expect(b.actor).toBe('bob@example.com');
    expect(b.trail).toBe('bob step 1 → bob step 2');
  });

  it('keeps only the most recent steps', async () => {
    const out = await withErrorContext({}, async () => {
      for (let i = 1; i <= MAX_TRAIL + 4; i++) trail(`step ${i}`);
      return currentErrorContext();
    });
    const steps = out.trail.split(' → ');
    expect(steps).toHaveLength(MAX_TRAIL);
    // The last few explain the failure; the first forty do not.
    expect(steps.at(-1)).toBe(`step ${MAX_TRAIL + 4}`);
    expect(steps[0]).toBe('step 5');
  });

  it('ignores empty steps and truncates very long ones', async () => {
    const out = await withErrorContext({}, async () => {
      trail('');
      trail(null);
      trail('x'.repeat(200));
      return currentErrorContext();
    });
    expect(out.trail.split(' → ')).toHaveLength(1);
    expect(out.trail.length).toBeLessThanOrEqual(60);
  });

  it('omits fields that were never set', async () => {
    const out = await withErrorContext({ channel: 'scheduled' }, async () => currentErrorContext());
    expect(out).toEqual({ channel: 'scheduled' });
    expect(out).not.toHaveProperty('actor');
    expect(out).not.toHaveProperty('trail');
  });
});

describe('describeActor', () => {
  it('maps a Telegram chat id back to its email', () => {
    // Two people in the household — "which of us" is the useful part, and a
    // bare numeric chat id does not say.
    vi.stubEnv('TELEGRAM_EMAIL_MAP', 'me@example.com:111,wife@example.com:222');
    expect(describeActor('222')).toBe('wife@example.com');
    expect(describeActor(111)).toBe('me@example.com');
  });

  it('falls back to the raw id when unmapped', () => {
    vi.stubEnv('TELEGRAM_EMAIL_MAP', 'me@example.com:111');
    expect(describeActor('999')).toBe('999');
  });

  it('survives a missing or malformed map', () => {
    vi.stubEnv('TELEGRAM_EMAIL_MAP', '');
    expect(describeActor('111')).toBe('111');
    expect(describeActor(undefined)).toBe('');
  });
});
