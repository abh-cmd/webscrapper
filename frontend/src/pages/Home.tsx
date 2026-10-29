import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../lib/use-api';
import type { HealthResponse, SourceStatus } from '../api/types';
import { StatusBadge } from '../components/StatusBadge';
import { ErrorPanel } from '../components/Panels';
import { TechnicalDetails } from '../components/TechnicalDetails';

const DEMO_URL = 'http://127.0.0.1:3000/input/fixtures/example-source-product.html';

type SourceOption = { value: string; label: string; blocked: boolean; reason: string | null; url: string | null; locked: boolean };

function randomItemNumber() {
  return 'WO-' + Math.floor(Math.random() * 900000 + 100000);
}

export default function Home() {
  const navigate = useNavigate();
  const { data: health } = useApi<HealthResponse>(() => api.get('/health'), [], 20000);
  const { data: sourcesData } = useApi<{ sources: SourceStatus[] }>(() => api.get('/sources'), []);

  const [sourceChoice, setSourceChoice] = useState('demo');
  const [targetUrl, setTargetUrl] = useState(DEMO_URL);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [itemNumber, setItemNumber] = useState(randomItemNumber());
  const [itemName, setItemName] = useState('');
  const [size, setSize] = useState('750ml');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);

  // "Blocked" here means the compliance record — a real, persisted fact
  // about this source, not dependent on whether a crawl happens to have
  // run recently in this exact database — says it isn't cleared for
  // production use. lastAttempted (the live crawl_jobs history) is a
  // separate, secondary signal shown only when it exists.
  const configuredSources: SourceOption[] = (sourcesData?.sources || []).map((s) => ({
    value: s.sourceName,
    label: s.sourceName,
    blocked: s.compliance ? !s.compliance.enabledInProduction : false,
    reason: s.lastAttempted?.errorType || s.compliance?.tosReviewNotes || null,
    url: null,
    locked: false
  }));

  const options: SourceOption[] = [
    { value: 'demo', label: 'Demo / Fixture (always works)', blocked: false, reason: null, url: DEMO_URL, locked: true },
    ...configuredSources,
    { value: 'other', label: 'Other website (auto-detect)', blocked: false, reason: null, url: null, locked: false }
  ];

  function selectSource(value: string) {
    setSourceChoice(value);
    const opt = options.find((o) => o.value === value);
    if (opt?.locked && opt.url) {
      setTargetUrl(opt.url);
    } else if (value === 'other') {
      setTargetUrl('');
    } else {
      setTargetUrl('');
    }
  }

  const currentOption = options.find((o) => o.value === sourceChoice);
  const urlLocked = Boolean(currentOption?.locked);

  async function runPipeline(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const sourceName = sourceChoice === 'demo' ? 'example-source' : sourceChoice === 'other' ? undefined : sourceChoice;
      const result = await api.post<{ runId: string }>('/pipeline/run', {
        item_number: itemNumber,
        item_name: itemName || 'Product',
        size,
        source: { name: sourceName, url: targetUrl },
        mode: sourceChoice === 'demo' ? 'demo' : 'live'
      });
      navigate(`/pipeline/${result.runId}`);
    } catch (err) {
      setSubmitError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>WineOutlet</h1>
          <p>Product Data Pipeline — give it a source, run it, and watch exactly what happens to the product.</p>
        </div>
        <div style={{ display: 'flex', gap: 10, fontSize: 12, color: 'var(--text-dim)', alignItems: 'center' }}>
          {health && (
            <>
              <span>DB <StatusBadge label={health.database.connected ? 'connected' : 'error'} /></span>
              <span>AI <StatusBadge label={health.ai.isMock ? 'test provider' : (health.ai.verification?.status || health.ai.provider)} tone={health.ai.isMock ? 'neutral' : undefined} /></span>
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 22 }}>
        <form onSubmit={runPipeline}>
          <div className="form-row">
            <label>Source</label>
            <select value={sourceChoice} onChange={(e) => selectSource(e.target.value)}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}{o.blocked ? ' — ⚠ BLOCKED' : ''}
                </option>
              ))}
            </select>
          </div>

          {currentOption?.blocked && (
            <div className="callout warn" style={{ marginBottom: 14 }}>
              <strong>⚠ This source is currently BLOCKED</strong> — a real, recorded compliance decision, not a guess.
              {currentOption.reason && <div style={{ marginTop: 6 }}>{currentOption.reason}</div>}
              <div style={{ marginTop: 6 }}>
                Nothing will bypass this. You can still paste a real product URL below to watch the real block happen honestly, or pick
                a different source above.
              </div>
            </div>
          )}
          {sourceChoice === 'demo' && (
            <div className="callout" style={{ marginBottom: 14 }}>
              Runs the real pipeline against a safe local test page — every mechanism is genuine, only the target isn't a live website.
            </div>
          )}
          {sourceChoice === 'other' && (
            <div className="callout" style={{ marginBottom: 14 }}>
              Works with any website — paste a real product page URL below. The system auto-detects it and reads whatever standard
              product markup (schema.org / OpenGraph) that page exposes.
            </div>
          )}
          {!currentOption?.locked && !currentOption?.blocked && sourceChoice !== 'other' && (
            <div className="callout" style={{ marginBottom: 14 }}>
              Paste a real product page URL from <strong>{sourceChoice}</strong> below — this dropdown only picks which reader the
              crawler uses; it doesn't fetch a page for you.
            </div>
          )}

          <div className="form-row">
            <label>Target URL {urlLocked ? '' : '— paste a real product page URL here'}</label>
            <input value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} required disabled={urlLocked} placeholder="https://www.example.com/product/some-wine" />
          </div>

          {submitError ? <ErrorPanel error={submitError} /> : null}

          <button className="btn primary" type="submit" disabled={submitting} style={{ marginTop: 4 }}>
            {submitting ? 'Starting…' : 'Run Pipeline'}
          </button>

          <div style={{ marginTop: 14 }}>
            <button type="button" className="details-toggle" onClick={() => setShowAdvanced((s) => !s)}>
              {showAdvanced ? 'Hide advanced options ▲' : 'Advanced options ▼'}
            </button>
            {showAdvanced && (
              <div className="grid grid-3" style={{ marginTop: 10 }}>
                <div className="form-row">
                  <label>Item number</label>
                  <input value={itemNumber} onChange={(e) => setItemNumber(e.target.value)} />
                </div>
                <div className="form-row">
                  <label>Expected product name (optional — used to confirm the page matches)</label>
                  <input value={itemName} onChange={(e) => setItemName(e.target.value)} />
                </div>
                <div className="form-row">
                  <label>Size</label>
                  <input value={size} onChange={(e) => setSize(e.target.value)} />
                </div>
              </div>
            )}
          </div>
        </form>
      </div>

      <TechnicalDetails>
        <div className="kv">
          <dt>Backend</dt><dd>{health?.status}</dd>
          <dt>Crawler</dt><dd>headless: {String(health?.crawler.headless)}, timeout: {health?.crawler.timeoutMs}ms</dd>
          <dt>Proxy pool</dt><dd>{health?.proxy.configured ? `${health.proxy.poolSize} configured` : 'not configured'}</dd>
          <dt>Image storage</dt><dd className="mono">{health?.imageStorage.root}</dd>
        </div>
      </TechnicalDetails>
    </div>
  );
}
