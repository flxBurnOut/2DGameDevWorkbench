'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readWorkspaceDraft, saveWorkspaceDraft } from '@/lib/workbench/browser-store';
import { createDocument, readDocument, readDocumentMetadata, saveDocument, type DocumentKind, type SharedDocument } from './client';
import { DocumentSyncController, type DocumentSyncCache, type DocumentSyncState, type DocumentSavedSnapshot } from './sync-controller.mjs';

export function useSharedDocument<T>({ id, kind, value, enabled, automatic = true, busy, prepare, saveLocal, applyRemote, backupLocal }: {
  id: string; kind: DocumentKind; value: T; enabled: boolean; automatic?: boolean; busy: boolean;
  prepare: (snapshot: T) => T | Promise<T>;
  saveLocal: (snapshot: T) => Promise<void>;
  applyRemote: (snapshot: T) => Promise<void>;
  backupLocal: (snapshot: T) => Promise<string>;
}) {
  const latest = useRef({ value, busy, prepare, saveLocal, applyRemote, backupLocal });
  useLayoutEffect(() => { latest.current = { value, busy, prepare, saveLocal, applyRemote, backupLocal }; });
  const controller = useRef<DocumentSyncController<T> | null>(null);
  const [state, setState] = useState<DocumentSyncState>({ status: 'connecting', message: '开始编辑后同步共享工程', revision: null, conflict: false });
  useEffect(() => {
    if (!enabled) return;
    const key = `document-sync:${kind}:${id}`;
    const current = new DocumentSyncController<T>({
      id, kind,
      current: () => latest.current.value,
      busy: () => latest.current.busy,
      prepare: (snapshot) => latest.current.prepare(snapshot),
      saveLocal: (snapshot) => latest.current.saveLocal(snapshot),
      applyRemote: (snapshot) => latest.current.applyRemote(snapshot),
      backupLocal: (snapshot) => latest.current.backupLocal(snapshot),
      readCache: () => readWorkspaceDraft<DocumentSyncCache>(key),
      writeCache: (cache) => saveWorkspaceDraft(key, cache, []),
      api: { read: readDocument<T>, metadata: readDocumentMetadata, save: saveDocument<T>, create: createDocument<T> },
    });
    controller.current = current;
    const unsubscribe = current.subscribe(() => {
      const next = current.getState();
      setState(next);
      if (next.status === 'synced' && next.revision !== null) {
        const nextUrl = new URL(location.href);
        nextUrl.searchParams.set('document', id);
        nextUrl.searchParams.delete('task');
        history.replaceState(null, '', nextUrl.pathname + nextUrl.search);
      }
    });
    return () => { unsubscribe(); current.dispose(); if (controller.current === current) controller.current = null; };
  }, [id, kind, enabled]);
  useEffect(() => {
    const current = controller.current;
    if (!enabled || !automatic || !current) return;
    const url = new URL(location.href);
    url.searchParams.set(kind === 'scene' ? 'scene' : 'project', id);
    if (url.searchParams.has('document') && url.searchParams.get('document') !== id)
      url.searchParams.delete('document');
    history.replaceState(null, '', url.pathname + url.search);
    void current.sync();
    const timer = setInterval(() => void current.poll(), 5000);
    return () => clearInterval(timer);
  }, [id, kind, enabled, automatic]);
  useEffect(() => {
    if (!enabled || !automatic || busy) return;
    const timer = setTimeout(() => void controller.current?.sync(), 1200);
    return () => clearTimeout(timer);
  }, [value, enabled, automatic, busy]);
  const retry = useCallback(() => controller.current?.retry(), []);
  const reloadRemote = useCallback(() => controller.current?.reloadRemote(), []);
  const flushSaved = useCallback(async () => {
    if (!controller.current) throw new Error('共享工程尚未连接，请稍后重试。');
    return controller.current.flushSaved();
  }, []);
  const acceptAdopted = useCallback(async (document: SharedDocument<T>, guard: DocumentSavedSnapshot<T>) => {
    if (!controller.current) throw new Error('共享工程已切换，已采用结果仍保留在服务端。');
    return controller.current.acceptAdopted(document, guard);
  }, []);
  return { ...state, retry, reloadRemote, flushSaved, acceptAdopted };
}
