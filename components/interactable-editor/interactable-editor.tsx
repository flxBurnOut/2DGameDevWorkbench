/* oxlint-disable next/no-img-element -- User-uploaded local data URLs must retain their original bytes. */
'use client';
import { NativeSelect, NativeSelectOption, NativeSelectOptGroup } from '@/components/ui/native-select';
import {offerGodotExport} from '@/lib/workbench/godot-export';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type SetStateAction,
} from 'react';
import { Box, Plus, Copy, Download, FolderOpen, Save, Trash2, ChevronDown, Upload } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  createProject,
  createObject,
  makeId,
  nextClipName,
  KINDS,
  KIND_LABELS,
  TRIGGERS,
  describeError,
  referencedAssets,
  type Asset,
  type Kind,
  type Interactable,
  type InteractableProject,
} from '@/features/interactable-editor/contract.mjs';
import {
  importAsset,
  importProject,
  loadDraft,
  loadTaskProject,
  saveDraft,
  saveProjectToLibrary,
  downloadJson,
  exportProject,
  interactableWorkItems,
} from '@/features/interactable-editor/browser-storage';
import {
  publishEditorSession,
  removeEditorSession,
  markEditorSaved,
} from '@/lib/workbench/editor-session';
import { listWorkItems, readWorkspaceDraft } from '@/lib/workbench/browser-store';
import { AssetImportPicker } from '@/components/workbench/lazy-dialogs';
import { clearImportQuery, libraryAnimationTiming, readEditorHandoff, type ImportBundle, type ImportPurpose, type LibraryAsset } from '@/lib/workbench/asset-import';
import { normalizeProject } from '@/features/interactable-editor/contract.mjs';
import { projectSchema } from '@/features/interactable-editor/contract.mjs';
import { portableProject } from '@/features/interactable-editor/portable-project';
import { applyDocument, readDocument } from '@/features/editor-documents/client';
import { useSharedDocument } from '@/features/editor-documents/use-shared-document';
import { documentFingerprint, type DocumentSavedSnapshot } from '@/features/editor-documents/sync-controller.mjs';
import { ImageEditWorkspace } from '@/components/image-edit/lazy-image-edit-workspace';
import type { ImageTargetRef } from '@/features/image-edit/client';
import { imageTargetEquals, readImageEdit } from '@/features/image-edit/client';
import { clearImageEditNavigation, readImageEditNavigation, writeImageEditNavigation, type ImageEditNavigation } from '@/features/image-edit/navigation';
import { DocumentSyncStatus } from '@/components/workbench/document-sync-status';
import { SourceAssetLink } from '@/components/workbench/shared-navigation';
import { SharedDocumentPicker } from '@/components/workbench/shared-document-picker';
import { sharedDocumentHref } from '@/features/editor-documents/library';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import type { WorkItem } from '@/lib/workbench/work-items';
import { useWorkbenchActions } from '@/components/workbench/workbench-provider';
import { isUntouchedStarterProject } from '@/features/interactable-editor/draft-activity';
import { Field, Numeric, Check, BehaviorPanel } from './property-panels';
import { VisualPanel } from './visual-panel';
import { PropArtPanel } from './prop-art-panel';
import { ImagePropPanel } from './image-prop-panel';
import { applyPropArt } from '@/features/interactable-editor/prop-art.mjs';
import { Preview, assetUrl } from './preview';
import './interactable-editor.css';

