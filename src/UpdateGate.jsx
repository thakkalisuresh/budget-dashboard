// ════════════════════════════════════════════════════════════════════════════
// UpdateGate.jsx — tells the user a new version is out, and stops them using
// the stale one.
//
// Two presentations, chosen by whether there's unsaved work in flight:
//   • idle  → a blocking overlay. You update to continue.
//   • busy  → a non-blocking banner. Finish the expense you're typing or the
//             receipt you're uploading first; the gate escalates on its own once
//             the work is done. Forcing a reload mid-entry would destroy it.
// ════════════════════════════════════════════════════════════════════════════
import { RefreshCw, ArrowUpCircle } from 'lucide-react';
import { useAppUpdate } from './useAppUpdate.js';
import { useIsBusy } from './busyRegistry.js';

export function UpdateGate() {
  const { updateAvailable, updateNow, updating, currentVersion, nextVersion } = useAppUpdate();
  const busy = useIsBusy();

  if (!updateAvailable) return null;

  const versionLine = nextVersion && currentVersion && nextVersion !== currentVersion
    ? `v${currentVersion} → v${nextVersion}`
    : 'A newer version is available';

  // ── Busy: nag, don't block ──────────────────────────────────────────────────
  if (busy) {
    return (
      <div
        className="fixed left-1/2 -translate-x-1/2 z-[70] px-4 py-2.5 rounded-2xl flex items-center gap-2.5 shadow-lg animate-enter"
        style={{
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 5.5rem)',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-accent-border)',
        }}
        role="status"
      >
        <ArrowUpCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-accent-text)' }} />
        <span className="text-xs font-bold" style={{ color: 'var(--color-text)' }}>
          Update ready — finish up to continue
        </span>
      </div>
    );
  }

  // ── Idle: block ─────────────────────────────────────────────────────────────
  return (
    <>
      <div
        className="fixed inset-0 z-[70] animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 60%)', backdropFilter: 'blur(6px)' }}
      />
      <div className="fixed inset-0 z-[71] flex items-center justify-center p-6">
        <div
          className="glass-heavy animate-sheet-up rounded-3xl w-full max-w-sm overflow-hidden"
          style={{ border: '1px solid var(--sur-10)' }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="update-gate-title"
        >
          <div className="px-8 pt-8 pb-6 text-center">
            <div
              className="w-14 h-14 rounded-2xl mx-auto mb-5 flex items-center justify-center"
              style={{ background: 'var(--color-accent-subtle)' }}
            >
              <ArrowUpCircle className="w-7 h-7" style={{ color: 'var(--color-accent-text)' }} />
            </div>
            <p id="update-gate-title" className="text-lg font-black" style={{ color: 'var(--color-text)' }}>
              A new version of Fundient
            </p>
            <p className="text-xs mt-2 tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
              {versionLine}
            </p>
            <p className="text-xs mt-4" style={{ color: 'var(--color-text-muted)' }}>
              Update to keep going — this takes a second and you won&apos;t lose anything.
            </p>
          </div>
          <div className="px-8 pb-8">
            <button
              onClick={updateNow}
              disabled={updating}
              className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-2xl text-sm font-black text-white transition-all active:scale-95 disabled:opacity-60"
              style={{ background: 'var(--color-accent)' }}
            >
              <RefreshCw className={`w-4 h-4${updating ? ' animate-spin' : ''}`} />
              {updating ? 'Updating…' : 'Update now'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
