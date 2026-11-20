'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { motionRequest, type MotionWork } from './open-motion-model';

/**
 * Load, poll and mutate one open-motion work. Mutations always carry the
 * loaded revision; the server rejects a stale one and the caller re-reads.
 * GET polling never creates or submits anything.
 */
export function useMotionWork(workId: string, version?: number) {
  const [work, setWork] = useState<MotionWork | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!workId);
  const snapshot = useRef('');
  const pollRevision = useRef(0);
  const query = version ? { revision: String(version) } : {};
  const queryKey = JSON.stringify(query);
  const apply = useCallback((value: MotionWork) => {
    const next = JSON.stringify(value);
    if (next === snapshot.current) return;
    snapshot.current = next;
    setWork(value);
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!workId) return null;
    const value = await motionRequest<MotionWork>(`open-motion/${workId}`, undefined, JSON.parse(queryKey), signal);
    apply(value);
    return value;
  }, [workId, queryKey, apply]);
  useEffect(() => {
    if (!workId) return;
    const abort = new AbortController();
    void refresh(abort.signal).catch(e => { if (!abort.signal.aborted) setError((e as Error).message); })
      .finally(() => { if (!abort.signal.aborted) setLoaded(true); });
    return () => abort.abort();
  }, [workId, refresh]);
  useEffect(() => {
    if (!workId || !loaded) return;
    let running = false;
    const abort = new AbortController();
    const timer = setInterval(() => {
      if (running || busy || document.visibilityState === 'hidden') return;
      running = true;
      const revision = pollRevision.current;
      void motionRequest<MotionWork>(`open-motion/${workId}`, undefined, JSON.parse(queryKey), abort.signal)
        .then(value => { if (!abort.signal.aborted && revision === pollRevision.current) apply(value); })
        .catch(() => { /* Keep the last saved work; explicit refresh reports errors. */ })
        .finally(() => { running = false; });
    }, 2500);
    return () => { abort.abort(); clearInterval(timer); };
  }, [workId, loaded, busy, queryKey, apply]);
  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); pollRevision.current++;
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [busy]);
  const readOnly = Boolean(work && work.revision !== work.latest_revision);
  const mutate = useCallback(async (operation: string, values: Record<string, unknown> = {}) => {
    if (!work || readOnly) return undefined;
    const value = await motionRequest<MotionWork>(`open-motion/${work.id}/${operation}`, { expected_revision: work.revision, ...values });
    apply(value);
    return value;
  }, [work, readOnly, apply]);
  return { work, apply, refresh, error, setError, busy, run, mutate, readOnly, loaded };
}
