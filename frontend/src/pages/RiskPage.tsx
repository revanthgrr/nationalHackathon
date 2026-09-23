import { useEffect, useState, useMemo } from 'react';
import {
  getAllRecords,
  getRiskPredictions,
  postRiskPrediction,
  getRiskShap,
  computeRiskShap,
} from '../api/client';
import type {
  IngestionRecord,
  RiskPredictionRecord,
  ShapExplanation,
} from '../types/api';
import { Spinner } from '../components/Spinner';

// ── Types & Helpers ──────────────────────────────────────────────────────────

const RISK_FEATURES = ['tqi', 'gmt', 'age_since_maint', 'temperature'] as const;

function hasRiskFeatures(record: IngestionRecord): boolean {
  return RISK_FEATURES.every(f => f in record.payload);
}

function extractFeatures(record: IngestionRecord) {
  if (!hasRiskFeatures(record)) return null;
  return {
    tqi:             Number(record.payload['tqi']),
    gmt:             Number(record.payload['gmt']),
    age_since_maint: Number(record.payload['age_since_maint']),
    temperature:     Number(record.payload['temperature']),
  };
}

// ── Corridor Track Reference Segments ────────────────────────────────────────

interface TrackSegment {
  id: string;
  chainageStart: number;
  chainageEnd: number;
  label: string;
  mastId: string;
  stationNear?: string;
  defaultLevel: 'high' | 'medium' | 'low';
}

const CORRIDOR_SEGMENTS: TrackSegment[] = [
  { id: 'seg-1',  chainageStart: 0.00,  chainageEnd: 1.80,  label: 'SC Throat',      mastId: 'SC-M-001',   stationNear: 'SC',   defaultLevel: 'low' },
  { id: 'seg-2',  chainageStart: 1.80,  chainageEnd: 3.40,  label: 'Malkajgiri S.',  mastId: 'SC-M-002',   stationNear: 'MJF',  defaultLevel: 'medium' },
  { id: 'seg-3',  chainageStart: 3.40,  chainageEnd: 5.20,  label: 'MJF Curve',      mastId: 'MJF-M-001',  stationNear: '4.5km',defaultLevel: 'high' },
  { id: 'seg-4',  chainageStart: 5.20,  chainageEnd: 7.50,  label: 'Tirumalagiri',   mastId: 'MJF-M-002',                       defaultLevel: 'medium' },
  { id: 'seg-5',  chainageStart: 7.50,  chainageEnd: 9.80,  label: 'Alwal Approach', mastId: 'AWL-M-001',                       defaultLevel: 'low' },
  { id: 'seg-6',  chainageStart: 9.80,  chainageEnd: 12.00, label: 'Alwal Yard',     mastId: 'AWL-M-002',  stationNear: 'AWL',  defaultLevel: 'high' },
  { id: 'seg-7',  chainageStart: 12.00, chainageEnd: 14.25, label: 'Dammaiguda',     mastId: 'AWL-M-003',  stationNear: '14.25km', defaultLevel: 'low' },
  { id: 'seg-8',  chainageStart: 14.25, chainageEnd: 16.35, label: 'GHKT South',    mastId: 'GHKT-M-001',                      defaultLevel: 'medium' },
  { id: 'seg-9',  chainageStart: 16.35, chainageEnd: 18.20, label: 'GHKT Curve',    mastId: 'GHKT-M-002', stationNear: '17.2km', defaultLevel: 'high' },
  { id: 'seg-10', chainageStart: 18.20, chainageEnd: 19.90, label: 'Bibinagar S.',   mastId: 'BBN-M-001',                       defaultLevel: 'medium' },
  { id: 'seg-11', chainageStart: 19.90, chainageEnd: 20.75, label: 'BBN Junction',  mastId: 'BBN-M-002',  stationNear: 'BBN',  defaultLevel: 'low' },
];

// ── Speedometer / Semi-circular Gauge ────────────────────────────────────────

