import React from 'react';
import { X, Bell, Trash2, CheckCheck, TrendingDown, CalendarDays, Inbox } from 'lucide-react';

const TYPE_CONFIG = {
  over_budget: {
    icon:    TrendingDown,
    iconCls: 'text-rose-500',
    bgCls:   'bg-rose-50 dark:bg-rose-900/30',
  },
  digest: {
    icon:    CalendarDays,
    iconCls: 'text-indigo-500',
    bgCls:   'bg-indigo-50 dark:bg-indigo-900/30',
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
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />

      {/* Desktop: dropdown anchored to bell button
          Mobile: bottom sheet fixed to screen bottom */}
      <div className="
        sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:w-96 sm:rounded-2xl sm:max-h-[70vh] sm:bottom-auto sm:left-auto
        fixed bottom-0 left-0 right-0 rounded-t-[2rem] max-h-[80vh]
        bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-2xl overflow-hidden z-50 flex flex-col"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Mobile drag handle */}
        <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" />

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-700 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-slate-500 dark:text-slate-400" />
            <span className="text-sm font-black text-slate-700 dark:text-slate-200">Messages</span>
            {unreadCount > 0 && (
              <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-rose-500 text-white">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <button onClick={onMarkAllRead} title="Mark all as read"
                className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors">
                <CheckCheck className="w-3.5 h-3.5" />
              </button>
            )}
            {messages.length > 0 && (
              <button onClick={onClearAll} title="Clear all"
                className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition-colors">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Message list */}
        <div className="overflow-y-auto flex-1">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="w-10 h-10 bg-slate-100 dark:bg-slate-700 rounded-2xl flex items-center justify-center">
                <Inbox className="w-5 h-5 text-slate-400" />
              </div>
              <p className="text-xs font-bold text-slate-400">No messages yet</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50 dark:divide-slate-700/50">
              {messages.map(msg => {
                const cfg  = TYPE_CONFIG[msg.type] ?? TYPE_CONFIG.digest;
                const Icon = cfg.icon;
                return (
                  <div key={msg.id}
                    className={`flex gap-3 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-700/30 ${!msg.read ? 'bg-indigo-50/40 dark:bg-indigo-900/10' : ''}`}
                  >
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5 ${cfg.bgCls}`}>
                      <Icon className={`w-4 h-4 ${cfg.iconCls}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className={`text-xs font-black truncate ${!msg.read ? 'text-slate-800 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300'}`}>
                          {msg.title}
                          {!msg.read && <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500 ml-1.5 mb-0.5 flex-shrink-0" />}
                        </p>
                        <span className="text-[10px] text-slate-400 flex-shrink-0">{formatTimestamp(msg.timestamp)}</span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">{msg.body}</p>
                    </div>
                    <button onClick={() => onDismiss(msg.id)}
                      className="p-1 rounded-lg text-slate-300 dark:text-slate-600 hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition-colors flex-shrink-0 self-start mt-0.5">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
