/* oxlint-disable react/react-compiler -- Immutable document history is maintained alongside the current revision. */
'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { updateSplitSourceState } from '@/features/scene-composer/map-split-source.mjs';
import { updateMapCollisionOverride } from '@/features/scene-composer/map-collisions.mjs';
import { sharedSceneContent, sameSceneContent, sceneWithLocalView } from '@/features/scene-composer/shared-content.mjs';
import { SceneEditSession } from '@/features/scene-composer/edit-session.mjs';
import { documentFingerprint, type DocumentSyncCache } from '@/features/editor-documents/sync-controller.mjs';
import { browserDocumentMedia } from '@/features/editor-documents/browser-media';
import { makeId } from '@/features/interactable-editor/contract.mjs';
import { readWorkspaceDraft, updateWorkspaceDraft } from '@/lib/workbench/browser-store';
import { readDocument } from '@/features/editor-documents/client';
import { useSharedDocument } from '@/features/editor-documents/use-shared-document';
import {
  createScene,
  validateScene,
  type Scene,
} from '@/features/scene-composer/model.mjs';
import {
  loadScene,
  saveScene,
  sceneHref,
  sceneItem,
  prepareSceneDraft,
  migrateSceneSyncCache,
} from '@/features/scene-composer/browser';
import {
  publishEditorSession,
  removeEditorSession,
  markEditorSaved,
} from '@/lib/workbench/editor-session';

