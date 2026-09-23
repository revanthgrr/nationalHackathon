/**
 * DepartmentLettersPage — view and download block sanction letters.
 *
 * Department users see only their own department's executed blocks.
 * Each letter opens as an HTML page in a new tab for printing.
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getLetters, getLetterUrl } from '../api/client';
import type { LetterInfo } from '../types/api';
import { Spinner } from '../components/Spinner';

export function DepartmentLettersPage() {
  const { departmentName } = useAuth();
  const [letters, setLetters] = useState<LetterInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await getLetters();
        setLetters(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load letters');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <span>📄</span>
          <span>Official Block Sanction Letters</span>
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          {departmentName ?? 'Department'} Portal — formally executed railway block approvals with printable sanction letters
        </p>
      </div>

      {loading && (
        <div className="text-center py-16 bg-white border border-slate-200 rounded-xl space-y-3">
          <Spinner size={24} />
          <p className="text-xs text-slate-500">Retrieving executed block letters…</p>
        </div>
      )}

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-xs font-medium text-rose-800 flex items-center gap-2">
          <span className="text-base leading-none">⚠</span>
          <span>{error}</span>
        </div>
      )}

      {!loading && letters.length === 0 && (
        <div className="text-center py-16 bg-white border border-slate-200 rounded-xl space-y-2 shadow-xs">
          <div className="text-4xl">📄</div>
          <p className="text-base font-bold text-slate-800">No Sanction Letters Available Yet</p>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            Letters are generated automatically when candidate blocks are accepted and executed by the Section Controller.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {letters.map(letter => (
          <div
            key={letter.block_id}
            className="bg-white border border-slate-200 hover:border-blue-400 rounded-xl p-5 shadow-xs transition-all flex flex-col justify-between space-y-4"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-slate-900">
                  Block #{letter.block_id}
                </span>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 uppercase tracking-wide">
                  {letter.status}
                </span>
              </div>

              <div className="text-xs text-slate-600 space-y-1 bg-slate-50 p-3 rounded-lg border border-slate-100 font-mono">
                <div><span className="text-slate-400">Ref:</span> {letter.reference}</div>
                <div><span className="text-slate-400">Dept:</span> {letter.department}</div>
              </div>
            </div>

            <a
              href={getLetterUrl(letter.block_id)}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary w-full text-center text-xs py-2.5 no-underline"
            >
              <span>📄</span>
              <span>View &amp; Print Letter</span>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
