import { useEffect } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import AuthGuard from './ui/AuthGuard';
import Sidebar from './ui/Sidebar';
import Login from './pages/Login';
import Overview from './pages/Overview';
import GameConfig from './pages/GameConfig';
import RpsTournaments from './pages/RpsTournaments';
import Rounds from './pages/Rounds';
import RoundDetail from './pages/RoundDetail';
import WalletCalls from './pages/WalletCalls';
import Sessions from './pages/Sessions';
import SessionDetail from './pages/SessionDetail';
import PendingJobs from './pages/PendingJobs';
import Reports from './pages/Reports';
import Credentials from './pages/Credentials';
import { useAuthStore } from './store/authStore';
import ToastHost from './ui/ToastHost';

function ProtectedLayout() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <Outlet />
      </main>
      <ToastHost />
    </div>
  );
}

export default function App() {
  const hydrate = useAuthStore((s) => s.hydrate);
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <AuthGuard>
            <ProtectedLayout />
          </AuthGuard>
        }
      >
        <Route path="/" element={<Overview />} />
        <Route path="/game-config" element={<GameConfig />} />
        <Route path="/rps-tournaments" element={<RpsTournaments />} />
        <Route path="/rounds" element={<Rounds />} />
        <Route path="/rounds/:id" element={<RoundDetail />} />
        <Route path="/wallet-calls" element={<WalletCalls />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/sessions/:id" element={<SessionDetail />} />
        <Route path="/pending-jobs" element={<PendingJobs />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/credentials" element={<Credentials />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
