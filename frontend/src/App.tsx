import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { Layout } from './components/Layout';
import type { Page } from './components/Layout';

// Admin pages
import { DashboardPage } from './pages/DashboardPage';
import { IngestionPage } from './pages/IngestionPage';
import { ChainagePage } from './pages/ChainagePage';
import { RiskPage } from './pages/RiskPage';
import { DelayPage } from './pages/DelayPage';
import { SchedulingPage } from './pages/SchedulingPage';
import { DisruptionPage } from './pages/DisruptionPage';
import { PipelinePage } from './pages/PipelinePage';

// Department pages
import { DepartmentUploadPage } from './pages/DepartmentUploadPage';
import { DepartmentNotificationsPage } from './pages/DepartmentNotificationsPage';
import { DepartmentLettersPage } from './pages/DepartmentLettersPage';

// Auth
import { LoginPage } from './pages/LoginPage';

function AppContent() {
  const { isAuthenticated, isLoading, role } = useAuth();

  // Primary page for Section Controller is Scheduling, for Department is Upload
  const defaultPage: Page = role === 'section_controller' ? 'scheduling' : 'dept-upload';
  const [page, setPage] = useState<Page>(defaultPage);

  useEffect(() => {
    if (role === 'section_controller') {
      setPage(prev => (prev === 'dept-upload' || prev === 'dept-notifications' || prev === 'dept-letters') ? 'scheduling' : prev);
    } else if (role === 'department') {
      setPage(prev => (prev !== 'dept-upload' && prev !== 'dept-notifications' && prev !== 'dept-letters') ? 'dept-upload' : prev);
    }
  }, [role]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-600 font-sans">
        <div className="text-center space-y-3">
          <div className="text-5xl animate-bounce">🚂</div>
          <div className="text-sm font-semibold text-slate-800">Initializing RailSetu...</div>
          <p className="text-xs text-slate-400">South Central Railway Operational Optimization</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  const renderPage = () => {
    // Admin pages
    if (role === 'section_controller') {
      switch (page) {
        case 'scheduling':  return <SchedulingPage />;
        case 'dashboard':   return <DashboardPage />;
        case 'pipeline':    return <PipelinePage />;
        case 'risk':        return <RiskPage />;
        case 'delay':       return <DelayPage />;
        case 'disruption':  return <DisruptionPage />;
        case 'ingestion':   return <IngestionPage />;
        case 'chainage':    return <ChainagePage />;
        default:            return <SchedulingPage />;
      }
    }

    // Department pages
    switch (page) {
      case 'dept-upload':        return <DepartmentUploadPage />;
      case 'dept-notifications': return <DepartmentNotificationsPage />;
      case 'dept-letters':       return <DepartmentLettersPage />;
      default:                   return <DepartmentUploadPage />;
    }
  };

  return (
    <Layout currentPage={page} onNavigate={setPage}>
      {renderPage()}
    </Layout>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
