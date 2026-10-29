export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="loading-panel">{label}</div>;
}

export function ErrorPanel({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return <div className="error-panel">Request failed: {message}</div>;
}

export function Empty({ label = 'No data.' }: { label?: string }) {
  return <div className="empty-panel">{label}</div>;
}

export function NotAvailable() {
  return <span style={{ color: 'var(--text-faint)' }}>NOT AVAILABLE</span>;
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
