/**
 * DepartmentNotificationsPage — in-app notification feed for department users.
 *
 * Shows notifications scoped to the logged-in department.
 * Supports mark-as-read and unread-only filtering.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getNotifications, markNotificationRead } from '../api/client';
import type { NotificationItem } from '../types/api';
import { Spinner } from '../components/Spinner';

export function DepartmentNotificationsPage() {
  const { departmentName } = useAuth();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getNotifications(unreadOnly);
      setNotifications(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  }, [unreadOnly]);

  useEffect(() => { load(); }, [load]);

  const handleMarkRead = async (id: number) => {
    try {
      await markNotificationRead(id);
      setNotifications(prev =>
        prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n)
      );
    } catch (err) {
      console.error('Failed to mark as read:', err);
    }
  };

  const unreadCount = notifications.filter(n => !n.read_at).length;

  const eventTypeIcons: Record<string, string> = {
    block_accepted: '✅',
    block_rejected: '❌',
    disruption_detected: '⚠️',
  };

  const eventTypeColors: Record<string, { bg: string; text: string; border: string }> = {
    block_accepted: { bg: 'bg-emerald-50', text: 'text-emerald-800', border: 'border-emerald-200' },
    block_rejected: { bg: 'bg-rose-50', text: 'text-rose-800', border: 'border-rose-200' },
    disruption_detected: { bg: 'bg-amber-50', text: 'text-amber-800', border: 'border-amber-200' },
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <span>🔔</span>
            <span>Department Notifications</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {departmentName ?? 'Department'} Portal • {unreadCount} unread notices
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setUnreadOnly(!unreadOnly)}
            className={`px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors border ${
              unreadOnly
                ? 'bg-blue-800 text-white border-blue-800 shadow-xs'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {unreadOnly ? '📬 Filter: Unread Only' : '📭 View All Notifications'}
          </button>
          <button
            onClick={load}
            className="btn-secondary text-xs"
          >
            <span>🔄</span>
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {loading && (
        <div className="text-center py-16 bg-white border border-slate-200 rounded-xl space-y-3">
          <Spinner size={24} />
          <p className="text-xs text-slate-500">Checking department notification feed…</p>
        </div>
      )}

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-xs font-medium text-rose-800 flex items-center gap-2">
          <span className="text-base leading-none">⚠</span>
          <span>{error}</span>
        </div>
      )}

      {!loading && notifications.length === 0 && (
        <div className="text-center py-16 bg-white border border-slate-200 rounded-xl space-y-2">
          <div className="text-4xl">🔔</div>
          <p className="text-base font-bold text-slate-800">No Notifications Found</p>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            Block approval and corridor disruption notices will appear here in real-time.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {notifications.map(n => {
          const typeStyle = eventTypeColors[n.event_type] ?? {
            bg: 'bg-slate-50', text: 'text-slate-800', border: 'border-slate-200',
          };
          const isUnread = !n.read_at;

          return (
            <div
              key={n.id}
              className={`
                bg-white border rounded-xl p-5 flex items-start gap-4 shadow-xs transition-all
                ${isUnread ? 'border-l-4 border-l-blue-800 border-slate-200 bg-blue-50/10' : 'border-slate-200/80 opacity-90'}
              `}
            >
              <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-xl flex-shrink-0 border border-slate-200/60">
                {eventTypeIcons[n.event_type] ?? '📌'}
              </div>

              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider border ${typeStyle.bg} ${typeStyle.text} ${typeStyle.border}`}>
                    {n.event_type.replace(/_/g, ' ')}
                  </span>
                  <span className="text-xs text-slate-400 font-mono">
                    {new Date(n.created_at).toLocaleString()}
                  </span>
                </div>

                <p className="text-sm text-slate-800 leading-relaxed font-normal whitespace-pre-wrap">
                  {n.message}
                </p>

                {isUnread && (
                  <div className="pt-1">
                    <button
                      onClick={() => handleMarkRead(n.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-md shadow-2xs transition-colors"
                    >
                      <span>✓</span>
                      <span>Mark as read</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
