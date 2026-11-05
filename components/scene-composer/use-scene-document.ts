/* oxlint-disable react/react-compiler -- Immutable document history is maintained alongside the current revision. */
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { updateSplitSourceState } from '@/features/scene-composer/map-split-source.mjs';
import { makeId } from '@/features/interactable-editor/contract.mjs';
import { readWorkspaceDraft } from '@/lib/workbench/browser-store';
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
} from '@/features/scene-composer/browser';
import {
  publishEditorSession,
  removeEditorSession,
  markEditorSaved,
} from '@/lib/workbench/editor-session';

export function useSceneDocument(imageWindowOpen = false, imageOpening = false) {
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
  const history = useRef<{ past: Scene[]; future: Scene[] }>({
    past: [],
    future: [],
  });
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
  const shared = useSharedDocument({
    id: scene.id,
    kind: 'scene',
    value: scene,
    enabled: ready,
    automatic: !untouched,
    busy: busy || imageWindowOpen,
    // Browser history revisions and server CAS revisions are independent counters.
    prepare: (snapshot) => ({ ...validateScene(snapshot), revision: 0 }),
    saveLocal: async () => { await save(true); },
    applyRemote: async (incoming) => {
      const next = validateScene(incoming);
      const previous = current.current;
      await saveQueue.current.catch(() => undefined);
      if (busyRef.current) throw new Error('场景正在处理内容，共享修改暂未替换本机草稿。');
      if (current.current !== previous) throw new Error('读取期间本机场景已变化，修改已保留。');
      current.current = next;
      history.current = { past: [], future: [] };
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
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(location.search);
    const documentId = params.get('document');
    const loadShared = async () => {
      const local = await readWorkspaceDraft<{ scene: Scene; backupRevision: number | null }>(`scene:${documentId}`);
      if (local) return { ...local, scene: validateScene(local.scene) };
      const { document } = await readDocument<Scene>(documentId!);
      if (document.kind !== 'scene' || document.id !== documentId) throw new Error('共享场景身份或类型不匹配。');
      const loaded = validateScene(document.content);
      await saveScene(loaded, null);
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
      busy: busy || imageWindowOpen || imageOpening,
      save,
      beforeLeave: () => {
        if (busyRef.current || imageWindowOpen || imageOpening)
          throw new Error('场景正在处理文件，请等待完成后再离开。');
      },
    });
  }, [scene, ready, busy, save, saved, untouched, imageWindowOpen, imageOpening]);
  useEffect(() => () => removeEditorSession('scene-composer'), []);
  useEffect(() => {
    if (!ready || busy || untouched || scene.revision === savedRevision.current)
      return;
    const timer = setTimeout(() => void save().catch(() => {}), 650);
    return () => clearTimeout(timer);
  }, [scene, ready, busy, save, untouched]);
  const commit = (next: Scene, remember = true, fromHistory = false) => {
    if (!fromHistory) updateSplitSourceState(current.current, next);
    next = validateScene(next);
    next.revision = current.current.revision + 1;
    if (remember) {
      history.current.past.push(current.current);
      history.current.past = history.current.past.slice(-60);
      history.current.future = [];
    }
    current.current = next;
    setScene(next);
  };
  const edit = (fn: (draft: Scene) => void, remember = true) => {
    if (busyRef.current || !ready) return false;
    try {
      const next = structuredClone(current.current);
      fn(next);
      commit(next, remember);
      setError('');
      return true;
    } catch (error) {
      setError(`场景修改未应用：${(error as Error).message}`);
      return false;
    }
  };
  const undo = () => {
    if (busyRef.current) return;
    const previous = history.current.past.pop();
    if (previous) {
      history.current.future.push(current.current);
      commit(
        { ...structuredClone(previous), view: { ...current.current.view } },
        false,
        true,
      );
    }
  };
  const redo = () => {
    if (busyRef.current) return;
    const next = history.current.future.pop();
    if (next) {
      history.current.past.push(current.current);
      commit(
        { ...structuredClone(next), view: { ...current.current.view } },
        false,
        true,
      );
    }
  };
  const replaceDocument = async (
    next: Scene,
    backedUp = false,
    existingBackup?: number | null,
  ) => {
    await save();
    next = validateScene(next);
    const backupRevision =
      existingBackup !== undefined
        ? existingBackup
        : backedUp
          ? next.revision
          : null;
    await saveScene(next, backupRevision);
    persistedId.current = next.id;
    history.current = { past: [], future: [] };
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
    if (busyRef.current) return false;
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
    canUndo: !!history.current.past.length,
    canRedo: !!history.current.future.length,
  };
}
