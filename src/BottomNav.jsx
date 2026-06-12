import { LayoutDashboard, BookOpen, Plus, Clock, CreditCard } from 'lucide-react';

const NAV_ITEMS = [
  { id: 'budget',  Icon: LayoutDashboard, label: 'Home'    },
  { id: 'ledger',  Icon: BookOpen,        label: 'Ledger'  },
  { id: '_add',    Icon: null,            label: 'Add'     },
  { id: 'history', Icon: Clock,           label: 'History' },
  { id: 'cards',   Icon: CreditCard,      label: 'Cards'   },
];

// Notch: concave arc at top-center, radius 34px (button radius 28px + 6px clearance)
const NOTCH_MASK = 'radial-gradient(circle 34px at 50% 0, transparent 33px, black 34px)';

export function BottomNav({ activeTab, setActiveTab, onAdd, isReadOnly }) {
  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="Main navigation"
    >
      <div className="relative">
        {/* Glass bar */}
        <div
          className="glass-heavy h-16"
          style={{ borderTop: '1px solid var(--sur-10)', mask: NOTCH_MASK, WebkitMask: NOTCH_MASK }}
        >
          <div className="flex h-full">
            {NAV_ITEMS.map(({ id, Icon, label }) => {
              if (id === '_add') {
                return <div key="_add" className="flex-1" aria-hidden="true" />;
              }
              const isActive = activeTab === id;
              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className="flex-1 flex flex-col items-center justify-center gap-1 focus:outline-none focus-visible:outline-none"
                  aria-label={label}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <Icon
                    className="w-5 h-5 transition-colors duration-150"
                    style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
                    strokeWidth={isActive ? 2.5 : 2}
                  />
                  <span
                    className="text-[10px] font-semibold leading-none transition-colors duration-150"
                    style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
                  >
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Raised + FAB — center straddles bar top edge */}
        {!isReadOnly && (
          <button
            onClick={onAdd}
            className="absolute -top-7 left-1/2 -translate-x-1/2 w-14 h-14 rounded-full flex items-center justify-center transition-transform duration-100 active:scale-90"
            style={{
              background: 'var(--color-accent)',
              boxShadow: '0 4px 24px oklch(65% 0.18 var(--accent-hue) / 40%)',
            }}
            aria-label="Add expense"
          >
            <Plus className="w-7 h-7 text-white" strokeWidth={2.5} />
          </button>
        )}
      </div>
    </nav>
  );
}
