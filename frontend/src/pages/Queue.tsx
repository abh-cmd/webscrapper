import { api } from '../api/client';
import { useApi } from '../lib/use-api';
import type { QueueResponse } from '../api/types';
import { ErrorPanel, Loading, Empty } from '../components/Panels';
import { StatusBadge } from '../components/StatusBadge';

function CountRow({ counts }: { counts: Record<string, number> }) {
  return (
    <div className="grid grid-4">
      {Object.entries(counts).map(([status, n]) => (
        <div key={status} className="card stat-card">
          <div className="label">{status.replace('_', ' ')}</div>
          <div className="value">{n}</div>
        </div>
      ))}
    </div>
  );
}

export default function Queue() {
  const { data, error, loading } = useApi<QueueResponse>(() => api.get('/queue'), [], 8000);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorPanel error={error} />;
  if (!data) return null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Queue / Job Monitor</h1>
          <p>Real crawl_jobs and image_jobs state — FOR UPDATE SKIP LOCKED claiming, exponential backoff, dead-letter on exhaustion.</p>
        </div>
      </div>

      <div className="section-title">Crawl queue</div>
      <CountRow counts={data.crawlQueue} />

      <div className="section-title">Image queue</div>
      <CountRow counts={data.imageQueue} />

      <div className="section-title">Recent dead-letter jobs</div>
      {data.recentDeadLetter.length === 0 ? (
        <Empty label="No dead-lettered jobs." />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Item #</th><th>Source</th><th>URL</th><th>Attempts</th><th>Reason</th><th>Failed at</th>
            </tr>
          </thead>
          <tbody>
            {data.recentDeadLetter.map((job: any) => (
              <tr key={job.id}>
                <td className="mono">{job.item_number}</td>
                <td>{job.source_name}</td>
                <td className="mono" style={{ maxWidth: 240, overflowWrap: 'anywhere' }}>{job.source_url}</td>
                <td>{job.attempts}</td>
                <td>{job.reason}</td>
                <td>{new Date(job.failed_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
