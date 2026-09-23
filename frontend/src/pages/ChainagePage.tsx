import { useState, useEffect, useCallback } from 'react';
import { postChainageProcess, getChainageLookup, getAllRecords } from '../api/client';
import type { LocationType, ChainageProcessResponse, IngestionRecord } from '../types/api';
import { Spinner } from '../components/Spinner';
import { InlineAlert } from '../components/InlineAlert';
import { RecordsTable } from '../components/RecordsTable';

function SectionHeading({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  return (
    <div>
      <h2 className="text-base font-bold text-slate-900">{children}</h2>
      {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
    </div>
  );
}

// ── Process Panel ───────────────────────────────────────────────────────────

function ProcessPanel() {
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState<ChainageProcessResponse | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const handleProcess = async () => {
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await postChainageProcess();
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Processing failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
      <div className="border-b border-slate-100 pb-3">
        <SectionHeading
          subtitle="Resolves chainage_km for unmapped telemetry where chainage_processed = false"
        >
          Batch Process Unprocessed Records
        </SectionHeading>
      </div>

      <p className="text-xs text-slate-600 leading-relaxed">
        Interpolates GPS coordinates against track geometry or maps station codes and mast markers to linear corridor kilometer coordinates. Safe to run repeatedly.
      </p>

      <button
        id="btn-process"
        onClick={handleProcess}
        disabled={loading}
        className="btn-primary"
      >
        {loading && <Spinner size={14} />}
        <span>{loading ? 'Processing Batch…' : 'Process Unprocessed Records'}</span>
      </button>

      {error && <InlineAlert type="error" message={error} />}

      {result && (
        <div className="space-y-4 pt-2">
          {/* Summary counts */}
          <div className="flex flex-wrap gap-4 text-xs bg-slate-50 border border-slate-200 p-3.5 rounded-xl font-medium">
            <div>
              <span className="text-slate-500">Processed: </span>
              <span className="font-bold text-emerald-700">{result.processed}</span>
            </div>
            <div>
              <span className="text-slate-500">Failed: </span>
              <span className={`font-bold ${result.failed > 0 ? 'text-rose-600' : 'text-slate-700'}`}>
                {result.failed}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Total Evaluated: </span>
              <span className="font-bold text-slate-900">{result.processed + result.failed}</span>
            </div>
          </div>

          {/* Failure table */}
          {result.failures.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-rose-700 uppercase tracking-wide">Processing Failures</p>
              <div className="rounded-xl border border-rose-200 overflow-hidden shadow-xs">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-rose-50/80 text-xs font-semibold text-rose-800 uppercase tracking-wide">
                      <th className="px-4 py-2.5 border-b border-rose-200 text-left w-20 mono">ID</th>
                      <th className="px-4 py-2.5 border-b border-rose-200 text-left">Failure Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.failures.map((f) => (
                      <tr key={f.id} className="bg-white">
                        <td className="px-4 py-2 border-b border-rose-100 mono text-slate-600 font-semibold">#{f.id}</td>
                        <td className="px-4 py-2 border-b border-rose-100 text-rose-600 text-xs font-mono">{f.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result.failures.length === 0 && result.processed > 0 && (
            <InlineAlert type="success" message="All records processed and resolved successfully." />
          )}
          {result.processed === 0 && result.failed === 0 && (
            <InlineAlert type="info" message="No unprocessed records found — all current telemetry is resolved." />
          )}
        </div>
      )}
    </div>
  );
}

// ── Lookup Tool ─────────────────────────────────────────────────────────────

function LookupTool() {
  const [locType, setLocType]   = useState<LocationType>('station');
  const [lat, setLat]           = useState('');
  const [lon, setLon]           = useState('');
  const [station, setStation]   = useState('');
  const [mast, setMast]         = useState('');
  const [loading, setLoading]   = useState(false);
  const [resultText, setResultText] = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const handleLookup = async () => {
    setLoading(true);
    setResultText(null);
    setError(null);
    try {
      const params =
        locType === 'gps'     ? { lat: Number(lat), lon: Number(lon) }
        : locType === 'station' ? { station_code: station }
        : { mast_id: mast };

      const res = await getChainageLookup(params);
      if (res.error) {
        setError(`${res.error} (source: ${res.source})`);
      } else {
        setResultText(`${res.chainage_km?.toFixed(3)} km  (source: ${res.source})`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
      <div className="border-b border-slate-100 pb-3">
        <SectionHeading
          subtitle="Test-resolve chainage_km for any coordinate, station code, or mast marker on the fly"
        >
          Interactive Chainage Resolver Tool
        </SectionHeading>
      </div>

      <div className="space-y-4">
        {/* Location type radio buttons */}
        <div className="flex flex-wrap gap-4 text-xs font-semibold text-slate-700">
          {(['station', 'gps', 'mast'] as LocationType[]).map((lt) => (
            <label key={lt} className="inline-flex items-center gap-2 cursor-pointer bg-slate-50 border border-slate-200 hover:bg-slate-100 px-3 py-1.5 rounded-lg transition-colors">
              <input
                type="radio"
                name="lookup-loctype"
                value={lt}
                checked={locType === lt}
                onChange={() => setLocType(lt)}
                className="text-blue-800 focus:ring-blue-800"
              />
              <span>{lt === 'station' ? 'Station Code' : lt === 'gps' ? 'GPS Coordinates' : 'OHE Mast ID'}</span>
            </label>
          ))}
        </div>

        {/* Inputs */}
        <div className="flex flex-wrap gap-3 items-center">
          {locType === 'gps' && (
            <div className="flex gap-2">
              <input
                id="lookup-lat"
                className="input-field w-36"
                type="number"
                step="any"
                placeholder="Latitude"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
              />
              <input
                id="lookup-lon"
                className="input-field w-36"
                type="number"
                step="any"
                placeholder="Longitude"
                value={lon}
                onChange={(e) => setLon(e.target.value)}
              />
            </div>
          )}
          {locType === 'station' && (
            <input
              id="lookup-station"
              className="input-field w-48 mono font-bold uppercase"
              type="text"
              placeholder="e.g. GHKT or SC"
              value={station}
              onChange={(e) => setStation(e.target.value.toUpperCase())}
            />
          )}
          {locType === 'mast' && (
            <input
              id="lookup-mast"
              className="input-field w-56 mono uppercase"
              type="text"
              placeholder="e.g. GHKT-M-001"
              value={mast}
              onChange={(e) => setMast(e.target.value.toUpperCase())}
            />
          )}

          <button
            id="btn-lookup"
            onClick={handleLookup}
            disabled={loading}
            className="btn-primary"
          >
            {loading && <Spinner size={14} />}
            <span>{loading ? 'Resolving…' : 'Resolve Chainage'}</span>
          </button>
        </div>

        {/* Result */}
        {resultText && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs flex items-center gap-2 text-emerald-900 font-medium">
            <span>✓</span>
            <span className="text-slate-500">Resolved Location:</span>
            <span className="font-bold mono text-emerald-800 text-sm">{resultText}</span>
          </div>
        )}
        {error && <InlineAlert type="error" message={error} />}
      </div>
    </div>
  );
}

// ── All Records Table ────────────────────────────────────────────────────────

function AllRecordsSection() {
  const [records, setRecords]     = useState<IngestionRecord[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAllRecords();
      setRecords(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load records.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
      <div className="flex items-center justify-between border-b border-slate-100 pb-3">
        <SectionHeading subtitle="Live view of all raw records and their linear kilometer resolution state">
          Corridor Telemetry Records ({records.length})
        </SectionHeading>
        <button
          onClick={fetchAll}
          disabled={loading}
          className="btn-secondary text-xs"
        >
          {loading ? <Spinner size={12} /> : <span>🔄</span>}
          <span>{loading ? 'Loading…' : 'Refresh'}</span>
        </button>
      </div>
      {error
        ? <InlineAlert type="error" message={error} />
        : <RecordsTable records={records} showChainage emptyMessage="No records found." />
      }
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function ChainagePage() {
  return (
    <div className="space-y-6">
      <ProcessPanel />
      <LookupTool />
      <AllRecordsSection />
    </div>
  );
}
