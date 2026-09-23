/**
 * PipelinePage — Visual pipeline overview and orchestrator trigger.
 *
 * Shows the 9-stage pipeline flow with live status counts from
 * GET /pipeline/status and allows triggering a full pipeline run.
 */

import { useState, useEffect } from 'react';
import { getPipelineStatus, postPipelineRun } from '../api/client';
import type { PipelineStatusResponse, PipelineRunResponse } from '../types/api';
import { Spinner } from '../components/Spinner';

interface StageInfo {
  id: string;
  label: string;
  icon: string;
  getValue: (s: PipelineStatusResponse) => number | string;
  getLabel: (s: PipelineStatusResponse) => string;
}

const STAGES: StageInfo[] = [
  {
    id: '1', label: 'Multi-Source Ingestion', icon: '📥',
    getValue: s => s.total_records,
    getLabel: s => `${s.total_records} telemetry & measurement records loaded`,
  },
  {
    id: '2', label: 'Linear Chainage Mapping', icon: '📍',
    getValue: s => s.chainage_processed,
    getLabel: s => `${s.chainage_processed} resolved to km chainage • ${s.chainage_failed} failed`,
  },
  {
    id: '3a', label: 'Asset Failure Risk (XGBoost)', icon: '⚠️',
    getValue: s => s.risk_predictions,
    getLabel: s => `${s.risk_predictions} predictions (${s.high_risk} high-risk flags)`,
  },
  {
    id: '3b', label: 'Network Delay Forecasting (GCN-LSTM)', icon: '⏱️',
    getValue: s => s.delay_runs,
    getLabel: s => `${s.delay_runs} spatiotemporal prediction runs completed`,
  },
  {
    id: '4', label: 'Timetable Analysis & Conflict Windows', icon: '🚆',
    getValue: s => s.train_runs,
    getLabel: s => `${s.train_runs} train runs • ${s.maintenance_windows} available maintenance windows`,
  },
  {
    id: '5', label: 'Mathematical Optimization (CP-SAT)', icon: '📅',
    getValue: s => s.scheduled_blocks,
    getLabel: s => `${s.scheduled_blocks} candidate blocks scheduled`,
  },
  {
    id: '6', label: 'Multi-Department Bundling (VNS)', icon: '📦',
    getValue: s => s.scheduled_blocks,
    getLabel: s => `${s.pending_tasks} pending department demands synchronized`,
  },
  {
    id: '7-8', label: 'Human-in-the-Loop Review Gate', icon: '✅',
    getValue: s => s.executed_blocks,
    getLabel: s => `${s.executed_blocks} blocks reviewed and executed`,
  },
  {
    id: '9', label: 'Live Corridor Disruption Monitoring', icon: '🚨',
    getValue: s => s.disruption_events,
    getLabel: s => `${s.disruption_events} corridor disruption incidents registered`,
  },
];

export function PipelinePage() {
  const [status, setStatus] = useState<PipelineStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PipelineRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = async () => {
    try {
      const data = await getPipelineStatus();
      setStatus(data);
    } catch (err) {
      console.error('Failed to load pipeline status:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const res = await postPipelineRun();
      setResult(res);
      loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pipeline run failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            Pipeline Orchestrator
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Real-time status across all 9 RailSetu automated pipeline stages
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={loadStatus}
            className="btn-secondary"
          >
            <span>🔄</span>
            <span>Refresh</span>
          </button>
          <button
            onClick={handleRun}
            disabled={running}
            className="btn-primary"
          >
            {running && <Spinner size={14} />}
            <span>{running ? 'Running Pipeline…' : '▶ Run Pipeline (2→3a→3b)'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-xs font-medium text-rose-800 flex items-center gap-2">
          <span className="text-base leading-none">⚠</span>
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-5 space-y-2">
          <div className="text-sm font-bold text-emerald-800 flex items-center gap-2">
            <span>✓</span>
            <span>Pipeline Run Executed Successfully</span>
          </div>
          <div className="flex flex-wrap gap-6 text-xs text-emerald-700">
            <div>Stage 2 Chainage: <strong>{result.chainage.processed}</strong> processed</div>
            <div>Stage 3a Risk: <strong>{result.risk.succeeded}</strong> predictions</div>
            <div>Stage 3b Delay: {typeof result.delay === 'object' && result.delay ? 'Forecast Updated' : String(result.delay)}</div>
          </div>
        </div>
      )}

      {/* Pipeline Stages Flow */}
      {loading ? (
        <div className="text-center py-16 bg-white border border-slate-200 rounded-xl space-y-3">
          <Spinner size={24} />
          <p className="text-xs text-slate-500">Querying live pipeline state…</p>
        </div>
      ) : status ? (
        <div className="space-y-2">
          {STAGES.map((stage, i) => {
            const val = stage.getValue(status);
            const hasData = typeof val === 'number' ? val > 0 : !!val;

            return (
              <div key={stage.id} className="space-y-2">
                <div className={`
                  bg-white border rounded-xl p-4.5 flex items-center gap-4 transition-all shadow-xs
                  ${hasData ? 'border-slate-200 border-l-4 border-l-blue-800' : 'border-slate-200/80 border-l-4 border-l-slate-300'}
                `}>
                  <div className={`
                    w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0
                    ${hasData ? 'bg-blue-50 text-blue-900 border border-blue-100' : 'bg-slate-100 text-slate-400 border border-slate-200'}
                  `}>
                    {stage.icon}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-blue-800 uppercase tracking-wider bg-blue-50 px-2 py-0.5 rounded border border-blue-100">
                        STAGE {stage.id}
                      </span>
                      <span className="text-sm font-bold text-slate-900 truncate">
                        {stage.label}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {stage.getLabel(status)}
                    </div>
                  </div>

                  <div className={`
                    px-3.5 py-1.5 rounded-lg text-sm font-bold font-mono border
                    ${hasData
                      ? 'bg-blue-50 text-blue-900 border-blue-200'
                      : 'bg-slate-50 text-slate-400 border-slate-200'
                    }
                  `}>
                    {typeof val === 'number' ? val.toLocaleString() : val}
                  </div>
                </div>

                {/* Light Connector Arrow */}
                {i < STAGES.length - 1 && (
                  <div className="text-center text-slate-300 font-mono text-sm leading-none pl-6 py-0.5">
                    ↓
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
