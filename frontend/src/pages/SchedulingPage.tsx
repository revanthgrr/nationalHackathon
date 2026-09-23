/**
 * SchedulingPage.tsx — RailSetu Stages 4–9 UI
 *
 * Sections:
 *  1. Train Runs panel (add/list) + Analyse Timetable button
 *  2. Maintenance Tasks panel (add/list with status filter)
 *  3. Optimise Schedule + Bundle Blocks action buttons
 *  4. Gantt timeline (CSS-positioned blocks on chainage × time axis)
 *  5. Pending blocks list with Accept / Reject controls
 *  6. Disruption Monitoring panel
 */

import { useCallback, useEffect, useState } from 'react';
import { InlineAlert } from '../components/InlineAlert';
import {
  getDisruptions,
  getMaintenanceTasks,
  getPendingBlocks,
  getScheduledBlocks,
  getTrainRuns,
  postBlockDecision,
  postDisruption,
  postMaintenanceTask,
  postScheduleBundle,
  postScheduleOptimize,
  postTimetableAnalyze,
  postTrainRun,
  resetScheduleData,
  autoGenerateTasks,
} from '../api/client';
import type {
  DisruptionEventResponse,
  EnrichedBlockResponse,
  MaintenanceTaskResponse,
  ScheduledBlockResponse,
  TrainRunResponse,
} from '../types/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DEPT_COLORS: Record<string, { parent: string; child: string }> = {
  Civil:       { parent: 'bg-blue-500',   child: 'bg-blue-300' },
  Signalling:  { parent: 'bg-amber-500',  child: 'bg-amber-300' },
  Electrical:  { parent: 'bg-purple-500', child: 'bg-purple-300' },
};

/** Corridor stations bottom-to-top (SC at bottom) for Gantt Y axis */
const STATIONS = [
  { code: 'SC',   chainage: 0.00 },
  { code: 'MJF',  chainage: 3.40 },
  { code: 'AWL',  chainage: 9.80 },
  { code: 'GHKT', chainage: 16.35 },
  { code: 'BBN',  chainage: 19.90 },
];

const GANTT_WIDTH  = 960;   // px — 24 hours
const GANTT_HEIGHT = 400;   // px — 0 to 19.9 km
const MAX_CHAINAGE = 19.9;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function blockLeft(startIso: string): number {
  return (minutesOfDay(startIso) / 1440) * GANTT_WIDTH;
}

function blockWidth(startIso: string, endIso: string): number {
  const dur = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000;
  return Math.max(4, (dur / 1440) * GANTT_WIDTH);
}

function blockTop(chainageKm: number): number {
  return ((MAX_CHAINAGE - chainageKm) / MAX_CHAINAGE) * GANTT_HEIGHT;
}

