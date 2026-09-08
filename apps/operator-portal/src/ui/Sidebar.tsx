import { NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

const nav = [
  { to: '/', label: 'Overview', end: true },
  { to: '/game-config', label: 'Game config' },
  { to: '/rps-tournaments', label: 'RPS tournaments' },
  { to: '/rounds', label: 'Rounds' },
  { to: '/wallet-calls', label: 'Wallet calls' },
  { to: '/sessions', label: 'Sessions' },
  { to: '/pending-jobs', label: 'Pending jobs' },
  { to: '/reports', label: 'Reports' },
  { to: '/credentials', label: 'Credentials' },
];

export default function Sidebar() {
  const operator = useAuthStore((s) => s.operator);
  const user = useAuthStore((s) => s.operatorUser);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <div className="sidebar__brand-mark">K</div>
        <div>
          <div className="sidebar__brand-title">Yantra</div>
          <div className="sidebar__brand-sub">Operator portal</div>
        </div>
      </div>

      <div className="sidebar__operator">
        <div className="sidebar__operator-name">{operator?.name ?? '—'}</div>
        <div className="sidebar__operator-meta">
          {operator?.jurisdiction} · {operator?.defaultCurrency}
        </div>
      </div>

      <nav className="sidebar__nav">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              isActive ? 'sidebar__link sidebar__link--active' : 'sidebar__link'
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar__footer">
        <div className="sidebar__user">
          <div>{user?.displayName ?? user?.email ?? 'Unknown user'}</div>
          <div className="sidebar__user-role">{user?.role ?? ''}</div>
        </div>
        <button type="button" className="btn btn--ghost" onClick={handleLogout}>
          Log out
        </button>
      </div>
    </aside>
  );
}
