/**
 * LoginPage — RailSetu enterprise authentication page.
 *
 * Crisp, modern light-themed railway design.
 * Routes to Section Controller or Department views based on returned role.
 */

import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid email or password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickFill = (demoEmail: string, demoPass: string) => {
    setEmail(demoEmail);
    setPassword(demoPass);
    setError(null);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100/80 p-4 font-sans text-slate-800">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-xl p-8 md:p-10 space-y-6">
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-50 border border-blue-100 text-3xl shadow-xs mb-1">
            🚂
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900 tracking-wider">
            RAILSETU
          </h1>
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-800">
            South Central Railway • Secunderabad Div
          </p>
          <p className="text-xs text-slate-500">
            Automated Corridor Block Planning & Operational Optimization
          </p>
        </div>

        {/* Error Notice */}
        {error && (
          <div className="bg-rose-50 border border-rose-200 text-rose-800 text-xs font-medium rounded-lg p-3 flex items-center gap-2">
            <span className="text-base leading-none">⚠</span>
            <span>{error}</span>
          </div>
        )}

        {/* Sign In Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5" htmlFor="login-email">
              Official Email
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="admin@railsetu.in"
              required
              autoFocus
              className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-800/15 focus:border-blue-800 transition-colors shadow-xs"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5" htmlFor="login-password">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-800/15 focus:border-blue-800 transition-colors shadow-xs"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-2 bg-blue-800 hover:bg-blue-900 active:bg-blue-950 text-white font-semibold text-sm py-3 px-4 rounded-lg shadow-sm transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed mt-2"
          >
            {loading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Authenticating...</span>
              </>
            ) : (
              <span>Sign In to RailSetu</span>
            )}
          </button>
        </form>

        {/* Quick Demo Accounts Selection */}
        <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-600 uppercase tracking-wide">
              Quick Demo Access
            </span>
            <span className="text-[10px] text-slate-400 font-mono">1-Click Auto-Fill</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <button
              type="button"
              onClick={() => handleQuickFill('admin@railsetu.in', 'admin123')}
              className="px-2.5 py-2 bg-white border border-slate-200 hover:border-blue-500 hover:bg-blue-50/50 rounded-lg text-slate-800 font-medium text-left transition-colors flex items-center gap-1.5 shadow-xs"
            >
              <span>👑</span>
              <span className="truncate">Section Controller</span>
            </button>
            <button
              type="button"
              onClick={() => handleQuickFill('civil@railsetu.in', 'civil123')}
              className="px-2.5 py-2 bg-white border border-slate-200 hover:border-blue-500 hover:bg-blue-50/50 rounded-lg text-slate-800 font-medium text-left transition-colors flex items-center gap-1.5 shadow-xs"
            >
              <span>🛠</span>
              <span className="truncate">Civil Dept</span>
            </button>
            <button
              type="button"
              onClick={() => handleQuickFill('electrical@railsetu.in', 'electrical123')}
              className="px-2.5 py-2 bg-white border border-slate-200 hover:border-blue-500 hover:bg-blue-50/50 rounded-lg text-slate-800 font-medium text-left transition-colors flex items-center gap-1.5 shadow-xs"
            >
              <span>⚡</span>
              <span className="truncate">Electrical Dept</span>
            </button>
            <button
              type="button"
              onClick={() => handleQuickFill('signalling@railsetu.in', 'signalling123')}
              className="px-2.5 py-2 bg-white border border-slate-200 hover:border-blue-500 hover:bg-blue-50/50 rounded-lg text-slate-800 font-medium text-left transition-colors flex items-center gap-1.5 shadow-xs"
            >
              <span>🚦</span>
              <span className="truncate">Signalling Dept</span>
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-2 text-center text-xs text-slate-400 space-y-1">
          <p>Indian Railways • Centre for Railway Information Systems</p>
          <p className="text-[11px] text-slate-400 font-mono">Secunderabad Corridor Pilot (SC – BBN)</p>
        </div>
      </div>
    </div>
  );
}
