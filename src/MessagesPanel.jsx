import React from 'react';
import { X, Bell, Trash2, CheckCheck, TrendingDown, CalendarDays, Inbox } from 'lucide-react';

const TYPE_CONFIG = {
  over_budget: {
    icon:    TrendingDown,
    iconStyle: { color: 'var(--color-danger)' },
    bgStyle:   { background: 'oklch(62% 0.22 25 / 12%)' },
  },
  digest: {
    icon:    CalendarDays,
    iconStyle: { color: 'var(--color-accent-text)' },
    bgStyle:   { background: 'var(--color-accent-subtle)' },
  },
};

function formatTimestamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffH  = Math.floor(diffMs / 3_600_000);
    const diffD  = Math.floor(diffMs / 86_400_000);
    if (diffH < 1)  return 'Just now';
    if (diffH < 24) return `${diffH}h ago`;
    if (diffD < 7)  return `${diffD}d ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

export function MessagesPanel({ messages, unreadCount, onMarkAllRead, onDismiss, onClearAll, onClose }) {
  return (
    <div
      className="glass-heavy overflow-hidden flex flex-col rounded-t-[2rem] sm:rounded-2xl max-h-[80vh] sm:max-h-[70vh]"
      style={{ border: '1px solid oklch(100% 0 0 / 10%)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Mobile drag handle */}
      <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" style={{ background: 'oklch(100% 0 0 / 20%)' }} />

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid oklch(100% 0 0 / 8%)' }}>
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          <span className="text-sm font-black" style={{ color: 'var(--color-text)' }}>Messages</span>
          {unreadCount > 0 && (
            <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full text-white" style={{ background: 'var(--color-danger)' }}>
              {unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <button
              onClick={onMarkAllRead}
              title="Mark all as read"
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <CheckCheck className="w-3.5 h-3.5" />
            </button>
          )}
          {messages.length > 0 && (
            <button
              onClick={onClearAll}
              title="Clear all"
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Message list */}
      <div className="overflow-y-auto flex-1">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'oklch(100% 0 0 / 6%)' }}>
              <Inbox className="w-5 h-5" style={{ color: 'var(--color-text-muted)' }} />
            </div>
            <p className="text-xs font-bold" style={{ color: 'var(--color-text-muted)' }}>No messages yet</p>
          </div>
        ) : (
          <div>
            {messages.map((msg, idx) => {
              const cfg  = TYPE_CONFIG[msg.type] ?? TYPE_CONFIG.digest;
              const Icon = cfg.icon;
              return (
                <div
                  key={msg.id}
                  className="flex gap-3 px-4 py-3 transition-colors"
                  style={{
                    borderTop: idx > 0 ? '1px solid oklch(100% 0 0 / 6%)' : undefined,
                    background: !msg.read ? 'var(--color-accent-subtle)' : undefined,
                  }}
                >
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5" style={cfg.bgStyle}>
                    <Icon className="w-4 h-4" style={cfg.iconStyle} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-black truncate" style={{ color: !msg.read ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>
                        {msg.title}
                        {!msg.read && (
                          <span
                            className="inline-block w-1.5 h-1.5 rounded-full ml-1.5 mb-0.5 flex-shrink-0"
                            style={{ background: 'var(--color-accent)', verticalAlign: 'middle' }}
                          />
                        )}
                      </p>
                      <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{formatTimestamp(msg.timestamp)}</span>
                    </div>
                    <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>{msg.body}</p>
                  </div>
                  <button
                    onClick={() => onDismiss(msg.id)}
                    className="p-1 rounded-lg transition-colors flex-shrink-0 self-start mt-0.5"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
