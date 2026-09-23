import { useEffect, useState } from 'react';
import {
  getPipelineStatus,
  postPipelineRun,
  getDelayLatest,
  getRiskPredictions,
  resetAllData,
} from '../api/client';
import type {
  PipelineStatusResponse,
  PipelineRunResponse,
  DelayPredictionRunResponse,
  RiskPredictionRecord,
} from '../types/api';
import { Spinner } from '../components/Spinner';
import { InlineAlert } from '../components/InlineAlert';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

// ── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color = 'text-slate-900' }: {
  label: string; value: number | string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col gap-1.5 shadow-xs">
      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</span>
      <span className={`text-2xl font-bold mono ${color}`}>{value}</span>
      {sub && <span className="text-xs text-slate-400 font-medium">{sub}</span>}
    </div>
  );
}

// ── Risk level badge ──────────────────────────────────────────────────────────

const RISK_CFG = {
  high:   { bg: 'bg-rose-50 border-rose-200',    text: 'text-rose-700'   },
  medium: { bg: 'bg-amber-50 border-amber-200',  text: 'text-amber-700' },
  low:    { bg: 'bg-emerald-50 border-emerald-200',  text: 'text-emerald-700' },
} as const;

function RiskBadge({ level }: { level: string }) {
  const cfg = RISK_CFG[level as keyof typeof RISK_CFG] ?? { bg: 'bg-slate-50 border-slate-200', text: 'text-slate-700' };
  return (
    <span className={`inline-block px-2.5 py-0.5 rounded-full border text-xs font-semibold ${cfg.bg} ${cfg.text} capitalize`}>
      {level}
    </span>
  );
}

// ── Pipeline run result card ──────────────────────────────────────────────────

