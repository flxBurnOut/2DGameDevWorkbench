/* oxlint-disable react/react-compiler -- The preview clock and document history are explicitly imperative. */
'use client';
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useId } from 'react';
import {
  Layers,
  Plus,
  Upload,
  Download,
  Save,
  Undo2,
  Redo2,
  Play,
  Square,
  LocateFixed,
  Copy,
  Trash2,
  ArrowUp,
  ArrowDown,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  RefreshCw,
  FolderOpen,
  Search,
  MoreHorizontal,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { WorkbenchBreadcrumb } from '@/components/workbench/shared-navigation';
import { EditorWorkbenchMenu, EditorDraftControl, EditorTaskSummary } from '@/components/workbench/editor-chrome';
import {
  listWorkItems,
  readWorkspaceDraft,
} from '@/lib/workbench/browser-store';
import type { WorkItem } from '@/lib/workbench/work-items';
import {
  makeId,
  type InteractableProject,
} from '@/features/interactable-editor/contract.mjs';
import {
  addInstance,
  addMaterial,
  changeAnchor,
  createScene,
  materialFor,
  reorder,
  replaceInstances,
  replaceMap,
  removeInstances,
  validateScene,
  sceneBounds,
  sceneWarnings,
  type Instance,
  type Material,
  type Point,
  type Scene,
  type SceneMap,
} from '@/features/scene-composer/model.mjs';
import { createSceneSimulation } from '@/features/scene-composer/simulation.mjs';
import { mapSplitCollisionOwner, removeMapSplitElements } from '@/features/scene-composer/map-split.mjs';
import {
  downloadScene,
  exportScene,
  importScene,
  loadScene,
  readLocalMaps,
  readLocalObjectProjects,
  readMap,
  readObjects,
} from '@/features/scene-composer/browser';
import { useSceneDocument } from './use-scene-document';
import { DocumentSyncStatus } from '@/components/workbench/document-sync-status';
import { SharedDocumentPicker } from '@/components/workbench/shared-document-picker';
import { sharedDocumentHref } from '@/features/editor-documents/library';
import { AssetImportPicker } from '@/components/workbench/asset-import-picker';
import { mapImportFile, clearImportQuery, readEditorHandoff, storeEditorHandoff, type ImportBundle, type ImportPurpose } from '@/lib/workbench/asset-import';
import { normalizeProject } from '@/features/interactable-editor/contract.mjs';
import { useWorkbench } from '@/components/workbench/workbench-provider';
import { SceneCanvas } from './scene-canvas';
import { SceneLinksPanel } from './scene-links-panel';
import { ScenePreviewFeedback } from './scene-preview-feedback';
import { ObjectArt } from './scene-art';
import { SceneImagePreview } from './scene-image-preview';
import { SceneWorkflowPanel } from './scene-workflow-panel';
import { SceneSplitPanel } from './scene-split-panel';
import { splitCollisionTransfer } from './scene-split-client.mjs';
import { mapSplitElementRect } from '@/features/scene-composer/render-model.mjs';
import type { MapSplitElement } from '@/features/scene-composer/map-split.mjs';
import { sceneWorkflowNavigation, writeSceneWorkflowNavigation } from '@/features/scene-workflow/client';
import { ImageEditWorkspace } from '@/components/image-edit/image-edit-workspace';
import { imageSlotChoices, imageTargetEquals, readImageEdit, validateSceneImageReceipt, verifiedSceneImageSource } from '@/features/image-edit/client';
import type { ImageTargetInfo, ImageTargetRef } from '@/features/image-edit/client';
import { clearImageEditNavigation, readImageEditNavigation, writeImageEditNavigation, type ImageEditNavigation } from '@/features/image-edit/navigation';
import type { DocumentSavedSnapshot } from '@/features/editor-documents/sync-controller.mjs';
import { downloadBlob } from '@/features/map-stitcher/image-utils';
import { browserDocumentMedia, documentMediaUrl } from '@/features/editor-documents/browser-media';
import './scene-composer.css';

function NumberField({
  label,
  value,
  change,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  change: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const id = useId();
  return (
    <label className="sc-field" htmlFor={id}>
      {label}
      <Input
        id={id}
        type="number"
        aria-label={label}
        value={Number(value.toFixed(3))}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          if (e.target.value === '') return;
          const n = e.target.valueAsNumber;
          if (
            Number.isFinite(n) &&
            (min === undefined || n >= min) &&
            (max === undefined || n <= max)
          )
            change(n);
        }}
      />
    </label>
  );
}
function Thumbnail({ material }: { material: Material }) {
  const v = material.project.objects[0].visual;
  const instance: Instance = {
    id: `thumb_${material.id}`,
    materialId: material.id,
    name: material.name,
    x: 0,
    y: 0,
    scale: 1,
    flipH: false,
    anchor: { x: v.offset.x, y: v.offset.y },
    locked: false,
    hidden: false,
    included: true,
  };
  const size = Math.max(40, v.width * v.scale, v.height * v.scale) * 1.2;
  return (
    <svg
      className="sc-thumbnail"
      viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      aria-hidden="true"
    >
      <ObjectArt material={material} instance={instance} />
    </svg>
  );
}
function MapThumbnail({
  map,
  choose,
}: {
  map: SceneMap;
  choose?: (point: Point) => void;
}) {
  const width = Math.max(...map.layers.map((l) => l.width)),
    height = Math.max(...map.layers.map((l) => l.height));
  const content = (
    <svg
      className="sc-map-thumbnail"
      aria-label="地图预览"
      viewBox={`0 0 ${width} ${height}`}
    >
      {map.layers.map((l) => (
        <image key={l.id} href={documentMediaUrl(l.source)} width={l.width} height={l.height} />
      ))}
    </svg>
  );
  if (!choose) return content;
  return (
    <button
      className="sc-pick-point"
      aria-label="选择地图对应点（可使用下方坐标输入）"
      onClick={(e) => {
        const svg = e.currentTarget.querySelector('svg')!;
        if (e.detail === 0) {
          choose({ x: map.origin.x + width / 2, y: map.origin.y + height / 2 });
          return;
        }
        const point = svg.createSVGPoint();
        point.x = e.clientX;
        point.y = e.clientY;
        const matrix = svg.getScreenCTM();
        if (!matrix) return;
        const p = point.matrixTransform(matrix.inverse());
        choose({
          x: Math.round(p.x + map.origin.x),
          y: Math.round(p.y + map.origin.y),
        });
      }}
    >
      {content}
    </button>
  );
}

