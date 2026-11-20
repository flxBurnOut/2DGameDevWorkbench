'use client';

import { useEffect, useMemo, useState } from 'react';
import { browserRequestJournal } from '@/features/editor-documents/browser-journal';
import { submitPaidTask, type TaskPayload } from './paid-task.mjs';

export function usePaidTask(scope: string) {
  const journal = useMemo(() => browserRequestJournal('paid-task', scope), [scope]);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let alive = true;
    const update = () => void journal.pending().then(value => { if (alive) setPending(Boolean(value)); }).catch(() => {});
    update();
    window.addEventListener('focus', update);
    return () => { alive = false; window.removeEventListener('focus', update); };
  }, [journal]);

  const run = async (payload: TaskPayload | undefined) => {
    try { return payload ? await submitPaidTask(journal, payload) : await submitPaidTask(journal, undefined, { resume: true }); }
    finally { await journal.pending().then(value => setPending(Boolean(value))).catch(() => {}); }
  };
  return { pending, run };
}