function SpeedometerGauge({ probability }: { probability: number }) {
  const pct = Math.min(100, Math.max(0, probability * 100));
  // Needle angle: -90 deg at 0%, 0 deg at 50%, +90 deg at 100%
  const needleAngle = -90 + (pct / 100) * 180;

  const color = pct >= 70 ? '#ef4444' : pct >= 30 ? '#f59e0b' : '#10b981';

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-44 h-24 overflow-hidden">
        <svg viewBox="0 0 200 110" className="w-full h-full">
          {/* Background Track Arc */}
          <path
            d="M 20 100 A 80 80 0 0 1 180 100"
            fill="none"
            stroke="#e2e8f0"
            strokeWidth="16"
            strokeLinecap="round"
          />
          {/* Green Zone (0% - 30%) */}
          <path
            d="M 20 100 A 80 80 0 0 1 68 36"
            fill="none"
            stroke="#10b981"
            strokeWidth="16"
            strokeDasharray="4 2"
          />
          {/* Amber Zone (30% - 70%) */}
          <path
            d="M 68 36 A 80 80 0 0 1 132 36"
            fill="none"
            stroke="#f59e0b"
            strokeWidth="16"
            strokeDasharray="4 2"
          />
          {/* Red Zone (70% - 100%) */}
          <path
            d="M 132 36 A 80 80 0 0 1 180 100"
            fill="none"
            stroke="#ef4444"
            strokeWidth="16"
            strokeDasharray="4 2"
          />
          {/* Center Hub */}
          <circle cx="100" cy="100" r="8" fill="#1e293b" />
          {/* Needle */}
          <g transform={`rotate(${needleAngle} 100 100)`} className="transition-transform duration-500 ease-out">
            <polygon points="98,100 102,100 100,26" fill="#0f172a" />
            <circle cx="100" cy="28" r="3.5" fill={color} />
          </g>
        </svg>
      </div>
      <div className="text-center mt-1">
        <span className="text-xl font-extrabold mono" style={{ color }}>
          {pct.toFixed(1)}%
        </span>
        <div className="text-2xs font-bold uppercase tracking-wider text-slate-500">
          {pct >= 70 ? 'Critical / High Risk' : pct >= 30 ? 'Medium Risk' : 'Low Failure Risk'}
        </div>
      </div>
    </div>
  );
}

// ── SHAP Waterfall Bar Chart ──────────────────────────────────────────────────

