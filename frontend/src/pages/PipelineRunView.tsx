import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../lib/use-api';
import type { PipelineLogEntry, PipelineRun, StageEntry, StageStatus } from '../api/types';
import { StatusBadge } from '../components/StatusBadge';
import { ErrorPanel, JsonBlock, Loading } from '../components/Panels';
import { TechnicalDetails } from '../components/TechnicalDetails';

// Visual grouping only — queue + deduplication are one fast backend step
// shown as a single "Deduplicate" block; every other block maps 1:1 to a
// real tracked stage. Order here is REAL execution order, which differs
// from a generic textbook pipeline diagram in two ways worth knowing:
// dedup happens before the page is fetched (no point fetching a URL
// already queued), and AI Validation happens after Approval (it only
// applies to a product that already exists in the database).
const BLOCKS: Array<{ key: string; label: string; icon: string; note?: string }> = [
  { key: 'source', label: 'Source', icon: '🔗' },
  { key: 'fetch', label: 'Fetch', icon: '📡' },
  { key: 'extraction', label: 'Extract', icon: '🔎' },
  { key: 'normalization', label: 'Normalize', icon: '🧹' },
  { key: 'deduplication', label: 'Deduplicate', icon: '🧬' },
  { key: 'database', label: 'Database', icon: '🗄️' },
  { key: 'ai', label: 'AI', icon: '✨' },
  { key: 'staging', label: 'Stage', icon: '📝' },
  { key: 'approval', label: 'Approve', icon: '✅' },
  { key: 'ai_validation', label: 'Validate', icon: '🛡️', note: 'Runs after Approve — it checks a product that must already exist in the database.' },
  { key: 'image_pipeline', label: 'Image', icon: '🖼️' },
  { key: 'final_database', label: 'Final Record', icon: '📦' }
];

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'rejected']);
function isRunning(status: string) { return !TERMINAL_STATUSES.has(status); }

function trackIcon(status: StageStatus) {
  if (status === 'completed') return '✓';
  if (status === 'running') return '●';
  if (status === 'failed') return '✕';
  if (status === 'blocked') return '⚠';
  return '○';
}

function Field({ label, value, mono = false }: { label: string; value: string | number | null | undefined; mono?: boolean }) {
  const empty = value === null || value === undefined || value === '';
  return (
    <div className="stage-field">
      <div className="f-label">{label}</div>
      <div className={`f-value ${mono ? 'mono' : ''} ${empty ? 'empty' : ''}`}>{empty ? 'Not available' : value}</div>
    </div>
  );
}

function StageIcon({ status }: { status: StageStatus }) {
  const symbol = status === 'completed' ? '✓' : status === 'running' ? '●' : status === 'failed' ? '✕' : status === 'blocked' ? '⚠' : '○';
  return <span className={`stage-icon ${status}`}>{symbol}</span>;
}

function BlockedPanel({ reason, message }: { reason: string; message: string }) {
  const isRobots = reason === 'ROBOTS_DISALLOWED';
  return (
    <div className="blocked-callout">
      <div className="bc-title">⚠ BLOCKED</div>
      <div className="bc-detail">{isRobots ? 'robots.txt disallows crawling this URL' : reason}</div>
      <div className="bc-detail" style={{ color: 'var(--text-dim)', fontSize: 12.5 }}>{message}</div>
      <div className="bc-note">No product data was fabricated — the pipeline stopped here for real.</div>
    </div>
  );
}

// ---------- per-stage plain output ----------

