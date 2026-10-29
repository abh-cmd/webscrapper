import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../lib/use-api';
import { ErrorPanel, Loading } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';
import { TechnicalDetails } from '../components/TechnicalDetails';

type AdminStatus = { database: { configured: boolean; tableCounts?: Record<string, number> } };
type ProductListResponse = { products: any[]; total: number };

export default function Database() {
  const navigate = useNavigate();
  const { data: status, error, loading } = useApi<AdminStatus>(() => api.get('/admin/status'), [], 10000);
  const { data: products } = useApi<ProductListResponse>(() => api.get('/products?limit=10'), [], 10000);
  const { data: images } = useApi<{ images: any[]; total: number }>(() => api.get('/images?limit=10'), [], 10000);

  if (loading && !status) return <Loading />;
  if (error) return <ErrorPanel error={error} />;
  if (!status) return null;

  if (!status.database.configured) {
    return <div className="empty-panel">DATABASE_URL is not configured — no data to show.</div>;
  }

  const counts = status.database.tableCounts || {};

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Database</h1>
          <p>Real PostgreSQL row counts and recent records — this is the actual database, viewed through the backend API (the browser never connects to Postgres directly).</p>
        </div>
      </div>

      <div className="section-title">Table row counts</div>
      <div className="grid grid-4">
        {Object.entries(counts).map(([table, count]) => (
          <div className="card stat-card" key={table}>
            <div className="label">{table}</div>
            <div className="value">{count}</div>
          </div>
        ))}
      </div>

      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Most recently updated products (products table)</span>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{products?.total ?? 0} total rows</span>
      </div>
      {products && products.products.length === 0 && <div className="empty-panel">No rows in the products table yet.</div>}
      {products && products.products.length > 0 && (
        <table className="data">
          <thead><tr><th>item_number</th><th>product_name</th><th>source_site</th><th>price</th><th>scraped_at</th></tr></thead>
          <tbody>
            {products.products.map((p: any) => (
              <tr key={p.item_number} className="clickable" onClick={() => navigate(`/products/${encodeURIComponent(p.item_number)}`)}>
                <td className="mono">{p.item_number}</td>
                <td>{p.product_name || p.item_name}</td>
                <td>{p.source_site}</td>
                <td>{p.price ? `${p.price} ${p.currency || ''}` : '—'}</td>
                <td>{p.scraped_at ? new Date(p.scraped_at).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Most recently stored images (images table)</span>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{images?.total ?? 0} total rows</span>
      </div>
      {images && images.images.length === 0 && <div className="empty-panel">No rows in the images table yet.</div>}
      {images && images.images.length > 0 && (
        <table className="data">
          <thead><tr><th>id</th><th>preview</th><th>format</th><th>dimensions</th><th>content_hash</th><th>references</th></tr></thead>
          <tbody>
            {images.images.map((img: any) => (
              <tr key={img.id}>
                <td className="mono">{img.id}</td>
                <td><img src={`/api/images/${img.id}/file`} alt="" style={{ width: 36, height: 36, objectFit: 'contain', background: '#0a0b0d', border: '1px solid var(--border)', borderRadius: 4 }} /></td>
                <td>{img.format}</td>
                <td>{img.width}×{img.height}</td>
                <td className="mono" style={{ fontSize: 11 }}>{img.contentHash?.slice(0, 16)}…</td>
                <td>{img.references?.length > 1 ? <StatusBadge label={`reused ×${img.references.length}`} tone="warn" /> : '1'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <TechnicalDetails>
        <div className="kv">
          <dt>Endpoint (products)</dt><dd className="mono">GET /api/products</dd>
          <dt>Endpoint (images)</dt><dd className="mono">GET /api/images</dd>
          <dt>Endpoint (table counts)</dt><dd className="mono">GET /api/admin/status</dd>
        </div>
      </TechnicalDetails>
    </div>
  );
}
