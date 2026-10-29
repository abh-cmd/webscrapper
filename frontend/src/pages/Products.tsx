import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../lib/use-api';
import type { ProductListResponse } from '../api/types';
import { ErrorPanel, Loading, Empty } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';

const PAGE_SIZE = 20;
const RECENT_WINDOW_MS = 15 * 60 * 1000;

function isRecent(scrapedAt: string | null | undefined) {
  if (!scrapedAt) return false;
  return Date.now() - new Date(scrapedAt).getTime() < RECENT_WINDOW_MS;
}

function ProductCard({ p, onClick }: { p: any; onClick: () => void }) {
  return (
    <div className="card product-tile" onClick={onClick}>
      {isRecent(p.scraped_at) && <span className="demo-tag" style={{ position: 'absolute', top: 10, right: 10 }}>just crawled</span>}
      {p.primary_image_id ? (
        <img className="image-thumb" src={`/api/images/${p.primary_image_id}/file`} alt={p.product_name} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      ) : (
        <div className="image-thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 11 }}>No image</div>
      )}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 14, lineHeight: 1.3 }}>{p.product_name || p.item_name}</div>
        {p.price && <div style={{ fontWeight: 700, fontSize: 15, marginTop: 4 }}>{p.price} {p.currency}</div>}
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
          {[p.category, p.varietal].filter(Boolean).join(' · ') || <span style={{ color: 'var(--text-faint)' }}>—</span>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{p.source_site}</span>
          <div style={{ display: 'flex', gap: 5 }}>
            <StatusBadge label="AI enriched" tone="ok" />
            <StatusBadge label="approved" tone="ok" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Products() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [offset, setOffset] = useState(0);

  const { data, error, loading } = useApi<ProductListResponse>(
    () => api.get(`/products?search=${encodeURIComponent(committedSearch)}&limit=${PAGE_SIZE}&offset=${offset}`),
    [committedSearch, offset]
  );

  function submitSearch(e: FormEvent) {
    e.preventDefault();
    setOffset(0);
    setCommittedSearch(search);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p>Real rows from PostgreSQL — every one of these completed the full pipeline and was approved.</p>
        </div>
      </div>

      <form className="search-bar" onSubmit={submitSearch}>
        <input placeholder="Search by name, item number, producer…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn" type="submit">Search</button>
      </form>

      {loading && !data && <Loading />}
      {error ? <ErrorPanel error={error} /> : null}
      {data && data.products.length === 0 && <Empty label="No products yet — run the pipeline to add one." />}

      {data && data.products.length > 0 && (
        <>
          <div className="grid grid-4">
            {data.products.map((p: any) => (
              <ProductCard key={p.item_number} p={p} onClick={() => navigate(`/products/${encodeURIComponent(p.item_number)}`)} />
            ))}
          </div>
          <div className="pagination">
            <span>{data.total} total</span>
            <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>← Prev</button>
            <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)}</span>
            <button className="btn small" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}