export function useSceneDocument() {
  const [scene, setScene] = useState<Scene>(() => createScene());
  const current = useRef(scene);
  const [ready, setReady] = useState(false),
    [error, setError] = useState('');
  const [saved, setSaved] = useState(-1),
    [backup, setBackup] = useState<number | null>(null);
  const backupRef = useRef<number | null>(null);
  const persistedId = useRef<string | null>(null);
  const untouched =
    !scene.map &&
    !scene.materials.length &&
    scene.revision === 0 &&
    persistedId.current !== scene.id;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false),
    savedRevision = useRef(-1);
  const saveQueue = useRef(Promise.resolve());
  const save = useCallback(async (allowEmpty = false) => {
    const snapshot = current.current,
      backupRevision = backupRef.current;
    if (
      !allowEmpty && !snapshot.map &&
      !snapshot.materials.length &&
      snapshot.revision === 0 &&
      persistedId.current !== snapshot.id
    )
      return;
    const pending = saveQueue.current
      .catch(() => {})
      .then(() => saveScene(snapshot, backupRevision));
    saveQueue.current = pending;
    try {
      await pending;
      persistedId.current = snapshot.id;
      if (current.current === snapshot) {
        savedRevision.current = snapshot.revision;
        setSaved(snapshot.revision);
        markEditorSaved('scene-composer');
      }
      setError('');
    } catch (e) {
      setError(`本机保存失败：${(e as Error).message}。请下载场景源文件备份。`);
      throw e;
    }
  }, []);
  const sharedRef = useRef<ReturnType<typeof useSharedDocument<Scene>> | null>(null);
  const [session] = useState(() => new SceneEditSession({
    current: () => current.current,
    fingerprint: async snapshot => documentFingerprint(sharedSceneContent(await browserDocumentMedia.compact('scene', snapshot))),
    saveLocal: () => save(true),
    flushSaved: () => sharedRef.current!.flushSaved(),
    readDocument: (id, revision) => readDocument<Scene>(id, revision, { media: 'references' }),
    acceptAdopted: (document, guard) => sharedRef.current!.acceptAdopted(document, guard),
  }));
  const sessionState = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const shared = useSharedDocument({
    id: scene.id,
    kind: 'scene',
    media: 'references',
    migrateCache: cache => migrateSceneSyncCache(cache, current.current),
    value: scene,
    enabled: ready,
    automatic: !untouched,
    busy: busy || session.blocksSync,
    current: () => current.current,
    blocked: () => busyRef.current || session.blocksSync,
    // Browser history revisions and server CAS revisions are independent counters.
    prepare: async snapshot => sharedSceneContent(await browserDocumentMedia.compact('scene', snapshot)),
    saveLocal: async () => { await save(true); },
    applyRemote: async (incoming, context) => {
      const previous = current.current;
      await saveQueue.current.catch(() => undefined);
      const compact = await browserDocumentMedia.compact('scene', incoming);
      if (busyRef.current) throw new Error('场景正在处理内容，共享修改暂未替换本机草稿。');
      if (context?.reason !== 'adopt' && session.blocksSync) throw new Error('当前场景会话暂不接收共享修改，请退出预览或候选窗口后重试。');
      if (!sameSceneContent(current.current, previous)) throw new Error('读取期间本机场景已变化，修改已保留。');
      const next = sceneWithLocalView(compact, current.current);
      if (context?.reason === 'adopt') session.record(current.current, { revision: context.document.revision, contentHash: context.document.contentHash });
      else session.clearHistory();
      current.current = next;
      setScene(next);
      persistedId.current = next.id;
      backupRef.current = null;
      setBackup(null);
      const pending = saveQueue.current.catch(() => undefined).then(() => saveScene(next, null));
      saveQueue.current = pending;
      await pending;
      savedRevision.current = next.revision;
      setSaved(next.revision);
    },
    backupLocal: async (snapshot) => {
      const backup = { ...structuredClone(snapshot), id: makeId('scene'), name: `${snapshot.name.slice(0, 100)}（本机备份）` };
      await saveScene(backup, null);
      return backup.name;
    },
  });
  useEffect(() => { sharedRef.current = shared; }, [shared]);
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(location.search);
    const documentId = params.get('document');
    const loadShared = async () => {
      const local = await readWorkspaceDraft<{ scene: Scene; backupRevision: number | null }>(`scene:${documentId}`);
      if (local) return { ...local, scene: await prepareSceneDraft(local.scene) };
      const { document } = await readDocument<Scene>(documentId!, undefined, { media: 'references' });
      if (document.kind !== 'scene' || document.id !== documentId) throw new Error('共享场景身份或类型不匹配。');
      const loaded = validateScene(await browserDocumentMedia.compact('scene', document.content));
      await saveScene(loaded, null);
      const fingerprint = await documentFingerprint(sharedSceneContent(loaded));
      await updateWorkspaceDraft<DocumentSyncCache>(`document-sync:scene:${document.id}`, previous => previous?.pending ? previous : {
        revision: document.revision, fingerprint, mediaVersion: 2,
      });
      return { scene: loaded, backupRevision: null };
    };
    void (documentId ? loadShared() : loadScene(params.get('scene') || undefined))
      .then((loaded) => {
        if (!alive) return;
        if (loaded) {
          persistedId.current = loaded.scene.id;
          current.current = loaded.scene;
          setScene(loaded.scene);
          backupRef.current = loaded.backupRevision;
          setBackup(loaded.backupRevision);
          savedRevision.current = loaded.scene.revision;
          setSaved(loaded.scene.revision);
        }
        setReady(true);
      })
      .catch((e) => {
        if (alive) {
          setError((e as Error).message);
          setReady(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    publishEditorSession({
      capabilityId: 'scene-composer',
      items: untouched ? [] : [sceneItem(scene)],
      dirty: !untouched && scene.revision !== savedRevision.current,
      busy: busy || !['editing', 'preview'].includes(sessionState.phase),
      save,
      beforeLeave: () => {
        if (session.getState().phase === 'preview') session.preview(false);
        if (busyRef.current || session.blocksEditing)
          throw new Error('场景正在处理文件，请等待完成后再离开。');
      },
    });
  }, [scene, ready, busy, save, saved, untouched, session, sessionState.phase]);
  useEffect(() => () => removeEditorSession('scene-composer'), []);
  useEffect(() => {
    browserDocumentMedia.retain('scene-composer', [{ kind: 'scene', content: scene }]);
  }, [scene]);
  useEffect(() => () => browserDocumentMedia.release('scene-composer'), []);
  useEffect(() => {
    if (!ready || busy || untouched || scene.revision === savedRevision.current)
      return;
    const timer = setTimeout(() => void save().catch(() => {}), 650);
    return () => clearTimeout(timer);
  }, [scene, ready, busy, save, untouched]);
  const commit = (next: Scene, remember = true, fromHistory = false) => {
    updateMapCollisionOverride(current.current, next);
    if (!fromHistory) updateSplitSourceState(current.current, next);
    next = validateScene(next);
    next.revision = current.current.revision + 1;
    if (remember) {
      session.record(current.current);
    }
    current.current = next;
    setScene(next);
  };
  const edit = (fn: (draft: Scene) => void, remember = true) => {
    if (busyRef.current || !ready) return false;
    try {
      const next = structuredClone(current.current);
      fn(next);
      if (session.blocksEditing && !(sessionState.phase === 'preview' && !remember && sameSceneContent(next, current.current))) return false;
      commit(next, remember);
      setError('');
      return true;
    } catch (error) {
      setError(`场景修改未应用：${(error as Error).message}`);
      return false;
    }
  };
  const travel = (direction: 'undo' | 'redo') => {
    if (busyRef.current) return;
    void session.travel(direction, async snapshot => commit({ ...await browserDocumentMedia.compact('scene', snapshot), view: { ...current.current.view } }, false, true))
      .catch(cause => setError(cause instanceof Error ? cause.message : '撤销或重做未完成，本机草稿已保留。'));
  };
  const undo = () => travel('undo');
  const redo = () => travel('redo');
  const replaceDocument = async (
    next: Scene,
    backedUp = false,
    existingBackup?: number | null,
  ) => {
    await save();
    next = validateScene(await browserDocumentMedia.compact('scene', next));
    const backupRevision =
      existingBackup !== undefined
        ? existingBackup
        : backedUp
          ? next.revision
          : null;
    await saveScene(next, backupRevision);
    persistedId.current = next.id;
    session.clearHistory();
    session.close();
    current.current = next;
    savedRevision.current = next.revision;
    setScene(next);
    setSaved(next.revision);
    backupRef.current = backupRevision;
    setBackup(backupRef.current);
    window.history.replaceState(null, '', sceneHref(next.id));
  };
  const markBackup = async (revision: number) => {
    backupRef.current = revision;
    setBackup(revision);
    await save();
  };
  const perform = async (fn: () => Promise<void>) => {
    if (busyRef.current || !['editing', 'preview'].includes(session.getState().phase)) return false;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return {
    scene,
    current,
    ready,
    untouched,
    error,
    setError,
    saved,
    backup,
    busy,
    save,
    edit,
    commit,
    undo,
    redo,
    replaceDocument,
    markBackup,
    perform,
    shared,
    session,
    sessionState,
    canUndo: sessionState.canUndo,
    canRedo: sessionState.canRedo,
  };
}