function fmtTime(iso: string): string {
  return new Date(iso).toUTCString().slice(17, 22);
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    pending:   'bg-gray-100 text-gray-600',
    scheduled: 'bg-blue-100 text-blue-700',
    bundled:   'bg-amber-100 text-amber-700',
    executed:  'bg-green-100 text-green-700',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls[status] ?? 'bg-gray-100 text-gray-500'}`}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SchedulingPage() {
  // ── Train Runs ──────────────────────────────────────────────────────────
  const [trainRuns, setTrainRuns] = useState<TrainRunResponse[]>([]);
  const [trRoute,    setTrRoute]    = useState('');
  const [trTime,     setTrTime]     = useState('06:00:00');
  const [trDay,      setTrDay]      = useState(0);
  const [trDaily,    setTrDaily]    = useState(false);
  const [trLoading,  setTrLoading]  = useState(false);
  const [trError,    setTrError]    = useState<string | null>(null);

  // ── Timetable analyze ────────────────────────────────────────────────────
  const [analyzeResult, setAnalyzeResult] = useState<string | null>(null);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [analyzeError,   setAnalyzeError]   = useState<string | null>(null);

  // ── Maintenance Tasks ────────────────────────────────────────────────────
  const [tasks,        setTasks]       = useState<MaintenanceTaskResponse[]>([]);
  const [taskFilter,   setTaskFilter]  = useState('');
  const [tkChainage,   setTkChainage]  = useState('');
  const [tkDept,       setTkDept]      = useState<'Civil' | 'Signalling' | 'Electrical'>('Civil');
  const [tkDuration,   setTkDuration]  = useState('');
  const [tkPriority,   setTkPriority]  = useState('');
  const [tkLoading,    setTkLoading]   = useState(false);
  const [tkError,      setTkError]     = useState<string | null>(null);

  // ── Auto-generate from telemetry ─────────────────────────────────────────
  const [autoGenLoading, setAutoGenLoading] = useState(false);
  const [autoGenSuccess, setAutoGenSuccess] = useState<string | null>(null);
  const [autoGenError,   setAutoGenError]   = useState<string | null>(null);

  // ── Schedule Optimize ────────────────────────────────────────────────────
  const [optResult,  setOptResult]  = useState<string | null>(null);
  const [optLoading, setOptLoading] = useState(false);
  const [optError,   setOptError]   = useState<string | null>(null);

  // ── Bundle ───────────────────────────────────────────────────────────────
  const [bndResult,  setBndResult]  = useState<string | null>(null);
  const [bndLoading, setBndLoading] = useState(false);
  const [bndError,   setBndError]   = useState<string | null>(null);

  // ── Reset Schedule state ──────────────────────────────────────────────────
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting,    setResetting]    = useState(false);
  const [resetSuccess, setResetSuccess] = useState<string | null>(null);

  // ── Gantt blocks ─────────────────────────────────────────────────────────
  const [blocks, setBlocks] = useState<ScheduledBlockResponse[]>([]);

  // ── Pending blocks / decisions ───────────────────────────────────────────
  const [pending,        setPending]        = useState<EnrichedBlockResponse[]>([]);
  const [rejectInput,    setRejectInput]    = useState<Record<number, string>>({});
  const [rejectShown,    setRejectShown]    = useState<Record<number, boolean>>({});
  const [decisionLoading, setDecisionLoading] = useState<Record<number, boolean>>({});
  const [decisionError,   setDecisionError]   = useState<Record<number, string>>({});

  // ── Disruption ───────────────────────────────────────────────────────────
  const [disDelay,    setDisDelay]    = useState('');
  const [disChainage, setDisChainage] = useState('');
  const [disResult,   setDisResult]   = useState<string | null>(null);
  const [disLoading,  setDisLoading]  = useState(false);
  const [disError,    setDisError]    = useState<string | null>(null);
  const [disHistory,  setDisHistory]  = useState<DisruptionEventResponse[]>([]);
  const [showDisHistory, setShowDisHistory] = useState(false);

  // ── Load data ────────────────────────────────────────────────────────────
  const loadTrainRuns = useCallback(async () => {
    try { setTrainRuns(await getTrainRuns()); } catch { /* ignore */ }
  }, []);

  const loadTasks = useCallback(async () => {
    try { setTasks(await getMaintenanceTasks(taskFilter || undefined)); } catch { /* ignore */ }
  }, [taskFilter]);

  const loadBlocks = useCallback(async () => {
    try { setBlocks(await getScheduledBlocks()); } catch { /* ignore */ }
  }, []);

  const loadPending = useCallback(async () => {
    try { setPending(await getPendingBlocks()); } catch { /* ignore */ }
  }, []);

  const loadDisHistory = useCallback(async () => {
    try { setDisHistory(await getDisruptions()); } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadTrainRuns(); }, [loadTrainRuns]);
  useEffect(() => { loadTasks(); }, [loadTasks]);
  useEffect(() => { loadBlocks(); loadPending(); }, [loadBlocks, loadPending]);

  // ── Handlers ─────────────────────────────────────────────────────────────
  async function handleAddTrainRun(e: React.FormEvent) {
    e.preventDefault();
    setTrError(null); setTrLoading(true);
    try {
      await postTrainRun({ route: trRoute, scheduled_time: trTime, day_of_week: trDay, is_daily: trDaily });
      setTrRoute(''); setTrTime('06:00:00'); setTrDay(0); setTrDaily(false);
      await loadTrainRuns();
    } catch (err: unknown) {
      setTrError(err instanceof Error ? err.message : 'Failed to add train run');
    } finally { setTrLoading(false); }
  }

  async function handleAnalyze() {
    setAnalyzeError(null); setAnalyzeResult(null); setAnalyzeLoading(true);
    try {
      const res = await postTimetableAnalyze();
      setAnalyzeResult(`Clusters: ${res.clusters_found} · Windows saved: ${res.windows_saved} · Slots: ${res.virtual_slots.join(', ')}`);
    } catch (err: unknown) {
      setAnalyzeError(err instanceof Error ? err.message : 'Analysis failed');
    } finally { setAnalyzeLoading(false); }
  }

  async function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    setTkError(null); setTkLoading(true);
    try {
      await postMaintenanceTask({
        chainage_km: parseFloat(tkChainage),
        department: tkDept,
        estimated_duration_minutes: parseInt(tkDuration, 10),
        priority_weight: tkPriority ? parseFloat(tkPriority) : null,
      });
      setTkChainage(''); setTkDuration(''); setTkPriority('');
      await loadTasks();
    } catch (err: unknown) {
      setTkError(err instanceof Error ? err.message : 'Failed to create task');
    } finally { setTkLoading(false); }
  }

  async function handleAutoGenerateTasks() {
    setAutoGenLoading(true);
    setAutoGenSuccess(null);
    setAutoGenError(null);
    try {
      const res = await autoGenerateTasks(0.65);
      if (res.length > 0) {
        setAutoGenSuccess(`Generated ${res.length} maintenance demands from high-risk telemetry!`);
      } else {
        setAutoGenSuccess('High-risk telemetry sections already have active maintenance tasks queued.');
      }
      await loadTasks();
    } catch (err: unknown) {
      setAutoGenError(err instanceof Error ? err.message : 'Auto-generation failed');
    } finally {
      setAutoGenLoading(false);
    }
  }

  async function handleOptimize() {
    setOptError(null); setOptResult(null); setOptLoading(true);
    try {
      const res = await postScheduleOptimize();
      setOptResult(`Scheduled: ${res.tasks_scheduled} tasks · Blocks created: ${res.blocks_created}`);
      await loadBlocks(); await loadPending(); await loadTasks();
    } catch (err: unknown) {
      setOptError(err instanceof Error ? err.message : 'Optimisation failed');
    } finally { setOptLoading(false); }
  }

  async function handleBundle() {
    setBndError(null); setBndResult(null); setBndLoading(true);
    try {
      const res = await postScheduleBundle();
      setBndResult(`Bundles: ${res.bundles_created} · Blocks bundled: ${res.blocks_bundled}`);
      await loadBlocks(); await loadPending();
    } catch (err: unknown) {
      setBndError(err instanceof Error ? err.message : 'Bundling failed');
    } finally { setBndLoading(false); }
  }

  async function handleResetSchedule() {
    setResetting(true);
    setResetSuccess(null);
    setOptError(null);
    setOptResult(null);
    setBndResult(null);
    try {
      const res = await resetScheduleData();
      const d = res.deleted;
      setResetSuccess(`Cleared ${d.scheduled_blocks} scheduled blocks and ${d.maintenance_tasks} maintenance tasks.`);
      await Promise.all([loadBlocks(), loadPending(), loadTasks()]);
      if (showDisHistory) await loadDisHistory();
    } catch (err: unknown) {
      setOptError(err instanceof Error ? err.message : 'Failed to reset schedule');
    } finally {
      setResetting(false);
      setResetConfirm(false);
    }
  }

  async function handleAccept(blockId: number) {
    setDecisionLoading(p => ({ ...p, [blockId]: true }));
    setDecisionError(p => ({ ...p, [blockId]: '' }));
    try {
      await postBlockDecision(blockId, { decision: 'accept' });
      await loadPending(); await loadBlocks();
    } catch (err: unknown) {
      setDecisionError(p => ({ ...p, [blockId]: err instanceof Error ? err.message : 'Failed' }));
    } finally {
      setDecisionLoading(p => ({ ...p, [blockId]: false }));
    }
  }

  async function handleReject(blockId: number) {
    const reason = rejectInput[blockId] ?? '';
    if (!reason.trim()) {
      setDecisionError(p => ({ ...p, [blockId]: 'Rejection reason is required.' }));
      return;
    }
    setDecisionLoading(p => ({ ...p, [blockId]: true }));
    setDecisionError(p => ({ ...p, [blockId]: '' }));
    try {
      await postBlockDecision(blockId, { decision: 'reject', reason });
      setRejectInput(p => ({ ...p, [blockId]: '' }));
      setRejectShown(p => ({ ...p, [blockId]: false }));
      await loadPending(); await loadBlocks();
    } catch (err: unknown) {
      setDecisionError(p => ({ ...p, [blockId]: err instanceof Error ? err.message : 'Failed' }));
    } finally {
      setDecisionLoading(p => ({ ...p, [blockId]: false }));
    }
  }

  async function handleDisruption(e: React.FormEvent) {
    e.preventDefault();
    setDisError(null); setDisResult(null); setDisLoading(true);
    try {
      const res = await postDisruption({
        delay_minutes: parseFloat(disDelay),
        affected_chainage_km: parseFloat(disChainage),
      });
      setDisResult(
        res.reoptimized
          ? `Re-optimisation triggered! Blocks rescheduled: ${res.reoptimization_result?.blocks_created ?? '—'}`
          : `Below threshold — no re-optimisation (${res.reason ?? ''})`,
      );
      setDisDelay(''); setDisChainage('');
      if (showDisHistory) await loadDisHistory();
    } catch (err: unknown) {
      setDisError(err instanceof Error ? err.message : 'Failed to report disruption');
    } finally { setDisLoading(false); }
  }

  // ── Parent set for Gantt colouring ───────────────────────────────────────
  const parentIds = new Set(blocks.map(b => b.parent_block_id).filter(Boolean) as number[]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Scheduling</h1>
        <p className="text-sm text-gray-500 mt-1">
          Stages 4–9 · Timetable → CP-SAT → VNS Bundling → Field Approval → Disruption Re-opt
        </p>
      </div>

      {/* ── 1. Train Runs ──────────────────────────────────────────────── */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-xs">
        <div className="border-b border-slate-100 pb-3">
          <h2 className="text-base font-bold text-slate-900">Train Runs & Timetable Conflict Windows (Stage 4)</h2>
          <p className="text-xs text-slate-500">Corridor train timetable schedules and maintenance window analysis</p>
        </div>

        <form onSubmit={handleAddTrainRun} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <input
            id="tr-route"
            className="col-span-2 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Route (e.g. SC–BBN Exp)"
            value={trRoute}
            onChange={e => setTrRoute(e.target.value)}
            required
          />
          <input
            id="tr-time"
            type="time"
            step="1"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={trTime}
            onChange={e => setTrTime(e.target.value + ':00')}
            required
          />
          <select
            id="tr-day"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={trDay}
            onChange={e => setTrDay(Number(e.target.value))}
          >
            {DAY_NAMES.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-gray-600 col-span-2">
            <input type="checkbox" checked={trDaily} onChange={e => setTrDaily(e.target.checked)} />
            Daily (runs every day)
          </label>
          <button
            id="tr-add-btn"
            type="submit"
            disabled={trLoading}
            className="col-span-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded px-4 py-1.5 disabled:opacity-50 transition-colors"
          >
            {trLoading ? 'Adding…' : 'Add Train Run'}
          </button>
        </form>

        {trError && <InlineAlert type="error" message={trError} />}

        <div className="mt-2">
          <button
            id="analyze-btn"
            onClick={handleAnalyze}
            disabled={analyzeLoading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded px-4 py-1.5 disabled:opacity-50 transition-colors"
          >
            {analyzeLoading ? 'Analysing…' : 'Analyse Timetable'}
          </button>
          {analyzeResult && <p className="mt-2 text-sm text-green-700 font-medium">{analyzeResult}</p>}
          {analyzeError  && <InlineAlert type="error" message={analyzeError} />}
        </div>

        {trainRuns.length > 0 && (
          <div className="overflow-x-auto mt-2">
            <table className="min-w-full text-xs text-left">
              <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">Route</th>
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Day</th>
                  <th className="px-3 py-2">Daily</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {trainRuns.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-3 py-1.5 text-gray-400">{r.id}</td>
                    <td className="px-3 py-1.5 font-medium text-gray-800">{r.route}</td>
                    <td className="px-3 py-1.5 font-mono">{r.scheduled_time}</td>
                    <td className="px-3 py-1.5">{DAY_NAMES[r.day_of_week]}</td>
                    <td className="px-3 py-1.5">{r.is_daily ? '✓' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 2. Maintenance Tasks ───────────────────────────────────────── */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-xs">
        <div className="border-b border-slate-100 pb-3">
          <h2 className="text-base font-bold text-slate-900">Maintenance Demands & Tasks (Stage 5)</h2>
          <p className="text-xs text-slate-500">Department maintenance requests ready for CP-SAT solver allocation</p>
        </div>

        <form onSubmit={handleAddTask} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <input
            id="tk-chainage"
            type="number" step="0.01" min="0" max="19.9"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Chainage km"
            value={tkChainage}
            onChange={e => setTkChainage(e.target.value)}
            required
          />
          <select
            id="tk-dept"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={tkDept}
            onChange={e => setTkDept(e.target.value as 'Civil' | 'Signalling' | 'Electrical')}
          >
            <option>Civil</option>
            <option>Signalling</option>
            <option>Electrical</option>
          </select>
          <input
            id="tk-duration"
            type="number" min="1"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Duration (min)"
            value={tkDuration}
            onChange={e => setTkDuration(e.target.value)}
            required
          />
          <input
            id="tk-priority"
            type="number" step="0.1"
            className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Priority weight (opt.)"
            value={tkPriority}
            onChange={e => setTkPriority(e.target.value)}
          />
          <button
            id="tk-add-btn"
            type="submit"
            disabled={tkLoading}
            className="col-span-4 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded px-4 py-1.5 disabled:opacity-50 transition-colors"
          >
            {tkLoading ? 'Creating…' : 'Create Task'}
          </button>
        </form>

        {tkError && <InlineAlert type="error" message={tkError} />}

        <div className="flex items-center gap-3">
          <label className="text-xs text-gray-500">Filter by status:</label>
          <select
            id="tk-filter"
            className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none"
            value={taskFilter}
            onChange={e => { setTaskFilter(e.target.value); }}
          >
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="scheduled">Scheduled</option>
            <option value="bundled">Bundled</option>
            <option value="executed">Executed</option>
          </select>
          <button onClick={loadTasks} className="text-xs text-blue-600 hover:underline">Refresh</button>

          <button
            id="btn-auto-gen-tasks"
            onClick={handleAutoGenerateTasks}
            disabled={autoGenLoading}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-md text-xs font-semibold shadow-xs disabled:opacity-50 transition-colors"
          >
            <span>⚡</span>
            <span>{autoGenLoading ? 'Generating…' : 'Auto-Generate Tasks from Risk Telemetry'}</span>
          </button>
        </div>

        {autoGenSuccess && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-800 font-medium flex items-center justify-between">
            <span>✓ {autoGenSuccess}</span>
            <button onClick={() => setAutoGenSuccess(null)} className="text-emerald-600 hover:text-emerald-900 font-bold ml-2">×</button>
          </div>
        )}
        {autoGenError && <InlineAlert type="error" message={autoGenError} />}

        {tasks.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-left">
              <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">Chainage</th>
                  <th className="px-3 py-2">Dept</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">Priority</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {tasks.map(t => (
                  <tr key={t.id} className="hover:bg-gray-50">
                    <td className="px-3 py-1.5 text-gray-400">{t.id}</td>
                    <td className="px-3 py-1.5 font-mono">{t.chainage_km.toFixed(2)} km</td>
                    <td className="px-3 py-1.5 font-medium">{t.department}</td>
                    <td className="px-3 py-1.5">{t.estimated_duration_minutes} min</td>
                    <td className="px-3 py-1.5">{t.priority_weight ?? '—'}</td>
                    <td className="px-3 py-1.5"><StatusBadge status={t.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 px-4 bg-slate-50 border border-slate-200/80 rounded-xl space-y-3">
            <div>
              <p className="text-sm font-semibold text-slate-800">No Maintenance Tasks Found</p>
              <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
                {taskFilter
                  ? `No tasks found matching status "${taskFilter}".`
                  : 'Register a task manually above, or automatically convert high-risk telemetry predictions into scheduled maintenance demands.'}
              </p>
            </div>
            {!taskFilter && (
              <button
                onClick={handleAutoGenerateTasks}
                disabled={autoGenLoading}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors"
              >
                <span>⚡</span>
                <span>Auto-Queue Demands from Ingested Telemetry</span>
              </button>
            )}
          </div>
        )}
      </section>

      {/* ── 3. Optimize + Bundle buttons ──────────────────────────────── */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-xs">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">Optimization & Bundling Engine</h2>
            <p className="text-xs text-slate-500">Stages 5 & 6 — Mathematical solvers across timetable conflict windows</p>
          </div>
          <div>
            {!resetConfirm ? (
              <button
                id="btn-reset-schedule"
                onClick={() => setResetConfirm(true)}
                disabled={resetting || optLoading || bndLoading}
                className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50 border border-red-200 hover:border-red-300 rounded-lg px-3 py-1.5 font-medium transition-colors inline-flex items-center gap-1.5"
              >
                <span>🗑</span> Clear Schedule & Tasks
              </button>
            ) : (
              <div className="flex items-center gap-2 border border-red-300 bg-red-50 rounded-lg px-3 py-1.5">
                <span className="text-xs text-red-700 font-medium">Clear all blocks & tasks?</span>
                <button
                  id="btn-reset-schedule-confirm"
                  onClick={handleResetSchedule}
                  disabled={resetting}
                  className="text-xs bg-red-600 hover:bg-red-700 text-white font-medium px-2.5 py-1 rounded transition-colors"
                >
                  {resetting ? 'Clearing…' : 'Yes, clear'}
                </button>
                <button
                  onClick={() => setResetConfirm(false)}
                  className="text-xs text-slate-500 hover:text-slate-800"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        {resetSuccess && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-800 font-medium flex items-center justify-between">
            <span>✓ {resetSuccess}</span>
            <button onClick={() => setResetSuccess(null)} className="text-emerald-600 hover:text-emerald-900 font-bold ml-2">×</button>
          </div>
        )}
        <div className="flex flex-wrap gap-4">
          <div>
            <button
              id="opt-btn"
              onClick={handleOptimize}
              disabled={optLoading}
              className="inline-flex items-center gap-2 bg-blue-800 hover:bg-blue-900 text-white text-sm font-semibold rounded-lg px-5 py-2.5 shadow-sm disabled:opacity-50 transition-colors"
            >
              <span>⚙</span>
              <span>{optLoading ? 'Optimising with CP-SAT…' : 'Optimize Schedule (CP-SAT)'}</span>
            </button>
            {optResult && <p className="mt-2 text-xs text-emerald-800 font-semibold bg-emerald-50 px-2.5 py-1 rounded border border-emerald-200">{optResult}</p>}
            {optError  && <div className="mt-2"><InlineAlert type="error" message={optError} /></div>}
          </div>
          <div>
            <button
              id="bnd-btn"
              onClick={handleBundle}
              disabled={bndLoading}
              className="inline-flex items-center gap-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg px-5 py-2.5 shadow-sm disabled:opacity-50 transition-colors"
            >
              <span>⧉</span>
              <span>{bndLoading ? 'Bundling with VNS…' : 'Bundle Blocks (VNS)'}</span>
            </button>
            {bndResult && <p className="mt-2 text-xs text-amber-800 font-semibold bg-amber-50 px-2.5 py-1 rounded border border-amber-200">{bndResult}</p>}
            {bndError  && <div className="mt-2"><InlineAlert type="error" message={bndError} /></div>}
          </div>
        </div>
      </section>

      {/* ── 4. Gantt timeline ─────────────────────────────────────────── */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-xs">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">Corridor Gantt Timeline</h2>
            <p className="text-xs text-slate-500">24-hour visual projection of scheduled & bundled blocks along the Secunderabad corridor</p>
          </div>
          <button onClick={loadBlocks} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-medium transition-colors">
            <span>🔄</span> Refresh
          </button>
        </div>

        {/* Hour tick labels */}
        <div className="relative" style={{ width: GANTT_WIDTH, height: 20 }}>
          {Array.from({ length: 25 }, (_, h) => (
            <span
              key={h}
              className="absolute text-xs text-gray-400"
              style={{ left: (h / 24) * GANTT_WIDTH - 10 }}
            >
              {String(h).padStart(2, '0')}:00
            </span>
          ))}
        </div>

        {/* Chainage Y-axis + blocks */}
        <div className="flex gap-2">
          {/* Y-axis labels */}
          <div className="relative flex-shrink-0" style={{ width: 50, height: GANTT_HEIGHT }}>
            {STATIONS.map(s => (
              <div
                key={s.code}
                className="absolute text-xs text-gray-500 font-mono"
                style={{ top: blockTop(s.chainage) - 6, right: 4 }}
              >
                {s.code}
              </div>
            ))}
          </div>

          {/* Gantt canvas */}
          <div
            className="relative border border-gray-200 bg-gray-50 overflow-x-auto flex-shrink-0"
            style={{ width: GANTT_WIDTH, height: GANTT_HEIGHT }}
          >
            {/* Station gridlines */}
            {STATIONS.map(s => (
              <div
                key={s.code}
                className="absolute w-full border-t border-gray-200"
                style={{ top: blockTop(s.chainage) }}
              />
            ))}

            {/* Hour gridlines */}
            {Array.from({ length: 25 }, (_, h) => (
              <div
                key={h}
                className="absolute h-full border-l border-gray-100"
                style={{ left: (h / 24) * GANTT_WIDTH }}
              />
            ))}

            {/* Empty state overlay when no blocks exist */}
            {blocks.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center z-10 pointer-events-none">
                <div className="bg-white/95 backdrop-blur-xs border border-slate-200 shadow-sm rounded-xl px-6 py-4 max-w-sm space-y-1">
                  <div className="text-2xl mb-1">📅</div>
                  <p className="text-sm font-semibold text-slate-800">No Scheduled Blocks</p>
                  <p className="text-xs text-slate-500">
                    The corridor timeline is empty. Create maintenance demands or upload telemetry, then click &ldquo;Optimize Schedule (CP-SAT)&rdquo; to generate blocks.
                  </p>
                </div>
              </div>
            )}

            {/* Blocks */}
            {blocks.map(b => {
              const isChild = b.parent_block_id !== null;
              const dept = (tasks.find(t => t.id === b.task_id) ?? pending.find(p => p.task_id === b.task_id))
                ? (tasks.find(t => t.id === b.task_id)?.department ??
                   pending.find(p => p.task_id === b.task_id)?.task?.department ?? 'Civil')
                : 'Civil';
              const colors = DEPT_COLORS[dept] ?? DEPT_COLORS['Civil'];
              const colorClass = isChild ? colors.child : colors.parent;
              const isParent = parentIds.has(b.id);

              return (
                <div
                  key={b.id}
                  className={`absolute rounded-sm ${colorClass} opacity-90 hover:opacity-100 cursor-pointer transition-opacity`}
                  style={{
                    left:   blockLeft(b.start_time) + (isChild ? 4 : 0),
                    width:  blockWidth(b.start_time, b.end_time),
                    top:    blockTop(b.chainage_km),
                    height: 18,
                  }}
                  title={`Block #${b.id} | Task #${b.task_id} | ${dept} | ${fmtTime(b.start_time)}–${fmtTime(b.end_time)} | ${b.status}${isParent ? ' (parent)' : ''}${isChild ? ' (child)' : ''}`}
                />
              );
            })}
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-4 text-xs mt-1">
          {Object.entries(DEPT_COLORS).map(([dept, c]) => (
            <span key={dept} className="flex items-center gap-1.5">
              <span className={`inline-block w-4 h-3 rounded-sm ${c.parent}`} />
              {dept} (parent)
              <span className={`inline-block w-4 h-3 rounded-sm ${c.child}`} />
              (child)
            </span>
          ))}
        </div>
      </section>

      {/* ── 5. Pending blocks / decisions ─────────────────────────────── */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-xs">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">Field Controller Review Gate (Stage 7)</h2>
            <p className="text-xs text-slate-500">Official human-in-the-loop review for optimized and bundled maintenance blocks</p>
          </div>
          <button onClick={loadPending} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-medium transition-colors">
            <span>🔄</span> Refresh
          </button>
        </div>

        {pending.length === 0 ? (
          <div className="text-center py-10 px-4 bg-slate-50 border border-slate-200/80 rounded-xl space-y-2">
            <div className="text-3xl">✅</div>
            <p className="text-sm font-semibold text-slate-800">No Pending Blocks to Review</p>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              All corridor blocks are either scheduled or already approved. Run optimization or add tasks above to generate new candidate blocks.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {pending.map(b => {
              const inFlight = decisionLoading[b.id] ?? false;
              const errMsg   = decisionError[b.id] ?? '';
              const rejectVisible = rejectShown[b.id] ?? false;

              return (
                <div key={b.id} className="border border-slate-200 bg-white hover:border-slate-300 rounded-xl p-4 space-y-3 shadow-xs transition-colors">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="font-bold text-sm text-slate-900">Block #{b.id}</span>
                    <StatusBadge status={b.status} />
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                      b.task.department === 'Civil' ? 'bg-blue-50 text-blue-700 border border-blue-200'
                      : b.task.department === 'Signalling' ? 'bg-amber-50 text-amber-700 border border-amber-200'
                      : 'bg-purple-50 text-purple-700 border border-purple-200'
                    }`}>{b.task.department}</span>
                    <span className="text-xs text-slate-600 font-mono bg-slate-100 px-2 py-0.5 rounded">{b.chainage_km.toFixed(2)} km</span>
                    <span className="text-xs text-slate-600 font-medium">{fmtTime(b.start_time)} – {fmtTime(b.end_time)}</span>
                    {b.high_risk_nearby > 0 && (
                      <span className="text-xs bg-rose-50 text-rose-700 border border-rose-200 font-medium rounded-md px-2 py-0.5">
                        ⚠ {b.high_risk_nearby} high-risk nearby
                      </span>
                    )}
                    {b.latest_delay_minutes !== null && (
                      <span className="text-xs text-slate-500 font-medium">
                        Delay: {b.latest_delay_minutes.toFixed(1)} min
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-100">
                    <button
                      id={`accept-${b.id}`}
                      onClick={() => handleAccept(b.id)}
                      disabled={inFlight}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg px-3.5 py-2 shadow-xs disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                    >
                      <span>✓</span>
                      <span>Accept Block</span>
                    </button>
                    <button
                      id={`reject-toggle-${b.id}`}
                      onClick={() => setRejectShown(p => ({ ...p, [b.id]: !rejectVisible }))}
                      disabled={inFlight}
                      className="bg-white border border-slate-300 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-300 text-slate-700 text-xs font-semibold rounded-lg px-3.5 py-2 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
                    >
                      <span>✗</span>
                      <span>Reject Block</span>
                    </button>
                  </div>

                  {rejectVisible && (
                    <div className="flex gap-2 items-center bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                      <input
                        id={`reject-reason-${b.id}`}
                        className="flex-1 bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500"
                        placeholder="State official rejection reason (required)"
                        value={rejectInput[b.id] ?? ''}
                        onChange={e => setRejectInput(p => ({ ...p, [b.id]: e.target.value }))}
                      />
                      <button
                        id={`reject-confirm-${b.id}`}
                        onClick={() => handleReject(b.id)}
                        disabled={inFlight}
                        className="bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold rounded-lg px-3.5 py-1.5 disabled:opacity-50 transition-colors"
                      >
                        {inFlight ? 'Rejecting…' : 'Confirm Reject'}
                      </button>
                    </div>
                  )}

                  {errMsg && <InlineAlert type="error" message={errMsg} />}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 6. Disruption Monitoring ───────────────────────────────────── */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-4 shadow-xs">
        <div className="border-b border-slate-100 pb-3">
          <h2 className="text-base font-bold text-slate-900">Incident & Disruption Monitoring (Stage 9)</h2>
          <p className="text-xs text-slate-500">Inject or monitor corridor delays to evaluate rolling-horizon schedule resilience</p>
        </div>

        <form onSubmit={handleDisruption} className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <label className="text-xs text-gray-500">Delay (min)</label>
            <input
              id="dis-delay"
              type="number" step="0.1" min="0"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-32 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={disDelay}
              onChange={e => setDisDelay(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-gray-500">Affected chainage (km)</label>
            <input
              id="dis-chainage"
              type="number" step="0.01" min="0" max="19.9"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-36 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={disChainage}
              onChange={e => setDisChainage(e.target.value)}
              required
            />
          </div>
          <button
            id="dis-submit-btn"
            type="submit"
            disabled={disLoading}
            className="bg-orange-600 hover:bg-orange-700 text-white text-sm font-medium rounded px-4 py-1.5 disabled:opacity-50 transition-colors"
          >
            {disLoading ? 'Reporting…' : 'Report Disruption'}
          </button>
        </form>

        {disResult && <p className="text-sm font-medium text-orange-700">{disResult}</p>}
        {disError  && <InlineAlert type="error" message={disError} />}

        <button
          onClick={async () => {
            const next = !showDisHistory;
            setShowDisHistory(next);
            if (next) await loadDisHistory();
          }}
          className="text-xs text-blue-600 hover:underline"
        >
          {showDisHistory ? '▲ Hide' : '▼ Show'} Disruption History
        </button>

        {showDisHistory && disHistory.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs text-left mt-2">
              <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2">Received</th>
                  <th className="px-3 py-2">Delay (min)</th>
                  <th className="px-3 py-2">Chainage (km)</th>
                  <th className="px-3 py-2">Re-optimised</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {disHistory.map(d => (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-3 py-1.5 font-mono">
                      {new Date(d.received_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5">{d.delay_minutes.toFixed(1)}</td>
                    <td className="px-3 py-1.5">{d.affected_chainage_km.toFixed(2)}</td>
                    <td className="px-3 py-1.5">
                      {d.triggered_reoptimization
                        ? <span className="text-green-700 font-medium">Yes</span>
                        : <span className="text-gray-400">No</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
