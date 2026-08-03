// ════════════════════════════════════════════════════════════════════════════
// VendorActionSheet.jsx — the ⋯ menu for a vendor inside the DetailPanel.
//
// The panel is capped at max-w-sm (384px) at every viewport, so six inline icon
// buttons left the vendor name with ~0px of width and collapsed the header.
// Those actions live here instead. Mirrors CategoryActionSheet.jsx.
//
// Purely presentational: DetailPanel owns the state and passes the handlers.
// ════════════════════════════════════════════════════════════════════════════
import React from 'react';
import { Repeat, CalendarX, Plus, FolderInput, Edit2, Trash2 } from 'lucide-react';

export function VendorActionSheet({
  target, onClose,
  onToggleRecurring, onToggleNonMonthly, onAdd, onMove, onRename, onDelete,
}) {
  if (!target) return null;

  const { vendor, count = 1, isRecurring = false, isNonMonthly = false } = target;

  // Every row is the same shape; `state` renders the on/off label that the icon
  // background used to carry when these were inline toggle buttons.
  const rows = [
    onToggleRecurring && {
      key: 'recurring', icon: Repeat, label: 'Repeat monthly',
      sub: isRecurring ? 'Imported into every new month' : 'Not imported into new months',
      state: isRecurring, run: onToggleRecurring,
    },
    {
      key: 'nonmonthly', icon: CalendarX, label: 'One-time expense',
      sub: isNonMonthly ? 'Excluded from monthly totals' : 'Counted as a monthly expense',
      state: isNonMonthly, run: onToggleNonMonthly,
    },
    onAdd && {
      key: 'add', icon: Plus, label: 'Add transaction',
      sub: `Another ${vendor} entry`, run: onAdd,
    },
    {
      key: 'move', icon: FolderInput, label: count > 1 ? 'Move all to category' : 'Move to category',
      sub: count > 1 ? `All ${count} transactions` : 'Pick a different category', run: onMove,
    },
    {
      key: 'rename', icon: Edit2, label: 'Rename vendor',
      sub: 'Change the display name', run: onRename,
    },
  ].filter(Boolean);

  const fire = (run) => { onClose(); run(); };

  return (
    <>
      <div
        className="fixed inset-0 z-[70] animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />
      <div className="fixed inset-0 z-[75] flex items-end justify-center">
        <div
          className="glass-heavy animate-sheet-up rounded-t-3xl w-full overflow-hidden"
          style={{ border: '1px solid var(--sur-10)', borderBottom: 'none' }}
        >
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-4" style={{ background: 'var(--sur-20)' }} />

          <div className="px-6 pb-3">
            <p className="text-base font-black truncate" style={{ color: 'var(--color-text)' }}>{vendor}</p>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {count > 1 ? `${count} transactions · choose an action` : 'Choose an action'}
            </p>
          </div>

          <div className="px-4 pb-4 space-y-2" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
            {rows.map(({ key, icon: Icon, label, sub, state, run }) => (
              <button
                key={key}
                onClick={() => fire(run)}
                className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-left active:scale-[0.98] transition-all"
                style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-8)' }}
              >
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: state ? 'var(--color-accent)' : 'var(--color-accent-subtle)' }}>
                  <Icon className="w-5 h-5" style={{ color: state ? 'white' : 'var(--color-accent-text)' }} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>{label}</p>
                  <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>{sub}</p>
                </div>
                {state !== undefined && (
                  <span className="text-[10px] font-black uppercase tracking-widest flex-shrink-0"
                    style={{ color: state ? 'var(--color-accent-text)' : 'var(--color-text-muted)' }}>
                    {state ? 'On' : 'Off'}
                  </span>
                )}
              </button>
            ))}

            <button
              onClick={() => fire(onDelete)}
              className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-left active:scale-[0.98] transition-all"
              style={{ background: 'oklch(62% 0.22 25 / 8%)', border: '1px solid oklch(62% 0.22 25 / 15%)' }}
            >
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'oklch(62% 0.22 25 / 15%)' }}>
                <Trash2 className="w-5 h-5" style={{ color: 'var(--color-danger)' }} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold" style={{ color: 'var(--color-danger)' }}>Delete vendor</p>
                <p className="text-xs" style={{ color: 'oklch(62% 0.22 25 / 60%)' }}>
                  {count > 1 ? `Removes all ${count} transactions` : 'Permanently remove'}
                </p>
              </div>
            </button>

            <button
              onClick={onClose}
              className="w-full py-4 rounded-2xl text-sm font-bold transition-colors mt-1"
              style={{ background: 'var(--sur-8)', color: 'var(--color-text-muted)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