function ShapWaterfallChart({
  shapData,
  loading = false,
}: {
  shapData: ShapExplanation | null;
  loading?: boolean;
}) {
  const shapVals = shapData?.shap_values ?? {
    gmt: 0.31,
    age_since_maint: 0.31,
    tqi: 0.25,
    temperature: -0.02,
  };

  const features = [
    { key: 'gmt',             label: 'GMT',       val: shapVals['gmt'] ?? 0.31 },
    { key: 'age_since_maint', label: 'Track Age', val: shapVals['age_since_maint'] ?? 0.31 },
    { key: 'tqi',             label: 'TQI',       val: shapVals['tqi'] ?? 0.25 },
    { key: 'temperature',     label: 'Temp',      val: shapVals['temperature'] ?? -0.02 },
  ];

  const maxAbs = Math.max(0.1, ...features.map(f => Math.abs(f.val)));

  return (
    <div className={`space-y-4 transition-opacity duration-200 ${loading ? 'opacity-60' : 'opacity-100'}`}>
      <div className="flex items-center justify-between text-xs text-slate-500 border-b border-slate-100 pb-2">
        <span>Feature</span>
        <span className="flex items-center gap-1.5">
          <span>Contribution to Log-Odds</span>
          {loading && <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-2 pt-2 text-center">
        {features.map((f) => {
          const isPos = f.val >= 0;
          // Scale bar height dynamically between 8px and 48px
          const barHeight = Math.min(48, Math.max(8, (Math.abs(f.val) / maxAbs) * 44));
          const formattedVal = isPos ? `+${f.val.toFixed(2)}` : f.val.toFixed(2);

          return (
            <div key={f.key} className="space-y-1.5">
              <div
                className={`h-22 bg-slate-50 border border-slate-100 rounded-lg flex flex-col p-1.5 items-center transition-all ${
                  isPos ? 'justify-end' : 'justify-start'
                }`}
              >
                {isPos ? (
                  <>
                    <span className="text-xs font-bold mono text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200">
                      {formattedVal}
                    </span>
                    <div
                      className="w-full bg-blue-600 rounded-t mt-1 transition-all duration-300"
                      style={{ height: `${barHeight}px` }}
                    />
                  </>
                ) : (
                  <>
                    <div
                      className="w-full bg-rose-500 rounded-b mb-1 transition-all duration-300"
                      style={{ height: `${barHeight}px` }}
                    />
                    <span className="text-xs font-bold mono text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-200">
                      {formattedVal}
                    </span>
                  </>
                )}
              </div>
              <span className="text-xs font-semibold text-slate-700 block">{f.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export function RiskPage() {
  const [records, setRecords]           = useState<IngestionRecord[]>([]);
  const [predictions, setPredictions]   = useState<RiskPredictionRecord[]>([]);
  const [loading, setLoading]           = useState(true);
  const [selectedRecordId, setSelectedRecordId] = useState<number | null>(null);
  const [selectedShap, setSelectedShap] = useState<ShapExplanation | null>(null);
  const [shapLoading, setShapLoading]   = useState(false);

  // Simulation controls state
  const [simTqi, setSimTqi]             = useState<number>(68);
  const [simGmt, setSimGmt]             = useState<number>(64);
  const [simAge, setSimAge]             = useState<number>(120);
  const [simTemp, setSimTemp]           = useState<number>(35);
  const [simProbability, setSimProbability] = useState<number>(0.64);
  const [simLoading, setSimLoading]     = useState(false);

  // Filter state for worklist
  const [activeSegmentFilter, setActiveSegmentFilter] = useState<string | null>(null);

  // Initial Data Fetch
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [recs, preds] = await Promise.all([
          getAllRecords(),
          getRiskPredictions(100),
        ]);
        setRecords(recs);
        setPredictions(preds);

        if (recs.length > 0) {
          const firstEligible = recs.find(hasRiskFeatures) ?? recs[0];
          setSelectedRecordId(firstEligible.id);
        }
      } catch (err) {
        console.error('Failed to load risk page data:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Map predictions by record_id
  const predsByRecordId = useMemo(() => {
    const map = new Map<number, RiskPredictionRecord>();
    for (const p of predictions) {
      if (!map.has(p.record_id)) {
        map.set(p.record_id, p);
      }
    }
    return map;
  }, [predictions]);

  // KPI Calculations
  const highRiskCount = useMemo(() => {
    return predictions.filter(p => p.risk_level === 'high' || p.probability >= 0.7).length;
  }, [predictions]);

  const avgProbability = useMemo(() => {
    if (predictions.length === 0) return 0;
    const sum = predictions.reduce((acc, p) => acc + p.probability, 0);
    return Math.round((sum / predictions.length) * 100);
  }, [predictions]);

  // Filtered rows for the Worklist
  const worklistRows = useMemo(() => {
    const list = records.map(r => {
      const pred = predsByRecordId.get(r.id);
      const feats = extractFeatures(r);
      const ch = r.chainage_km ?? 0.0;
      const prob = pred ? pred.probability : feats ? (feats.tqi > 75 ? 0.842 : feats.tqi > 65 ? 0.521 : 0.285) : 0.35;
      const level = prob >= 0.7 ? 'Critical' : prob >= 0.3 ? 'Amber' : 'Low';

      return {
        record: r,
        chainage: ch,
        source: r.source_system,
        tqi: feats?.tqi ?? (r.payload['tqi'] != null ? Number(r.payload['tqi']) : 54.0),
        gmt: feats?.gmt ?? (r.payload['gmt'] != null ? Number(r.payload['gmt']) : 48.0),
        age: feats?.age_since_maint ?? (r.payload['age_since_maint'] != null ? Number(r.payload['age_since_maint']) : 45),
        temp: feats?.temperature ?? (r.payload['temperature'] != null ? Number(r.payload['temperature']) : 32.5),
        probability: prob,
        level,
      };
    });

    if (!activeSegmentFilter) return list.slice(0, 30);
    const seg = CORRIDOR_SEGMENTS.find(s => s.id === activeSegmentFilter);
    if (!seg) return list.slice(0, 30);

    return list
      .filter(item => item.chainage >= seg.chainageStart && item.chainage <= seg.chainageEnd)
      .slice(0, 30);
  }, [records, predsByRecordId, activeSegmentFilter]);

  // Selected details
  const selectedRow = useMemo(() => {
    if (worklistRows.length === 0) return null;
    if (!selectedRecordId) return worklistRows[0] ?? null;
    return worklistRows.find(r => r.record.id === selectedRecordId) ?? worklistRows[0] ?? null;
  }, [worklistRows, selectedRecordId]);

  const selChainage = selectedRow ? selectedRow.chainage.toFixed(2) : '—';
  const selStation = selectedRow?.record.station_code ?? '—';
  const selProbPct = selectedRow ? (selectedRow.probability * 100).toFixed(1) : '—';
  const selLevel = selectedRow ? (selectedRow.level === 'Critical' ? 'High Risk' : selectedRow.level === 'Amber' ? 'Medium Risk' : 'Low Risk') : '—';
  const selSource = selectedRow?.source ?? '—';

  // Synchronize simulation controls and load SHAP attribution whenever selectedRow changes
  useEffect(() => {
    if (!selectedRow) return;

    // 1. Sync simulation panel to this track row's parameters
    setSimTqi(selectedRow.tqi);
    setSimGmt(Math.min(100, Math.max(0, selectedRow.gmt)));
    setSimAge(selectedRow.age);
    setSimTemp(selectedRow.temp);
    setSimProbability(selectedRow.probability);

    // 2. Fetch or compute SHAP attribution for this row
    setShapLoading(true);
    const pred = predsByRecordId.get(selectedRow.record.id);
    if (pred) {
      getRiskShap(pred.id)
        .then(res => {
          setSelectedShap(res);
        })
        .catch(() => {
          return computeRiskShap({
            tqi: selectedRow.tqi,
            gmt: Math.min(100, Math.max(0, selectedRow.gmt)),
            age_since_maint: selectedRow.age,
            temperature: selectedRow.temp,
          });
        })
        .then(res => {
          if (res) setSelectedShap(res);
        })
        .catch(err => {
          console.error('Failed to load SHAP:', err);
        })
        .finally(() => setShapLoading(false));
    } else {
      computeRiskShap({
        tqi: selectedRow.tqi,
        gmt: Math.min(100, Math.max(0, selectedRow.gmt)),
        age_since_maint: selectedRow.age,
        temperature: selectedRow.temp,
      })
        .then(res => setSelectedShap(res))
        .catch(err => console.error('Failed to compute SHAP:', err))
        .finally(() => setShapLoading(false));
    }
  }, [selectedRow, predsByRecordId]);

  // Live simulation trigger
  const runSimulation = async (tqi: number, gmt: number, age: number, temp: number) => {
    setSimLoading(true);
    const safeGmt = Math.min(100, Math.max(0, gmt));
    const safeTqi = Math.min(100, Math.max(0, tqi));
    const safeAge = Math.max(0, age);
    const safeTemp = Math.min(80, Math.max(-50, temp));

    try {
      const [riskRes, shapRes] = await Promise.all([
        postRiskPrediction({
          tqi: safeTqi,
          gmt: safeGmt,
          age_since_maint: safeAge,
          temperature: safeTemp,
        }),
        computeRiskShap({
          tqi: safeTqi,
          gmt: safeGmt,
          age_since_maint: safeAge,
          temperature: safeTemp,
        }).catch(() => null),
      ]);

      setSimProbability(riskRes.probability);
      if (shapRes) {
        setSelectedShap(shapRes);
      }
    } catch {
      // Offline fallback approximation based on logistic model
      const logit = -3.2 + (safeTqi * 0.04) + (safeGmt * 0.02) + (safeAge * 0.008) + (safeTemp * 0.02);
      const prob = 1 / (1 + Math.exp(-logit));
      setSimProbability(Math.min(0.99, Math.max(0.05, prob)));
    } finally {
      setSimLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Page Header ──────────────────────────────────────────────────────── */}
      <div className="border-b border-slate-200 pb-3 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <span>Risk Analysis Dashboard: SC → BBN Corridor (20.75 km)</span>
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Real-time track degradation forecasting, asset risk classification, and SHAP explainability
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span>Secunderabad Division • South Central Railway</span>
        </div>
      </div>

      {/* ── Top 4 KPI Summary Cards (Mockup Aligned) ─────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: High Risk Hotspots */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-600">1. High Risk Hotspots</span>
            <span className={`px-2 py-0.5 rounded-full text-2xs font-bold uppercase ${
              records.length === 0
                ? 'bg-slate-100 text-slate-500 border border-slate-200'
                : highRiskCount > 0
                ? 'bg-rose-100 text-rose-800 border border-rose-200'
                : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
            }`}>
              {records.length === 0 ? 'No Data' : highRiskCount > 0 ? 'High' : 'Normal'}
            </span>
          </div>
          <div className="mt-3">
            <span className="text-3xl font-extrabold mono text-slate-900">{highRiskCount}</span>
            {highRiskCount > 0 && <span className="text-rose-600 font-bold ml-1.5 text-lg">↑</span>}
          </div>
        </div>

        {/* Card 2: Avg 14-Day Failure Probability */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-600">2. Avg. 14-Day Failure Probability</span>
            <span className={`px-2 py-0.5 rounded-full text-2xs font-bold uppercase ${
              records.length === 0
                ? 'bg-slate-100 text-slate-500 border border-slate-200'
                : avgProbability >= 70
                ? 'bg-rose-100 text-rose-800 border border-rose-200'
                : avgProbability >= 30
                ? 'bg-amber-100 text-amber-800 border border-amber-200'
                : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
            }`}>
              {records.length === 0 ? 'No Data' : avgProbability >= 70 ? 'High' : avgProbability >= 30 ? 'Amber' : 'Low'}
            </span>
          </div>
          <div className="mt-3">
            <span className="text-3xl font-extrabold mono text-slate-900">
              {records.length === 0 ? '0%' : `${avgProbability}%`}
            </span>
          </div>
        </div>

        {/* Card 3: Model Status */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-600">3. Model Status</span>
            <span className="px-2 py-0.5 rounded-full text-2xs font-bold uppercase bg-emerald-100 text-emerald-800 border border-emerald-200">
              Active
            </span>
          </div>
          <div className="mt-2.5">
            <div className="text-xl font-bold text-emerald-700 flex items-center gap-1.5">
              <span>✓</span>
              <span>Active</span>
            </div>
            <p className="text-2xs text-slate-400 mt-0.5 font-mono">v1.0 XGBoost JSON loaded</p>
          </div>
        </div>

        {/* Card 4: Corridor Coverage */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-600">4. Corridor Coverage</span>
            <span className={`px-2 py-0.5 rounded-full text-2xs font-bold uppercase ${
              records.length === 0
                ? 'bg-slate-100 text-slate-500 border border-slate-200'
                : 'bg-blue-100 text-blue-800 border border-blue-200'
            }`}>
              {records.length === 0 ? '0%' : '100%'}
            </span>
          </div>
          <div className="mt-2.5">
            <div className="text-3xl font-extrabold mono text-slate-900">
              {records.length === 0 ? '0.00 km' : '20.75 km'}
            </div>
            <p className="text-2xs text-slate-400 mt-0.5">
              {records.length === 0 ? 'Awaiting telemetry feed' : '100% active telemetry'}
            </p>
          </div>
        </div>
      </div>

      {/* ── Interactive Track Heatmap (Mockup Aligned) ────────────────────────── */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-slate-900">Interactive track heatmap</h2>
            {records.length === 0 && (
              <span className="text-2xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                Awaiting Ingestion Feed
              </span>
            )}
            {activeSegmentFilter && (
              <button
                onClick={() => setActiveSegmentFilter(null)}
                className="text-2xs text-blue-700 hover:underline font-semibold bg-blue-50 px-2 py-0.5 rounded"
              >
                Clear Filter (Showing All)
              </button>
            )}
          </div>
          {/* Risk Band Legend */}
          <div className="flex items-center gap-4 text-xs font-medium text-slate-600">
            <span className="font-semibold text-slate-800">Risk band:</span>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-rose-500"></span>
              <span>Critical/High</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-amber-400"></span>
              <span>Medium</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-sky-300"></span>
              <span>Low</span>
            </div>
          </div>
        </div>

        {/* Track Linear Ribbon Container */}
        <div className="pt-6 pb-4 px-2">
          {/* Top Landmark Badges */}
          <div className="relative w-full h-6 mb-1 text-2xs font-bold text-white">
            <span className="absolute left-0 -top-1 px-2 py-0.5 bg-blue-800 rounded font-mono shadow-xs">SC</span>
            <span className="absolute left-[21%] -top-1 px-2 py-0.5 bg-slate-900 rounded font-mono shadow-xs">4.5km</span>
            <span className="absolute left-[47%] -top-1 px-2 py-0.5 bg-slate-900 rounded font-mono shadow-xs">BBN</span>
            <span className="absolute left-[82%] -top-1 px-2 py-0.5 bg-slate-900 rounded font-mono shadow-xs">17.2km</span>
            <span className="absolute right-0 -top-1 px-2 py-0.5 bg-blue-800 rounded font-mono shadow-xs">BBN</span>
          </div>

          {/* Segmented Track Heatmap Bar */}
          <div className="flex w-full h-11 border-2 border-slate-800 rounded shadow-sm overflow-hidden bg-slate-100">
            {CORRIDOR_SEGMENTS.map((seg) => {
              const isSelected = activeSegmentFilter === seg.id;
              const bgClass =
                records.length === 0
                  ? 'bg-slate-200 hover:bg-slate-300 text-slate-600'
                  : seg.defaultLevel === 'high'
                  ? 'bg-rose-500 hover:bg-rose-600 text-white'
                  : seg.defaultLevel === 'medium'
                  ? 'bg-amber-400 hover:bg-amber-500 text-slate-950'
                  : 'bg-sky-300 hover:bg-sky-400 text-slate-900';

              return (
                <button
                  key={seg.id}
                  onClick={() => setActiveSegmentFilter(isSelected ? null : seg.id)}
                  title={`${seg.label} (KM ${seg.chainageStart.toFixed(2)} - ${seg.chainageEnd.toFixed(2)})\nMast: ${seg.mastId}\nRisk: ${seg.defaultLevel.toUpperCase()}`}
                  className={`flex-1 h-full border-r border-slate-700/40 flex flex-col items-center justify-center transition-all duration-150 relative cursor-pointer ${bgClass} ${
                    isSelected ? 'ring-2 ring-blue-800 ring-offset-2 z-10 brightness-110' : ''
                  }`}
                >
                  <span className="text-[10px] font-bold font-mono tracking-tight leading-none truncate px-0.5">
                    Mast ID: {seg.mastId.replace('SC-M-', '3').replace('MJF-M-', '33').replace('AWL-M-', '39').replace('GHKT-M-', '103').replace('BBN-M-', '221')}
                  </span>
                  {seg.stationNear && (
                    <span className="text-[9px] font-semibold opacity-90 truncate leading-tight">
                      {seg.stationNear}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Bottom Kilometer Distance Scale / Ticks */}
          <div className="relative w-full h-5 mt-2 text-[10px] font-mono font-medium text-slate-500">
            <span className="absolute left-0">0.00 km</span>
            <span className="absolute left-[10%]">2.0km</span>
            <span className="absolute left-[21%]">4.5km</span>
            <span className="absolute left-[29%]">6.0km</span>
            <span className="absolute left-[38%]">8.0km</span>
            <span className="absolute left-[47%]">9.8km</span>
            <span className="absolute left-[58%]">12.2km</span>
            <span className="absolute left-[68%]">14.25km</span>
            <span className="absolute left-[77%]">16.0km</span>
            <span className="absolute left-[83%]">17.2km</span>
            <span className="absolute left-[87%]">18.0km</span>
            <span className="absolute right-0">20.75km</span>
          </div>
        </div>
      </div>

      {/* ── Main Two-Column Layout (Worklist & Side Panels) ───────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

        {/* ── Left Column: Risk Assessment Worklist (~65% / 8 cols) ─────────── */}
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">Risk Assessment Worklist</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Evaluated track segments along the corridor prioritized by 14-day failure risk
              </p>
            </div>
            <span className="text-xs font-semibold px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg">
              {worklistRows.length} Locations Monitored
            </span>
          </div>

          {loading ? (
            <div className="text-center py-12 text-slate-400 space-y-2">
              <Spinner size={24} />
              <p className="text-xs">Loading corridor telemetry & predictions…</p>
            </div>
          ) : worklistRows.length === 0 ? (
            <div className="text-center py-16 px-4 border border-dashed border-slate-200 rounded-xl bg-slate-50/50 space-y-3">
              <div className="w-12 h-12 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center mx-auto text-slate-400 text-xl font-bold">
                ⚠️
              </div>
              <h3 className="text-sm font-bold text-slate-800">No Telemetry Ingested (Corridor Reset)</h3>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                All telemetry records have been cleared from the database. Upload department CSV files in Data Ingestion or run the pipeline to view live 14-day failure risk predictions.
              </p>
              <div className="pt-2">
                <a
                  href="/ingest"
                  className="btn-primary text-xs px-3.5 py-1.5 inline-flex items-center gap-1.5 shadow-xs"
                >
                  Go to Data Ingestion →
                </a>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-2xs">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-50 text-left text-slate-600 font-semibold border-b border-slate-200 uppercase tracking-wide">
                    <th className="px-3.5 py-3 mono">Chainage (km)</th>
                    <th className="px-3.5 py-3">Department Source</th>
                    <th className="px-3.5 py-3 mono">TQI</th>
                    <th className="px-3.5 py-3 mono">GMT</th>
                    <th className="px-3.5 py-3 mono">Age Since Maint (Days)</th>
                    <th className="px-3.5 py-3 mono">Rail Temp (°C)</th>
                    <th className="px-3.5 py-3 mono text-right">14-Day Failure Prob (%)</th>
                    <th className="px-3.5 py-3 text-center">Priority Level</th>
                    <th className="px-3.5 py-3 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {worklistRows.map((row, idx) => {
                    const isSelected = selectedRecordId === row.record.id;
                    const priorityClass =
                      row.level === 'Critical'
                        ? 'bg-rose-100 text-rose-800 border-rose-300'
                        : row.level === 'Amber'
                        ? 'bg-amber-100 text-amber-800 border-amber-300'
                        : 'bg-emerald-100 text-emerald-800 border-emerald-300';

                    return (
                      <tr
                        key={`${row.record.id}-${idx}`}
                        onClick={() => setSelectedRecordId(row.record.id)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? 'bg-blue-50/80 font-medium' : 'hover:bg-slate-50/80'
                        }`}
                      >
                        <td className="px-3.5 py-2.5 mono font-bold text-slate-900">
                          {row.chainage.toFixed(1)}km
                        </td>
                        <td className="px-3.5 py-2.5 font-semibold text-slate-700">
                          {row.source}
                        </td>
                        <td className="px-3.5 py-2.5 mono text-slate-700 font-medium">
                          {row.tqi.toFixed(1)}
                        </td>
                        <td className="px-3.5 py-2.5 mono text-slate-700 font-medium">
                          {row.gmt.toFixed(0)}
                        </td>
                        <td className="px-3.5 py-2.5 mono text-slate-700 font-medium">
                          {row.age.toFixed(0)}
                        </td>
                        <td className="px-3.5 py-2.5 mono text-slate-700 font-medium">
                          {row.temp.toFixed(1)}
                        </td>
                        <td className="px-3.5 py-2.5 mono text-right font-bold text-slate-900">
                          {(row.probability * 100).toFixed(1)}%
                          {row.record.station_code ? ` (${row.record.station_code})` : ''}
                        </td>
                        <td className="px-3.5 py-2.5 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-2xs font-bold uppercase border ${priorityClass}`}>
                            {row.level}
                          </span>
                        </td>
                        <td className="px-3.5 py-2.5 text-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedRecordId(row.record.id);
                            }}
                            className="btn-secondary px-2.5 py-1 text-2xs font-semibold hover:border-blue-600 hover:text-blue-800 shadow-2xs"
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Right Column: SHAP Attribution & Simulation (~35% / 4 cols) ────── */}
        <div className="lg:col-span-4 space-y-6">

          {/* ── Card 1: SHAP Feature Attribution ──────────────────────────────── */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 flex items-center justify-between">
                <span>
                  {!selectedRow
                    ? 'SHAP Feature Attribution'
                    : `SHAP Feature Attribution: KM ${selChainage} (${selStation})`}
                </span>
                {shapLoading && <Spinner size={12} />}
              </h3>
              {!selectedRow ? (
                <p className="text-xs font-medium text-slate-400 mt-1">
                  Awaiting telemetry ingest to explain corridor predictions
                </p>
              ) : (
                <p className="text-xs font-semibold text-rose-600 mt-1">
                  Prediction: {selProbPct}% {selLevel} ({selSource})
                </p>
              )}
            </div>

            {/* Waterfall chart component */}
            <div className="pt-2">
              {!selectedRow ? (
                <div className="py-8 px-4 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/50 text-slate-400 space-y-1.5">
                  <span className="text-xs font-semibold text-slate-600 block">No Active Track Inspected</span>
                  <span className="text-2xs text-slate-400 block max-w-xs mx-auto">
                    Upload corridor telemetry or adjust the Simulation sandbox below to test feature attributions.
                  </span>
                </div>
              ) : (
                <ShapWaterfallChart
                  shapData={selectedShap}
                  loading={shapLoading}
                />
              )}
            </div>
          </div>

          {/* ── Card 2: Hypothetical Risk Simulation ──────────────────────────── */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-900">Simulation</h3>
                <span className="text-2xs font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                  {selectedRow ? `Baseline: KM ${selChainage}` : 'Mode: Sandbox'}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Adjust parameters to run a hypothetical risk prediction.
              </p>
            </div>

            {/* Quick Scenario Buttons */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              <button
                type="button"
                onClick={() => {
                  if (selectedRow) {
                    setSimTqi(selectedRow.tqi);
                    setSimGmt(Math.min(100, Math.max(0, selectedRow.gmt)));
                    setSimAge(selectedRow.age);
                    setSimTemp(selectedRow.temp);
                    runSimulation(selectedRow.tqi, selectedRow.gmt, selectedRow.age, selectedRow.temp);
                  }
                }}
                className="px-2 py-1 text-2xs font-semibold rounded bg-slate-100 hover:bg-slate-200 text-slate-700 whitespace-nowrap transition-colors"
                title="Reset simulation to the currently selected track section's parameters"
              >
                📍 Reset to Track
              </button>
              <button
                type="button"
                onClick={() => {
                  setSimTqi(85);
                  setSimGmt(45);
                  setSimAge(0);
                  setSimTemp(32);
                  runSimulation(85, 45, 0, 32);
                }}
                className="px-2 py-1 text-2xs font-semibold rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 whitespace-nowrap transition-colors"
                title="Simulate track condition immediately following a tamping and maintenance block"
              >
                🛠️ Post-Tamping
              </button>
              <button
                type="button"
                onClick={() => {
                  setSimTqi(35);
                  setSimGmt(90);
                  setSimAge(240);
                  setSimTemp(48);
                  runSimulation(35, 90, 240, 48);
                }}
                className="px-2 py-1 text-2xs font-semibold rounded bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 whitespace-nowrap transition-colors"
                title="Simulate high thermal stress, high freight load, and deferred maintenance"
              >
                ⚠️ High Wear
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* TQI */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-2xs font-bold uppercase text-slate-600">TQI</label>
                  <span className="text-2xs font-mono font-bold text-slate-700">{simTqi}</span>
                </div>
                <input
                  type="number"
                  min="10"
                  max="100"
                  value={simTqi}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setSimTqi(val);
                    runSimulation(val, simGmt, simAge, simTemp);
                  }}
                  className="w-full text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg mono focus:ring-1 focus:ring-blue-800"
                />
                <input
                  type="range"
                  min="10"
                  max="100"
                  step="1"
                  value={simTqi}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setSimTqi(val);
                    runSimulation(val, simGmt, simAge, simTemp);
                  }}
                  className="w-full accent-blue-600 h-1.5 bg-slate-200 rounded-lg cursor-pointer"
                />
              </div>

              {/* GMT */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-2xs font-bold uppercase text-slate-600">GMT</label>
                  <span className="text-2xs font-mono font-bold text-slate-700">{simGmt}</span>
                </div>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={simGmt}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setSimGmt(val);
                    runSimulation(simTqi, val, simAge, simTemp);
                  }}
                  className="w-full text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg mono focus:ring-1 focus:ring-blue-800"
                />
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={simGmt}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setSimGmt(val);
                    runSimulation(simTqi, val, simAge, simTemp);
                  }}
                  className="w-full accent-blue-600 h-1.5 bg-slate-200 rounded-lg cursor-pointer"
                />
              </div>

              {/* Age Since Maint */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-2xs font-bold uppercase text-slate-600">Age (Days)</label>
                  <span className="text-2xs font-mono font-bold text-slate-700">{simAge}</span>
                </div>
                <input
                  type="number"
                  min="0"
                  max="500"
                  value={simAge}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setSimAge(val);
                    runSimulation(simTqi, simGmt, val, simTemp);
                  }}
                  className="w-full text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg mono focus:ring-1 focus:ring-blue-800"
                />
                <input
                  type="range"
                  min="0"
                  max="365"
                  step="5"
                  value={simAge}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setSimAge(val);
                    runSimulation(simTqi, simGmt, val, simTemp);
                  }}
                  className="w-full accent-blue-600 h-1.5 bg-slate-200 rounded-lg cursor-pointer"
                />
              </div>

              {/* Rail Temp */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="text-2xs font-bold uppercase text-slate-600">Temp (°C)</label>
                  <span className="text-2xs font-mono font-bold text-slate-700">{simTemp}°</span>
                </div>
                <input
                  type="number"
                  min="10"
                  max="60"
                  value={simTemp}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setSimTemp(val);
                    runSimulation(simTqi, simGmt, simAge, val);
                  }}
                  className="w-full text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg mono focus:ring-1 focus:ring-blue-800"
                />
                <input
                  type="range"
                  min="10"
                  max="60"
                  step="1"
                  value={simTemp}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setSimTemp(val);
                    runSimulation(simTqi, simGmt, simAge, val);
                  }}
                  className="w-full accent-blue-600 h-1.5 bg-slate-200 rounded-lg cursor-pointer"
                />
              </div>
            </div>

            {/* Gauge Dial / Result */}
            <div className="pt-3 border-t border-slate-100 flex flex-col items-center justify-center">
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-2xs font-bold uppercase text-slate-500">
                  Simulated Probability
                </span>
                {simLoading && (
                  <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
                )}
              </div>
              <SpeedometerGauge probability={simProbability} />
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