export function SceneComposer() {
  'use no memo';
  const { navigate } = useWorkbench();
  const [library, setLibrary] = useState<{ purpose: ImportPurpose; assetId?: string; replace?: boolean } | null>(null);
  const [sharedOpen, setSharedOpen] = useState(false);
  const importStarted = useRef(false);
  const [handoffUrl, setHandoffUrl] = useState('');
  const [imageEdit, setImageEdit] = useState<{ target: ImageTargetRef; guard: DocumentSavedSnapshot<Scene> | null; navigation?: ImageEditNavigation } | null>(null);
  const [imageSlot, setImageSlot] = useState('visual');
  const [workflow, setWorkflow] = useState<DocumentSavedSnapshot<Scene> | null>(null);
  const [splitWindow, setSplitWindow] = useState<DocumentSavedSnapshot<Scene> | null>(null);
  const [splitInitialMode, setSplitInitialMode] = useState<'auto' | 'local' | 'vision'>();
  const [workflowInitialId, setWorkflowInitialId] = useState<string>();
  const workflowNavigationConsumed = useRef(false);
  const imageEditRef = useRef(imageEdit), imageNavigationConsumed = useRef(false);
  useLayoutEffect(() => { imageEditRef.current = imageEdit; }, [imageEdit]);
  const doc = useSceneDocument(),
    { scene, ready, busy: documentBusy } = doc;
  const imageOpening = doc.sessionState.phase === 'preparing' && doc.sessionState.tool === 'image';
  const workflowOpening = doc.sessionState.phase === 'preparing' && doc.sessionState.tool === 'workflow';
  const busy = documentBusy || !['editing', 'preview'].includes(doc.sessionState.phase);
  const [selected, setSelected] = useState<string[]>([]),
    [tab, setTab] = useState<'materials' | 'nodes'>('materials');
  const [search, setSearch] = useState(''),
    [notice, setNotice] = useState('从地图开始，拖入物件后可右键调整遮挡。');
  const preview = doc.sessionState.phase === 'preview';
  const setPreview = (value: boolean) => doc.session.preview(value);
  const [reset, setReset] = useState(0),
    [clock, setClock] = useState(0);
  const [targetMode, setTargetMode] = useState<'before' | 'after' | null>(null);
  const [dialog, setDialog] = useState<
    'new' | 'open' | 'map' | 'objects' | 'replace' | null
  >(null);
  const [local, setLocal] = useState<WorkItem[]>([]),
    [newName, setNewName] = useState('新场景');
  const [project, setProject] = useState<InteractableProject | null>(null),
    [objectIds, setObjectIds] = useState<string[]>([]);
  const [pendingMap, setPendingMap] = useState<SceneMap | null>(null),
    [pendingScene, setPendingScene] = useState<Scene | null>(null);
  const [replacement, setReplacement] = useState<Material | null>(null);
  useEffect(() => {
    browserDocumentMedia.retain('scene-picker', [
      ...(project ? [{ kind: 'interactable', content: project }] : []),
      ...(pendingMap ? [{ kind: 'scene', content: { map: pendingMap, materials: [] } }] : []),
      ...(pendingScene ? [{ kind: 'scene', content: pendingScene }] : []),
      ...(replacement ? [{ kind: 'interactable', content: replacement.project }] : []),
    ]);
  }, [project, pendingMap, pendingScene, replacement]);
  useEffect(() => () => browserDocumentMedia.release('scene-picker'), []);
  const [align, setAlign] = useState(false),
    [oldPoint, setOldPoint] = useState<Point>({ x: 0, y: 0 }),
    [newPoint, setNewPoint] = useState<Point>({ x: 0, y: 0 });
  const [exportLinks, setExportLinks] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null),
    workArea = useRef<HTMLDivElement>(null);
  const fileMode = useRef<'map' | 'objects' | 'scene'>('map');
  const replacementIds = useRef<string[]>([]),
    draggedNodes = useRef<string[]>([]);
  useEffect(() => {
    setSelected((previous) => {
      const valid = previous.filter((id) => scene.order.includes(id));
      return valid.length === previous.length ? previous : valid;
    });
  }, [scene.order]);
  const simKey = useMemo(() => JSON.stringify([
    preview,
    reset,
    scene.id,
    scene.instances,
    scene.order,
    scene.materials,
    scene.links,
  ]), [preview, reset, scene.id, scene.instances, scene.order, scene.materials, scene.links]);
  // Camera changes and save status must not reset the temporary interaction state.
  const sim = useMemo(() => createSceneSimulation(scene), [simKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const bounds = sceneBounds(scene);
    sim.moveActor(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      if (preview) sim.tick(Math.min(0.1, (now - last) / 1000));
      last = now;
      setClock(preview ? sim.time : now / 1000);
    }, 50);
    return () => clearInterval(timer);
  }, [sim, preview]); // eslint-disable-line react-hooks/exhaustive-deps -- Fixed scene snapshot for this preview session.
  useEffect(() => {
    if (!preview) return;
    const played = new WeakSet<object>(),
      audio = new Set<HTMLAudioElement>();
    const timer = setInterval(() => {
      for (const event of sim.events) {
        if (event.name !== 'play_audio' || played.has(event)) continue;
        played.add(event);
        const i = scene.instances.find((item) => item.id === event.instanceId);
        const asset =
          i &&
          materialFor(scene, i)?.project.assets.find(
            (a) => a.id === event.assetId,
          );
        if (!asset) continue;
        const player = new Audio(documentMediaUrl(asset.source));
        audio.add(player);
        player.volume = Math.min(1, 10 ** ((event.volumeDb || 0) / 20));
        const done = () => {
          audio.delete(player);
          if (
            sim.waiting?.type === 'play_audio' &&
            sim.active?.id === event.instanceId &&
            sim.waiting.assetId === event.assetId
          )
            sim.finishAudio();
        };
        player.onended = done;
        player.onerror = () => {
          setNotice(`音效无法播放：${asset.name}`);
          done();
        };
        void player.play().catch(() => {
          setNotice('浏览器暂未允许音频播放；再次点击预览操作后重试。');
          done();
        });
      }
      if (!sim.active)
        for (const a of audio) {
          if (!a.ended && sim.events[0]?.name === 'interaction_cancelled') {
            a.pause();
            audio.delete(a);
          }
        }
    }, 40);
    return () => {
      clearInterval(timer);
      for (const a of audio) a.pause();
    };
  }, [sim, preview]); // eslint-disable-line react-hooks/exhaustive-deps -- Fixed scene snapshot for this preview session.

  const selectedInstances = scene.instances.filter((i) =>
    selected.includes(i.id),
  );
  const active =
    selectedInstances.length === 1 ? selectedInstances[0] : undefined;
  const activeMaterial = active && materialFor(scene, active);
  const activeSplit = selected.length === 1 ? scene.mapSplit?.elements.find(element => element.id === selected[0]) : undefined;
  const [splitPartId, setSplitPartId] = useState(''), [splitImageWindow, setSplitImageWindow] = useState('');
  const splitPart = activeSplit?.parts.find(part => part.id === splitPartId) ?? activeSplit?.parts[0];
  const slotChoices = activeMaterial ? imageSlotChoices(activeMaterial.project.objects[0], true) : [];
  const selectedSlot = slotChoices.find(choice => choice.value === imageSlot) || slotChoices[0];
  const layer =
    selected.length === 1
      ? scene.map?.layers.find((l) => l.id === selected[0])
      : undefined;
  const flagNodes = [...scene.instances, ...(scene.map?.layers || []), ...(scene.mapSplit?.elements || [])].filter(
    (i) => selected.includes(i.id),
  );
  const warnings = sceneWarnings(scene);
  const visibleNodeIds = scene.order.filter(id => !scene.mapSplit || scene.mapSplit.stale || !scene.map?.layers.some(mapLayer => mapLayer.id === id));
  const objectCount = scene.instances.length + (scene.mapSplit && !scene.mapSplit.stale ? scene.mapSplit.elements.filter(element => element.kind === 'object').length : 0);
  const nodeName = (id: string) =>
    id === 'actor'
      ? '玩家所在层'
      : scene.instances.find((i) => i.id === id)?.name ||
        scene.mapSplit?.elements.find(element => element.id === id)?.name ||
        scene.map?.layers.find((l) => l.id === id)?.name ||
        id;
  const select = (ids: string[]) => {
    setSelected(ids);
  };
  const fit = () => {
    const rect = workArea.current
      ?.querySelector('svg.sc-canvas')
      ?.getBoundingClientRect();
    if (!rect) return;
    const b = sceneBounds(doc.current.current),
      zoom = Math.max(
        0.02,
        Math.min(4, (rect.width - 80) / b.width, (rect.height - 80) / b.height),
      );
    doc.edit((s) => {
      s.view.zoom = zoom;
      s.view.x = (rect.width - b.width * zoom) / 2 - b.x * zoom;
      s.view.y = (rect.height - b.height * zoom) / 2 - b.y * zoom;
    }, false);
  };
  useEffect(() => {
    if (!ready) return;
    const url = new URL(location.href);
    if (url.searchParams.get('fit') !== '1') return;
    const frame = requestAnimationFrame(() => {
      fit();
      url.searchParams.delete('fit');
      window.history.replaceState(null, '', url.pathname + url.search);
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, scene.id]); // eslint-disable-line react-hooks/exhaustive-deps -- Explicit one-time map handoff request.
  const arrange = (action: string, target?: string | number) => {
    if (busy || preview) return;
    if (action.startsWith('target-')) {
      setTargetMode(action === 'target-before' ? 'before' : 'after');
      setTab('nodes');
      return;
    }
    doc.edit((s) => {
      reorder(s, selected, action, target);
    });
    setTargetMode(null);
  };
  const duplicate = (offset = 16, selection = selected) => {
    const ids: string[] = [];
    doc.edit((s) => {
      const originals = s.order.filter((id) => selection.includes(id));
      for (const key of originals) {
        const element = s.mapSplit?.elements.find(item => item.id === key);
        if (element && !element.locked) {
          const copied = { ...structuredClone(element), id: makeId('map_object'), name: `${element.name} 副本`, x: element.x + offset, y: element.y + offset };
          delete copied.sourceKey;
          copied.collision.mapIndices = [];
          s.mapSplit!.elements.push(copied); s.mapSplit!.review = 'unverified';
          s.order.splice(s.order.indexOf(key), 0, copied.id); ids.push(copied.id);
          continue;
        }
        const i = s.instances.find((item) => item.id === key);
        if (!i || i.locked) continue;
        const copied = {
          ...structuredClone(i),
          id: makeId('instance'),
          name: `${i.name} 副本`,
          x: i.x + offset,
          y: i.y + offset,
        };
        s.instances.push(copied);
        s.order.splice(s.order.indexOf(key), 0, copied.id);
        ids.push(copied.id);
      }
    });
    setSelected(ids);
    return ids;
  };
  const remove = () => {
    if (preview) return;
    let removedLinks = 0;
    const applied = doc.edit((s) => {
      const ids = new Set(
        s.instances
          .filter((i) => selected.includes(i.id) && !i.locked)
          .map((i) => i.id),
      );
      removedLinks = removeInstances(s, [...ids]).length;
      if (s.mapSplit) {
        const removed = s.mapSplit.elements.filter(element => selected.includes(element.id) && !element.locked).map(element => element.id);
        removeMapSplitElements(s, removed);
      }
    });
    if (applied) {
      setSelected([]);
      if (removedLinks) setNotice(`已删除物件及 ${removedLinks} 条关联联动，可用撤销恢复。`);
    }
  };
  const add = (materialId: string, p: Point) => {
    if (!materialId || !scene.map || preview) return;
    doc.edit((s) => {
      const i = addInstance(
        s,
        materialId,
        Math.round(p.x / s.view.grid) * s.view.grid,
        Math.round(p.y / s.view.grid) * s.view.grid,
      );
      setSelected([i.id]);
    });
  };
  const flags = (key: 'locked' | 'hidden' | 'included', value: boolean) =>
    doc.edit((s) => {
      for (const node of [...s.instances, ...(s.map?.layers || []), ...(s.mapSplit?.elements || [])])
        if (selected.includes(node.id) && (key === 'locked' || !node.locked)) node[key] = value;
    });
  const changeSplit = (fn: (element: MapSplitElement) => void) => doc.edit(s => {
    const element = s.mapSplit?.elements.find(item => item.id === activeSplit?.id);
    if (element && !element.locked) { fn(element); s.mapSplit!.review = 'unverified'; }
  });
  const openPicker = (kind: typeof dialog) => {
    if (preview) setPreview(false);
    replacementIds.current = selectedInstances
      .filter((i) => !i.locked)
      .map((i) => i.id);
    setProject(null);
    setObjectIds([]);
    void doc.perform(async () => {
      setLocal(
        kind === 'map'
          ? await readLocalMaps()
          : kind === 'open'
            ? (await listWorkItems()).filter(
                (i) => i.capabilityId === 'scene-composer',
              )
            : kind === 'new'
              ? []
              : await readLocalObjectProjects(),
      );
      setDialog(kind);
    });
  };
  const chooseMap = (map: SceneMap) => {
    if (!map.layers.length) throw new Error('地图中没有可用的视觉层。');
    const check = createScene();
    replaceMap(check, map);
    validateScene(check);
    map.offset = scene.map ? { ...scene.map.offset } : { x: 0, y: 0 };
    setPendingMap(map);
    setAlign(false);
    setOldPoint(
      scene.map
        ? {
            x: scene.map.origin.x + scene.map.offset.x,
            y: scene.map.origin.y + scene.map.offset.y,
          }
        : { x: 0, y: 0 },
    );
    setNewPoint({ ...map.origin });
    setDialog(null);
  };
  const chooseObjects = async (incoming: InteractableProject) => {
    const p = await browserDocumentMedia.compact('interactable', incoming);
    setProject(p);
    setObjectIds(
      dialog === 'replace'
        ? [p.objects[0].definitionId]
        : p.objects.map((o) => o.definitionId),
    );
  };
  const file = (mode: typeof fileMode.current) => {
    fileMode.current = mode;
    if (fileInput.current) {
      fileInput.current.accept =
        mode === 'objects' ? '.json,.zip' : '.zip,.json';
      fileInput.current.click();
    }
  };
  const openImported = async (next: Scene) => {
    const existing = await readWorkspaceDraft(`scene:${next.id}`);
    setDialog(null);
    if (existing) setPendingScene(next);
    else {
      await doc.replaceDocument(next, true);
      setSelected([]);
    }
  };
  const importFromLibrary = async (bundle: ImportBundle) => {
    const success = await doc.perform(async () => {
      if (bundle.purpose === 'map') chooseMap(await readMap(await mapImportFile(bundle)));
      else if (bundle.purpose === 'scene') await openImported(await importScene(bundle.files[0].file));
      else {
        const incoming = normalizeProject(JSON.parse(await bundle.files[0].file.text())) as InteractableProject;
        await chooseObjects(incoming);
        if (bundle.asset.definitionIds?.length) setObjectIds(bundle.asset.definitionIds);
        else if (bundle.asset.definitionId) setObjectIds([bundle.asset.definitionId]);
        setDialog(library?.replace ? 'replace' : 'objects');
      }
    });
    if (!success) throw new Error('导入未应用，请检查源文件或当前编辑状态。');
  };
  const consumeImport = useEffectEvent(() => {
    const params = new URLSearchParams(location.search);
    const assetId = params.get('importAsset'), purpose = params.get('importPurpose');
    if (assetId && ['map', 'interactable', 'scene'].includes(purpose || '')) {
      setLibrary({purpose: purpose as ImportPurpose, assetId});
      clearImportQuery();
    } else if (params.has('handoff')) {
      void doc.perform(async () => {
        const record = await readEditorHandoff('scene-composer');
        if (record?.purpose === 'interactable') {
          const payload = record.payload as {project: unknown; definitionIds?: string[]};
          const incoming = normalizeProject(payload.project) as InteractableProject;
          await chooseObjects(incoming);
          setObjectIds(payload.definitionIds || incoming.objects.map(o => o.definitionId));
          setDialog('objects');
        }
        clearImportQuery();
      });
    }
  });
  useEffect(()=>{if(!ready||importStarted.current)return;importStarted.current=true;queueMicrotask(()=>consumeImport());},[ready]);
  useEffect(()=>{
    if(!busy && handoffUrl) queueMicrotask(()=>{setHandoffUrl('');void navigate(handoffUrl);});
  },[busy,handoffUrl,navigate]);
  const editMaterial = () => void doc.perform(async () => {
    const material = active && materialFor(scene, active);
    if (!material) return;
    await doc.save();
    const href = await storeEditorHandoff('interactable-editor', 'interactable', {project: await browserDocumentMedia.hydrate('interactable', material.project)});
    // Navigate only after the editor has published its idle state.
    setHandoffUrl(href);
  });
  const editMapSource = () => void doc.perform(async () => {
    if (!scene.map) return;
    await doc.save();
    const href = await storeEditorHandoff('map-stitcher', 'map', {source: await browserDocumentMedia.dataUrl(scene.map.source, 'application/zip'), name: scene.map.name + '.zip'});
    setHandoffUrl(href);
  });
  const openWorkflow = useCallback(async (workId?: string) => {
    if (busy || preview) return;
    try {
      const guard = await doc.session.open('workflow');
      setWorkflowInitialId(workId); setWorkflow(guard);
    } catch (error) { setNotice(error instanceof Error ? error.message : '场景协作尚未打开。'); }
  }, [busy, preview, doc]);
  const openSplit = useCallback(async (mode?: 'auto' | 'local' | 'vision') => {
    if (busy || preview || !doc.current.current.map) return;
    try {
      const guard = await doc.session.open('split');
      setSplitInitialMode(mode); setSplitWindow(guard);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : '地图分层尚未打开。'); }
  }, [busy, preview, doc]);
  useEffect(() => {
    if (!ready || busy || preview || workflowNavigationConsumed.current) return;
    const navigation = sceneWorkflowNavigation(location.href);
    if (!navigation || navigation.documentId !== scene.id) return;
    workflowNavigationConsumed.current = true;
    void openWorkflow(navigation.workId);
  }, [ready, busy, preview, scene.id, openWorkflow]);
  const openImageEdit = async (target: ImageTargetRef, navigation?: ImageEditNavigation) => {
    if (busy || preview) return;
    try {
      const guard = await doc.session.open('image');
      if (!['scene-layer', 'scene-instance', 'scene-split-part'].includes(target.kind) || !('documentId' in target) || target.documentId !== guard.document.id) throw new Error('保存期间场景或图片目标已变化，请重新选择。');
      if (target.kind === 'scene-layer' && !guard.document.content.map?.layers.some(item => item.id === target.layerId)) throw new Error('选中的场景图层已不存在。');
      if (target.kind === 'scene-instance' && !guard.document.content.instances.some(item => item.id === target.instanceId)) throw new Error('选中的场景实例已不存在。');
      if (target.kind === 'scene-split-part' && !guard.document.content.mapSplit?.elements.some(element => element.id === target.elementId && element.parts.some(part => part.id === target.partId))) throw new Error('选中的分层子片已不存在。');
      const next = { target, guard, navigation }; imageEditRef.current = next; setImageEdit(next);
    } catch (error) {
      if (doc.sessionState.tool === 'image' || doc.session.getState().tool === 'image') doc.session.close();
      if (navigation && ['scene-layer', 'scene-instance', 'scene-split-part'].includes(target.kind)) {
        doc.session.openReadOnly('image');
        const next = { target, guard: null, navigation }; imageEditRef.current = next; setImageEdit(next);
      }
      setNotice(error instanceof Error ? error.message : '图片调整尚未打开。');
    }
  };
  const resumeImageEdit = useEffectEvent(() => {
    const navigation = readImageEditNavigation(); if (!navigation) return;
    void readImageEdit(navigation.editId).then(({ edit }) => {
      if (!['scene-layer', 'scene-instance', 'scene-split-part'].includes(edit.target.targetRef.kind)) throw new Error('此图片会话不属于场景图层、实例或分层子片。');
      return openImageEdit(edit.target.targetRef, navigation);
    }).catch(error => setNotice(error instanceof Error ? error.message : '历史会话读取失败。'));
  });
  useEffect(() => { if (!ready || imageNavigationConsumed.current) return; imageNavigationConsumed.current = true; resumeImageEdit(); }, [ready]);
  const closeImageEdit = () => { doc.session.close(); imageEditRef.current = null; setImageEdit(null); clearImageEditNavigation(); };
  const imageEditMapSource = async (target: ImageTargetInfo) => {
    const current = imageEditRef.current;
    if (!current?.guard || !imageTargetEquals(target.targetRef, current.target)) throw new Error('宿主场景已变化；请关闭调整窗口并刷新场景后再打开源包。');
    await doc.session.check();
    const document = current.guard.document;
    const source = await verifiedSceneImageSource(target, { ...document, content: { ...document.content,
      map: document.content.map && { ...document.content.map, source: await browserDocumentMedia.dataUrl(document.content.map.source, 'application/zip') },
    } });
    await doc.session.check();
    if (imageEditRef.current !== current) throw new Error('核验期间宿主场景已变化，未交付源包；请刷新场景。');
    return { ...source, name: current.guard.document.content.map!.name + '.zip' };
  };
  const renderImageContext = useCallback((source: string) => imageEdit ? <SceneImagePreview scene={scene} target={imageEdit.target} source={source} /> : null, [scene, imageEdit]);
  const applyObjects = () => {
    if (!project) return;
    if (dialog === 'replace') {
      const temporary = createScene();
      const m = addMaterial(temporary, project, objectIds[0]);
      setReplacement(m);
      setDialog(null);
      return;
    }
    const applied = doc.edit((s) => {
      for (const id of objectIds) addMaterial(s, project, id);
    });
    if (!applied) return;
    setDialog(null);
    setTab('materials');
    setNotice(`已加入 ${objectIds.length} 个素材，拖到画布即可摆放。`);
  };
  const sourceDownload = () =>
    void doc.perform(async () => {
      const s = doc.current.current;
      await downloadScene(s);
      await doc.markBackup(s.revision);
      setNotice('已发起场景源文件下载。');
    });
  const exportSavedScene = async () => {
    try {
      const guard = await doc.session.open('export');
      const result = await exportScene(guard.document.content, guard.document);
      setExportLinks(result.outputs);
      setNotice(`已导出共享版本 ${guard.document.revision}，来源身份与哈希已写入资源包。`);
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : '场景导出未完成。'); }
    finally { if (doc.session.getState().tool === 'export') doc.session.close(); }
  };
  const exportLocalDraft = () => void doc.perform(async () => {
    const result = await exportScene(doc.current.current);
    setExportLinks(result.outputs);
    setNotice('已导出本机草稿，资源包保留草稿内容哈希。');
  });
  const changeActive = (fn: (i: Instance) => void) =>
    doc.edit((s) => {
      const i = s.instances.find((item) => item.id === active?.id);
      if (i && !i.locked) fn(i);
    });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (
        e.target instanceof Element && e.target.closest(
          'input,textarea,select,[contenteditable="true"],[role="dialog"],[role="menu"]',
        )
      )
        return;
      if (e.key === 'Escape') {
        setTargetMode(null);
        return;
      }
      if (dialog || pendingMap || pendingScene || replacement || busy || !ready)
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void doc.save().catch(() => {});
        return;
      }
      if (preview) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (
          sim.waiting?.type === 'show_text' &&
          ['enter', ' ', sim.active?.definition.activation.key.toLowerCase()].includes(e.key.toLowerCase())
        ) {
          e.preventDefault();
          sim.advanceText();
        } else if (
          sim.focus &&
          e.key.toLowerCase() ===
            sim.focus.definition.activation.key.toLowerCase()
        ) {
          e.preventDefault();
          sim.press();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doc.redo();
        else doc.undo();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        duplicate();
      } else if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        remove();
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const n = e.shiftKey ? 10 : 1;
        doc.edit((s) => {
          for (const i of s.instances)
            if (selected.includes(i.id) && !i.locked) {
              i.x +=
                e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0;
              i.y += e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
            }
          for (const element of s.mapSplit?.elements ?? []) if (selected.includes(element.id) && !element.locked) {
            element.x += e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0;
            element.y += e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0;
          }
        });
      } else if (e.key === '0') fit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
    <main className="sc-workspace" data-scene-composer inert={imageOpening || Boolean(imageEdit) || workflowOpening || Boolean(workflow)}>
      <header className="sc-header">
        <div className="sc-title">
          <EditorWorkbenchMenu />
          <WorkbenchBreadcrumb compact projectName={ready ? scene.name : '正在打开场景…'} />
        </div>
        <div className="sc-actions">
          <EditorDraftControl capabilityId="scene-composer" />
          <EditorTaskSummary compact />
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !ready}
            onClick={() => openPicker('new')}
          >
            <Plus />
            新建
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !ready}
            onClick={() => openPicker('open')}
          >
            <FolderOpen />
            打开工程
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="更多项目操作" />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem disabled={busy || !ready} onClick={sourceDownload}>
                <Save /> 下载源文件
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy || !ready || !scene.map} onClick={exportLocalDraft}>
                <Download /> 导出本机草稿为 Godot
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || preview || !ready}
            onClick={() => void openWorkflow()}
          >
            <Users /> 场景协作
          </Button>
          <Button
            size="sm"
            disabled={busy || preview || !scene.map || !ready}
            onClick={() => void exportSavedScene()}
          >
            <Download />
            导出 Godot
          </Button>
        </div>
      </header>
      {ready && !doc.untouched && <DocumentSyncStatus state={doc.shared} disabled={busy || preview} />}
      <div className="sc-toolbar">
        <div className="sc-actions">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || preview || !ready}
            onClick={() => openPicker('map')}
          >
            {scene.map ? <RefreshCw /> : <Upload />}
            {scene.map ? '替换地图' : '选择地图'}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || preview || !ready || !scene.map} onClick={() => void openSplit('auto')}>一键地图粗分</Button>
          <Button size="sm" variant="ghost" disabled={busy || preview || !ready || !scene.map} onClick={() => void openSplit()}>分层候选 / 恢复</Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || preview || !ready}
            onClick={() => openPicker('objects')}
          >
            <Plus />
            添加交互物
          </Button>
          <span className="sc-divider" />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="撤销场景修改"
            disabled={busy || preview || !doc.canUndo}
            onClick={doc.undo}
          >
            <Undo2 />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="重做场景修改"
            disabled={busy || preview || !doc.canRedo}
            onClick={doc.redo}
          >
            <Redo2 />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="适配地图"
            disabled={busy || !scene.map}
            onClick={fit}
          >
            <LocateFixed />
          </Button>
        </div>
        <div className="sc-actions">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" variant="ghost" />}>
              辅助显示
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {(
                [
                  ['showGrid', '网格'],
                  ['showNames', '物件名称'],
                  ['showShapes', '碰撞与交互范围'],
                  ['showActor', '玩家参考来源'],
                ] as const
              ).map(([key, label]) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={scene.view[key]}
                  onCheckedChange={(value) =>
                    doc.edit((s) => {
                      s.view[key] = value;
                    })
                  }
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant={preview ? 'default' : 'outline'}
            disabled={busy || !scene.map}
            onClick={() => {
              setPreview(!preview);
              setTargetMode(null);
            }}
          >
            {preview ? <Square /> : <Play />}
            {preview ? '退出预览' : '交互预览'}
          </Button>
        </div>
      </div>
      {doc.error && (
        <div className="sc-error" role="alert">
          {doc.error}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={sourceDownload}
          >
            下载源文件备份
          </Button>
        </div>
      )}
      <div className="sc-body" ref={workArea}>
        <aside className="sc-library">
          <div className="sc-tabs">
            <button
              aria-pressed={tab === 'materials'}
              onClick={() => setTab('materials')}
            >
              素材 <span>{scene.materials.length}</span>
            </button>
            <button
              aria-pressed={tab === 'nodes'}
              onClick={() => setTab('nodes')}
            >
              场景节点 <span>{visibleNodeIds.length}</span>
            </button>
          </div>
          <label className="sc-search" htmlFor="sc-search">
            <Search size={15} />
            <Input
              id="sc-search"
              aria-label="搜索素材或节点"
              placeholder="搜索名称"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div className="sc-library-scroll">
            {tab === 'materials' ? (
              <>
                {!scene.materials.length && (
                  <div className="sc-empty">
                    <Layers />
                    <p>添加制作好的交互物</p>
                    <span>图片和行为在交互物编辑器中制作。</span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !ready}
                      onClick={() => openPicker('objects')}
                    >
                      添加交互物
                    </Button>
                  </div>
                )}
                {scene.materials
                  .filter((m) => m.name.includes(search))
                  .map((m) => (
                    <div
                      className="sc-material"
                      key={m.id}
                      draggable={!busy && !preview}
                      onDragStart={(e) =>
                        e.dataTransfer.setData(
                          'application/x-scene-material',
                          m.id,
                        )
                      }
                    >
                      <Thumbnail material={m} />
                      <strong title={m.name}>{m.name}</strong>
                      <span>
                        {
                          scene.instances.filter((i) => i.materialId === m.id)
                            .length
                        }{' '}
                        个已摆放
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || preview || !scene.map}
                        onClick={() => {
                          const b = sceneBounds(scene);
                          add(m.id, {
                            x: b.x + b.width / 2,
                            y: b.y + b.height / 2,
                          });
                        }}
                      >
                        放入地图
                      </Button>
                    </div>
                  ))}
              </>
            ) : (
              <>
                <p className="sc-note">上方在前 · 拖动节点调整遮挡</p>
                {visibleNodeIds
                  .filter((id) => nodeName(id).includes(search))
                  .map((id) => {
                    const node =
                      scene.instances.find((i) => i.id === id) ||
                      scene.mapSplit?.elements.find(element => element.id === id) ||
                      scene.map?.layers.find((l) => l.id === id);
                    return (
                      <div
                        key={id}
                        className={`sc-node ${selected.includes(id) ? 'is-selected' : ''} ${id === 'actor' ? 'sc-actor-node' : ''}`}
                        draggable={!busy && !preview && !node?.locked}
                        onDragStart={(e) => {
                          draggedNodes.current = selected.includes(id)
                            ? selected
                            : [id];
                          e.dataTransfer.setData(
                            'application/x-scene-node',
                            id,
                          );
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (
                            busy ||
                            preview ||
                            !e.dataTransfer.getData('application/x-scene-node')
                          )
                            return;
                          const after =
                            e.clientY >
                            e.currentTarget.getBoundingClientRect().top +
                              e.currentTarget.getBoundingClientRect().height /
                                2;
                          doc.edit((s) =>
                            reorder(
                              s,
                              draggedNodes.current,
                              after ? 'after' : 'before',
                              id,
                            ),
                          );
                        }}
                      >
                        <button
                          className="sc-node-name"
                          onClick={(e) => {
                            if (targetMode) {
                              arrange(targetMode, id);
                              return;
                            }
                            setSelected(
                              e.shiftKey
                                ? selected.includes(id)
                                  ? selected.filter((key) => key !== id)
                                  : [...selected, id]
                                : [id],
                            );
                          }}
                        >
                          <span>{visibleNodeIds.indexOf(id) + 1}</span>
                          <strong title={nodeName(id)}>{nodeName(id)}</strong>
                        </button>
                        {node && (
                          <>
                            <button
                              aria-label={`${node.hidden ? '显示' : '隐藏'} ${nodeName(id)}（仅编辑）`}
                              disabled={busy || preview || node.locked}
                              onClick={() =>
                                doc.edit((s) => {
                                  const item = [
                                    ...s.instances,
                                    ...(s.map?.layers || []),
                                    ...(s.mapSplit?.elements || []),
                                  ].find((n) => n.id === id)!;
                                  item.hidden = !item.hidden;
                                })
                              }
                            >
                              {node.hidden ? (
                                <EyeOff size={14} />
                              ) : (
                                <Eye size={14} />
                              )}
                            </button>
                            <button
                              aria-label={`${node.locked ? '解锁' : '锁定'} ${nodeName(id)}`}
                              disabled={busy || preview}
                              onClick={() =>
                                doc.edit((s) => {
                                  const item = [
                                    ...s.instances,
                                    ...(s.map?.layers || []),
                                    ...(s.mapSplit?.elements || []),
                                  ].find((n) => n.id === id)!;
                                  item.locked = !item.locked;
                                })
                              }
                            >
                              {node.locked ? (
                                <Lock size={14} />
                              ) : (
                                <Unlock size={14} />
                              )}
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
              </>
            )}
          </div>
        </aside>
        <section className="sc-stage">
          <SceneCanvas
            scene={scene}
            selected={selected}
            select={select}
            edit={doc.edit}
            duplicate={duplicate}
            drop={add}
            arrange={arrange}
            remove={remove}
            replace={() => openPicker('replace')}
            disabled={
              busy ||
              !ready ||
              !!dialog ||
              !!pendingMap ||
              !!replacement ||
              !!pendingScene
            }
            preview={preview}
            sim={sim}
            time={clock}
            targetMode={targetMode}
            target={(id) => arrange(targetMode!, id)}
            notice={setNotice}
          />
          {preview && (
            <div className="sc-preview-controls">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const i =
                    sim.objects.find((o) => selected.includes(o.id)) ||
                    sim.objects[0];
                  if (i) {
                    sim.moveActor(
                      i.x + i.definition.detection.shape.offset.x,
                      i.y + i.definition.detection.shape.offset.y,
                    );
                    setSelected([i.id]);
                  }
                }}
              >
                靠近选中物件
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  sim.moveActor(
                    sceneBounds(scene).x - 10000,
                    sceneBounds(scene).y - 10000,
                  )
                }
              >
                离开
              </Button>
              <Button size="sm" variant="outline" onClick={() => sim.press()}>
                按键交互
                {sim.focus ? ` · ${sim.focus.definition.activation.key}` : ''}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !sim.objects.some(
                    (i) =>
                      selected.includes(i.id) &&
                      i.definition.activation.mode === 'external_request' && i.enabled && !i.state.completed,
                  )
                }
                onClick={() => {
                  const i = sim.objects.find(
                    (o) =>
                      selected.includes(o.id) &&
                      o.definition.activation.mode === 'external_request' && o.enabled && !o.state.completed,
                  );
                  if (i) sim.request(i);
                }}
              >
                模拟外部触发
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setReset((n) => n + 1)}
              >
                <RefreshCw />
                重置
              </Button>
            </div>
          )}
          {preview && sim.waiting?.type === 'show_text' && (
            <div className="sc-dialogue">
              <p>
                {sim.active?.definition.content.charactersPerSecond === 0
                  ? sim.waiting.pages[sim.waiting.index]
                  : sim.waiting.pages[sim.waiting.index]?.slice(
                      0,
                      Math.floor(sim.waiting.shown),
                    )}
              </p>
              <Button size="sm" onClick={() => sim.advanceText()}>
                继续 · {sim.waiting.index + 1}/{sim.waiting.pages.length}
              </Button>
            </div>
          )}
        </section>
        <aside className="sc-inspector">
          <h2>
            {preview
              ? '预览检查'
              : selected.length
                ? `已选择 ${selected.length} 项`
                : '场景设置'}
          </h2>
          {preview ? (
            <ScenePreviewFeedback scene={scene} sim={sim} selected={selected} select={setSelected} />
          ) : (
            <fieldset disabled={busy || !ready}>
              {!selected.length && (
                <>
                  <label className="sc-field" htmlFor="sc-name">
                    场景名称
                    <Input
                      id="sc-name"
                      value={scene.name}
                      maxLength={120}
                      onChange={(e) =>
                        doc.edit((s) => {
                          s.name = e.target.value || '未命名场景';
                        })
                      }
                    />
                  </label>
                  <NumberField
                    label="吸附间距（像素）"
                    value={scene.view.grid}
                    min={1}
                    max={256}
                    change={(n) =>
                      doc.edit((s) => {
                        s.view.grid = Math.round(n);
                      })
                    }
                  />
                  {scene.map && (
                    <>
                      <h3>{scene.map.name}</h3>
                      <Button size="sm" variant="outline" onClick={editMapSource} disabled={busy}>编辑地图源文件</Button>
                      <p className="sc-note">
                        {sceneBounds(scene).width} × {sceneBounds(scene).height}{' '}
                        · {scene.map.layers.length} 个视觉层 ·{' '}
                        {scene.map.collisions.length} 个碰撞区域
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openPicker('map')}
                      >
                        手动替换地图
                      </Button>
                    </>
                  )}
                </>
              )}
              {active && (
                <>
                  <Button size="sm" variant="outline" onClick={editMaterial} disabled={busy}>编辑此交互物</Button>
                  <label className="sc-field">要调整的图片<select aria-label="要调整的图片" value={selectedSlot?.value || 'visual'} onChange={event => setImageSlot(event.target.value)}>{slotChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}{choice.available ? '' : ` · ${choice.reason}`}</option>)}</select></label>
                  <Button size="sm" variant="outline" disabled={busy || active.locked || !selectedSlot?.available} onClick={() => { if (selectedSlot) void openImageEdit({ kind: 'scene-instance', documentId: scene.id, instanceId: active.id, slot: selectedSlot.slot, ...(selectedSlot.index !== undefined ? { index: selectedSlot.index } : {}) }); }}>局部调整选中实例图片</Button>
                  <p className="sc-note">只改此实例；采用时派生独立素材。共享原素材的 {scene.instances.filter(item => item.materialId === active.materialId).length - 1} 个其他实例保留。{!selectedSlot?.available && ` ${selectedSlot?.reason || '没有静态图片'}`}</p>
                  <label className="sc-field" htmlFor="sc-instance-name">
                    实例名称
                    <Input
                      id="sc-instance-name"
                      value={active.name}
                      maxLength={200}
                      disabled={active.locked}
                      onChange={(e) =>
                        changeActive((i) => {
                          i.name = e.target.value;
                        })
                      }
                    />
                  </label>
                  <div className="sc-two">
                    <NumberField
                      label="X"
                      value={active.x}
                      change={(n) =>
                        changeActive((i) => {
                          i.x = n;
                        })
                      }
                    />
                    <NumberField
                      label="Y"
                      value={active.y}
                      change={(n) =>
                        changeActive((i) => {
                          i.y = n;
                        })
                      }
                    />
                  </div>
                  <NumberField
                    label="等比例缩放"
                    value={active.scale}
                    min={0.05}
                    max={32}
                    step={0.25}
                    change={(n) =>
                      changeActive((i) => {
                        i.scale = n;
                      })
                    }
                  />
                  <label className="sc-check">
                    <input
                      type="checkbox"
                      checked={active.flipH}
                      disabled={active.locked}
                      onChange={(e) =>
                        changeActive((i) => {
                          i.flipH = e.target.checked;
                        })
                      }
                    />
                    水平翻转整个物件
                  </label>
                  <details>
                    <summary>摆放锚点</summary>
                    <p className="sc-note">调整锚点保持物件画面位置不变。</p>
                    <div className="sc-two">
                      <NumberField
                        label="锚点 X"
                        value={active.anchor.x}
                        change={(n) =>
                          changeActive((i) =>
                            changeAnchor(i, { ...i.anchor, x: n }),
                          )
                        }
                      />
                      <NumberField
                        label="锚点 Y"
                        value={active.anchor.y}
                        change={(n) =>
                          changeActive((i) =>
                            changeAnchor(i, { ...i.anchor, y: n }),
                          )
                        }
                      />
                    </div>
                  </details>
                  <p className="sc-note">
                    素材：{materialFor(scene, active)?.name}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setSelected(
                        scene.instances
                          .filter((i) => i.materialId === active.materialId)
                          .map((i) => i.id),
                      )
                    }
                  >
                    选择使用相同素材的物件
                  </Button>
                </>
              )}
              {activeSplit && <>
                <h3>{activeSplit.kind === 'object' ? '独立地图物件' : activeSplit.kind === 'background' ? '场景背景' : '地图地表'}</h3>
                <p className="sc-note">{activeSplit.id} · {activeSplit.parts.length} 个子片 · {Math.round(mapSplitElementRect(scene, activeSplit).width)} × {Math.round(mapSplitElementRect(scene, activeSplit).height)}</p>
                {scene.mapSplit?.stale && <p className="sc-note">地图已替换，旧分层待迁移。请打开“分层候选 / 恢复”检查新版。</p>}
                <label className="sc-field" htmlFor="sc-split-object-name">物件名称<Input id="sc-split-object-name" value={activeSplit.name} disabled={activeSplit.locked} maxLength={200} onChange={event => changeSplit(element => { element.name = event.target.value; })} /></label>
                <div className="sc-two"><NumberField label="地图内 X" value={activeSplit.x} change={n => changeSplit(element => { element.x = n; })} /><NumberField label="地图内 Y" value={activeSplit.y} change={n => changeSplit(element => { element.y = n; })} /></div>
                <label className="sc-field">下次地图替换时<select aria-label="物件迁移定位方式" value={activeSplit.positionMode} disabled={activeSplit.locked} onChange={event => changeSplit(element => { element.positionMode = event.target.value as 'relative' | 'world'; })}><option value="relative">随新版物件位置重放场景位移</option><option value="world">固定当前世界位置</option></select></label>
                <label className="sc-field">图片与效果子片<select aria-label="分层图片与效果子片" value={splitPart?.id ?? ''} onChange={event => { setSplitPartId(event.target.value); setSplitImageWindow(''); }}>{activeSplit.parts.map(part => <option key={part.id} value={part.id}>{part.id} · {part.role === 'effect' ? '效果' : '美术'} · {part.width}×{part.height}</option>)}</select></label>
                {splitPart && <>
                  <label className="sc-check"><input type="checkbox" checked={splitPart.enabled} disabled={activeSplit.locked} onChange={event => changeSplit(element => { element.parts.find(part => part.id === splitPart.id)!.enabled = event.target.checked; })} />启用此{splitPart.role === 'effect' ? '效果' : '子片'}</label>
                  <label className="sc-field">相对玩家的遮挡<select aria-label="分层子片玩家前后关系" value={splitPart.plane} disabled={activeSplit.locked} onChange={event => changeSplit(element => { element.parts.find(part => part.id === splitPart.id)!.plane = event.target.value as 'back' | 'front'; })}><option value="back">玩家后方</option><option value="front">玩家前方</option></select></label>
                  <details><summary>大图编辑窗口</summary><label className="sc-field" htmlFor="sc-split-edit-window">子片内原像素坐标 JSON<Input id="sc-split-edit-window" value={splitImageWindow} placeholder={'{"x":0,"y":0,"width":512,"height":512}'} onChange={event => setSplitImageWindow(event.target.value)} /></label></details>
                  <Button size="sm" variant="outline" disabled={busy || activeSplit.locked || scene.mapSplit?.stale} onClick={() => {
                    try {
                      const window = splitImageWindow.trim() ? JSON.parse(splitImageWindow) as { x: number; y: number; width: number; height: number } : undefined;
                      if (window && (![window.x, window.y, window.width, window.height].every(Number.isInteger) || window.x < 0 || window.y < 0 || window.width < 1 || window.height < 1 || window.x + window.width > splitPart.width || window.y + window.height > splitPart.height)) throw new Error('编辑窗口超出所选子片。');
                      void openImageEdit({ kind: 'scene-split-part', documentId: scene.id, elementId: activeSplit.id, partId: splitPart.id, ...(window ? { window } : {}) });
                    } catch (cause) { setNotice(cause instanceof Error ? cause.message : '编辑窗口无效。'); }
                  }}>局部调整此分层子片</Button>
                </>}
                <h3>独立阻挡轮廓</h3>
                <label className="sc-check"><input type="checkbox" checked={activeSplit.collision.enabled} disabled={activeSplit.locked} onChange={event => changeSplit(element => { element.collision.enabled = event.target.checked; })} />启用此物件碰撞</label>
                <details><summary>修正轮廓（相对物件锚点）</summary><label className="sc-field">碰撞多边形 JSON<textarea aria-label="分层物件碰撞多边形JSON" key={`${activeSplit.id}:${JSON.stringify(activeSplit.collision.polygons)}`} rows={5} defaultValue={JSON.stringify(activeSplit.collision.polygons, null, 2)} disabled={activeSplit.locked} onBlur={event => {
                  try { const polygons = JSON.parse(event.target.value) as Array<Array<Point>>; if (!Array.isArray(polygons) || polygons.some(poly => !Array.isArray(poly) || poly.length < 3 || poly.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)))) throw new Error('每个轮廓需要至少三个有效坐标点。'); changeSplit(element => { element.collision.polygons = polygons; }); }
                  catch (cause) { doc.setError(cause instanceof Error ? cause.message : '碰撞轮廓无效，草稿已保留。'); }
                }} /></label></details>
                <p className="sc-note">碰撞建议可修正；{activeSplit.collision.mapIndices.length ? `已接管 ${activeSplit.collision.mapIndices.length} 个原地图区域。` : '未接管原地图碰撞。'}</p>
                {!!scene.map?.collisions.length && <details><summary>接管 / 解除原地图碰撞</summary>
                  <p className="sc-note">接管会用选中地图区域替换此物件的轮廓，并继承地图的启用状态。取消全部区域会关闭此物件轮廓，恢复原地图阻挡。</p>
                  {scene.map.collisions.map((points, index) => {
                    const ownership = mapSplitCollisionOwner(scene, index);
                    const owner = ownership && !ownership.deleted && ownership.elementId !== activeSplit.id ? ownership : undefined;
                    const deleted = ownership?.deleted;
                    return <label className="sc-check" key={index}><input type="checkbox" aria-label={`接管地图碰撞区域 ${index + 1}`} checked={activeSplit.collision.mapIndices.includes(index)} disabled={activeSplit.locked || scene.mapSplit?.stale || !!owner || !!deleted} onChange={event => {
                      const indices = event.target.checked ? [...activeSplit.collision.mapIndices, index] : activeSplit.collision.mapIndices.filter(value => value !== index);
                      try { const collision = splitCollisionTransfer(doc.current.current, activeSplit.id, indices); changeSplit(element => { element.collision = collision; }); }
                      catch (cause) { setNotice(cause instanceof Error ? cause.message : '碰撞归属未改变。'); }
                    }} />区域 {index + 1} · {points.length} 点{owner ? ` · 已归属 ${owner.name}` : deleted ? ' · 已随删除物件停用' : ''}</label>;
                  })}
                </details>}
                <Button size="sm" variant="outline" disabled={busy || activeSplit.locked} onClick={remove}>删除此分层对象</Button>
              </>}
              {layer && scene.map && (
                <>
                  <h3>{layer.name}</h3>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void openImageEdit({ kind: 'scene-layer', documentId: scene.id, layerId: layer.id })}>局部调整此地图层</Button>
                  <p className="sc-note">只编辑可追溯的源图；烘焙、派生或映射不明确的图层只读。快照采用会同步嵌入源包。</p>
                  <p className="sc-note">
                    地图图层共享地图位置；解除锁定后可移动整张地图。
                  </p>
                  <div className="sc-two">
                    <NumberField
                      label="地图偏移 X"
                      value={scene.map.offset.x}
                      change={(n) => {
                        if (!layer.locked)
                          doc.edit((s) => {
                            s.map!.offset.x = n;
                          });
                      }}
                    />
                    <NumberField
                      label="地图偏移 Y"
                      value={scene.map.offset.y}
                      change={(n) => {
                        if (!layer.locked)
                          doc.edit((s) => {
                            s.map!.offset.y = n;
                          });
                      }}
                    />
                  </div>
                </>
              )}
              {!!selected.length && (
                <>
                  <h3>前后遮挡</h3>
                  <div className="sc-actions">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => arrange('front')}
                    >
                      置顶
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => arrange('back')}
                    >
                      置底
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="向前一层"
                      onClick={() => arrange('forward')}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="向后一层"
                      onClick={() => arrange('backward')}
                    >
                      <ArrowDown />
                    </Button>
                  </div>
                  {selected.length === 1 && (
                    <NumberField
                      label="层级序号（1 在最前）"
                      value={visibleNodeIds.indexOf(selected[0]) + 1}
                      min={1}
                      max={visibleNodeIds.length}
                      change={(n) => { const index = Math.round(n) - 1, target = visibleNodeIds[index]; if (target) arrange(index > visibleNodeIds.indexOf(selected[0]) ? 'after' : 'before', target); }}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => arrange('target-before')}
                  >
                    放到指定节点前面…
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => arrange('target-after')}
                  >
                    放到指定节点后面…
                  </Button>
                </>
              )}
              {!!flagNodes.length && (
                <>
                  <h3>编辑与导出</h3>
                  <label className="sc-check">
                    <input
                      type="checkbox"
                      checked={flagNodes.every((n) => n.locked)}
                      onChange={(e) => flags('locked', e.target.checked)}
                    />
                    锁定位置
                  </label>
                  <label className="sc-check">
                    <input
                      type="checkbox"
                      checked={flagNodes.every((n) => n.hidden)}
                      onChange={(e) => flags('hidden', e.target.checked)}
                    />
                    仅在编辑时隐藏
                  </label>
                  <label className="sc-check">
                    <input
                      type="checkbox"
                      checked={flagNodes.every((n) => n.included)}
                      onChange={(e) => flags('included', e.target.checked)}
                    />
                    参与导出
                  </label>
                </>
              )}
              {!!selectedInstances.length && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={selectedInstances.every((i) => i.locked)}
                    onClick={() => openPicker('replace')}
                  >
                    <RefreshCw />
                    替换选中物件…
                  </Button>
                  <div className="sc-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => duplicate()}
                    >
                      <Copy />
                      复制
                    </Button>
                    <Button size="sm" variant="ghost" onClick={remove}>
                      <Trash2 />
                      删除
                    </Button>
                  </div>
                </>
              )}
            </fieldset>
          )}
          <div hidden={preview}><SceneLinksPanel scene={scene} selected={selected} disabled={busy || !ready || preview} edit={doc.edit} select={setSelected} /></div>
          {!!warnings.length && (
            <details className="sc-warnings">
              <summary>{warnings.length} 条场景提示</summary>
              {warnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </details>
          )}
          {!!exportLinks.length && (
            <div className="sc-export-links">
              <h3>最近导出</h3>
              {exportLinks.map((output) => (
                <a
                  key={output}
                  href={`/api/workbench/artifacts?path=${encodeURIComponent(output)}`}
                  download
                >
                  {output.endsWith('scene-godot.zip')
                    ? '下载 Godot 场景包'
                    : '下载场景源包'}
                </a>
              ))}
            </div>
          )}
        </aside>
      </div>
      <footer className="sc-footer">
        <button
          onClick={() => void doc.save().catch(() => {})}
          disabled={busy || !ready}
        >
          {!ready
            ? '正在恢复场景…'
            : doc.untouched
              ? '尚未创建场景'
              : doc.saved === scene.revision
                ? '本机已保存'
                : '有修改待保存'}{' '}
          ·{' '}
          {doc.backup === null
            ? '尚未下载源文件'
            : doc.backup === scene.revision
              ? '源文件已备份'
              : '文件备份后有修改'}
        </button>
        <output aria-live="polite">
          {busy ? '正在处理文件，请稍候…' : notice}
        </output>
        <span>
          {objectCount} 个物件 · {Math.round(scene.view.zoom * 100)}%
        </span>
      </footer>
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        aria-label="导入场景或素材文件"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          void doc.perform(async () => {
            if (fileMode.current === 'map') chooseMap(await readMap(f));
            else if (fileMode.current === 'objects')
              await chooseObjects(await readObjects(f));
            else await openImported(await importScene(f));
          });
        }}
      />
      <AssetImportPicker open={!!library} onClose={() => setLibrary(null)} purposes={[library?.purpose || 'interactable']} initialAsset={library?.assetId} onImport={importFromLibrary} />
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <DialogContent className="sc-modal">
          <DialogHeader>
            <DialogTitle>
              {
                {
                  new: '新建场景',
                  open: '打开场景',
                  map: scene.map ? '替换场景地图' : '选择地图',
                  objects: '添加交互物',
                  replace: '替换选中交互物',
                }[dialog || 'new']
              }
            </DialogTitle>
            <DialogDescription>
              {dialog === 'replace'
                ? `仅替换选中的 ${replacementIds.current.length} 个未锁定物件，保留摆放与层级。`
                : dialog === 'map'
                  ? '使用地图工具的当前保存内容，或导入完整地图包。'
                  : dialog === 'objects'
                    ? '选择已有素材加入本场景，然后拖到地图上。'
                    : '本机保存与场景源文件均可恢复完整布局。'}
            </DialogDescription>
          </DialogHeader>
          {doc.error && (
            <p role="alert" className="sc-error">
              {doc.error}
            </p>
          )}
          {dialog === 'new' ? (
            <>
              <label className="sc-field" htmlFor="sc-new-name">
                场景名称
                <Input
                  id="sc-new-name"
                  value={newName}
                  maxLength={120}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </label>
              <Button
                disabled={busy || !newName.trim()}
                onClick={() =>
                  void doc.perform(async () => {
                    await doc.replaceDocument(createScene(newName.trim()));
                    setSelected([]);
                    setLocal(await readLocalMaps());
                    setDialog('map');
                  })
                }
              >
                创建并选择地图
              </Button>
            </>
          ) : (
            <>
              {dialog === 'open' && <Button variant="outline" disabled={busy} onClick={() => { setDialog(null); setSharedOpen(true); }}>浏览服务端共享场景</Button>}
              <Button variant="outline" disabled={busy} onClick={() => {setLibrary({purpose: dialog === 'map' ? 'map' : dialog === 'open' ? 'scene' : 'interactable', replace: dialog === 'replace'});setDialog(null);}}>从资产库选用</Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  file(
                    dialog === 'map'
                      ? 'map'
                      : dialog === 'open'
                        ? 'scene'
                        : 'objects',
                  )
                }
              >
                <Upload />
                从文件导入
              </Button>
              {dialog === 'replace' && !project && !!scene.materials.length && (
                <div className="sc-picker-grid">
                  {scene.materials.map((m) => (
                    <button
                      key={m.id}
                      disabled={busy}
                      onClick={() => {
                        setReplacement(m);
                        setDialog(null);
                      }}
                    >
                      <Thumbnail material={m} />
                      <strong>{m.name}</strong>
                      <span>使用场景中的素材</span>
                    </button>
                  ))}
                </div>
              )}
              {project ? (
                <>
                  <div className="sc-picker-grid">
                    {project.objects.map((o) => (
                      <label key={o.definitionId}>
                        <Thumbnail
                          material={{
                            id: o.definitionId,
                            name: o.displayName,
                            project: { ...project, objects: [o] },
                          }}
                        />
                        <strong>{o.displayName}</strong>
                        <input
                          type={dialog === 'replace' ? 'radio' : 'checkbox'}
                          name="scene-object-choice"
                          checked={objectIds.includes(o.definitionId)}
                          onChange={(e) =>
                            setObjectIds(
                              dialog === 'replace'
                                ? [o.definitionId]
                                : e.target.checked
                                  ? [...objectIds, o.definitionId]
                                  : objectIds.filter(
                                      (id) => id !== o.definitionId,
                                    ),
                            )
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <Button
                    disabled={busy || !objectIds.length}
                    onClick={applyObjects}
                  >
                    {dialog === 'replace'
                      ? '预览替换效果'
                      : `添加 ${objectIds.length} 个素材`}
                  </Button>
                  <Button variant="ghost" onClick={() => setProject(null)}>
                    返回本机素材
                  </Button>
                </>
              ) : (
                <div className="sc-local-list">
                  {!local.length && (
                    <p className="sc-note">
                      没有可读取的本机记录，可从文件导入。
                    </p>
                  )}
                  {local.map((item) => (
                    <button
                      key={item.id}
                      disabled={busy}
                      onClick={() =>
                        void doc.perform(async () => {
                          if (dialog === 'map') chooseMap(await readMap(item));
                          else if (dialog === 'open') {
                            const loaded = await loadScene(item.id);
                            if (loaded) {
                              await doc.replaceDocument(
                                loaded.scene,
                                loaded.backupRevision === loaded.scene.revision,
                                loaded.backupRevision,
                              );
                              setSelected([]);
                              setDialog(null);
                            }
                          } else await chooseObjects(await readObjects(item));
                        })
                      }
                    >
                      <strong>{item.title}</strong>
                      <span>{item.detail}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!pendingMap}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingMap(null);
        }}
      >
        <DialogContent className="sc-modal">
          <DialogHeader>
            <DialogTitle>{scene.map ? '预览地图替换' : '确认地图'}</DialogTitle>
            <DialogDescription>
              现有物件保持世界坐标。地图碰撞和图层使用新地图内容。
            </DialogDescription>
          </DialogHeader>
          {doc.error && (
            <p role="alert" className="sc-error">
              {doc.error}
            </p>
          )}
          {pendingMap && (
            <>
              <div className="sc-two">
                {scene.map && (
                  <div>
                    <strong>当前地图</strong>
                    <MapThumbnail
                      map={scene.map}
                      choose={
                        align
                          ? (point) =>
                              setOldPoint({
                                x: point.x + scene.map!.offset.x,
                                y: point.y + scene.map!.offset.y,
                              })
                          : undefined
                      }
                    />
                  </div>
                )}
                <div>
                  <strong>新地图</strong>
                  <MapThumbnail
                    map={pendingMap}
                    choose={align ? setNewPoint : undefined}
                  />
                </div>
              </div>
              <p className="sc-note">
                原点 ({pendingMap.origin.x}, {pendingMap.origin.y}) ·{' '}
                {pendingMap.layers.map((l) => l.name).join('、')} ·{' '}
                {pendingMap.collisions.length} 个碰撞区域
              </p>
              {scene.map && (
                <>
                  <p className="sc-note">
                    当前 {sceneBounds(scene).width} ×{' '}
                    {sceneBounds(scene).height} → 新地图{' '}
                    {pendingMap.layers[0]?.width} ×{' '}
                    {pendingMap.layers[0]?.height}
                    。物件尺寸和坐标不会自动缩放；新旧视觉层的增减会在应用时生效。
                  </p>
                  <label className="sc-check">
                    <input
                      type="checkbox"
                      checked={align}
                      onChange={(e) => setAlign(e.target.checked)}
                    />
                    指定对应点对齐（也可点击两张预览图取点）
                  </label>
                  {align && (
                    <div className="sc-two">
                      <NumberField
                        label="旧地图世界点 X"
                        value={oldPoint.x}
                        change={(x) => setOldPoint({ ...oldPoint, x })}
                      />
                      <NumberField
                        label="旧地图世界点 Y"
                        value={oldPoint.y}
                        change={(y) => setOldPoint({ ...oldPoint, y })}
                      />
                      <NumberField
                        label="新地图对应点 X"
                        value={newPoint.x}
                        change={(x) => setNewPoint({ ...newPoint, x })}
                      />
                      <NumberField
                        label="新地图对应点 Y"
                        value={newPoint.y}
                        change={(y) => setNewPoint({ ...newPoint, y })}
                      />
                    </div>
                  )}
                </>
              )}
              {pendingMap.warnings.map((text, n) => (
                <p className="sc-note" key={n}>
                  {text}
                </p>
              ))}
              <Button
                disabled={busy}
                onClick={() => {
                  const map = structuredClone(pendingMap);
                  if (align)
                    map.offset = {
                      x: oldPoint.x - newPoint.x,
                      y: oldPoint.y - newPoint.y,
                    };
                  const needsMigration = Boolean(doc.current.current.mapSplit);
                  if (!doc.edit((s) => replaceMap(s, map))) return;
                  setPendingMap(null);
                  setSelected([]);
                  setNotice(needsMigration ? '地图已应用，正在为新版创建本地迁移候选；可从“分层候选 / 恢复”继续核对对应与冲突。' : '地图已应用；原物件位置已保留。可撤销本次替换。');
                  setTimeout(fit, 0);
                  if (needsMigration) setTimeout(() => void openSplit('auto'), 0);
                }}
              >
                应用地图
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!replacement}
        onOpenChange={(open) => {
          if (!open) setReplacement(null);
        }}
      >
        <DialogContent className="sc-modal">
          <DialogHeader>
            <DialogTitle>确认物件替换</DialogTitle>
            <DialogDescription>
              只更新选中的物件。位置、比例、朝向、名称与遮挡保持不变；行为和范围采用新素材。
            </DialogDescription>
          </DialogHeader>
          {doc.error && (
            <p role="alert" className="sc-error">
              {doc.error}
            </p>
          )}
          {replacement && (
            <>
              <div className="sc-two">
                <div>
                  <strong>当前物件</strong>
                  {scene.instances
                    .filter((i) => replacementIds.current.includes(i.id))
                    .slice(0, 3)
                    .map((i) => (
                      <div key={i.id}>
                        <Thumbnail material={materialFor(scene, i)!} />
                        <span>{i.name}</span>
                      </div>
                    ))}
                </div>
                <div>
                  <strong>新素材：{replacement.name}</strong>
                  <Thumbnail material={replacement} />
                </div>
              </div>
              <p className="sc-note">
                以底部中心锚点对齐，可撤销；未选中的物件不变。
              </p>
              <Button
                disabled={busy}
                onClick={() => {
                  const applied = doc.edit((s) => {
                    if (!s.materials.some((m) => m.id === replacement.id))
                      s.materials.push(replacement);
                    replaceInstances(s, replacementIds.current, replacement.id);
                  });
                  if (!applied) return;
                  setReplacement(null);
                  setNotice(`已替换 ${replacementIds.current.length} 个物件。`);
                }}
              >
                替换 {replacementIds.current.length} 个物件
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!pendingScene}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingScene(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>本机已有这个场景</DialogTitle>
            <DialogDescription>
              可以用文件替换本机版本，或保存为独立的新场景。
            </DialogDescription>
          </DialogHeader>
          {doc.error && (
            <p role="alert" className="sc-error">
              {doc.error}
            </p>
          )}
          <Button
            disabled={busy}
            onClick={() =>
              void doc.perform(async () => {
                await doc.replaceDocument(pendingScene!, true);
                setPendingScene(null);
                setSelected([]);
              })
            }
          >
            替换本机版本
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void doc.perform(async () => {
                const next = structuredClone(pendingScene!);
                next.id = makeId('scene');
                next.name += ' 副本';
                await doc.replaceDocument(next);
                setPendingScene(null);
                setSelected([]);
              })
            }
          >
            另存为新场景
          </Button>
        </DialogContent>
      </Dialog>
    </main>
    <SharedDocumentPicker open={sharedOpen} kind="scene" currentId={scene.id} disabled={busy || !ready} onClose={() => setSharedOpen(false)} onOpen={async document => {
      if (busy || !ready) throw new Error('场景正在处理内容，请完成后再打开工程。');
      const href = sharedDocumentHref(location.pathname, document.id);
      setSharedOpen(false);
      await navigate(href);
    }} />
    {workflow && <SceneWorkflowPanel
      document={workflow.document}
      initialWorkId={workflowInitialId}
      onSelection={workId => writeSceneWorkflowNavigation(workflow.document.id, workId)}
      beforeAdopt={async () => {
        await doc.session.check();
      }}
      onAdopt={async receipt => {
        const next = await doc.session.accept(receipt);
        setWorkflow(next); setSelected([]);
        setNotice('协作候选已采用到当前场景。');
      }}
      onClose={() => { doc.session.close(); setWorkflow(null); writeSceneWorkflowNavigation(workflow.document.id, null); }}
    />}
    {splitWindow && <SceneSplitPanel document={splitWindow.document} initialMode={splitInitialMode}
      beforeAdopt={async () => {
        await doc.session.check();
      }}
      onAdopt={async receipt => {
        const next = await doc.session.accept(receipt);
        setSplitWindow(next); setSelected([]); setTab('nodes');
        setNotice('地图分层已采用；选择对象即可独立移动、修改子片或碰撞。');
      }}
      onClose={() => { doc.session.close(); setSplitWindow(null); }} />}
    {imageEdit && <ImageEditWorkspace
      onNavigationChange={writeImageEditNavigation}
      target={imageEdit.target}
      initialEditId={imageEdit.navigation?.editId}
      initialCandidateVersion={imageEdit.navigation?.candidateVersion}
      readOnly={!imageEdit.guard}
      renderContext={imageEdit.guard ? renderImageContext : undefined}
      onOpenSource={imageEdit.target.kind === 'scene-layer' && imageEdit.guard && scene.map ? async target => {
        const source = await imageEditMapSource(target);
        const href = await storeEditorHandoff('map-stitcher', 'map', { source: source.source, name: source.name });
        closeImageEdit(); setHandoffUrl(href);
      } : undefined}
      onDownloadSource={imageEdit.target.kind === 'scene-layer' && imageEdit.guard && scene.map ? async target => {
        const source = await imageEditMapSource(target);
        downloadBlob(source.blob, 'map-source.zip');
      } : undefined}
      beforeApply={async () => {
        await doc.session.check();
      }}
      onAdopt={async receipt => {
        const current = imageEditRef.current;
        if (!current?.guard) throw new Error('历史场景入口只读。');
        validateSceneImageReceipt(current.target, receipt);
        if (!imageTargetEquals(receipt.target.targetRef, current.target) || !('documentId' in current.target)) throw new Error('场景图片目标不匹配。');
        const guard = await doc.session.accept({ documentId: current.target.documentId, revision: receipt.revision as number });
        const next = { ...current, guard }; imageEditRef.current = next; setImageEdit(next);
        setNotice(current.target.kind === 'scene-instance' ? '仅选中实例图片已采用；其他共享实例、位置与联动保留。' : current.target.kind === 'scene-split-part' ? '选中分层子片图片已采用到场景。' : '选中图层与嵌入源包已同步采用。');
      }}
      onClose={closeImageEdit}
    />}
    </>
  );
}
