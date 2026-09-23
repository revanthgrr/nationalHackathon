import type { IngestionRecord } from '../types/api';

function formatLocation(r: IngestionRecord): string {
  if (r.latitude != null && r.longitude != null)
    return `${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)}`;
  if (r.station_code) return r.station_code;
  if (r.mast_id)      return r.mast_id;
  return '—';
}

function locationTypeLabel(r: IngestionRecord): string {
  if (r.latitude != null)   return 'GPS';
  if (r.station_code)       return 'Station';
  if (r.mast_id)            return 'Mast';
  return '—';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function StatusBadge({ record }: { record: IngestionRecord }) {
  if (record.chainage_processed)
    return <span className="text-success font-medium">Processed</span>;
  if (record.chainage_error)
    return <span className="text-error" title={record.chainage_error}>Failed</span>;
  return <span className="text-pending">Pending</span>;
}

interface Props {
  records: IngestionRecord[];
  showChainage?: boolean;
  emptyMessage?: string;
  onDelete?: (id: number) => void;
  deletingId?: number | null;
}

/**
 * RecordsTable — shared table used on both pages.
 * When showChainage=false (Ingestion page) the chainage columns are hidden.
 */
export function RecordsTable({ records, showChainage = false, emptyMessage = 'No records.', onDelete, deletingId }: Props) {
  if (records.length === 0) {
    return <p className="text-sm text-gray-400 py-4">{emptyMessage}</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 shadow-xs">
      <table className="w-full text-sm border-collapse table-fixed-mono">
        <thead>
          <tr className="bg-slate-50 text-left text-xs font-semibold text-slate-600 uppercase tracking-wide">
            <th className="px-3.5 py-2.5 border-b border-slate-200 w-14 mono">ID</th>
            <th className="px-3.5 py-2.5 border-b border-slate-200 w-20">Source</th>
            <th className="px-3.5 py-2.5 border-b border-slate-200 w-16">Type</th>
            <th className="px-3.5 py-2.5 border-b border-slate-200">Location</th>
            <th className="px-3.5 py-2.5 border-b border-slate-200 w-40">Ingested At</th>
            {showChainage && (
              <>
                <th className="px-3.5 py-2.5 border-b border-slate-200 w-24 text-right">Chainage (km)</th>
                <th className="px-3.5 py-2.5 border-b border-slate-200 w-48">Error</th>
              </>
            )}
            <th className="px-3.5 py-2.5 border-b border-slate-200 w-24">Status</th>
              {onDelete && (
                <th className="px-3.5 py-2.5 border-b border-slate-200 w-10" aria-label="Actions" />
              )}
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => (
            <tr
              key={`${r.id}-${r.ingested_at}`}
              className={i % 2 === 0 ? 'bg-white hover:bg-slate-50/80 transition-colors' : 'bg-slate-50/70 hover:bg-slate-100/70 transition-colors'}
            >
              <td className="px-3.5 py-2 border-b border-slate-100 mono text-slate-500 font-medium">#{r.id}</td>
              <td className="px-3.5 py-2 border-b border-slate-100 font-semibold text-slate-800">{r.source_system}</td>
              <td className="px-3.5 py-2 border-b border-slate-100 text-slate-500 text-xs">{locationTypeLabel(r)}</td>
              <td className="px-3.5 py-2 border-b border-slate-100 mono text-slate-700 font-medium truncate max-w-[200px]" title={formatLocation(r)}>
                {formatLocation(r)}
              </td>
              <td className="px-3.5 py-2 border-b border-slate-100 text-slate-500 text-xs whitespace-nowrap">{formatDate(r.ingested_at)}</td>
              {showChainage && (
                <>
                  <td className="px-3.5 py-2 border-b border-slate-100 text-right mono text-slate-800 font-semibold">
                    {r.chainage_km != null ? r.chainage_km.toFixed(3) : '—'}
                  </td>
                  <td className="px-3.5 py-2 border-b border-slate-100 text-rose-600 text-xs truncate" title={r.chainage_error ?? ''}>
                    {r.chainage_error ?? '—'}
                  </td>
                </>
              )}
              <td className="px-3.5 py-2 border-b border-slate-100">
                <StatusBadge record={r} />
              </td>
              {onDelete && (
                <td className="px-2 py-2 border-b border-slate-100 text-center">
                  <button
                    onClick={() => onDelete(r.id)}
                    disabled={deletingId === r.id}
                    title="Delete record"
                    className="text-gray-300 hover:text-red-500 transition-colors disabled:opacity-40 text-base leading-none"
                    aria-label={`Delete record ${r.id}`}
                  >
                    {deletingId === r.id ? '…' : '×'}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