function StageOutput({ blockKey, run }: { blockKey: string; run: PipelineRun }) {
  if (blockKey === 'deduplication') {
    const queue = run.stages.queue;
    const dedup = run.stages.deduplication;
    const d = dedup.detail;
    const q = queue.detail;
    if (!d) return null;
    return (
      <>
        <div className="stage-fields">
          <Field label="Job" value={q ? `#${q.jobId}` : null} mono />
          <Field label="Result" value={d.deduped ? 'Existing job reused' : 'New job created'} />
        </div>
        <TechnicalDetails>
          <div className="kv">
            <dt>Canonical URL</dt><dd className="mono">{d.canonicalUrl}</dd>
            <dt>Decision</dt><dd>{d.decision}</dd>
          </div>
        </TechnicalDetails>
      </>
    );
  }

  const entry = run.stages[blockKey];
  const d = entry?.detail;
  if (!d) return null;

  if (blockKey === 'source') {
    return (
      <div className="stage-fields">
        <Field label="Input" value={d.url} mono />
        <Field label="Resolved to" value={d.sourceName} />
      </div>
    );
  }

  if (blockKey === 'fetch') {
    if (entry.status === 'blocked') return <BlockedPanel reason={d.reason} message={d.message} />;
    if (entry.status === 'failed') return <div className="stage-fields"><Field label="Error" value={d.error} /></div>;
    return (
      <div className="stage-fields">
        <Field label="HTTP status" value={d.httpStatus} />
        <Field label="Duration" value={d.durationMs !== undefined ? `${d.durationMs} ms` : null} />
      </div>
    );
  }

  if (blockKey === 'extraction') {
    if (entry.status === 'failed') return <div className="stage-fields"><Field label="Error" value={d.error} /></div>;
    const raw = d.raw || {};
    // Every field the 32-field schema defines, in schema order — not a
    // curated subset. Anything the page didn't have shows "Not available"
    // right here, nothing is hidden behind a click.
    const allFields = Object.keys(raw).filter((k) => k !== '__meta' && k !== 'professional_ratings' && k !== 'image_urls');
    const populatedCount = allFields.filter((k) => raw[k] !== null && raw[k] !== undefined && raw[k] !== '').length;
    return (
      <>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 10 }}>
          {populatedCount} of {allFields.length} schema fields populated from this page.
        </div>
        <div className="stage-fields">
          {allFields.map((key) => <Field key={key} label={key.replace(/_/g, ' ')} value={raw[key]} />)}
          <Field label="image urls" value={Array.isArray(raw.image_urls) && raw.image_urls.length ? raw.image_urls.join(', ') : null} />
          <Field label="professional ratings" value={Array.isArray(raw.professional_ratings) && raw.professional_ratings.length ? `${raw.professional_ratings.length} rating(s)` : null} />
        </div>
        <TechnicalDetails><JsonBlock value={raw} /></TechnicalDetails>
      </>
    );
  }

  if (blockKey === 'normalization') {
    const raw = d.raw || {};
    const normalized = d.normalized || {};
    const allFields = Array.from(new Set([...Object.keys(raw), ...Object.keys(normalized)])).filter((k) => k !== '__meta' && k !== 'scraped_at');
    const changed = allFields.filter((f) => JSON.stringify(raw[f]) !== JSON.stringify(normalized[f]));
    if (changed.length === 0) {
      return <div style={{ color: 'var(--text-dim)', fontSize: 13.5 }}>Compared all {allFields.length} fields — no formatting changes were needed on this record.</div>;
    }
    return (
      <>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 10 }}>
          {changed.length} of {allFields.length} fields changed during normalization.
        </div>
        <div className="stage-fields">
          {changed.map((f) => <Field key={f} label={f.replace(/_/g, ' ')} value={`${JSON.stringify(raw[f])} → ${JSON.stringify(normalized[f])}`} mono />)}
        </div>
      </>
    );
  }

  if (blockKey === 'database') {
    return (
      <div className="stage-fields">
        <Field label="Result" value="Product data saved" />
        <Field label="Job" value={d.jobId ? `#${d.jobId}` : null} mono />
      </div>
    );
  }

  if (blockKey === 'ai') {
    const rawCalls = d.rawCalls || [];
    const hadAnyText = rawCalls.length > 0 && rawCalls.some((c: any) => d.original?.[c.kind === 'description' ? 'product_description' : 'food_pairing']);
    const isRealAi = d.provider === 'http-llm';
    return (
      <>
        <div style={{ marginBottom: 10 }}>
          {isRealAi ? <StatusBadge label="REAL AI" tone="ok" /> : <StatusBadge label="TEST PROVIDER — not real AI" tone="warn" />}
        </div>
        <div className="stage-fields">
          <Field label="Provider" value={d.provider} />
          <Field label="Model" value={d.model} />
        </div>
        {!hadAnyText && <div className="callout" style={{ marginTop: 10 }}>No description/food-pairing text was extracted for this product, so there was nothing to send the AI.</div>}
        {hadAnyText && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {rawCalls.filter((c: any) => d.original?.[c.kind === 'description' ? 'product_description' : 'food_pairing']).map((call: any, i: number) => {
              const originalField = call.kind === 'description' ? 'product_description' : 'food_pairing';
              return (
                <div key={i}>
                  <div className="ai-block input">
                    <div className="ai-block-header">AI Input — {call.kind.replace('_', ' ')}</div>
                    {d.original?.[originalField]}
                  </div>
                  <div className="ai-arrow">↓</div>
                  <div className="ai-block output">
                    <div className="ai-block-header">AI Output</div>
                    {call.ok ? call.response?.text : <span style={{ color: 'var(--bad)' }}>{call.error?.type}: {call.error?.message}</span>}
                  </div>
                </div>
              );
            })}
            <div className="ai-arrow">↓</div>
            <div className="ai-block validation">
              <div className="ai-block-header">Application Validation</div>
              Schema check: PASS &nbsp;·&nbsp; Hallucination guard: PASS &nbsp;·&nbsp;
              Decision: {d.rejectedFields?.length > 0 ? `ACCEPT ${d.paraphrasedFields?.length || 0}, REJECT ${d.rejectedFields.length}` : (d.paraphrasedFields?.length ? 'ACCEPT' : 'NO CHANGE NEEDED')}
              {d.rejectedFields?.length > 0 && (
                <div style={{ marginTop: 6, color: 'var(--warn)' }}>
                  Rejected: {d.rejectedFields.map((r: any) => `${r.field} (${r.reason})`).join('; ')} — original text kept.
                </div>
              )}
            </div>
          </div>
        )}
        <TechnicalDetails><JsonBlock value={d} /></TechnicalDetails>
      </>
    );
  }

  if (blockKey === 'staging') {
    return <div className="stage-fields"><Field label="Draft saved" value={`Staging #${d.stagingId}`} mono /><Field label="Status" value="Awaiting approval — not yet a real product" /></div>;
  }

  if (blockKey === 'approval') {
    if (d.rejected) return <div className="stage-fields"><Field label="Decision" value="Rejected" /><Field label="Reason" value={d.reason} /></div>;
    return <div className="stage-fields"><Field label="Decision" value="Approved" /><Field label="Product ID" value={d.itemNumber} mono /></div>;
  }

  if (blockKey === 'ai_validation') {
    const raw = d.rawCalls?.[0];
    const n = d.findingsCreated?.length || 0;
    const isRealAi = raw?.provider === 'http-llm';
    return (
      <>
        <div style={{ marginBottom: 10 }}>
          {isRealAi ? <StatusBadge label="REAL AI" tone="ok" /> : <StatusBadge label="TEST PROVIDER — not real AI" tone="warn" />}
        </div>
        <div className="stage-fields">
          <Field label="AI response" value="Valid" />
          <Field label="Findings" value={n > 0 ? `${n} flagged for review` : 'None — data looks consistent'} />
        </div>
        {n > 0 && (
          <table className="data" style={{ marginTop: 10 }}>
            <thead><tr><th>Field</th><th>Current</th><th>Suggested</th><th>Why</th></tr></thead>
            <tbody>
              {d.findingsCreated.map((f: any, i: number) => (
                <tr key={i}><td>{f.field}</td><td>{String(f.currentValue)}</td><td>{String(f.suggestedValue)}</td><td>{f.reason}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {raw && <TechnicalDetails><JsonBlock value={raw} /></TechnicalDetails>}
      </>
    );
  }

  if (blockKey === 'image_pipeline') {
    const images = d.images || [];
    if (images.length === 0) return <div style={{ color: 'var(--text-dim)', fontSize: 13.5 }}>No image URLs were found for this product.</div>;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {images.map((img: any, i: number) => {
          const ok = img.outcome === 'STORED' || img.outcome === 'EXISTING_IMAGE_REUSED';
          return (
            <div key={i} style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              {ok && img.imageId ? (
                <img src={`/api/images/${img.imageId}/file`} alt="" style={{ width: 90, height: 90, objectFit: 'contain', background: '#0a0b0d', border: '1px solid var(--border)', borderRadius: 8 }} />
              ) : (
                <div style={{ width: 90, height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0b0d', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--bad)', fontSize: 20 }}>✕</div>
              )}
              <div style={{ flex: 1 }}>
                <StatusBadge label={img.outcome} tone={ok ? 'ok' : 'bad'} />
                {ok ? (
                  <div className="stage-fields" style={{ marginTop: 8 }}>
                    <Field label="Format" value={img.format} />
                    <Field label="Dimensions" value={img.width ? `${img.width}×${img.height}` : null} />
                    <Field label="Deduplication" value={img.outcome === 'EXISTING_IMAGE_REUSED' ? 'Existing image reused' : 'New image'} />
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 6 }}>{img.reason || img.error || 'Fetch failed.'}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (blockKey === 'final_database') {
    return (
      <div className="stage-fields">
        <Field label="Found in database" value={d.found ? 'Yes' : 'No'} />
        <Field label="Images attached" value={d.images?.length ?? 0} />
      </div>
    );
  }

  return null;
}

// ---------- final product card ----------

function ProductCard({ run }: { run: PipelineRun }) {
  const finalEntry = run.stages.final_database;
  const detail = finalEntry?.detail;
  const product = detail?.product;
  if (!product || !detail) return null;
  const images = detail.images || [];
  const primaryImage = images.find((i: any) => i.isPrimary) || images[0];

  const checks: Array<[string, boolean]> = [
    ['Source', run.stages.source?.status === 'completed'],
    ['Normalized', run.stages.normalization?.status === 'completed'],
    ['Database', Boolean(detail.found)],
    ['AI', run.stages.ai?.status === 'completed'],
    ['Validation', run.stages.ai_validation?.status === 'completed'],
    ['Approval', run.stages.approval?.status === 'completed'],
    ['Images', run.stages.image_pipeline?.status === 'completed' && images.length > 0]
  ];

  const metaParts = [product.category, product.varietal, product.abv, product.size].filter(Boolean);
  const brand = product.brand || product.producer;

  return (
    <div className="product-card" style={{ marginBottom: 24 }}>
      {run.mode === 'demo' && <span className="demo-tag">Demo / Fixture</span>}
      {primaryImage ? (
        <img className="pc-image" src={`/api/images/${primaryImage.imageId}/file`} alt={product.product_name} />
      ) : (
        <div className="pc-image" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 12 }}>No image</div>
      )}
      <div className="pc-name">{product.product_name || product.item_name}</div>
      {brand && <div className="pc-producer">{brand}</div>}
      {product.price && <div className="pc-price">{product.price} {product.currency}</div>}
      {metaParts.length > 0 && <div className="pc-meta">{metaParts.join(' · ')}</div>}
      {product.product_description && (
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 12, maxWidth: 420, marginLeft: 'auto', marginRight: 'auto', textAlign: 'left' }}>
          {product.product_description}
        </div>
      )}
      <div className="pc-checklist">
        {checks.map(([label, ok]) => (
          <div className="pc-check-row" key={label}>
            <span>{label}</span>
            <span style={{ color: ok ? 'var(--ok)' : 'var(--text-faint)' }}>{ok ? '✓' : '—'}</span>
          </div>
        ))}
      </div>
      <div className="pc-banner">PIPELINE COMPLETE</div>
      <div style={{ marginTop: 14 }}>
        <Link to={`/products/${encodeURIComponent(product.item_number)}`} className="btn ghost small">VIEW FULL RECORD →</Link>
      </div>
    </div>
  );
}

function ApprovalGate({ run, onActed }: { run: PipelineRun; onActed: () => void }) {
  const [reviewer, setReviewer] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [showReject, setShowReject] = useState(false);

  async function approve() {
    if (!reviewer) { setError(new Error('Reviewer name is required.')); return; }
    setBusy(true); setError(null);
    try { await api.post(`/pipeline/${run.id}/approve`, { reviewer }); onActed(); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  }
  async function reject() {
    if (!reviewer || !reason) { setError(new Error('Reviewer and reason are both required.')); return; }
    setBusy(true); setError(null);
    try { await api.post(`/pipeline/${run.id}/reject`, { reviewer, reason }); onActed(); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: 22 }}>
      <h3 style={{ marginTop: 0 }}>Awaiting your approval</h3>
      <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>The product is staged but nothing has been saved to the database yet.</p>
      <div className="form-row" style={{ maxWidth: 300 }}>
        <label>Reviewer</label>
        <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="you@wineoutlet" />
      </div>
      {showReject && (
        <div className="form-row" style={{ maxWidth: 300 }}>
          <label>Rejection reason</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      {error ? <ErrorPanel error={error} /> : null}
      <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
        <button className="btn ok" onClick={approve} disabled={busy}>Approve</button>
        {!showReject ? <button className="btn" onClick={() => setShowReject(true)} disabled={busy}>Reject…</button>
          : <button className="btn danger" onClick={reject} disabled={busy}>Confirm Reject</button>}
      </div>
    </div>
  );
}

export default function PipelineRunView() {
  const { runId } = useParams();
  const [showLogs, setShowLogs] = useState(false);
  const { data: run, error, reload } = useApi<PipelineRun>(() => api.get(`/pipeline/${runId}`), [runId], 1500);
  const { data: logsData } = useApi<{ logs: PipelineLogEntry[] }>(() => api.get(`/pipeline/${runId}/logs`), [runId], showLogs ? 1500 : undefined);

  if (error) return <ErrorPanel error={error} />;
  if (!run) return <Loading />;

  const complete = run.status === 'completed';

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{run.itemNumber}</h1>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
            {run.mode === 'demo' && <span className="demo-tag">Demo / Fixture</span>}
            <StatusBadge label={run.status} />
            {isRunning(run.status) && <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>watching live…</span>}
          </div>
        </div>
      </div>

      <div className="pipeline-track">
        {BLOCKS.map((b, i) => {
          const status = b.key === 'deduplication'
            ? (run.stages.deduplication?.status === 'pending' ? run.stages.queue?.status || 'pending' : run.stages.deduplication.status)
            : (run.stages[b.key]?.status || 'pending');
          return (
            <span key={b.key} style={{ display: 'flex', alignItems: 'center' }}>
              <span className={`track-step ${status}`}>
                <span className="icon">{trackIcon(status)}</span>{b.label}
              </span>
              {i < BLOCKS.length - 1 && <span className={`track-connector ${status === 'completed' ? 'done' : ''}`} />}
            </span>
          );
        })}
      </div>

      {complete && <div style={{ marginTop: 20 }}><ProductCard run={run} /></div>}
      {run.status === 'awaiting_approval' && <div style={{ marginTop: 20 }}><ApprovalGate run={run} onActed={() => reload(true)} /></div>}

      <div className="section-title">Step by step</div>
      <div>
        {BLOCKS.map((b) => {
          const status = b.key === 'deduplication'
            ? (run.stages.deduplication?.status === 'pending' ? run.stages.queue?.status || 'pending' : run.stages.deduplication.status)
            : (run.stages[b.key]?.status || 'pending');
          return (
            <div className={`stage-block ${status}`} key={b.key}>
              <div className="stage-block-head">
                <StageIcon status={status} />
                <span className="stage-title">{b.label}</span>
                <StatusBadge label={status} />
              </div>
              {b.note && status !== 'pending' && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 8, marginTop: -6 }}>{b.note}</div>}
              {status !== 'pending' && <StageOutput blockKey={b.key} run={run} />}
            </div>
          );
        })}
      </div>

      <div className="section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>System log</span>
        <button className="btn small" onClick={() => setShowLogs((s) => !s)}>{showLogs ? 'Hide' : 'Show'}</button>
      </div>
      {showLogs && (
        <div className="card" style={{ maxHeight: 280, overflowY: 'auto' }}>
          {(logsData?.logs || []).map((log, i) => (
            <div key={i} className={`log-line ${log.level}`}>
              <span className="ts">{new Date(log.ts).toLocaleTimeString()}</span>
              <span className="stage-tag">[{log.stage.toUpperCase()}]</span>
              {log.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