const triggerLabels = {
  proximity_press: '靠近后按键',
  pointer_click: '鼠标点击',
  automatic_enter: '进入范围自动触发',
  external_request: '外部调用',
};
async function flushPendingDrafts(pass: () => Promise<boolean>) {
  while (await pass()) {
    /* Drain edits made while a previous save was committing. */
  }
}
export function InteractableEditor() {
  const { navigate } = useWorkbenchActions();
  type MotionTarget = {target: 'toggle-state' | 'sequence-entry'; index: number; definitionId: string;
    source: 'state' | 'transition'; guard: DocumentSavedSnapshot<InteractableProject>};
  const [library, setLibrary] = useState<{purposes: ImportPurpose[]; assetId?: string; motion?: MotionTarget} | null>(null);
  const [importDestination, setImportDestination] = useState('default');
  const [openProject, setOpenProject] = useState(false), [sharedOpen, setSharedOpen] = useState(false);
  const [localProjects, setLocalProjects] = useState<WorkItem[]>([]), [localProjectsError, setLocalProjectsError] = useState('');
  const [localProjectsLoading, setLocalProjectsLoading] = useState(false);
  const importStarted = useRef(false);
  const [project, setProjectState] =
      useState<InteractableProject>(createProject),
    [selected, setSelected] = useState(''),
    [exportIds, setExportIds] = useState<string[]>([]),
    [tab, setTab] = useState('visual');
  const [started, setStarted] = useState(false);
  const imageEditing = useRef(false);
  const [imageOpening, setImageOpening] = useState(false);
  const [imageEdit, setImageEdit] = useState<{ target: ImageTargetRef; guard: DocumentSavedSnapshot<InteractableProject> | null; navigation?: ImageEditNavigation } | null>(null);
  const editNavigationConsumed = useRef(false);
  const imageEditRef = useRef(imageEdit);
  useLayoutEffect(() => { imageEditRef.current = imageEdit; }, [imageEdit]);
  const setProject = useCallback(
    (value: SetStateAction<InteractableProject>) => {
      if (imageEditing.current) return;
      setStarted(true);
      setProjectState(value);
    },
    [],
  );
  const [message, setMessage] = useState(''),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [draftStatus, setDraftStatus] = useState('正在读取草稿');
  const [result, setResult] = useState<{
    taskId: string;
    status: string;
    outputs: string[];
  } | null>(null);
  const [draftWritable, setDraftWritable] = useState(true);
  useEffect(() => {
    if (!openProject) return;
    let alive = true;
    // oxlint-disable-next-line react/react-compiler -- Loading browser-only project summaries is tied to this picker session.
    setLocalProjectsLoading(true); setLocalProjectsError(''); setLocalProjects([]);
    void listWorkItems().then(items => {
      if (alive) setLocalProjects([...new Map(items.filter(item => item.capabilityId === 'interactable-editor' && item.draftKey).map(item => [item.scopeId || item.draftKey, item])).values()]);
    }).catch(cause => { if (alive) setLocalProjectsError(cause instanceof Error ? cause.message : '本机草稿列表暂时不可读。'); }).finally(() => { if (alive) setLocalProjectsLoading(false); });
    return () => { alive = false; };
  }, [openProject]);
  const assetInput = useRef<HTMLInputElement>(null),
    projectInput = useRef<HTMLInputElement>(null),
    framesInput = useRef<HTMLInputElement>(null);
  const current =
    project.objects.find((o) => o.definitionId === selected) ??
    project.objects[0];
  const latest = useRef({ project, ready, draftWritable, busy, started });
  useLayoutEffect(() => {
    latest.current = { project, ready, draftWritable, busy, started };
  });
  const savedProject = useRef<InteractableProject | null>(null);
  const unreadableFallback = useRef<InteractableProject | null>(null);
  const savedAt = useRef('');
  const completedIds = useRef<string[]>([]);
  const writeChain = useRef(Promise.resolve());
  const persist = useCallback((explicit = false) => {
    if (explicit) {
      if (!latest.current.started) savedProject.current = null;
      latest.current = { ...latest.current, started: true };
      setStarted(true);
    }
    return flushPendingDrafts(async () => {
      const value = latest.current;
      if (!value.ready) throw new Error('交互物草稿还在读取，请稍候。');
      if (!value.started) return false;
      if (!value.draftWritable) {
        if (value.project === unreadableFallback.current) return false;
        throw new Error(
          '原草稿暂时无法读取。请先保存当前源文件或打开工程，再离开页面。',
        );
      }
      if (savedProject.current === value.project) return false;
      const writing = writeChain.current
        .catch(() => undefined)
        .then(() => saveDraft(value.project, completedIds.current));
      writeChain.current = writing;
      try {
        await writing;
        savedProject.current = value.project;
        savedAt.current = new Date().toISOString();
        if (latest.current.project !== value.project) return true;
        markEditorSaved('interactable-editor');
        setDraftStatus('草稿已保存');
        return false;
      } catch {
        setDraftStatus('草稿保存失败，请下载源文件');
        throw new Error('交互物草稿保存失败，请保留页面并下载源文件。');
      }
    });
  }, []);
  const shared = useSharedDocument({
    id: project.projectId,
    kind: 'interactable',
    value: project,
    enabled: ready && started && draftWritable,
    busy: busy || Boolean(imageEdit),
    prepare: portableProject,
    saveLocal: async () => { await persist(); },
    applyRemote: async (incoming) => {
      const next = normalizeProject(incoming);
      const previous = latest.current.project;
      await writeChain.current.catch(() => undefined);
      if (latest.current.busy) throw new Error('交互物正在处理内容，共享修改暂未替换本机草稿。');
      if (latest.current.project !== previous) throw new Error('读取期间本机工程已变化，修改已保留。');
      // Apply synchronously after the controller's identity guard; later local edits remain a new draft.
      latest.current = { ...latest.current, project: next, started: true };
      setProjectState(next);
      setStarted(true);
      completedIds.current = [];
      setExportIds([]);
      const writing = writeChain.current.catch(() => undefined).then(() => saveDraft(next));
      writeChain.current = writing;
      await writing;
      savedProject.current = next;
      savedAt.current = new Date().toISOString();
      setDraftStatus('共享修改已保存到本机');
    },
    backupLocal: async (snapshot) => {
      const backup = { ...structuredClone(snapshot), projectId: makeId('project'), name: `${snapshot.name.slice(0, 180)}（本机备份）` };
      await saveDraft(backup);
      return backup.name;
    },
  });
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams(location.search);
    const taskId = params.get('task');
    const documentId = params.get('document');
    const loadShared = async () => {
      const local = await readWorkspaceDraft<InteractableProject>(`interactable-project:${documentId}`);
      if (local) return projectSchema.parse(local);
      const { document } = await readDocument<InteractableProject>(documentId!);
      if (document.kind !== 'interactable' || document.id !== documentId)
        throw new Error('共享工程身份或类型不匹配。');
      return projectSchema.parse(document.content);
    };
    (taskId ? loadTaskProject(taskId) : documentId ? loadShared() : loadDraft(params.get('project') || undefined))
      .then(async (p) => {
        if (!p) {
          if (alive) setDraftStatus('开始编辑后自动保存');
          return;
        }
        const items = await listWorkItems();
        if (alive) {
          const existing = items.find((item) => item.scopeId === p.projectId);
          // Migrate a real legacy draft once; merely restoring a registered draft is clean.
          savedProject.current = existing ? p : null;
          completedIds.current = p.objects
            .filter((object) =>
              items.some(
                (item) =>
                  item.scopeId === p.projectId &&
                  item.state === 'completed' &&
                  item.id.endsWith(`:${object.definitionId}`),
              ),
            )
            .map((object) => object.definitionId);
          savedAt.current = existing?.savedAt || '';
          setStarted(Boolean(documentId) || Boolean(existing) || !isUntouchedStarterProject(p));
          setDraftStatus(
            existing || !isUntouchedStarterProject(p)
              ? '草稿已恢复'
              : '开始编辑后自动保存',
          );
          setProjectState(p);
          const objectId = params.get('object');
          if (objectId && p.objects.some((o) => o.definitionId === objectId))
            setSelected(objectId);
        }
      })
      .catch((e) => {
        if (alive) {
          unreadableFallback.current = latest.current.project;
          setMessage(`草稿读取失败：${describeError(e)}`);
          setError(true);
          setDraftWritable(false);
        }
      })
      .finally(() => {
        if (alive) {
          setReady(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (
      !ready ||
      !draftWritable ||
      !started ||
      savedProject.current === project
    )
      return;
    completedIds.current = [];
    // oxlint-disable-next-line react/react-compiler -- Synchronize the visible status with an IndexedDB save cycle.
    setDraftStatus('正在保存草稿…');
    const timer = setTimeout(() => {
      void persist().catch(() => undefined);
    }, 700);
    return () => clearTimeout(timer);
  }, [project, ready, draftWritable, started, persist]);
  useEffect(() => {
    if (!ready) return;
    const dirty =
      started &&
      (draftWritable
        ? savedProject.current !== project
        : unreadableFallback.current !== project);
    const failed = !draftWritable || draftStatus.includes('失败');
    const items = (
      started ? interactableWorkItems(project, completedIds.current) : []
    ).map((item) => ({
      ...item,
      savedAt: savedAt.current || undefined,
      state: failed
        ? ('attention' as const)
        : dirty
          ? ('editing' as const)
          : item.state,
      detail: failed
        ? '草稿保存需要处理，请先下载源文件'
        : dirty
          ? '正在保存交互物修改'
          : item.detail,
    }));
    items.sort(
      (a, b) =>
        Number(b.id.endsWith(`:${current?.definitionId}`)) -
        Number(a.id.endsWith(`:${current?.definitionId}`)),
    );
    publishEditorSession({
      capabilityId: 'interactable-editor',
      items,
      dirty,
      busy: busy || imageOpening || Boolean(imageEdit),
      save: persist,
      beforeLeave: () => {
        if (latest.current.busy || imageEditing.current)
          throw new Error('交互物正在提交、采用或导出，请完成后再切换页面。');
      },
    });
  }, [
    project,
    current?.definitionId,
    ready,
    draftWritable,
    draftStatus,
    busy,
    started,
    persist,
    imageOpening,
    imageEdit,
  ]);
  useEffect(() => () => removeEditorSession('interactable-editor'), []);
  const edit = (fn: (o: Interactable) => void) =>
    setProject((p) => {
      const next = structuredClone(p);
      const o = next.objects.find(
        (o) => o.definitionId === current.definitionId,
      );
      if (o) fn(o);
      return next;
    });
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(false);
    setMessage('');
    try {
      await action();
    } catch (e) {
      setMessage(describeError(e));
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const add = (kind: Kind) => {
    const o = createObject(kind);
    setProject((p) => ({ ...p, objects: [...p.objects, o] }));
    setSelected(o.definitionId);
  };
  const clone = () => {
    const o = structuredClone(current);
    o.definitionId = makeId();
    o.displayName += ' 副本';
    setProject((p) => ({ ...p, objects: [...p.objects, o] }));
    setSelected(o.definitionId);
  };
  const remove = () => {
    const id = current.definitionId;
    setProject((p) => ({
      ...p,
      objects: p.objects.filter((o) => o.definitionId !== id),
    }));
    setSelected('');
    setExportIds((ids) => ids.filter((v) => v !== id));
  };
  const loadAssets = (files: File[], frames = false) =>
    run(async () => {
      const ordered = frames
        ? [...files].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true }),
          )
        : files;
      const imported: Asset[] = [];
      for (const f of ordered) imported.push(await importAsset(f));
      setProject((p) => {
        const next = structuredClone(p);
        next.assets.push(...imported);
        const o = next.objects.find(
          (o) => o.definitionId === current.definitionId,
        );
        if (!o) return next;
        if (frames) {
          const name = nextClipName(o);
          o.visual.clips.push({
            name,
            fps: 8,
            loop: true,
            frames: imported.map((a) => ({ assetId: a.id, duration: 1 })),
          });
          if (!o.visual.idleAnimation) o.visual.idleAnimation = name;
        } else if (!o.visual.assetId)
          o.visual.assetId =
            imported.find((a) => a.mime.startsWith('image'))?.id ?? '';
        return next;
      });
      setMessage(`已导入 ${imported.length} 个素材`);
    });
  const doExport = () =>
    run(async () => {
      setMessage('正在生成 Godot 包…');
      const task = await exportProject(
        project,
        exportIds.length ? exportIds : [current.definitionId],
      );
      setResult(task);
      if (latest.current.project === project) {
        completedIds.current = exportIds.length
          ? exportIds
          : [current.definitionId];
        savedProject.current = null;
        await persist(true);
      }
      setMessage('已导出，点击下方文件下载。');
      const output = task.outputs.find((p) => p.endsWith('.zip'));
      if (output) offerGodotExport({name:project.name||current.displayName,url:`/api/workbench/artifacts?path=${encodeURIComponent(output)}`});
    });
  const adoptImportedProject = async (incoming: InteractableProject, definitionId?: string) => {
    if (latest.current.draftWritable) await persist();
    let next = normalizeProject(incoming) as InteractableProject;
    const existing = await readWorkspaceDraft<InteractableProject>('interactable-project:' + next.projectId);
    if (existing && JSON.stringify(normalizeProject(existing)) !== JSON.stringify(next)) next = {...next, projectId: makeId('project'), name: next.name.slice(0,170) + '（导入版本）'};
    setProject(next); setDraftWritable(true); setSelected(definitionId || next.objects[0]?.definitionId || ''); setExportIds([]); setResult(null);
    setMessage('项目与素材已导入；原项目保留。');
  };
  const slotEntries = current.behavior.kind === 'toggle' ? current.behavior.states :
    current.behavior.kind === 'sequence' ? current.behavior.entries : [];
  const openLibrary = async () => {
    try {
      if (importDestination === 'default' || !slotEntries.length) {
        setLibrary({purposes:['image','animation']});
        return;
      }
      const [mode, position] = importDestination.split(':');
      const index = Number(position);
      if (!slotEntries[index]) throw new Error('请重新选择当前物件的导入位置。');
      const fingerprint = await documentFingerprint(await portableProject(project));
      await persist(true);
      const guard = await shared.flushSaved();
      if (guard.fingerprint !== fingerprint) throw new Error('工程已变化，请核对导入位置后重选。');
      const source = mode === 'state' ? 'state' : 'transition';
      setLibrary({purposes:[source === 'state' ? 'image' : 'animation'], motion:{
        definitionId:current.definitionId, index, source, guard,
        target:current.behavior.kind === 'toggle' ? 'toggle-state' : 'sequence-entry'}});
    } catch (cause) {setError(true); setMessage(describeError(cause));}
  };
  // The state-animation panel writes back through the shared document, so save it first and pass its identity.
  const openStateMotion = async () => {
    try {
      await persist(true);
      const guard = await shared.flushSaved();
      await navigate('/tools/interactable-motion?' + new URLSearchParams({document: guard.document.id, definition: current.definitionId}));
    } catch (cause) {setError(true); setMessage(describeError(cause));}
  };
  const importMotion = async (asset: LibraryAsset) => {
    const slot = library?.motion;
    if (!slot || asset.motionSource !== slot.source) throw new Error('请选择当前用途的状态链素材。');
    const {guard, target, index, definitionId} = slot;
    if (await documentFingerprint(await portableProject(latest.current.project)) !== guard.fingerprint)
      throw new Error('选择期间本机工程已变化，请重新打开资产库。');
    const response = await fetch('/api/workbench/assets?' + new URLSearchParams({assetId:asset.id}), {cache:'no-store'});
    const { asset: detail } = await response.json() as { asset?: LibraryAsset };
    if (!response.ok || detail?.id !== asset.id || detail.motionSource !== slot.source ||
      detail.checkpointToken !== asset.checkpointToken || detail.planSha256 !== asset.planSha256 ||
      detail.stateSha256 !== asset.stateSha256 || !detail.revision) throw new Error('源素材已变化，请刷新后重新选择。');
    const command = {type:'import-motion-asset', definitionId, target, index, assetId:asset.id, assetRevision:detail.revision};
    const commandId = 'motion-' + await documentFingerprint([guard.document.id, guard.document.revision, command]);
    const result = await applyDocument<InteractableProject>(guard.document.id, guard.document.revision, [command], commandId);
    await shared.acceptAdopted(result.document, guard);
    setError(false);
    setMessage(slot.source === 'state' ? '已写入所选条目的状态图。' : '已绑定过渡，进入所选条目时播放一次。');
  };
  const importFromLibrary = async (bundle: ImportBundle) => {
    if (latest.current.busy) throw new Error('请等待当前操作完成。');
    const target = {projectId: latest.current.project.projectId, definitionId: current.definitionId, previousAssetId: current.visual.assetId};
    setBusy(true);
    try {
      if (bundle.purpose === 'interactable') await adoptImportedProject(await importProject(bundle.files[0].file), bundle.asset.definitionId);
      else {
        const timing = bundle.purpose === 'animation' ? libraryAnimationTiming(bundle.asset, bundle.files.length) : null;
        const imported: Asset[] = [];
        for (const {file,sha256} of bundle.files) {
          const asset = await importAsset(file);
          const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(bundle.asset.id + ':' + sha256));
          asset.id = 'library_' + Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('').slice(0,32);
          if (bundle.asset.kind === 'prop' && bundle.asset.taskId) asset.generation = {sourceTaskId:bundle.asset.taskId,sha256};
          imported.push(asset);
        }
        const next = structuredClone(latest.current.project);
        const object = next.objects.find(o=>o.definitionId===target.definitionId);
        if (next.projectId!==target.projectId || !object || object.visual.assetId!==target.previousAssetId) throw new Error('目标物件已变化，请重新选择导入目标。');
        for (const asset of imported) { const previous=next.assets.find(a=>a.id===asset.id); if(previous&&previous.source!==asset.source)throw new Error('素材身份冲突。'); if(!previous)next.assets.push(asset); }
        if (bundle.purpose === 'animation') {
          const name=nextClipName(object);
          object.visual.clips.push({name,fps:timing!.fps,loop:timing!.loop,frames:imported.map((a,index)=>({assetId:a.id,duration:timing!.durations[index]}))});
          object.visual.idleAnimation=name;
        } else {object.visual.assetId=imported[0].id;object.visual.idleAnimation='';object.visual.focusAnimation='';}
        setProject(next);setMessage(bundle.purpose==='animation'?'动画帧与播放设置已导入当前物件。':'原图已用于当前物件；其他状态图片和交互行为保留。');
      }
    } finally { setBusy(false); }
  };
  const consumeImport = useEffectEvent(()=>{
    const params=new URLSearchParams(location.search),assetId=params.get('importAsset'),purpose=params.get('importPurpose');
    if(assetId&&['image','animation','interactable'].includes(purpose||'')){queueMicrotask(()=>setLibrary({purposes:[purpose as ImportPurpose],assetId}));clearImportQuery();}
    else if(params.has('handoff'))void run(async()=>{const record=await readEditorHandoff('interactable-editor');if(record?.purpose==='interactable'){const payload=record.payload as {project:unknown};await adoptImportedProject(normalizeProject(payload.project));}clearImportQuery();});
  });
  useEffect(()=>{if(!ready||importStarted.current)return;importStarted.current=true;queueMicrotask(()=>consumeImport());},[ready]);
  const used = new Set(referencedAssets(project).map((a) => a.id));
  const openImageEdit = async (selection?: Extract<ImageTargetRef, { kind: 'interactable' }>, navigation?: ImageEditNavigation) => {
    if (latest.current.busy || imageEditing.current) return;
    imageEditing.current = true;
    setImageOpening(true);
    try {
      const original = await documentFingerprint(await portableProject(latest.current.project));
      await persist(true);
      const guard = await shared.flushSaved();
      if (original !== guard.fingerprint) throw new Error('保存期间项目或状态条目发生变化，请重新选择图片位置。');
      if (selection && selection.documentId !== guard.document.id) throw new Error('图片会话不属于当前项目。');
      const object = guard.document.content.objects.find(object => object.definitionId === (selection?.definitionId || current.definitionId));
      if (!object) throw new Error('当前物件已不存在。');
      const slot = selection?.slot || 'visual', index = selection?.index;
      const entry = slot === 'toggle-state' && object.behavior.kind === 'toggle' ? object.behavior.states[index ?? -1] : slot === 'sequence-entry' && object.behavior.kind === 'sequence' ? object.behavior.entries[index ?? -1] : undefined;
      if (slot !== 'visual' && !entry) throw new Error('指定状态或序列条目已变化，请重新选择。');
      if (!(entry?.appearance.assetId || object.visual.assetId)) throw new Error('当前图片位置没有静态源图片。');
      const next = { target: { kind: 'interactable', documentId: guard.document.id, definitionId: object.definitionId, slot, ...(slot !== 'visual' ? { index } : {}) } as ImageTargetRef, guard, navigation };
      imageEditRef.current = next;
      setImageEdit(next);
      setError(false);
    } catch (error) {
      if (selection && navigation) {
        const next = { target: selection, guard: null, navigation };
        imageEditRef.current = next; setImageEdit(next);
      } else imageEditing.current = false;
      setMessage(describeError(error));
      setError(true);
    } finally { setImageOpening(false); }
  };
  const resumeImageEdit = useEffectEvent(() => {
    const navigation = readImageEditNavigation(); if (!navigation) return;
    void readImageEdit(navigation.editId).then(({ edit }) => {
      if (edit.target.targetRef.kind !== 'interactable') throw new Error('图片会话不是交互物外观。');
      return openImageEdit(edit.target.targetRef, navigation);
    }).catch(error => { setMessage(describeError(error)); setError(true); });
  });
  useEffect(() => { if (!ready || editNavigationConsumed.current) return; editNavigationConsumed.current = true; resumeImageEdit(); }, [ready]);
  return (
    <>
    <main className="ie-workspace" inert={imageOpening || Boolean(imageEdit)}>
      {!ready && (
        <output className="wb-loading-veil">正在恢复交互物草稿…</output>
      )}
      <AssetImportPicker open={!!library} onClose={()=>setLibrary(null)} purposes={library?.purposes || ['interactable']} initialAsset={library?.assetId} motionSource={library?.motion?.source} onImportMotion={importMotion} onImport={importFromLibrary} />
      <header className="ie-toolbar">
        <Box color="var(--theme-cyan)" />
        <strong>交互物编辑</strong>
        <input
          aria-label="项目名称"
          value={project.name}
          onChange={(e) => setProject({ ...project, name: e.target.value })}
        />
        <span className="ie-note">
          {draftWritable
            ? draftStatus
            : '原草稿保留，请保存源文件；打开工程可恢复自动保存'}
        </span>
        <SourceAssetLink />
        <span className="ie-spacer" />
        <DropdownMenu>
          <DropdownMenuTrigger render={<button type="button" aria-label="打开" disabled={busy || !ready} />}>
            <FolderOpen size={16} />
            打开
            <ChevronDown size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="ie-menu">
            <DropdownMenuItem disabled={imageOpening || Boolean(imageEdit)} onClick={() => setOpenProject(true)}>
              <span><strong>打开工程</strong><small>选择本机草稿、共享工程或导出的源文件。</small></span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setLibrary({ purposes: ['interactable'] })}>
              <span><strong>从资产库选用</strong><small>打开资产库中已保存的交互物项目。</small></span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Three different destinations: browser draft, runtime asset library and a downloaded file. */}
        <DropdownMenu>
          <DropdownMenuTrigger render={<button type="button" aria-label="保存" disabled={!ready} />}>
            <Save size={16} />
            保存
            <ChevronDown size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="ie-menu">
            <DropdownMenuItem disabled={!draftWritable} onClick={() => void persist(true).then(() => { setMessage(''); toast.success('草稿已保存', '保存在当前浏览器，可从制作记录继续。'); }, (e: Error) => setMessage(e.message))}>
              <span><strong>保存草稿</strong><small>保存在当前浏览器，编辑时也会自动保存。从制作记录继续。</small></span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy || !draftWritable} onClick={() => void run(async () => { await saveProjectToLibrary(latest.current.project); await persist(true); toast.success('已保存到资产库', '其他工具可以选用；尚未导出 Godot。'); })}>
              <span><strong>保存到资产库</strong><small>交给本机服务登记，其他工具和其他浏览器都能选用；不导出 Godot。</small></span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { downloadJson(project); toast.success('源文件已开始下载', '工程 JSON 可在其他电脑上打开。'); void persist(true).catch(() => undefined); }}>
              <span><strong>下载源文件</strong><small>下载工程 JSON 到本机，用于备份或在其他电脑上打开。</small></span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          className="ie-primary"
          disabled={busy || !ready}
          onClick={doExport}
        >
          <Download size={16} />
          {busy
            ? '处理中…'
            : `导出 Godot${exportIds.length ? ` · ${exportIds.length} 个` : ''}`}
        </button>
      </header>
      {ready && started && <DocumentSyncStatus state={shared} disabled={busy} />}
      {message && (
        <div
          role={error ? 'alert' : 'status'}
          className={`ie-message ${error ? 'ie-error' : ''}`}
        >
          {message}
          {result && !error && (
            <div className="ie-row">
              {result.outputs
                .filter((p) => !p.endsWith('result.json'))
                .map((p) => (
                  <a
                    key={p}
                    href={`/api/workbench/artifacts?path=${encodeURIComponent(p)}`}
                  >
                    {p.split('/').at(-1)}
                  </a>
                ))}
              <small>
                任务 {result.taskId} · {result.status}
              </small>
            </div>
          )}
        </div>
      )}
      <input
        hidden
        ref={projectInput}
        type="file"
        accept=".json,.zip"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f)
            void run(async () => {
              const p = await importProject(f);
              if (latest.current.draftWritable) await persist();
              setProject(p);
              setDraftWritable(true);
              setSelected('');
              setExportIds([]);
              setResult(null);
              setMessage('项目与素材已恢复');
            });
        }}
      />
      <input
        hidden
        ref={assetInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,audio/wav,audio/ogg,audio/mpeg"
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (fs.length) void loadAssets(fs);
        }}
      />
      <input
        hidden
        ref={framesInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          const fs = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (fs.length) void loadAssets(fs, true);
        }}
      />
      <div className="ie-layout">
        <aside className="ie-library">
          <h2>
            物件 <small>{project.objects.length}</small>
          </h2>
          {project.objects.map((o) => (
            <div key={o.definitionId} className="ie-object-row">
              <button
                aria-pressed={o.definitionId === current.definitionId}
                onClick={() => setSelected(o.definitionId)}
              >
                <Box size={17} />
                <span>
                  {o.displayName}
                  <small>{KIND_LABELS[o.behavior.kind]}</small>
                </span>
              </button>
              <input
                aria-label={`导出 ${o.displayName}`}
                type="checkbox"
                checked={exportIds.includes(o.definitionId)}
                onChange={(e) =>
                  setExportIds((ids) =>
                    e.target.checked
                      ? [...ids, o.definitionId]
                      : ids.filter((i) => i !== o.definitionId),
                  )
                }
              />
            </div>
          ))}
          <p className="ie-note">勾选可批量导出；未勾选时导出当前物件。</p>
          <div className="ie-presets">
            {KINDS.map((kind) => (
              <button key={kind} onClick={() => add(kind)}>
                <Plus size={14} />
                {KIND_LABELS[kind]}
              </button>
            ))}
          </div>
          <div className="ie-row mt-3.5">
            <button onClick={clone}>
              <Copy size={14} />
              复制
            </button>
            <button disabled={project.objects.length === 1} onClick={remove}>
              <Trash2 size={14} />
              删除
            </button>
          </div>
          <details open>
            <summary>素材 · {project.assets.length}</summary>
            {!project.assets.length && <p className="ie-note">先导入图片 / 音效，或从资产库选用原图 / 动画，再配置物件外观与行为。</p>}
            <button disabled={busy} onClick={() => assetInput.current?.click()}>
              <Upload size={14} />
              导入图片 / 音效
            </button>
            {!!slotEntries.length && <label>导入位置<NativeSelect value={importDestination} onChange={e => setImportDestination(e.target.value)}>
              <NativeSelectOption value="default">默认外观 / 动画</NativeSelectOption>
              {slotEntries.map((entry, index) => <NativeSelectOptGroup key={index} label={`${index+1} · ${entry.name}`}>
                <NativeSelectOption value={`state:${index}`}>{entry.name} · 状态图</NativeSelectOption>
                <NativeSelectOption value={`transition:${index}`}>{entry.name} · 进入过渡</NativeSelectOption>
              </NativeSelectOptGroup>)}
            </NativeSelect></label>}
            <button disabled={busy || !ready || !draftWritable} onClick={()=>void openLibrary()}>从资产库选用原图 / 动画</button>
            {!!slotEntries.length && <button disabled={busy || !ready || !draftWritable} onClick={()=>void openStateMotion()}>制作状态动画</button>}
            <div className="ie-asset-list">
              {project.assets.map((a) => (
                <div key={a.id}>
                  {a.mime.startsWith('image') ? (
                    <img loading="lazy" decoding="async" src={assetUrl(a)} alt="" />
                  ) : (
                    <span>♫</span>
                  )}
                  <span title={a.name}>{a.name}</span>
                  {!used.has(a.id) && (
                    <button
                      title={`移除未使用素材 ${a.name}`}
                      onClick={() =>
                        setProject((p) => ({
                          ...p,
                          assets: p.assets.filter((v) => v.id !== a.id),
                        }))
                      }
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </details>
        </aside>
        <Preview object={current} assets={project.assets} edit={edit} />
        <aside className="ie-inspector">
          <Field label="物件名称">
            <input
              value={current.displayName}
              onChange={(e) =>
                edit((o) => {
                  o.displayName = e.target.value;
                })
              }
            />
          </Field>
          <fieldset className="ie-tabs ui-segmented" aria-label="物件设置">
            {[
              ['visual', '外观'],
              ['trigger', '触发'],
              ['behavior', '行为'],
              ['memory', '记忆'],
            ].map(([key, label]) => (
              <button
                key={key}
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </fieldset>
          {/* Kept mounted on other tabs so running generations keep polling. */}
          <section className="ie-get-image" aria-label="获取图片" hidden={tab !== 'visual'}>
            <h3>获取图片</h3>
            <button disabled={!ready || busy || !draftWritable || !current.visual.assetId || imageOpening} onClick={() => void openImageEdit()}>
              {imageOpening ? '正在保存源工程…' : '局部调整默认图片'}
            </button>
            {!current.visual.assetId && <p className="wb-disabled-reason">在下方“图片”中选定一张图后，可以局部调整。</p>}
            <ImagePropPanel
              projectId={project.projectId}
              definitionId={current.definitionId}
              objectName={current.displayName}
              imageId={current.visual.assetId}
              disabled={!ready || busy || !draftWritable}
              onBusy={setBusy}
              beforeGenerate={async () => {
                await persist(true);
                const url = new URL(location.href);
                url.searchParams.delete('task');
                url.searchParams.set('project', latest.current.project.projectId);
                url.searchParams.set('object', current.definitionId);
                history.replaceState(null, '', url.pathname + url.search);
              }}
              onAdopt={(target, asset) => setProject(applyPropArt(latest.current.project, target, asset))}
            />
            <PropArtPanel
              projectId={project.projectId}
              definitionId={current.definitionId}
              objectName={current.displayName}
              imageId={current.visual.assetId}
              disabled={!ready || busy || !draftWritable}
              onBusy={setBusy}
              beforeGenerate={async () => {
                await persist(true);
                const url = new URL(location.href);
                url.searchParams.delete('task');
                url.searchParams.set('project', latest.current.project.projectId);
                url.searchParams.set('object', current.definitionId);
                history.replaceState(null, '', url.pathname + url.search);
              }}
              onAdopt={(target, asset) => {
                setProject(applyPropArt(latest.current.project, target, asset));
              }}
            />
          </section>
          {tab === 'visual' && (
            <VisualPanel
              object={current}
              assets={project.assets}
              edit={edit}
              run={run}
              importFrames={() => framesInput.current?.click()}
              busy={busy}
            />
          )}
          {tab === 'trigger' && (
            <div className="ie-tab-content">
              <Field label="触发方式">
                <NativeSelect
                  value={current.activation.mode}
                  onChange={(e) =>
                    edit((o) => {
                      o.activation.mode = e.target
                        .value as Interactable['activation']['mode'];
                    })
                  }
                >
                  {TRIGGERS.map((t) => (
                    <NativeSelectOption key={t} value={t}>
                      {triggerLabels[t]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Check
                label="初始启用"
                value={current.activation.enabled}
                onChange={(v) =>
                  edit((o) => {
                    o.activation.enabled = v;
                  })
                }
              />
              <Field label="提示文字（留空自动显示按键）">
                <input
                  value={current.content.prompt}
                  onChange={(e) =>
                    edit((o) => {
                      o.content.prompt = e.target.value;
                    })
                  }
                />
              </Field>
              <Field label="默认按键（action 尚未配置时）">
                <input
                  value={current.activation.key}
                  onChange={(e) =>
                    edit((o) => {
                      o.activation.key = e.target.value;
                    })
                  }
                />
              </Field>
              <div className="ie-row">
                <Numeric
                  label="提示偏移 X"
                  value={current.content.promptOffset.x}
                  onChange={(x) =>
                    edit((o) => {
                      o.content.promptOffset.x = x;
                    })
                  }
                />
                <Numeric
                  label="提示偏移 Y"
                  value={current.content.promptOffset.y}
                  onChange={(y) =>
                    edit((o) => {
                      o.content.promptOffset.y = y;
                    })
                  }
                />
              </div>
              <Check
                label="来源离开时取消未完成交互"
                value={current.activation.cancelOnExit}
                onChange={(v) =>
                  edit((o) => {
                    o.activation.cancelOnExit = v;
                  })
                }
              />
              <details open>
                <summary>高级接入</summary>
                <Field label="InputMap action">
                  <input
                    value={current.activation.action}
                    onChange={(e) =>
                      edit((o) => {
                        o.activation.action = e.target.value;
                      })
                    }
                  />
                </Field>
                <Field label="人物 group">
                  <input
                    value={current.detection.actorGroup}
                    onChange={(e) =>
                      edit((o) => {
                        o.detection.actorGroup = e.target.value;
                      })
                    }
                  />
                </Field>
                <Numeric
                  label="感知 mask（位掩码）"
                  value={current.detection.mask}
                  min={0}
                  onChange={(mask) =>
                    edit((o) => {
                      o.detection.mask = mask;
                    })
                  }
                />
                <Numeric
                  label="焦点优先级"
                  value={current.detection.priority}
                  onChange={(priority) =>
                    edit((o) => {
                      o.detection.priority = priority;
                    })
                  }
                />
                <p className="ie-note">
                  靠近模式需要 PhysicsBody2D，且 mask 包含人物所在
                  layer。鼠标和外部调用无需人物。
                </p>
              </details>
            </div>
          )}
          {tab === 'behavior' && (
            <div className="ie-tab-content">
              <h2>{KIND_LABELS[current.behavior.kind]}</h2>
              <BehaviorPanel
                object={current}
                assets={project.assets}
                edit={edit}
                imageBusy={busy || imageOpening || !draftWritable}
                onEditImage={(slot, index) => void openImageEdit({ kind: 'interactable', documentId: project.projectId, definitionId: current.definitionId, slot, index })}
              />
            </div>
          )}
          {tab === 'memory' && (
            <div className="ie-tab-content">
              <Field label="记忆范围">
                <NativeSelect
                  value={current.memory.scope}
                  onChange={(e) =>
                    edit((o) => {
                      o.memory.scope = e.target
                        .value as Interactable['memory']['scope'];
                    })
                  }
                >
                  <NativeSelectOption value="instance">当前实例（重载重置）</NativeSelectOption>
                  <NativeSelectOption value="session">同一局跨场景</NativeSelectOption>
                  <NativeSelectOption value="persistent">保存到存档</NativeSelectOption>
                </NativeSelect>
              </Field>
              {current.memory.scope !== 'instance' && (
                <>
                  <Field label="命名空间">
                    <input
                      value={current.memory.namespace}
                      onChange={(e) =>
                        edit((o) => {
                          o.memory.namespace = e.target.value;
                        })
                      }
                    />
                  </Field>
                  <Field label="存档槽">
                    <input
                      value={current.memory.slot}
                      onChange={(e) =>
                        edit((o) => {
                          o.memory.slot = e.target.value;
                        })
                      }
                    />
                  </Field>
                  <p>
                    同一局记忆需要游戏根节点持有共享 StateStore。持久化使用独立
                    ConfigFile，也可通过快照接口接入已有存档。
                  </p>
                  <p>
                    动态物件需要在 Godot 中设置稳定
                    instance_id。静态物件默认按关卡内路径区分。
                  </p>
                </>
              )}
              <details>
                <summary>模板身份</summary>
                <code className="[overflow-wrap:anywhere]">
                  {current.definitionId}
                </code>
                <p className="ie-note">
                  复制物件会生成新的模板身份。关卡中同模板的不同实例各自保存状态。
                </p>
              </details>
            </div>
          )}
        </aside>
      </div>
    </main>
    <Dialog open={openProject} onOpenChange={setOpenProject}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>打开交互物工程</DialogTitle><DialogDescription>选择本机草稿、服务端共享工程、源文件或资产库项目。当前草稿沿用保存与冲突保护。</DialogDescription></DialogHeader>
        <Button disabled={busy || !ready} onClick={() => { setOpenProject(false); setSharedOpen(true); }}>浏览服务端共享工程</Button>
        <Button variant="outline" disabled={busy || !ready} onClick={() => { setOpenProject(false); projectInput.current?.click(); }}>从源文件打开</Button>
        <Button variant="outline" disabled={busy || !ready} onClick={() => { setOpenProject(false); setLibrary({ purposes: ['interactable'] }); }}>从资产库选用</Button>
        <h3>当前浏览器的本机草稿</h3>
        {localProjectsLoading && <output>正在读取本机草稿…</output>}
        {localProjectsError && <p role="alert">{localProjectsError} 仍可通过上方其他入口打开工程。</p>}
        {!localProjectsLoading && !localProjectsError && !localProjects.length && <p>当前浏览器没有已保存的交互物草稿。</p>}
        {localProjects.map(item => <Button variant="outline" key={item.id} disabled={busy || !ready} onClick={() => { setOpenProject(false); void navigate(item.href); }} className="block h-auto whitespace-normal text-left"><strong>{item.title}</strong><br /><small>{item.detail}</small></Button>)}
      </DialogContent>
    </Dialog>
    <SharedDocumentPicker open={sharedOpen} kind="interactable" currentId={project.projectId} disabled={busy || !ready || imageOpening || Boolean(imageEdit)} onClose={() => setSharedOpen(false)} onOpen={async document => {
      if (latest.current.busy || imageEditing.current || !latest.current.ready) throw new Error('交互物正在处理内容，请完成后再打开工程。');
      const href = sharedDocumentHref(location.pathname, document.id);
      setSharedOpen(false);
      await navigate(href);
    }} />
    {imageEdit && <ImageEditWorkspace
      onNavigationChange={writeImageEditNavigation}
      target={imageEdit.target}
      initialEditId={imageEdit.navigation?.editId}
      initialCandidateVersion={imageEdit.navigation?.candidateVersion}
      readOnly={!imageEdit.guard}
      beforeApply={async () => {
        const current = imageEditRef.current;
        if (!current?.guard || latest.current.project.projectId !== current.guard.document.id || await documentFingerprint(await portableProject(latest.current.project)) !== current.guard.fingerprint)
          throw new Error('本机交互物在图片调整期间已变化，请保留候选并重新打开。');
      }}
      onAdopt={async receipt => {
        const current = imageEditRef.current;
        const ref = receipt.target.targetRef;
        if (!current?.guard || ref.kind !== 'interactable' || current.target.kind !== 'interactable' || !imageTargetEquals(ref, current.target) || typeof receipt.revision !== 'number' || receipt.currentRevision !== receipt.revision)
          throw new Error('已采用结果与当前物件或共享版本不匹配。');
        const { document } = await readDocument<InteractableProject>(ref.documentId, receipt.revision);
        const guard = await shared.acceptAdopted(document, current.guard);
        const next = { ...current, guard };
        imageEditRef.current = next;
        setImageEdit(next);
        setMessage(ref.slot === 'visual' ? '默认图片已采用，共享工程与本机草稿已同步。' : '指定状态图片已采用；默认图片、其他状态与行为保留。');
        setError(false);
      }}
      onClose={() => { imageEditing.current = false; imageEditRef.current = null; setImageEdit(null); clearImageEditNavigation(); }}
    />}
    </>
  );
}
