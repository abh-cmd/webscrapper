import { NavLink, Route, Routes } from 'react-router-dom';
import Home from './pages/Home';
import PipelineRunView from './pages/PipelineRunView';
import Products from './pages/Products';
import ProductDetail from './pages/ProductDetail';
import Jobs from './pages/Jobs';
import Database from './pages/Database';
import { useApi } from './lib/use-api';
import { api } from './api/client';
import type { HealthResponse } from './api/types';
import { StatusBadge } from './components/StatusBadge';

const NAV_ITEMS = [
  { to: '/', label: 'Run Pipeline', end: true },
  { to: '/products', label: 'Products' },
  { to: '/jobs', label: 'Jobs' },
  { to: '/database', label: 'Database' }
];

function SidebarFooter() {
  const { data } = useApi<HealthResponse>(() => api.get('/health'), [], 20000);
  if (!data) return null;
  return (
    <div className="sidebar-footer">
      <div className="dot-row">DB <StatusBadge label={data.database.connected ? 'connected' : 'error'} /></div>
      <div className="dot-row">AI <StatusBadge label={data.ai.isMock ? 'test' : (data.ai.verification?.status || 'ready')} tone={data.ai.isMock ? 'neutral' : undefined} /></div>
    </div>
  );
}

export default function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          WineOutlet
          <small>Product Data Pipeline</small>
        </div>
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            {item.label}
          </NavLink>
        ))}
        <SidebarFooter />
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/pipeline/:runId" element={<PipelineRunView />} />
          <Route path="/products" element={<Products />} />
          <Route path="/products/:itemNumber" element={<ProductDetail />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/database" element={<Database />} />
        </Routes>
      </main>
    </div>
  );
}
