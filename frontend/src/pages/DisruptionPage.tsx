/**
 * DisruptionPage — Disruption monitoring & re-optimisation dashboard.
 *
 * Allows the section controller to:
 * 1. Report a new disruption event (delay + affected chainage)
 * 2. View all past disruption events with re-optimisation status
 */

import { useState, useEffect } from 'react';
import { postDisruption, getDisruptions } from '../api/client';
import type { DisruptionEventResponse, DisruptionResponse } from '../types/api';
import { Spinner } from '../components/Spinner';

export function DisruptionPage() {
  const [events, setEvents] = useState<DisruptionEventResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<DisruptionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [delayMinutes, setDelayMinutes] = useState('');
  const [affectedChainage, setAffectedChainage] = useState('');

  const loadEvents = async () => {
    try {
      const data = await getDisruptions();
      setEvents(data);
    } catch (err) {
      console.error('Failed to load disruptions:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadEvents(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    setError(null);

    try {
      const res = await postDisruption({
        delay_minutes: parseFloat(delayMinutes),
        affected_chainage_km: parseFloat(affectedChainage),
      });
      setResult(res);
      setDelayMinutes('');
      setAffectedChainage('');
      loadEvents();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to report disruption');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Report Form Card */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
        <div className="border-b border-slate-100 pb-3">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <span>🚨</span>
            <span>Report Real-Time Corridor Disruption</span>
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Stage 9 — Delays exceeding 15 minutes trigger rolling-horizon re-optimisation of non-executed blocks.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[160px]">
            <label className="form-label" htmlFor="dis-delay-input">
              Delay (minutes)
            </label>
            <input
              id="dis-delay-input"
              type="number"
              step="0.1"
              min="0"
              value={delayMinutes}
              onChange={e => setDelayMinutes(e.target.value)}
              required
              placeholder="e.g. 25"
              className="input-field"
            />
          </div>

          <div className="flex-1 min-w-[160px]">
            <label className="form-label" htmlFor="dis-chainage-input">
              Affected Chainage (km)
            </label>
            <input
              id="dis-chainage-input"
              type="number"
              step="0.01"
              min="0"
              max="19.9"
              value={affectedChainage}
              onChange={e => setAffectedChainage(e.target.value)}
              required
              placeholder="e.g. 12.50"
              className="input-field"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 bg-rose-600 hover:bg-rose-700 text-white font-semibold text-sm px-5 py-2.5 rounded-lg shadow-sm disabled:opacity-50 transition-colors"
          >
            {submitting && <Spinner size={14} />}
            <span>{submitting ? 'Reporting…' : 'Report Disruption'}</span>
          </button>
        </form>
      </div>

      {/* Result Notice */}
      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-xs font-medium text-rose-800 flex items-center gap-2">
          <span className="text-base leading-none">⚠</span>
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className={`
          border rounded-xl p-5 space-y-1.5 shadow-xs
          ${result.triggered_reoptimization
            ? 'bg-amber-50 border-amber-200 text-amber-900'
            : 'bg-emerald-50 border-emerald-200 text-emerald-900'
          }
        `}>
          <div className="text-sm font-bold flex items-center gap-2">
            <span>{result.triggered_reoptimization ? '⚡' : '✓'}</span>
            <span>
              {result.triggered_reoptimization
                ? 'Automatic Rolling-Horizon Re-optimisation Triggered'
                : 'Disruption Logged (Below 15-minute threshold — schedule maintained)'}
            </span>
          </div>
          <div className="text-xs opacity-90 font-mono">
            Event #{result.id} • Delay: {result.delay_minutes} min • Affected Chainage: {result.affected_chainage_km} km
            {result.reoptimization_result && ` • Tasks Rescheduled: ${result.reoptimization_result.tasks_scheduled}`}
          </div>
        </div>
      )}

      {/* Disruption History Table */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <h3 className="text-base font-bold text-slate-900">
            Disruption Log History ({events.length})
          </h3>
          <button
            onClick={loadEvents}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-medium transition-colors"
          >
            <span>🔄</span>
            <span>Refresh</span>
          </button>
        </div>

        {loading ? (
          <div className="text-center py-10 text-slate-400">
            <Spinner size={20} />
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-12 bg-slate-50 border border-slate-200/80 rounded-xl space-y-2">
            <div className="text-3xl">🛡️</div>
            <p className="text-sm font-semibold text-slate-800">No Disruption Events Recorded</p>
            <p className="text-xs text-slate-500">The corridor is currently operating under normal timetable conditions.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-xs">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50 text-xs font-semibold text-slate-600 uppercase tracking-wide text-left">
                  <th className="px-4 py-3 border-b border-slate-200 mono w-16">ID</th>
                  <th className="px-4 py-3 border-b border-slate-200">Reported Delay</th>
                  <th className="px-4 py-3 border-b border-slate-200">Affected Location</th>
                  <th className="px-4 py-3 border-b border-slate-200">Re-optimised?</th>
                  <th className="px-4 py-3 border-b border-slate-200 text-right">Logged Time</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev, i) => (
                  <tr key={ev.id} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                    <td className="px-4 py-3 border-b border-slate-100 mono text-slate-500 font-medium">#{ev.id}</td>
                    <td className="px-4 py-3 border-b border-slate-100 font-mono font-semibold">
                      <span className={ev.delay_minutes > 15 ? 'text-rose-600 font-bold' : 'text-slate-700'}>
                        {ev.delay_minutes.toFixed(1)} min
                      </span>
                    </td>
                    <td className="px-4 py-3 border-b border-slate-100 font-mono text-slate-600">
                      {ev.affected_chainage_km.toFixed(2)} km
                    </td>
                    <td className="px-4 py-3 border-b border-slate-100">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                        ev.triggered_reoptimization
                          ? 'bg-amber-50 text-amber-800 border border-amber-200'
                          : 'bg-slate-100 text-slate-600 border border-slate-200'
                      }`}>
                        {ev.triggered_reoptimization ? '⚡ Yes' : 'No'}
                      </span>
                    </td>
                    <td className="px-4 py-3 border-b border-slate-100 text-right text-xs text-slate-500">
                      {new Date(ev.received_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
