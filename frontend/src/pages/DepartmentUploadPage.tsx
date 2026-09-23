/**
 * DepartmentUploadPage — CSV upload form scoped to the department.
 *
 * Shows upload form + results from the CSV ingest endpoint.
 * Also displays recent uploads by this department.
 */

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getDepartmentUploads } from '../api/client';
import { getAuthToken } from '../api/client';
import type { IngestionRecord } from '../types/api';
import { Spinner } from '../components/Spinner';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8000';

interface UploadResult {
  inserted: number;
  failed: number;
  total_rows: number;
  filename: string;
  errors: Array<{ row: number; reason: string }>;
}

export function DepartmentUploadPage() {
  const { departmentName } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [records, setRecords] = useState<IngestionRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const data = await getDepartmentUploads();
        setRecords(data);
      } catch {
        // Silently fail — records are supplementary info
      } finally {
        setLoadingRecords(false);
      }
    })();
  }, [result]);

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setUploading(true);
    setResult(null);
    setUploadError(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const headers: Record<string, string> = {};
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`${BASE_URL}/ingest/csv`, {
        method: 'POST',
        headers,
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `HTTP ${res.status}`);
      }

      const data: UploadResult = await res.json();
      setResult(data);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Upload Card */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
        <div className="border-b border-slate-100 pb-3">
          <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <span>📤</span>
            <span>Upload Department Measurement Data</span>
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {departmentName ?? 'Department'} Portal — submit CSV files with location telemetry and maintenance parameters
          </p>
        </div>

        {/* Drop zone */}
        <div className="border-2 border-dashed border-blue-200 bg-blue-50/30 rounded-xl p-8 text-center space-y-3">
          <div className="text-4xl">📊</div>
          <div>
            <p className="text-sm font-semibold text-slate-800">
              Select or Drop Measurement CSV File
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Supports TMS, Track Recording Car, and OHE inspection spreadsheets
            </p>
          </div>
          <div className="pt-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              className="text-xs text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-blue-800 file:text-white hover:file:bg-blue-900 cursor-pointer"
            />
          </div>
        </div>

        <button
          onClick={handleUpload}
          disabled={uploading}
          className="w-full btn-primary py-3"
        >
          {uploading && <Spinner size={16} />}
          <span>{uploading ? 'Processing & Ingesting CSV…' : 'Upload and Ingest CSV'}</span>
        </button>
      </div>

      {/* Result Card */}
      {uploadError && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-xs font-medium text-rose-800 flex items-center gap-2">
          <span className="text-base leading-none">⚠</span>
          <span>{uploadError}</span>
        </div>
      )}

      {result && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6 space-y-3 shadow-xs">
          <h3 className="text-sm font-bold text-emerald-900 flex items-center gap-2">
            <span>✓</span>
            <span>Upload Completed Successfully — {result.filename}</span>
          </h3>
          <div className="flex flex-wrap gap-6 text-xs text-emerald-800">
            <div><strong className="font-bold">{result.inserted}</strong> records inserted</div>
            <div><strong className="font-bold text-slate-600">{result.failed}</strong> failed</div>
            <div><strong className="font-bold">{result.total_rows}</strong> total rows evaluated</div>
          </div>
          {result.errors.length > 0 && (
            <div className="mt-3 pt-3 border-t border-emerald-200/80">
              <p className="text-xs font-semibold text-rose-700 mb-1.5">Row-level Notice:</p>
              <div className="max-h-36 overflow-auto bg-white border border-rose-200 rounded-lg p-3 space-y-1">
                {result.errors.map((e, i) => (
                  <div key={i} className="text-xs text-rose-600 font-mono">
                    Row {e.row}: {e.reason}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Recent Uploads Table */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-4">
        <div className="border-b border-slate-100 pb-3">
          <h3 className="text-base font-bold text-slate-900">
            Recent Department Telemetry Records ({records.length})
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Latest records ingested by your department
          </p>
        </div>

        {loadingRecords ? (
          <div className="text-center py-10 text-slate-400">
            <Spinner size={20} />
          </div>
        ) : records.length === 0 ? (
          <div className="text-center py-12 bg-slate-50 border border-slate-200/80 rounded-xl space-y-2">
            <div className="text-3xl">📥</div>
            <p className="text-sm font-semibold text-slate-800">No Records Found for {departmentName ?? 'your department'}</p>
            <p className="text-xs text-slate-500">Upload a CSV file above to populate department telemetry.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-xs">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50 text-xs font-semibold text-slate-600 uppercase tracking-wide text-left">
                  <th className="px-4 py-3 border-b border-slate-200 mono w-16">ID</th>
                  <th className="px-4 py-3 border-b border-slate-200">Source System</th>
                  <th className="px-4 py-3 border-b border-slate-200">Station / Mast</th>
                  <th className="px-4 py-3 border-b border-slate-200">Chainage</th>
                  <th className="px-4 py-3 border-b border-slate-200">Status</th>
                  <th className="px-4 py-3 border-b border-slate-200 text-right">Ingested At</th>
                </tr>
              </thead>
              <tbody>
                {records.slice(0, 50).map((r, i) => (
                  <tr key={r.id} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                    <td className="px-4 py-3 border-b border-slate-100 mono text-slate-500">#{r.id}</td>
                    <td className="px-4 py-3 border-b border-slate-100 font-semibold text-slate-800">{r.source_system}</td>
                    <td className="px-4 py-3 border-b border-slate-100 mono text-slate-600">{r.station_code ?? r.mast_id ?? '—'}</td>
                    <td className="px-4 py-3 border-b border-slate-100 mono font-medium text-slate-700">
                      {r.chainage_km != null ? `${r.chainage_km.toFixed(3)} km` : '—'}
                    </td>
                    <td className="px-4 py-3 border-b border-slate-100">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                        r.chainage_processed
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-amber-50 text-amber-700 border border-amber-200'
                      }`}>
                        {r.chainage_processed ? 'Processed' : 'Pending'}
                      </span>
                    </td>
                    <td className="px-4 py-3 border-b border-slate-100 text-right text-xs text-slate-500">
                      {new Date(r.ingested_at).toLocaleString()}
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
