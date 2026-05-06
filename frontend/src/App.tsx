/**
 * C.O.V.E.R.T - Main Application Component
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AppLayout } from './components/layout/AppLayout';
import { LandingPage } from './pages/LandingPage';
import { ReporterDashboard } from './pages/ReporterDashboard';
import { SubmitReport } from './pages/SubmitReport';
import { MySubmissions } from './components/reporter/MySubmissions';
import { ProtocolModeratorDashboard } from './pages/ProtocolModeratorDashboard';
import { useRoleAccess } from './hooks/useRoleAccess';
import { ReportDetailPage } from './pages/ReportDetailPage';
import { PrivacyGuide } from './pages/PrivacyGuide';
import { DeptResponsePage } from './pages/DeptResponsePage';
import { AccountabilityPage } from './pages/AccountabilityPage';

/** Renders the role-appropriate dashboard at the single /dashboard route. */
function DashboardPage() {
  const { isModerator, loading } = useRoleAccess();

  if (loading) {
    return (
      <div className="py-16 text-center text-neutral-500">
        Loading dashboard…
      </div>
    );
  }

  if (isModerator) return <ProtocolModeratorDashboard />;
  return <ReporterDashboard />;
}

function App() {
  return (
    <BrowserRouter>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: '#1f2937',
            color: '#f9fafb',
          },
        }}
      />
      <Routes>
        {/* Landing page — standalone, no AppLayout */}
        <Route path="/" element={<LandingPage />} />

        {/* Main app routes with layout */}
        <Route element={<AppLayout />}>
          {/* Dashboard — renders reporter / reviewer / moderator view based on role */}
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/submit" element={<SubmitReport />} />
          <Route path="/my-reports" element={<MySubmissions />} />

          {/* Legacy paths → unified dashboard */}
          <Route path="/reviewer-dashboard" element={<Navigate to="/dashboard" replace />} />
          <Route path="/reviewer" element={<Navigate to="/dashboard" replace />} />
          <Route path="/moderator-dashboard" element={<Navigate to="/dashboard" replace />} />
          <Route path="/moderation" element={<Navigate to="/dashboard" replace />} />
          <Route path="/moderation/queue" element={<Navigate to="/dashboard" replace />} />
          <Route path="/moderation/history" element={<Navigate to="/dashboard" replace />} />
          <Route path="/moderation/stats" element={<Navigate to="/dashboard" replace />} />
          <Route path="/protocol-moderator" element={<Navigate to="/dashboard" replace />} />

          {/* Privacy guide — no wallet needed */}
          <Route path="/privacy-guide" element={<PrivacyGuide />} />

          {/* Report detail page */}
          <Route path="/report/:id" element={<ReportDetailPage />} />

          {/* Accountability dashboard — public */}
          <Route path="/accountability" element={<AccountabilityPage />} />
        </Route>

        {/* Department response — standalone, no AppLayout, no wallet */}
        <Route path="/dept-response/:token" element={<DeptResponsePage />} />

        {/* 404 fallback */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
