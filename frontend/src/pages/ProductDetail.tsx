import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../lib/use-api';
import type { ProductDetailResponse } from '../api/types';
import { ErrorPanel, JsonBlock, Loading } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';
import { TechnicalDetails } from '../components/TechnicalDetails';

// Only genuinely core fields always render, with "Not available" if
// missing; everything else only shows up if the source page actually had
// it — no wall of empty rows for fields that don't apply to this product.
const CORE_FIELDS: [string, string][] = [
  ['category', 'Category'], ['varietal', 'Varietal'], ['size', 'Size'], ['abv', 'ABV']
];
const OPTIONAL_FIELDS: [string, string][] = [
  ['producer', 'Producer'], ['brand', 'Brand'], ['subcategory', 'Subcategory'], ['color', 'Color'],
  ['vintage', 'Vintage'], ['availability_status', 'Availability'], ['upc', 'UPC'], ['sku', 'SKU'], ['region', 'Region']
];

function Field({ label, value }: { label: string; value: any }) {
  const isEmpty = value === null || value === undefined || value === '';
  return (
    <>
      <dt>{label}</dt>
      <dd style={isEmpty ? { color: 'var(--text-faint)' } : undefined}>{isEmpty ? 'Not available' : String(value)}</dd>
    </>
  );
}

function ImageCard({ ref_ }: { ref_: any }) {
  const img = ref_.image || {};
  return (
    <div className="card">
      <img
        className="image-thumb"
        src={`/api/images/${ref_.imageId}/file`}
        alt={ref_.role}
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
      />
      <div style={{ marginTop: 8, fontSize: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: 4 }}>
          <StatusBadge label={ref_.role} tone={ref_.role === 'placeholder' ? 'warn' : 'neutral'} />
          {ref_.isPrimary && <StatusBadge label="primary" tone="ok" />}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{img.format} · {img.width}×{img.height}</div>
        <TechnicalDetails>
          <dl className="kv" style={{ gridTemplateColumns: '90px 1fr', fontSize: 11.5 }}>
            <dt>Content hash</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{img.contentHash}</dd>
            <dt>Perceptual hash</dt><dd className="mono">{img.perceptualHash || 'n/a'}</dd>
            <dt>Storage path</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{img.storagePath}</dd>
            <dt>Source URL</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{ref_.sourceUrl}</dd>
          </dl>
        </TechnicalDetails>
      </div>
    </div>
  );
}

export default function ProductDetail() {
  const { itemNumber } = useParams();
  const { data, error } = useApi<ProductDetailResponse>(() => api.get(`/products/${encodeURIComponent(itemNumber!)}`), [itemNumber]);

  if (error) return <ErrorPanel error={error} />;
  if (!data) return <Loading />;

  const p = data.product;
  const presentOptional = OPTIONAL_FIELDS.filter(([key]) => p[key] !== null && p[key] !== undefined && p[key] !== '');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{p.product_name || p.item_name}</h1>
          <p className="mono">{p.item_number}{p.price ? ` · ${p.price} ${p.currency || ''}` : ''}</p>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>Product</h3>
          <dl className="kv">
            {CORE_FIELDS.map(([key, label]) => <Field key={key} label={label} value={p[key]} />)}
            {presentOptional.map(([key, label]) => <Field key={key} label={label} value={p[key]} />)}
          </dl>
        </div>

        <div className="card">
          <h3>Description &amp; Provenance</h3>
          <dl className="kv">
            <Field label="Description" value={p.product_description} />
            {p.food_pairing && <Field label="Food pairing" value={p.food_pairing} />}
            <Field label="Source" value={p.source_site} />
            <Field label="Scraped" value={p.scraped_at ? new Date(p.scraped_at).toLocaleString() : null} />
          </dl>
          <TechnicalDetails>
            <dl className="kv">
              <dt>Source URL</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{p.source_url}</dd>
            </dl>
          </TechnicalDetails>
        </div>
      </div>

      {Array.isArray(p.professional_ratings) && p.professional_ratings.length > 0 && (
        <>
          <div className="section-title">Professional ratings</div>
          <table className="data">
            <thead><tr><th>Rater</th><th>Rating</th><th>Description</th></tr></thead>
            <tbody>
              {p.professional_ratings.map((r: any, i: number) => (
                <tr key={i}><td>{r.rater}</td><td>{r.rating}</td><td>{r.description}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {data.aiExceptions.length > 0 && (
        <>
          <div className="section-title">AI findings</div>
          <table className="data">
            <thead><tr><th>Field</th><th>Current</th><th>Suggested</th><th>Status</th></tr></thead>
            <tbody>
              {data.aiExceptions.map((ex) => (
                <tr key={ex.id}>
                  <td>{ex.fieldName}</td>
                  <td>{String(ex.currentValue)}</td>
                  <td>{String(ex.suggestedValue)}</td>
                  <td><StatusBadge label={ex.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="section-title">Images</div>
      {data.images.length === 0 ? (
        <div className="empty-panel">No images stored for this product.</div>
      ) : (
        <div className="grid grid-4">
          {data.images.map((ref_) => <ImageCard key={ref_.id} ref_={ref_} />)}
        </div>
      )}

      <TechnicalDetails>
        <JsonBlock value={p} />
      </TechnicalDetails>
    </div>
  );
}
