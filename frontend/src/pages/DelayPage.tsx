import { useEffect, useState } from 'react';
import {
  postDelayFromDB,
  getDelayLatest,
  postDelayPrediction,
} from '../api/client';
import type { DelayPredictionRunResponse } from '../types/api';
import { Spinner } from '../components/Spinner';
import { InlineAlert } from '../components/InlineAlert';

// ── Constants ────────────────────────────────────────────────────────────────

const STATIONS = ['SC', 'MJF', 'AWL', 'GHKT', 'BBN'] as const;
const STATION_NAMES: Record<string, string> = {
  SC: 'Secunderabad', MJF: 'Malkajgiri', AWL: 'Alwal',
  GHKT: 'Ghatkesar', BBN: 'Bibinagar',
};
const SEQ_LEN = 12;
const N_STATIONS = STATIONS.length;

function blankSequence(): string[][] {
  return Array.from({ length: SEQ_LEN }, () => Array(N_STATIONS).fill(''));
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

// ── Delay bar ────────────────────────────────────────────────────────────────

function DelayBar({ delay }: { delay: number }) {
  const pct   = Math.min(100, Math.max(0, (Math.abs(delay) / 20) * 100));
  const color = delay <= 2 ? 'bg-emerald-500' : delay <= 8 ? 'bg-amber-500' : 'bg-rose-500';
  const text  = delay <= 2 ? 'text-emerald-700' : delay <= 8 ? 'text-amber-700' : 'text-rose-700';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-semibold w-16 text-right mono ${text}`}>
        {delay.toFixed(2)} min
      </span>
    </div>
  );
}

// ── Prediction table ──────────────────────────────────────────────────────────

function PredictionTable({ run }: { run: DelayPredictionRunResponse }) {
  return (
    <div className="space-y-3">
      {/* Run meta */}
      <div className="flex flex-wrap gap-4 text-xs text-slate-500 bg-slate-50 px-3.5 py-2.5 rounded-xl border border-slate-200">
        <span>Run: <span className="mono text-slate-700 font-semibold">{run.run_id.slice(0, 16)}…</span></span>
        <span>At: <span className="text-slate-700 font-medium">{formatDate(run.predicted_at)}</span></span>
        {run.obs_count != null && (
          <span>
            Observations used: <span className="font-semibold text-slate-800">{run.obs_count}</span>
          </span>
        )}
        {run.input_window_start && (
          <span>Window:&nbsp;
            <span className="text-slate-700 font-medium">
              {formatDate(run.input_window_start)} → {run.input_window_end ? formatDate(run.input_window_end) : '…'}
            </span>
          </span>
        )}
      </div>

      {/* Station table */}
      <div className="rounded-xl border border-slate-200 overflow-hidden shadow-xs bg-white">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-50 text-xs font-semibold text-slate-600 uppercase tracking-wide text-left">
              <th className="px-3.5 py-2.5 border-b border-slate-200 mono w-16">Code</th>
              <th className="px-3.5 py-2.5 border-b border-slate-200">Station</th>
              <th className="px-3.5 py-2.5 border-b border-slate-200 text-right w-32">Predicted Delay</th>
              <th className="px-3.5 py-2.5 border-b border-slate-200 w-48">Bar</th>
            </tr>
          </thead>
          <tbody>
            {run.predictions.map((p, i) => (
              <tr key={p.station} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                <td className="px-3.5 py-2.5 border-b border-slate-100 mono text-slate-800 font-bold">{p.station}</td>
                <td className="px-3.5 py-2.5 border-b border-slate-100 text-slate-700 font-medium">
                  {STATION_NAMES[p.station] ?? p.station}
                </td>
                <td className="px-3.5 py-2.5 border-b border-slate-100 text-right mono font-semibold text-slate-800">
                  {p.predicted_delay_minutes.toFixed(2)} min
                </td>
                <td className="px-3.5 py-2.5 border-b border-slate-100">
                  <DelayBar delay={p.predicted_delay_minutes} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex gap-4 text-xs text-slate-500 pt-1">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />On-time: ≤ 2 min</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />Minor: 2–8 min</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block" />Significant: &gt; 8 min</span>
      </div>
    </div>
  );
}

// ── Insufficient history banner ───────────────────────────────────────────────

function InsufficientBanner({ detail, stepsAvailable, stepsNeeded }: {
  detail: string; stepsAvailable: number; stepsNeeded: number;
}) {
  return (
    <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 space-y-2">
      <p className="text-sm font-semibold text-amber-800">⚠ Insufficient Delay History</p>
      <p className="text-sm text-amber-700">{detail}</p>
      <div className="flex gap-2 items-center">
        <div className="flex-1 h-2 bg-amber-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-amber-500 rounded-full"
            style={{ width: `${Math.round((stepsAvailable / stepsNeeded) * 100)}%` }}
          />
        </div>
        <span className="text-xs text-amber-700 whitespace-nowrap">
          {stepsAvailable} / {stepsNeeded} time steps
        </span>
      </div>
      <p className="text-xs text-amber-600">
        Ingest at least <strong>{stepsNeeded}</strong> delay observations (one per 5-min bin across 5 stations)
        using the <strong>Ingestion</strong> page with <code className="bg-amber-100 px-1 rounded">delay_minutes</code> in the payload.
      </p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function DelayPage() {
  const [latestRun, setLatestRun]       = useState<DelayPredictionRunResponse | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(true);

  // DB-driven prediction state
  const [running, setRunning]     = useState(false);
  const [runResult, setRunResult] = useState<DelayPredictionRunResponse | null>(null);
  const [insuffErr, setInsuffErr] = useState<{
    detail: string; steps_available: number; steps_needed: number;
  } | null>(null);
  const [dbError, setDbError]     = useState<string | null>(null);

  // Manual grid state
  const [showGrid, setShowGrid]     = useState(false);
  const [seqValues, setSeqValues]   = useState<string[][]>(blankSequence);
  const [gridLoading, setGridLoading] = useState(false);
  const [gridResult, setGridResult] = useState<Array<{station: string; predicted_delay_minutes: number}> | null>(null);
  const [gridError, setGridError]   = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const run = await getDelayLatest();
        setLatestRun(run);
      } finally {
        setLoadingLatest(false);
      }
    })();
  }, []);

  const handleRunFromDB = async () => {
    setRunning(true);
    setRunResult(null);
    setInsuffErr(null);
    setDbError(null);
    try {
      const res = await postDelayFromDB();
      if ('error' in res && res.error === 'insufficient_history') {
        setInsuffErr({
          detail: res.detail,
          steps_available: res.steps_available,
          steps_needed: res.steps_needed,
        });
      } else {
        const run = res as DelayPredictionRunResponse;
        setRunResult(run);
        setLatestRun(run);
      }
    } catch (e) {
      setDbError(e instanceof Error ? e.message : 'Prediction failed');
    } finally {
      setRunning(false);
    }
  };

  const updateCell = (t: number, s: number, val: string) => {
    setSeqValues(prev => {
      const next = prev.map(row => [...row]);
      next[t][s] = val;
      return next;
    });
  };

  const handleGridPredict = async () => {
    const sequence: number[][] = [];
    for (let t = 0; t < SEQ_LEN; t++) {
      const row: number[] = [];
      for (let s = 0; s < N_STATIONS; s++) {
        const v = parseFloat(seqValues[t][s]);
        if (isNaN(v)) {
          setGridError(`Step ${t + 1}, station ${STATIONS[s]} is empty.`);
          return;
        }
        row.push(v);
      }
      sequence.push(row);
    }
    setGridError(null);
    setGridResult(null);
    setGridLoading(true);
    try {
      const res = await postDelayPrediction({ sequence });
      setGridResult(res.predictions);
    } catch (e) {
      setGridError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setGridLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold text-gray-900">Delay Prediction</h1>
        <p className="text-sm text-gray-500 mt-1">
          Stage 3b — GCN-LSTM station delay prediction driven by historical DB observations.
        </p>
      </div>

      {/* ── Primary: DB-driven prediction ── */}
      <div className="bg-white border border-border rounded-md p-6 space-y-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-gray-800">
              Run Prediction from Database
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Queries the last 60 minutes of <code className="bg-gray-100 px-1 rounded">delay_minutes</code> observations,
              builds the 12 × 5 input matrix, runs GCN-LSTM, and saves results.
            </p>
          </div>
          <button
            id="btn-delay-db"
            onClick={handleRunFromDB}
            disabled={running}
            className="btn-primary flex items-center gap-2 shrink-0"
          >
            {running && <Spinner size={14} />}
            {running ? 'Building window…' : 'Run from DB'}
          </button>
        </div>

        {dbError && <InlineAlert type="error" message={dbError} />}
        {insuffErr && (
          <InsufficientBanner
            detail={insuffErr.detail}
            stepsAvailable={insuffErr.steps_available}
            stepsNeeded={insuffErr.steps_needed}
          />
        )}
        {runResult && (
          <div className="space-y-2">
            <p className="text-xs text-green-600 font-medium">✓ Prediction saved successfully</p>
            <PredictionTable run={runResult} />
          </div>
        )}
      </div>

      {/* ── Latest saved prediction ── */}
      <div className="bg-white border border-border rounded-md p-6">
        <p className="text-sm font-semibold text-gray-700 mb-4">Latest Saved Prediction</p>
        {loadingLatest ? (
          <div className="flex gap-2 items-center text-sm text-gray-400">
            <Spinner size={14} /> Loading…
          </div>
        ) : latestRun ? (
          <PredictionTable run={latestRun} />
        ) : (
          <p className="text-sm text-gray-400 italic">
            No predictions saved yet. Use "Run from DB" above, or ingest delay data first.
          </p>
        )}
      </div>

      {/* ── Secondary: developer 12×5 grid ── */}
      <div className="bg-white border border-border rounded-md">
        <button
          className="w-full text-left px-5 py-3 text-sm font-medium text-gray-500 flex justify-between items-center hover:bg-muted transition-colors"
          onClick={() => setShowGrid(v => !v)}
        >
          Developer Tool — Manual 12 × 5 Input Grid (not DB-connected, results not saved)
          <span className="text-xs mono">{showGrid ? '▲ Hide' : '▼ Show'}</span>
        </button>
        {showGrid && (
          <div className="px-5 pb-5 pt-2 border-t border-border space-y-4">
            <p className="text-xs text-gray-500">
              Enter delay values (minutes) for each of the 12 time steps × 5 stations.
              Station order: SC → MJF → AWL → GHKT → BBN (chainage order).
            </p>
            <div className="flex gap-2">
              <button onClick={() => setSeqValues(Array.from({length: SEQ_LEN}, () => Array(N_STATIONS).fill('0')))}
                className="text-xs text-accent hover:underline">Fill zeros</button>
              <span className="text-gray-300">|</span>
              <button onClick={() => setSeqValues(blankSequence())}
                className="text-xs text-gray-400 hover:text-gray-700">Clear</button>
            </div>

            <div className="overflow-x-auto">
              <table className="border-collapse text-xs w-full min-w-[560px]">
                <thead>
                  <tr>
                    <th className="px-2 py-1.5 text-left text-gray-500 font-medium w-14">Step</th>
                    {STATIONS.map(st => (
                      <th key={st} className="px-2 py-1.5 text-center text-gray-600 font-semibold">
                        <span className="block mono">{st}</span>
                        <span className="block text-gray-400 font-normal text-xs">{STATION_NAMES[st]}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {seqValues.map((row, t) => (
                    <tr key={t} className={t % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="px-2 py-1 text-gray-400 mono">T-{SEQ_LEN - t}</td>
                      {row.map((val, s) => (
                        <td key={s} className="px-1 py-1">
                          <input
                            id={`grid-t${t}-s${s}`}
                            type="number" step="any" min="0"
                            className="input-field text-xs py-1 px-1.5 text-center w-full"
                            placeholder="min"
                            value={val}
                            onChange={e => updateCell(t, s, e.target.value)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-4">
              <button
                id="btn-delay-grid"
                onClick={handleGridPredict}
                disabled={gridLoading}
                className="btn-primary flex items-center gap-2 text-sm"
              >
                {gridLoading && <Spinner size={13} />}
                {gridLoading ? 'Running…' : 'Run GCN-LSTM (Not Saved)'}
              </button>
            </div>

            {gridError && <InlineAlert type="error" message={gridError} />}

            {gridResult && (
              <div className="rounded border border-border overflow-hidden max-w-lg">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted text-xs font-semibold text-gray-500 uppercase tracking-wide">
                      <th className="px-3 py-2 border-b border-border text-left">Station</th>
                      <th className="px-3 py-2 border-b border-border text-right">Predicted Delay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gridResult.map((p, i) => (
                      <tr key={p.station} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        <td className="px-3 py-2 border-b border-border mono font-semibold">{p.station}</td>
                        <td className="px-3 py-2 border-b border-border text-right mono">
                          {p.predicted_delay_minutes.toFixed(2)} min
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-gray-400 px-3 py-2 italic">Result not saved to database.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* About */}
      <div className="bg-white border border-border rounded-md p-5">
        <p className="text-sm font-semibold text-gray-700 mb-3">About this Model</p>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-sm">
          <dt className="text-gray-500">Architecture</dt><dd>GCN-LSTM (Graph Conv + LSTM)</dd>
          <dt className="text-gray-500">Stations</dt><dd>SC, MJF, AWL, GHKT, BBN (chainage order)</dd>
          <dt className="text-gray-500">DB input field</dt><dd><code className="bg-gray-100 px-1 rounded text-xs">delay_minutes</code> in payload</dd>
          <dt className="text-gray-500">Window</dt><dd>12 time steps × 5 min = 60 minutes</dd>
          <dt className="text-gray-500">Results saved to</dt><dd>delay_predictions table</dd>
        </dl>
      </div>
    </div>
  );
}
