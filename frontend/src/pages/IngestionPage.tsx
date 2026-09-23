import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChangeEvent, FormEvent, DragEvent } from 'react';
import { postIngest, getUnprocessed, deleteRecord, uploadCSV } from '../api/client';
import type { CsvUploadResult } from '../api/client';
import type { SourceSystem, LocationType, IngestionRecord } from '../types/api';
import { Spinner } from '../components/Spinner';
import { InlineAlert } from '../components/InlineAlert';
import { RecordsTable } from '../components/RecordsTable';

// ── Payload templates for ML-compatible records ───────────────────────────────

const RISK_TEMPLATE: Array<{ key: string; value: string }> = [
  { key: 'tqi',             value: '65.0'  },
  { key: 'gmt',             value: '70.0'  },
  { key: 'age_since_maint', value: '180.0' },
  { key: 'temperature',     value: '38.0'  },
];

const DELAY_TEMPLATE: Array<{ key: string; value: string }> = [
  { key: 'delay_minutes', value: '2.5' },
];

// ── CSV template content (60 delay rows + 5 risk rows) ─────────────────────────────────
// 12 time steps × 5 stations = 60 delay rows at 5-minute spacing.
// Plus 5 TMS risk rows (tqi, gmt, age_since_maint, temperature).
// observation_time is in UTC; change to your local timezone if needed.

const STATIONS = ['SC', 'MJF', 'AWL', 'GHKT', 'BBN'] as const;
const BASE_ISO  = '2026-09-21T09:00:00Z';   // adjust to actual data date
const DELAY_BY_STATION: Record<string, number[]> = {
  SC:   [2.5, 2.4, 2.6, 2.5, 2.3, 2.7, 2.4, 2.5, 2.6, 2.4, 2.5, 2.3],
  MJF:  [1.8, 1.9, 1.7, 1.8, 2.0, 1.8, 1.9, 1.7, 1.8, 1.9, 1.8, 2.0],
  AWL:  [3.2, 3.1, 3.3, 3.2, 3.0, 3.2, 3.1, 3.3, 3.2, 3.0, 3.1, 3.2],
  GHKT: [0.9, 1.0, 0.8, 0.9, 1.1, 0.9, 1.0, 0.8, 0.9, 1.0, 0.9, 1.1],
  BBN:  [4.1, 4.0, 4.2, 4.1, 3.9, 4.1, 4.0, 4.2, 4.1, 3.9, 4.0, 4.1],
};

function buildCsvTemplate(): string {
  const header = 'observation_time,source_system,station_code,mast_id,latitude,longitude,tqi,gmt,age_since_maint,temperature,delay_minutes';
  const rows: string[] = [header];

  // 60 delay rows (12 steps × 5 stations)
  const base = new Date(BASE_ISO).getTime();
  for (let step = 0; step < 12; step++) {
    const ts = new Date(base + step * 5 * 60 * 1000).toISOString().replace('.000Z', 'Z');
    for (const station of STATIONS) {
      const dm = DELAY_BY_STATION[station][step];
      rows.push(`${ts},SMMS,${station},,,,,,,,${dm}`);
    }
  }

  // 5 TMS risk rows (all at the same base timestamp)
  const riskTs = BASE_ISO;
  const riskData = [
    ['SC',   '65.0', '70.0', '180.0', '38.0'],
    ['MJF',  '72.0', '68.0',  '90.0', '36.5'],
    ['AWL',  '58.0', '62.0', '240.0', '40.0'],
    ['GHKT', '81.0', '75.0',  '60.0', '35.0'],
    ['BBN',  '74.0', '71.0', '120.0', '37.2'],
  ];
  for (const [sc, tqi, gmt, age, temp] of riskData) {
    rows.push(`${riskTs},TMS,${sc},,,,${tqi},${gmt},${age},${temp},`);
  }

  return rows.join('\n');
}

const CSV_TEMPLATE = buildCsvTemplate();

function downloadTemplate() {
  const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'railsetu_template.csv' });
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ── CSV Upload section component ──────────────────────────────────────────────

