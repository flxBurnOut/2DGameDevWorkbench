'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readWorkspaceDraft, saveWorkspaceDraft } from '@/lib/workbench/browser-store';
import { createDocument, readDocument, readDocumentMetadata, saveDocument, type DocumentKind, type SharedDocument } from './client';
import { DocumentSyncController, type DocumentSyncCache, type DocumentSyncState, type DocumentSavedSnapshot, type DocumentApplication } from './sync-controller.mjs';
import { browserRequestJournal } from './browser-journal';
import { browserDocumentMedia } from './browser-media';

export function useSharedDocument<T>({ id, kind, value, enabled, automatic = true, busy, current: currentValue, blocked, media, migrateCache, prepare, saveLocal, applyRemote, backupLocal }: {
  id: string; kind: DocumentKind; value: T; enabled: boolean; automatic?: boolean; busy: boolean;
  prepare: (snapshot: T) => T | Promise<T>;
  saveLocal: (snapshot: T) => Promise<void>;
  current?: () => T; blocked?: () => boolean;
  media?: 'references';
  migrateCache?: (cache: DocumentSyncCache | undefined) => Promise<DocumentSyncCache | undefined>;
  applyRemote: (snapshot: T, context?: DocumentApplication<T>) => Promise<void>;
  backupLocal: (snapshot: T) => Promise<string>;
}) {
  const latest = useRef({ value, busy, currentValue, blocked, prepare, saveLocal, applyRemote, backupLocal, migrateCache });
  useLayoutEffect(() => { latest.current = { value, busy, currentValue, blocked, prepare, saveLocal, applyRemote, backupLocal, migrateCache }; });
  const controller = useRef<DocumentSyncController<T> | null>(null);
  const [state, setState] = useState<DocumentSyncState>({ status: 'connecting', message: '开始编辑后同步共享工程', revision: null, conflict: false });
  useEffect(() => {
    if (!enabled) return;
    const key = `document-sync:${kind}:${id}`;
    const current = new DocumentSyncController<T>({
      id, kind,
      journal: browserRequestJournal(`document-sync:${kind}`, id),
      current: () => latest.current.currentValue ? latest.current.currentValue() : latest.current.value,
      busy: () => latest.current.busy || Boolean(latest.current.blocked?.()),
      prepare: (snapshot) => latest.current.prepare(snapshot),
      saveLocal: (snapshot) => latest.current.saveLocal(snapshot),
      applyRemote: (snapshot, context) => latest.current.applyRemote(snapshot, context),
      backupLocal: (snapshot) => latest.current.backupLocal(snapshot),
      readCache: async () => {
        const cache = await readWorkspaceDraft<DocumentSyncCache>(key);
        return latest.current.migrateCache ? latest.current.migrateCache(cache) : cache;
      },
      writeCache: (cache) => saveWorkspaceDraft(key, { ...cache, ...(media ? { mediaVersion: 2 } : {}) }, []),
      api: {
        read: documentId => readDocument<T>(documentId, undefined, { media }), metadata: readDocumentMetadata,
        save: async (documentId, revision, content, commandId) => {
          if (media === 'references') await browserDocumentMedia.publish(kind, content);
          return saveDocument<T>(documentId, revision, content, commandId, { media });
        },
        create: async (documentKind, content, commandId) => {
          if (media === 'references') await browserDocumentMedia.publish(documentKind, content);
          return createDocument<T>(documentKind, content, commandId, { media });
        },
      },
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
  }, [id, kind, enabled, media]);
  useEffect(() => {
    const current = controller.current;
    if (!enabled || !automatic || !current) return;
    const url = new URL(location.href);
    url.searchParams.set('project', id);
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