function PipelineResultCard({ result }: { result: PipelineRunResponse }) {
  const { chainage, risk, delay } = result;
  return (
    <div className="bg-white border border-border rounded-md p-5 space-y-4">
      <p className="text-sm font-semibold text-gray-700">Pipeline Run Result</p>

      <div className="grid grid-cols-3 gap-4 text-sm">
        {/* Chainage */}
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Stage 2 — Chainage</p>
          <p><span className="text-green-600 font-semibold">{chainage.processed}</span> processed</p>
          <p><span className="text-red-500 font-semibold">{chainage.failed}</span> failed</p>
        </div>
        {/* Risk */}
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Stage 3a — Risk</p>
          <p><span className="text-green-600 font-semibold">{risk.succeeded}</span> predicted</p>
          <p><span className="text-gray-400 font-semibold">{risk.skipped_ineligible}</span> ineligible</p>
          {risk.failed > 0 && <p><span className="text-red-500 font-semibold">{risk.failed}</span> failed</p>}
        </div>
        {/* Delay */}
        <div className="space-y-1">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Stage 3b — Delay</p>
          {(delay as any).ok
            ? <p className="text-green-600 font-semibold">OK — {(delay as any).run_id?.slice(0, 8)}…</p>
            : <p className="text-amber-600 font-semibold">{(delay as any).reason ?? 'Skipped'}</p>}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const [status, setStatus]         = useState<PipelineStatusResponse | null>(null);
  const [latestDelay, setLatestDelay] = useState<DelayPredictionRunResponse | null>(null);
  const [latestRisk, setLatestRisk] = useState<RiskPredictionRecord[]>([]);
  const [loading, setLoading]       = useState(true);
  const [running, setRunning]       = useState(false);
  const [runResult, setRunResult]   = useState<PipelineRunResponse | null>(null);
  const [error, setError]           = useState<string | null>(null);

  // Reset state
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting]       = useState(false);
  const [resetResult, setResetResult]   = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [s, d, r] = await Promise.all([
        getPipelineStatus(),
        getDelayLatest(),
        getRiskPredictions(5),
      ]);
      setStatus(s);
      setLatestDelay(d);
      setLatestRisk(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleRunPipeline = async () => {
    setRunning(true);
    setRunResult(null);
    setError(null);
    try {
      const result = await postPipelineRun();
      setRunResult(result);
      await loadData();   // refresh counts
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pipeline run failed');
    } finally {
      setRunning(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    setResetResult(null);
    setError(null);
    try {
      const res = await resetAllData();
      const d = res.deleted;
      const parts = [
        `${d.raw_ingestion_records} records`,
        `${d.risk_predictions} risk predictions`,
        `${d.delay_predictions} delay predictions`,
      ];
      if (d.scheduled_blocks !== undefined) {
        parts.push(`${d.scheduled_blocks} scheduled blocks`);
      }
      if (d.maintenance_tasks !== undefined) {
        parts.push(`${d.maintenance_tasks} maintenance tasks`);
      }
      setResetResult(`Deleted ${parts.join(', ')}.`);
      setRunResult(null);
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setResetting(false);
      setResetConfirm(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Pipeline Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">
            Real-time overview of all pipeline stages and prediction results.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            id="btn-run-pipeline"
            onClick={handleRunPipeline}
            disabled={running}
            className="btn-primary flex items-center gap-2"
          >
            {running && <Spinner size={14} />}
            {running ? 'Running Pipeline…' : 'Run Full Pipeline'}
          </button>

          {/* Reset controls */}
          {!resetConfirm ? (
            <button
              id="btn-reset-all"
              onClick={() => setResetConfirm(true)}
              disabled={resetting || running}
              className="text-xs text-red-400 hover:text-red-600 border border-red-200 hover:border-red-400 rounded px-3 py-1.5 transition-colors"
            >
              Reset All Data
            </button>
          ) : (
            <div className="flex items-center gap-2 border border-red-300 bg-red-50 rounded px-3 py-1.5">
              <span className="text-xs text-red-700 font-medium">Delete ALL records?</span>
              <button
                id="btn-reset-confirm"
                onClick={handleReset}
                disabled={resetting}
                className="text-xs bg-red-600 text-white px-2 py-0.5 rounded hover:bg-red-700 flex items-center gap-1"
              >
                {resetting && <Spinner size={11} />}
                {resetting ? 'Deleting…' : 'Yes, delete'}
              </button>
              <button
                onClick={() => setResetConfirm(false)}
                className="text-xs text-gray-500 hover:text-gray-800"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <InlineAlert type="error" message={error} />}
      {resetResult && (
        <div className="rounded border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">
          ✓ {resetResult}
        </div>
      )}
      {runResult && <PipelineResultCard result={runResult} />}

      {/* Stats grid */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Spinner size={16} /> Loading…
        </div>
      ) : status ? (
        <>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
              Pipeline Overview
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Total Records" value={status.total_records} />
              <StatCard label="Chainage Processed" value={status.chainage_processed}
                        sub={`${status.chainage_failed} failed`} />
              <StatCard label="Risk Predictions" value={status.risk_predictions} />
              <StatCard label="Delay Runs" value={status.delay_runs} />
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
              Risk Distribution
            </p>
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="High Risk" value={status.high_risk} color="text-red-600" />
              <StatCard label="Medium Risk" value={status.medium_risk} color="text-amber-600" />
              <StatCard label="Low Risk" value={status.low_risk} color="text-green-600" />
            </div>
          </div>
        </>
      ) : null}

      {/* Latest delay */}
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
          Latest Delay Prediction
        </p>
        {latestDelay ? (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
            <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex gap-6 text-xs text-slate-600 font-medium">
              <span>Run: <span className="mono text-slate-800 font-semibold">{latestDelay.run_id.slice(0, 12)}…</span></span>
              <span>At: <span className="text-slate-700">{formatDate(latestDelay.predicted_at)}</span></span>
              {latestDelay.input_window_start && (
                <span>Window: <span className="text-slate-700">
                  {formatDate(latestDelay.input_window_start)} → {latestDelay.input_window_end ? formatDate(latestDelay.input_window_end) : '—'}
                </span></span>
              )}
            </div>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50/60 text-xs font-semibold text-slate-600 uppercase tracking-wide text-left">
                  <th className="px-4 py-2.5 border-b border-slate-200">Station</th>
                  <th className="px-4 py-2.5 border-b border-slate-200 text-right">Predicted Delay</th>
                  <th className="px-4 py-2.5 border-b border-slate-200 w-48">Bar</th>
                </tr>
              </thead>
              <tbody>
                {latestDelay.predictions.map((p, i) => {
                  const pct = Math.min(100, Math.abs(p.predicted_delay_minutes) / 20 * 100);
                  const color = p.predicted_delay_minutes <= 2 ? 'bg-emerald-500'
                    : p.predicted_delay_minutes <= 8 ? 'bg-amber-500' : 'bg-rose-500';
                  return (
                    <tr key={p.station} className={i % 2 === 0 ? 'bg-white hover:bg-slate-50/80 transition-colors' : 'bg-slate-50/70 hover:bg-slate-100/70 transition-colors'}>
                      <td className="px-4 py-2.5 border-b border-slate-100 font-bold mono text-slate-800">{p.station}</td>
                      <td className="px-4 py-2.5 border-b border-slate-100 text-right mono font-semibold text-slate-800">
                        {p.predicted_delay_minutes.toFixed(2)} min
                      </td>
                      <td className="px-4 py-2.5 border-b border-slate-100">
                        <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                          <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl px-4 py-6 text-sm text-slate-400 italic">
            No delay predictions yet. Run the pipeline or use the Delay Prediction page.
          </div>
        )}
      </div>

      {/* Recent risk predictions */}
      <div>
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-3">
          Recent Risk Predictions
        </p>
        {latestRisk.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl px-4 py-6 text-sm text-slate-400 italic">
            No risk predictions yet. Run the pipeline or use the Risk Prediction page.
          </div>
        ) : (
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-xs font-semibold text-slate-600 uppercase tracking-wide text-left bg-slate-50 border-b border-slate-200">
                  <th className="px-4 py-2.5 border-b border-slate-200">Pred. ID</th>
                  <th className="px-4 py-2.5 border-b border-slate-200">Record ID</th>
                  <th className="px-4 py-2.5 border-b border-slate-200 text-right">Probability</th>
                  <th className="px-4 py-2.5 border-b border-slate-200">Risk Level</th>
                  <th className="px-4 py-2.5 border-b border-slate-200">Predicted At</th>
                </tr>
              </thead>
              <tbody>
                {latestRisk.map((r, i) => (
                  <tr key={r.id} className={i % 2 === 0 ? 'bg-white hover:bg-slate-50/80 transition-colors' : 'bg-slate-50/70 hover:bg-slate-100/70 transition-colors'}>
                    <td className="px-4 py-2.5 border-b border-slate-100 mono text-slate-500">#{r.id}</td>
                    <td className="px-4 py-2.5 border-b border-slate-100 mono text-slate-700">#{r.record_id}</td>
                    <td className="px-4 py-2.5 border-b border-slate-100 text-right mono font-semibold text-slate-800">
                      {(r.probability * 100).toFixed(1)}%
                    </td>
                    <td className="px-4 py-2.5 border-b border-slate-100">
                      <RiskBadge level={r.risk_level} />
                    </td>
                    <td className="px-4 py-2.5 border-b border-slate-100 text-xs text-slate-500">
                      {formatDate(r.predicted_at)}
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
