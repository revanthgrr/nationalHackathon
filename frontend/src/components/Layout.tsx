import { useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { ChatbotWidget } from './ChatbotWidget';

export type AdminPage =
  | 'scheduling'
  | 'dashboard'
  | 'pipeline'
  | 'risk'
  | 'delay'
  | 'disruption'
  | 'ingestion'
  | 'chainage';

export type DeptPage =
  | 'dept-upload'
  | 'dept-notifications'
  | 'dept-letters';

export type Page = AdminPage | DeptPage;

interface Props {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  children: ReactNode;
}

interface NavItem {
  id: Page;
  label: string;
  icon: string;
  description: string;
}

const adminNavItems: NavItem[] = [
  { id: 'scheduling', label: 'Scheduling & Gantt', icon: '📅', description: 'Gantt timeline, review queue & optimization' },
  { id: 'dashboard',  label: 'Overview',           icon: '📊', description: 'System health, pipeline metrics & stats' },
  { id: 'pipeline',   label: 'Pipeline Tracker',   icon: '🔄', description: '9-stage orchestrator & live status' },
  { id: 'risk',       label: 'Risk Prediction',    icon: '⚠️', description: 'XGBoost 14-day asset failure probability' },
  { id: 'delay',      label: 'Delay Prediction',   icon: '⏱️', description: 'GCN-LSTM corridor delay forecast' },
  { id: 'disruption', label: 'Disruptions',        icon: '🚨', description: 'Live incident reporting & re-optimization' },
  { id: 'ingestion',  label: 'Data Ingestion',     icon: '📥', description: 'Multi-source sensor & TMS data feeds' },
  { id: 'chainage',   label: 'Chainage Mapping',   icon: '📍', description: 'Linear coordinate resolver' },
];

const deptNavItems: NavItem[] = [
  { id: 'dept-upload',        label: 'Upload Data',     icon: '📤', description: 'Upload department maintenance & sensor data' },
  { id: 'dept-notifications', label: 'Notifications',   icon: '🔔', description: 'Decisions and real-time corridor alerts' },
  { id: 'dept-letters',       label: 'Sanction Letters', icon: '📄', description: 'Official executed block approval letters' },
];

const PAGE_META: Record<Page, { title: string; subtitle: string }> = {
  scheduling: { title: 'Corridor Scheduling & Field Review', subtitle: 'Automated block optimization, Gantt timeline & field approval gate' },
  dashboard: { title: 'Executive Overview', subtitle: 'Live division metrics, pipeline health and operational summary' },
  pipeline: { title: 'Pipeline Orchestrator', subtitle: 'Real-time execution tracker across all 9 RailSetu stages' },
  risk: { title: 'Track Risk Prediction', subtitle: 'Machine learning failure risk assessment with XGBoost & SHAP explainability' },
  delay: { title: 'Network Delay Prediction', subtitle: 'Spatiotemporal graph network delay forecasting across corridor stations' },
  disruption: { title: 'Disruption & Re-planning', subtitle: 'Live corridor incident reporting and rolling-horizon schedule adjustment' },
  ingestion: { title: 'Data Ingestion', subtitle: 'Station, GPS, and Mast location telemetry ingestion engine' },
  chainage: { title: 'Chainage Resolution', subtitle: 'Railway kilometer chainage resolver for heterogeneous coordinates' },
  'dept-upload': { title: 'Department Data Ingestion', subtitle: 'Submit maintenance requests and track measurement CSV files' },
  'dept-notifications': { title: 'Department Notifications', subtitle: 'Official block approval decisions and corridor disruption notices' },
  'dept-letters': { title: 'Block Sanction Letters', subtitle: 'Download and print formal railway sanction letters for sanctioned maintenance' },
};

export function Layout({ currentPage, onNavigate, children }: Props) {
  const { user, logout, role } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = role === 'section_controller' ? adminNavItems : deptNavItems;
  const isController = role === 'section_controller';
  const roleBadge = isController ? 'Section Controller' : (user?.department_name ? `${user.department_name} Dept` : 'Department');
  const currentMeta = PAGE_META[currentPage] ?? { title: 'RailSetu', subtitle: 'Railway Operational Optimization' };

  const handleNavClick = (pageId: Page) => {
    onNavigate(pageId);
    setMobileOpen(false);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 text-slate-800 font-sans">
      {/* ── Mobile Backdrop ── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-sm lg:hidden transition-opacity"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Persistent Light Sidebar ── */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-slate-200 flex flex-col
        transition-transform duration-200 ease-in-out lg:static lg:translate-x-0
        ${mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full lg:shadow-none'}
      `}>
        {/* Brand Header */}
        <div className="h-16 px-5 border-b border-slate-200 flex items-center justify-between bg-white">
          <div className="flex items-center gap-3">
            <span className="text-2xl" role="img" aria-label="train">🚂</span>
            <div>
              <div className="text-base font-extrabold tracking-wider text-slate-900 leading-tight">
                RAILSETU
              </div>
              <div className="text-[10px] font-semibold text-blue-800 tracking-wider uppercase">
                Secunderabad Div
              </div>
            </div>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1.5 text-slate-400 hover:text-slate-600 rounded-md"
            aria-label="Close menu"
          >
            ✕
          </button>
        </div>

        {/* Role Pill */}
        <div className="px-4 py-3 bg-slate-50/80 border-b border-slate-100 flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Portal</span>
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
            isController ? 'bg-blue-100 text-blue-800 border border-blue-200' : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
          }`}>
            {roleBadge}
          </span>
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {navItems.map(({ id, label, icon }) => {
            const active = currentPage === id;
            return (
              <button
                key={id}
                onClick={() => handleNavClick(id)}
                className={`
                  w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium flex items-center gap-3
                  transition-colors duration-150
                  ${active
                    ? 'bg-blue-50 text-blue-900 font-semibold shadow-xs border-l-4 border-blue-800 pl-2'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 border-l-4 border-transparent'
                  }
                `}
              >
                <span className="text-base flex-shrink-0">{icon}</span>
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </nav>

        {/* User Card & Logout */}
        <div className="p-4 border-t border-slate-200 bg-slate-50/50 space-y-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-blue-800 text-white flex items-center justify-center font-bold text-xs">
              {user?.display_name ? user.display_name.charAt(0).toUpperCase() : 'U'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-slate-900 truncate">
                {user?.display_name ?? 'User'}
              </p>
              <p className="text-[11px] text-slate-500 truncate" title={user?.email}>
                {user?.email}
              </p>
            </div>
          </div>
          <button
            onClick={logout}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 text-slate-600 rounded-md text-xs font-medium transition-colors"
          >
            <span>🚪</span>
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* ── Main Viewport ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-50">
        {/* Top Header Bar */}
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between flex-shrink-0 shadow-xs">
          <div className="flex items-center gap-3 min-w-0">
            {/* Hamburger Button on Mobile */}
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              aria-label="Open menu"
            >
              ☰
            </button>
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-400 font-medium">
                <span>{isController ? 'Section Controller' : 'Department Portal'}</span>
                <span>/</span>
                <span className="text-blue-800 font-semibold">{currentMeta.title}</span>
              </div>
              <h1 className="text-base font-bold text-slate-900 truncate tracking-tight">
                {currentMeta.title}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-100 text-slate-600 text-xs font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              Live Pipeline Active
            </span>
          </div>
        </header>

        {/* Content Area */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8">
          <div className="max-w-7xl mx-auto space-y-6">
            {children}
          </div>
        </main>
      </div>

      {/* Floating AI Assistant Widget */}
      <ChatbotWidget />
    </div>
  );
}
