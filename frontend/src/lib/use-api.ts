import { useCallback, useEffect, useRef, useState } from 'react';

// A small fetch-on-mount(+deps) hook with loading/error/data state and an
// optional poll interval — used for the dashboard, queue, and pipeline
// screens, which need to reflect real, changing backend state rather than
// a one-time snapshot.
export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = [], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function run(silent: boolean) {
      if (!silent) setLoading(true);
      try {
        const result = await fetcherRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run(false);
    if (pollMs) {
      timer = window.setInterval(() => run(true), pollMs);
    }
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload };
}