function CsvUploadSection({ onInserted }: { onInserted: () => void }) {
  const [dragging, setDragging]   = useState(false);
  const [file, setFile]           = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult]       = useState<CsvUploadResult | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: DragEvent) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = ()             => setDragging(false);
  const handleDrop = (e: DragEvent)      => {
    e.preventDefault(); setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) { setFile(dropped); setResult(null); setUploadErr(null); }
  };
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0] ?? null;
    if (chosen) { setFile(chosen); setResult(null); setUploadErr(null); }
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setResult(null);
    setUploadErr(null);
    try {
      const res = await uploadCSV(file);
      setResult(res);
      if (res.inserted > 0) onInserted();
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="bg-white border border-border rounded-md p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-gray-800">CSV Bulk Upload</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Upload a CSV file — every valid row is inserted as a new record with auto chainage resolution.
          </p>
        </div>
        <button
          id="btn-download-template"
          onClick={downloadTemplate}
          className="text-xs text-accent hover:underline border border-accent/30 rounded px-3 py-1.5 shrink-0"
        >
          ↓ Download Template
        </button>
      </div>

      {/* Drag-and-drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`relative rounded-lg border-2 border-dashed transition-colors cursor-pointer select-none
          ${ dragging ? 'border-accent bg-blue-50' : 'border-gray-200 hover:border-accent/60 hover:bg-gray-50' }`}
      >
        <input
          ref={inputRef}
          id="csv-file-input"
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={handleFileChange}
        />
        <div className="py-8 flex flex-col items-center gap-2 text-center">
          {file ? (
            <>
              <span className="text-2xl">📄</span>
              <p className="text-sm font-medium text-gray-700">{file.name}</p>
              <p className="text-xs text-gray-400">{(file.size / 1024).toFixed(1)} KB · click to change</p>
            </>
          ) : (
            <>
              <span className="text-3xl opacity-30">☁</span>
              <p className="text-sm text-gray-500">Drag &amp; drop a <span className="font-medium">.csv</span> file here</p>
              <p className="text-xs text-gray-400">or click to browse</p>
            </>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          id="btn-upload-csv"
          onClick={handleUpload}
          disabled={!file || uploading}
          className="btn-primary flex items-center gap-2"
        >
          {uploading && <Spinner size={13} />}
          {uploading ? 'Uploading…' : 'Upload & Insert Records'}
        </button>
        {file && !uploading && (
          <button
            onClick={() => { setFile(null); setResult(null); setUploadErr(null); if (inputRef.current) inputRef.current.value = ''; }}
            className="text-xs text-gray-400 hover:text-gray-700"
          >
            Clear
          </button>
        )}
      </div>

      {/* Error */}
      {uploadErr && <InlineAlert type="error" message={uploadErr} />}

      {/* Result card */}
      {result && (
        <div className="space-y-3">
          <div className={`rounded border px-4 py-3 text-sm ${
            result.failed === 0
              ? 'border-green-200 bg-green-50 text-green-800'
              : result.inserted === 0
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}>
            <span className="font-semibold">
              {result.inserted === result.total_rows ? '✓ All ' : ''}
              {result.inserted} of {result.total_rows} rows inserted
            </span>
            {result.failed > 0 && <span className="ml-2 text-xs">({result.failed} failed)</span>}
            <span className="ml-2 text-xs opacity-70">{result.filename}</span>
          </div>

          {result.errors.length > 0 && (
            <div className="rounded border border-red-200 overflow-hidden">
              <p className="px-3 py-1.5 text-xs font-semibold text-red-700 bg-red-50 border-b border-red-200">
                Row errors ({result.errors.length})
              </p>
              <div className="max-h-40 overflow-y-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-left text-gray-500 bg-gray-50">
                      <th className="px-3 py-1.5 border-b border-border w-16">Row</th>
                      <th className="px-3 py-1.5 border-b border-border">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.map((err, i) => (
                      <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                        <td className="px-3 py-1.5 border-b border-border mono text-red-600 font-medium">{err.row}</td>
                        <td className="px-3 py-1.5 border-b border-border text-red-700">{err.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Column guide */}
      <details className="text-xs text-gray-500">
        <summary className="cursor-pointer hover:text-gray-800 select-none font-medium">
          CSV column guide
        </summary>
        <div className="mt-3 space-y-3">
          {/* Timestamp distinction callout */}
          <div className="rounded border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            <p className="font-semibold mb-0.5">Two timestamps — different purposes</p>
            <p>
              <span className="font-mono font-semibold">observation_time</span> = when the telemetry/measurement actually occurred.
              Supply this in the CSV. Used by the GCN-LSTM for chronological sequencing.
            </p>
            <p className="mt-1">
              <span className="font-mono font-semibold">ingested_at</span> = when the system received the record (auto-set by the DB).
              Never set this manually.
            </p>
          </div>

          {/* Delay record requirement */}
          <div className="rounded border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <p className="font-semibold mb-0.5">Delay records require 3 fields together</p>
            <p>
              <span className="font-mono">station_code</span> (must be SC/MJF/AWL/GHKT/BBN) +
              <span className="font-mono ml-1">observation_time</span> +
              <span className="font-mono ml-1">delay_minutes</span>
            </p>
            <p className="mt-1">For GCN-LSTM: provide 12 time steps × 5 stations = 60 rows at 5-min spacing.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="border-collapse text-xs w-full">
              <thead>
                <tr className="bg-slate-50 text-left text-slate-600 font-semibold">
                  <th className="px-3 py-2 border border-slate-200">Column</th>
                  <th className="px-3 py-2 border border-slate-200">Required?</th>
                  <th className="px-3 py-2 border border-slate-200">Notes</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['observation_time', 'Yes (all rows)', 'ISO-8601, e.g. 2026-09-21T09:00:00Z — when the measurement occurred'],
                  ['source_system',    'Yes',            'TMS | SMMS | TDMS | COA'],
                  ['station_code',     'One of these',   'e.g. SC, MJF, AWL, GHKT, BBN — required for delay records'],
                  ['mast_id',          '↕',             'e.g. SC-M-001'],
                  ['latitude',         '↕',             'Decimal degrees (must pair with longitude)'],
                  ['longitude',        '↕',             'Decimal degrees (must pair with latitude)'],
                  ['tqi',              'Payload',        'XGBoost risk — Track Quality Index (0–100). Must be finite number.'],
                  ['gmt',              'Payload',        'XGBoost risk — Geometry Mean Track (0–100). Must be finite number.'],
                  ['age_since_maint',  'Payload',        'XGBoost risk — days since last maintenance. Must be finite number.'],
                  ['temperature',      'Payload',        'XGBoost risk — ambient °C. Must be finite number.'],
                  ['delay_minutes',    'Payload',        'GCN-LSTM delay — requires station_code. Must be finite number.'],
                  ['any other col',    'Optional',       'Stored as payload key→value string'],
                ].map(([col, req, notes], i) => (
                  <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/70'}>
                    <td className="px-3 py-2 border border-slate-200 mono text-slate-800 font-medium">{col}</td>
                    <td className="px-3 py-2 border border-slate-200 text-slate-700">{req}</td>
                    <td className="px-3 py-2 border border-slate-200 text-slate-500">{notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </div>
  );
}

// ── Section heading utility ──────────────────────────────────────────────────
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-base font-semibold text-gray-800 mb-3">{children}</h2>
  );
}

// ── Payload editor ─────────────────────────────────────────────────────────
interface KVPair { key: string; value: string; }

function PayloadEditor({ pairs, onChange }: {
  pairs: KVPair[];
  onChange: (pairs: KVPair[]) => void;
}) {
  const update = (i: number, field: 'key' | 'value', val: string) => {
    const next = pairs.map((p, idx) => idx === i ? { ...p, [field]: val } : p);
    onChange(next);
  };
  const remove = (i: number) => onChange(pairs.filter((_, idx) => idx !== i));
  const add    = () => onChange([...pairs, { key: '', value: '' }]);

  return (
    <div className="space-y-1.5">
      {pairs.map((p, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input
            className="flex-1 input-field"
            placeholder="key"
            value={p.key}
            onChange={(e) => update(i, 'key', e.target.value)}
          />
          <input
            className="flex-1 input-field"
            placeholder="value"
            value={p.value}
            onChange={(e) => update(i, 'value', e.target.value)}
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="text-gray-400 hover:text-error text-sm px-1"
            aria-label="Remove field"
          >×</button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs text-accent hover:underline mt-1"
      >
        + Add field
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────

export function IngestionPage() {
  // Form state
  const [source, setSource]           = useState<SourceSystem>('tms');
  const [locType, setLocType]         = useState<LocationType>('station');
  const [lat, setLat]                 = useState('');
  const [lon, setLon]                 = useState('');
  const [stationCode, setStationCode] = useState('');
  const [mastId, setMastId]           = useState('');
  const [kvPairs, setKvPairs]         = useState<KVPair[]>([]);

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [alert, setAlert]           = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // Unprocessed records table
  const [records, setRecords]         = useState<IngestionRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [recordsError, setRecordsError]     = useState<string | null>(null);
  const [deletingId, setDeletingId]         = useState<number | null>(null);

  const fetchRecords = useCallback(async () => {
    setLoadingRecords(true);
    setRecordsError(null);
    try {
      const data = await getUnprocessed();
      setRecords(data);
    } catch (e) {
      setRecordsError(e instanceof Error ? e.message : 'Failed to load records.');
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      await deleteRecord(id);
      setRecords(prev => prev.filter(r => r.id !== id));
    } catch (e) {
      setRecordsError(e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => { fetchRecords(); }, [fetchRecords]);

  // Build payload object from KV pairs
  const buildPayload = (): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    for (const { key, value } of kvPairs) {
      if (!key.trim()) continue;
      // Coerce numeric strings
      const num = Number(value);
      obj[key.trim()] = value !== '' && !isNaN(num) ? num : value;
    }
    return obj;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAlert(null);
    setSubmitting(true);

    try {
      const body = {
        payload: buildPayload(),
        ...(locType === 'gps'
          ? { latitude: lat !== '' ? Number(lat) : undefined, longitude: lon !== '' ? Number(lon) : undefined }
          : locType === 'station'
          ? { station_code: stationCode || undefined }
          : { mast_id: mastId || undefined }),
      };

      const result = await postIngest(source, body);
      setAlert({ type: 'success', msg: `Record #${result.id} ingested (source: ${result.source_system}).` });
      // Reset form
      setLat(''); setLon(''); setStationCode(''); setMastId(''); setKvPairs([]);
      // Refresh table
      await fetchRecords();
    } catch (e) {
      setAlert({ type: 'error', msg: e instanceof Error ? e.message : 'Ingestion failed.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Page header */}
      <div className="border-b border-border pb-4">
        <h1 className="text-xl font-semibold text-gray-900">Data Ingestion</h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload a CSV for bulk insert, or submit individual records manually.
        </p>
      </div>

      {/* ── CSV upload card ── */}
      <CsvUploadSection onInserted={fetchRecords} />

      {/* ── Form card ── */}
      <div className="bg-white border border-border rounded-md p-6">
        <SectionHeading>Submit Record</SectionHeading>
        <form onSubmit={handleSubmit} className="space-y-5">

          {/* Source system */}
          <div className="flex flex-col gap-1">
            <label className="form-label">Source System</label>
            <select
              id="source-system"
              className="input-field w-48"
              value={source}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setSource(e.target.value as SourceSystem)}
            >
              <option value="tms">TMS — Track Measurement</option>
              <option value="smms">SMMS — Signal Monitoring</option>
              <option value="tdms">TDMS — Train Dynamics</option>
              <option value="coa">COA — Change of Asset</option>
            </select>
          </div>

          {/* Location type selector */}
          <div className="flex flex-col gap-1">
            <label className="form-label">Location Type</label>
            <div className="flex gap-4">
              {(['gps', 'station', 'mast'] as LocationType[]).map((lt) => (
                <label key={lt} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="loctype"
                    value={lt}
                    checked={locType === lt}
                    onChange={() => setLocType(lt)}
                    className="accent-accent"
                  />
                  {lt === 'gps' ? 'GPS (lat/lon)' : lt === 'station' ? 'Station Code' : 'Mast ID'}
                </label>
              ))}
            </div>
          </div>

          {/* Location inputs */}
          {locType === 'gps' && (
            <div className="flex gap-3">
              <div className="flex flex-col gap-1 flex-1">
                <label className="form-label">Latitude</label>
                <input id="lat" className="input-field" type="number" step="any" placeholder="17.4941"
                  value={lat} onChange={(e) => setLat(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1 flex-1">
                <label className="form-label">Longitude</label>
                <input id="lon" className="input-field" type="number" step="any" placeholder="78.5908"
                  value={lon} onChange={(e) => setLon(e.target.value)} />
              </div>
            </div>
          )}
          {locType === 'station' && (
            <div className="flex flex-col gap-1">
              <label className="form-label">Station Code</label>
              <input id="station-code" className="input-field w-48 mono" type="text"
                placeholder="e.g. GHKT, AWL, SC"
                value={stationCode}
                onChange={(e) => setStationCode(e.target.value.toUpperCase())}
              />
              <span className="text-xs text-gray-400 mt-0.5">Known: SC, MJF, AWL, GHKT, BBN</span>
            </div>
          )}
          {locType === 'mast' && (
            <div className="flex flex-col gap-1">
              <label className="form-label">Mast ID</label>
              <input id="mast-id" className="input-field w-64 mono" type="text"
                placeholder="e.g. GHKT-M-001"
                value={mastId}
                onChange={(e) => setMastId(e.target.value.toUpperCase())}
              />
              <span className="text-xs text-gray-400 mt-0.5">Known: SC-M-001/002, MJF-M-001/002, AWL-M-001/002, GHKT-M-001/002, BBN-M-001</span>
            </div>
          )}

          {/* Payload */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between mb-1">
              <label className="form-label">Payload Fields</label>
              <span className="flex gap-2 text-xs">
                <span className="text-gray-400">Templates:</span>
                <button
                  type="button"
                  id="template-risk"
                  onClick={() => {
                    setKvPairs(RISK_TEMPLATE.map(t => ({ ...t })));
                    setSource('tms');
                  }}
                  className="text-accent hover:underline"
                >
                  Risk (TMS)
                </button>
                <span className="text-gray-300">|</span>
                <button
                  type="button"
                  id="template-delay"
                  onClick={() => setKvPairs(DELAY_TEMPLATE.map(t => ({ ...t })))}
                  className="text-accent hover:underline"
                >
                  Delay
                </button>
              </span>
            </div>
            <PayloadEditor pairs={kvPairs} onChange={setKvPairs} />
            <p className="text-xs text-gray-400 mt-1">
              Risk records need: <span className="mono">tqi, gmt, age_since_maint, temperature</span>. &nbsp;
              Delay records need: <span className="mono">delay_minutes</span> (+ station_code location).
            </p>
          </div>

          {/* Alert */}
          {alert && <InlineAlert type={alert.type} message={alert.msg} />}

          {/* Submit */}
          <div>
            <button
              type="submit"
              id="submit-ingest"
              disabled={submitting}
              className="btn-primary flex items-center gap-2"
            >
              {submitting && <Spinner size={14} />}
              {submitting ? 'Submitting…' : 'Submit Record'}
            </button>
          </div>
        </form>
      </div>

      {/* ── Unprocessed records table ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <SectionHeading>Unprocessed Records</SectionHeading>
          <button
            onClick={fetchRecords}
            disabled={loadingRecords}
            className="text-xs text-accent hover:underline flex items-center gap-1"
          >
            {loadingRecords && <Spinner size={12} />}
            {loadingRecords ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {recordsError
          ? <InlineAlert type="error" message={recordsError} />
          : <RecordsTable
              records={records}
              showChainage={false}
              emptyMessage="No unprocessed records."
              onDelete={handleDelete}
              deletingId={deletingId}
            />
        }
      </div>
    </div>
  );
}
