import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useApi } from '../lib/use-api';
import type { PipelineListItem, QueueResponse, StagingRecord, ValidationException } from '../api/types';
import { ErrorPanel, Loading, Empty } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';
import { TechnicalDetails } from '../components/TechnicalDetails';

function StagingApprovalRow({ item, onActed }: { item: StagingRecord; onActed: () => void }) {
  const [reviewer, setReviewer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function approve() {
    if (!reviewer) { setError(new Error('Reviewer name is required.')); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/ai/staging/${item.id}/approve`, { reviewer });
      onActed();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong className="mono">{item.itemNumber}</strong>
          <span style={{ marginLeft: 10, color: 'var(--text-dim)' }}>{item.normalized?.product_name}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={reviewer} onChange={(e) => setReviewer(e.target.value)} placeholder="reviewer" style={{ width: 140 }} />
          <button className="btn small ok" disabled={busy} onClick={approve}>Approve</button>
        </div>
      </div>
      {error ? <ErrorPanel error={error} /> : null}
    </div>
  );
}

function ExceptionsTable({ items, onActed }: { items: ValidationException[]; onActed: () => void }) {
  const [busyId, setBusyId] = useState<number | null>(null);
  async function act(id: number, action: 'approve' | 'reject') {
    const reviewer = window.prompt('Reviewer name:');
    if (!reviewer) return;
    setBusyId(id);
    try {
      await api.post(`/ai/exceptions/${id}/${action}`, { reviewer });
      onActed();
    } finally {
      setBusyId(null);
    }
  }
  return (
    <table className="data">
      <thead><tr><th>Item #</th><th>Field</th><th>Suggested</th><th></th></tr></thead>
      <tbody>
        {items.map((ex) => (
          <tr key={ex.id}>
            <td className="mono">{ex.itemNumber}</td>
            <td>{ex.fieldName}: {String(ex.suggestedValue)}</td>
            <td style={{ fontSize: 12, color: 'var(--text-dim)' }}>{ex.reason}</td>
            <td>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn small ok" disabled={busyId === ex.id} onClick={() => act(ex.id, 'approve')}>Approve</button>
                <button className="btn small danger" disabled={busyId === ex.id} onClick={() => act(ex.id, 'reject')}>Reject</button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function durationOf(run: PipelineListItem) {
  if (run.status === 'running' || run.status === 'processing' || run.status === 'awaiting_approval') return '—';
  const ms = new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function Jobs() {
  const navigate = useNavigate();
  const { data: runs, error: runsError, loading: runsLoading } = useApi<{ runs: PipelineListItem[] }>(() => api.get('/pipeline?limit=30'), [], 5000);
  const { data: staging, error: stagingError, reload: reloadStaging } = useApi<{ staging: StagingRecord[] }>(() => api.get('/ai/staging?status=pending_review'), [], 10000);
  const { data: exceptions, error: exError, reload: reloadEx } = useApi<{ exceptions: ValidationException[] }>(() => api.get('/ai/exceptions?status=pending_review'), [], 10000);
  const { data: queue } = useApi<QueueResponse>(() => api.get('/queue'), [], 10000);

  const needsApproval = (staging?.staging.length || 0) + (exceptions?.exceptions.length || 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Jobs</h1>
          <p>Every pipeline run — what source it used, how long it took, and what happened.</p>
        </div>
      </div>

      {needsApproval > 0 && (
        <>
          <div className="section-title">Needs your approval ({needsApproval})</div>
          {stagingError ? <ErrorPanel error={stagingError} /> : null}
          {staging?.staging.map((item) => <StagingApprovalRow key={item.id} item={item} onActed={() => reloadStaging(true)} />)}
          {exError ? <ErrorPanel error={exError} /> : null}
          {exceptions && exceptions.exceptions.length > 0 && <ExceptionsTable items={exceptions.exceptions} onActed={() => reloadEx(true)} />}
        </>
      )}

      <div className="section-title">Run history</div>
      {runsLoading && !runs && <Loading />}
      {runsError ? <ErrorPanel error={runsError} /> : null}
      {runs && runs.runs.length === 0 && <Empty label="No pipeline runs yet." />}
      {runs && runs.runs.length > 0 && (
        <table className="data">
          <thead>
            <tr>
              <th>Product</th>
              <th>Source</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {runs.runs.map((run) => (
              <tr key={run.id} className="clickable" onClick={() => navigate(`/pipeline/${run.id}`)}>
                <td className="mono">{run.itemNumber}</td>
                <td>{(() => { try { return new URL(run.sourceUrl).hostname; } catch { return run.sourceUrl; } })()} {run.mode === 'demo' && <span className="demo-tag" style={{ marginLeft: 6 }}>demo</span>}</td>
                <td>{new Date(run.createdAt).toLocaleString()}</td>
                <td>{durationOf(run)}</td>
                <td><StatusBadge label={run.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {queue && (
        <TechnicalDetails>
          <div className="kv">
            <dt>Crawl queue — pending</dt><dd>{queue.crawlQueue.pending}</dd>
            <dt>Crawl queue — processing</dt><dd>{queue.crawlQueue.processing}</dd>
            <dt>Crawl queue — retrying</dt><dd>{queue.crawlQueue.retrying}</dd>
            <dt>Crawl queue — dead letter</dt><dd>{queue.crawlQueue.dead_letter}</dd>
          </div>
          {queue.recentDeadLetter.length > 0 && (
            <table className="data" style={{ marginTop: 10 }}>
              <thead><tr><th>Item #</th><th>Source</th><th>Attempts</th><th>Reason</th></tr></thead>
              <tbody>
                {queue.recentDeadLetter.map((job: any) => (
                  <tr key={job.id}>
                    <td className="mono">{job.item_number}</td>
                    <td>{job.source_name}</td>
                    <td>{job.attempts}</td>
                    <td>{job.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TechnicalDetails>
      )}
    </div>
  );
}
