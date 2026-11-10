'use client';
import { WorkbenchBreadcrumb } from '@/components/workbench/shared-navigation';

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  FilePlus2,
  CircleHelp,
  Download,
  FolderOpen,
  PanelRight,
  Redo2,
  Save,
  Settings,
  ChevronDown,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import {
  EditorWorkbenchMenu,
  EditorDraftControl,
  EditorTaskSummary,
} from '@/components/workbench/editor-chrome';
import { MapWorkArea } from './map-work-area';
import { MapSceneButton } from '@/components/scene-composer/map-scene-button';
import { AssetImportPicker } from '@/components/workbench/asset-import-picker';
import { mapImportFile, clearImportQuery, readEditorHandoff, type ImportBundle } from '@/lib/workbench/asset-import';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Toaster } from '@/components/ui/toast';
import { REGION_LAYER_META, isEditableMapLayer } from '@/features/map-stitcher/frame-ronin-types';
import {
  hasImageView,
  IMAGE_VIEW_LABELS,
} from '@/features/map-stitcher/editor-selectors';
import {
  useMapEditorController,
  type MapExportFormat,
} from './use-map-editor-controller';
import { useMapAgentTools } from './use-map-agent-tools';
import { useMapWorkspace, type MapSavedImageGuard } from './use-map-workspace';
import { ImageEditWorkspace } from '@/components/image-edit/image-edit-workspace';
import type { ImageTargetRef, ImageEditContextLayer } from '@/features/image-edit/client';
import { readImageEdit } from '@/features/image-edit/client';
import { clearImageEditNavigation, readImageEditNavigation, writeImageEditNavigation, type ImageEditNavigation } from '@/features/image-edit/navigation';
import { MapCanvas } from './canvas/map-canvas';
import { MapInspector } from './panels/map-inspector';
import { MapApiSettingsDialog } from './panels/map-api-settings';
import { ImageFineEditor } from './editors/image-fine-editor';
import { MapOriginGenerator } from './panels/map-origin-generator';
import './frame-ronin-editor.css';

export function FrameRoninMapEditor({ initialOriginOpen = false }: { initialOriginOpen?: boolean }) {
  const [library, setLibrary] = useState<{assetId?:string}|null>(null);
  const importStarted = useRef(false);
  const c = useMapEditorController();
  const workspace = useMapWorkspace(c);
  const [imageEdit, setImageEdit] = useState<{ target: ImageTargetRef; guard: MapSavedImageGuard | null; navigation?: ImageEditNavigation } | null>(null);
  const editNavigationConsumed = useRef(false);
  const imageEditRef = useRef(imageEdit);
  useLayoutEffect(() => { imageEditRef.current = imageEdit; }, [imageEdit]);
  useMapAgentTools(c);
  const sourceInput = useRef<HTMLInputElement>(null),
    layerInput = useRef<HTMLInputElement>(null),
    stateInput = useRef<HTMLInputElement>(null),
    directoryInput = useRef<HTMLInputElement>(null);
  const [originOpen, setOriginOpen] = useState(initialOriginOpen);
  useEffect(() => {
    if (workspace.loading) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('origin') !== 'generate') return;
    url.searchParams.delete('origin');
    window.history.replaceState(window.history.state, '', url);
  }, [workspace.loading]);
  useEffect(() => {
    if (!workspace.loading && new URLSearchParams(location.search).has('imageTask'))
      queueMicrotask(() => setOriginOpen(true));
  }, [workspace.loading]);
  const [settingsOpen, setSettingsOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [newProjectOpen, setNewProjectOpen] = useState(false),
    [creating, setCreating] = useState(false);
  const importFromLibrary = async (bundle: ImportBundle) => { await c.openProject([await mapImportFile(bundle)]); };
  useEffect(()=>{
    if(workspace.loading || importStarted.current)return;importStarted.current=true;
    const params=new URLSearchParams(location.search),assetId=params.get('importAsset');
    if(assetId&&params.get('importPurpose')==='map'){queueMicrotask(()=>setLibrary({assetId}));clearImportQuery();}
    else if(params.has('handoff'))c.perform(async()=>{const record=await readEditorHandoff('map-stitcher');if(record?.purpose==='map'){const payload=record.payload as {source:string;name:string};if(!payload.source.startsWith('data:'))throw new Error('地图源文件无效。');const blob=await(await fetch(payload.source)).blob();await c.openProject([new File([blob],payload.name,{type:blob.type})]);}clearImportQuery();});
  },[workspace.loading,c]);
  const createProject = () =>
    c.perform(async () => {
      setCreating(true);
      try {
        await workspace.newProject();
        for (const input of [
          sourceInput,
          layerInput,
          stateInput,
          directoryInput,
        ])
          if (input.current) input.current.value = '';
        setNewProjectOpen(false);
      } finally {
        setCreating(false);
      }
    });
  const openSettings = () => {
    c.resetSession();
    setSettingsOpen(true);
  };
  const activeCount = c.tiles.filter((tile) =>
    hasImageView(tile, c.activeMapLayer),
  ).length;
  const doExport = (format: MapExportFormat) =>
    c.perform(async () => {
      await c.exportArtifact(format);
      setExportOpen(false);
      c.setHint('文件已导出。');
    });
  const openImageEdit = (selection?: Extract<ImageTargetRef, { kind: 'map-layer' }>, navigation?: ImageEditNavigation) => c.perform(async () => {
    try {
      if (selection && selection.projectId !== c.workspaceId) throw new Error('图片会话属于另一个地图工程。');
      const ticket = c.beginImageEdit(selection);
      const guard = await workspace.flushSaved(ticket);
      const target: ImageTargetRef = { kind: 'map-layer', projectId: guard.projectId, tileKey: ticket.tileKey, layer: ticket.layer };
      const next = { target, guard, navigation };
      imageEditRef.current = next;
      setImageEdit(next);
    } catch (error) {
      c.endImageEdit();
      if (!selection || !navigation) throw error;
      c.beginImageHistory();
      const next = { target: selection, guard: null, navigation };
      imageEditRef.current = next; setImageEdit(next);
    }
  });
  const resumeImageEdit = useEffectEvent(() => {
    const navigation = readImageEditNavigation(); if (!navigation) return;
    void readImageEdit(navigation.editId).then(({ edit }) => {
      if (edit.target.targetRef.kind !== 'map-layer') throw new Error('图片会话不是地图源图。');
      return openImageEdit(edit.target.targetRef, navigation);
    }).catch(error => c.setHint(error instanceof Error ? error.message : '图片会话未打开。'));
  });
  useEffect(() => {
    if (workspace.loading || editNavigationConsumed.current) return;
    editNavigationConsumed.current = true; resumeImageEdit();
  }, [workspace.loading]);
  const contextLayers: ImageEditContextLayer[] = [];
  if (imageEdit?.guard) {
    const { ticket } = imageEdit.guard;
    const tile = c.tiles.find(tile => tile.key === ticket.tileKey);
    const layer = ticket.layer;
    const layers = layer === 'object' ? [tile?.images.surface && !tile.surfaceIsDraft ? 'surface' : 'overall', 'object'] as const
      : layer === 'surface' ? ['surface', 'object'] as const : [layer];
    for (const name of layers) {
      const asset = tile?.images[name];
      if (asset) contextLayers.push({ id: name, url: asset.url, width: asset.width, height: asset.height, target: name === layer });
    }
  }
  return (
    <Toaster>
      <AssetImportPicker open={!!library} onClose={()=>setLibrary(null)} purposes={['map']} initialAsset={library?.assetId} onImport={importFromLibrary} />
      <main
        className="map-workspace"
        inert={c.imageEditLocked}
        data-map-editor
        data-focus-mode={c.focusMode}
      >
        {workspace.loading && (
          <output className="wb-loading-veil">正在恢复地图草稿…</output>
        )}
        {workspace.error && (
          <div className="wb-map-draft-error" role="alert">
            {workspace.error}
          </div>
        )}
        <header className="map-project-bar">
          <div className="map-project-title">
            <EditorWorkbenchMenu />
            <WorkbenchBreadcrumb compact projectName={c.sourceAsset?.name.replace(/\.[^.]+$/, '') || '未命名地图工程'} />
            <span>{c.tiles.length} 块</span>
          </div>
          <div className="map-project-actions">
            <EditorDraftControl capabilityId="map-stitcher" />
            <MapSceneButton c={c} />
            <Button size="sm" variant="outline" disabled={c.busy || workspace.loading} onClick={()=>setLibrary({})}>从资产库选用</Button>
            <Button
              className="map-project-wide-action"
              variant="outline"
              size="sm"
              disabled={c.busy || workspace.loading || creating}
              onClick={() => setNewProjectOpen(true)}
            >
              <FilePlus2 /> 新建项目
            </Button>
            <Button
              className="map-project-wide-action"
              variant="outline"
              size="sm"
              disabled={c.busy}
              onClick={() => stateInput.current?.click()}
            >
              <FolderOpen />
              打开工程
            </Button>
            <Button
              size="sm"
              disabled={c.busy || !c.sourceAsset}
              onClick={() => {
                c.resetSession();
                setExportOpen(true);
              }}
            >
              <Download />
              导出
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="更多地图操作"
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="map-compact-menu">
                <DropdownMenuItem
                  className="map-project-overflow-action"
                  disabled={c.busy || workspace.loading || creating}
                  onClick={() => setNewProjectOpen(true)}
                >
                  <FilePlus2 /> 新建项目
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="map-project-overflow-action"
                  disabled={c.busy}
                  onClick={() => stateInput.current?.click()}
                >
                  <FolderOpen />
                  打开状态 / Godot
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={c.busy || !c.sourceAsset}
                  onClick={() => doExport('state')}
                >
                  <Save />
                  下载编辑源文件
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={openSettings}>
                  <Settings />
                  生成设置
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    c.resetSession();
                    setHelpOpen(true);
                  }}
                >
                  <CircleHelp />
                  地图帮助
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <div
          className="map-view-bar"
          role="toolbar"
          aria-label="地图编辑工具栏"
        >
          <fieldset className="map-primary-views" aria-label="图片视图">
            {(['overall', 'surface', 'object'] as const).map((layer) => (
              <Button
                className="map-view-wide"
                key={layer}
                size="sm"
                variant={
                  c.activeMapLayer === layer && !c.exportPreview
                    ? 'default'
                    : 'ghost'
                }
                aria-pressed={c.activeMapLayer === layer && !c.exportPreview}
                onClick={() => c.selectView(layer)}
              >
                {IMAGE_VIEW_LABELS[layer]}
              </Button>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    className="map-view-menu-trigger"
                    variant="ghost"
                    size="sm"
                    aria-label="选择图片视图"
                  />
                }
              >
                <span>{IMAGE_VIEW_LABELS[c.activeMapLayer]}</span>
                <ChevronDown size={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="map-compact-menu">
                {(
                  [
                    'overall',
                    'surface',
                    'object',
                    'black',
                    'white',
                    'mask',
                  ] as const
                ).map((layer) => (
                  <DropdownMenuCheckboxItem
                    key={layer}
                    checked={c.activeMapLayer === layer && !c.exportPreview}
                    onClick={() => c.selectView(layer)}
                  >
                    {IMAGE_VIEW_LABELS[layer]}
                    {layer === 'mask' ? ' · 只读' : ''}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </fieldset>
          <Button size="sm" variant="outline" disabled={c.busy || workspace.loading || !c.selectedTile || !isEditableMapLayer(c.activeMapLayer) || !c.selectedTile.images[c.activeMapLayer] || c.imageLocks[c.activeMapLayer]} onClick={() => openImageEdit()}>
            局部调整本层
          </Button>
          <div className="map-view-options">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="撤销地图修改"
              title={c.undoLabel ? `撤销：${c.undoLabel}` : '没有可撤销的修改'}
              disabled={!c.canUndo || c.busy}
              onClick={c.undo}
            >
              <Undo2 />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="重做地图修改"
              title={c.redoLabel ? `重做：${c.redoLabel}` : '没有可重做的修改'}
              disabled={!c.canRedo || c.busy}
              onClick={c.redo}
            >
              <Redo2 />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="sm" variant="ghost" aria-label="显示选项" />
                }
              >
                <SlidersHorizontal />
                <span className="map-tool-label">显示</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="map-compact-menu">
                <DropdownMenuItem
                  className="map-project-overflow-action"
                  disabled={c.busy || workspace.loading || creating}
                  onClick={() => setNewProjectOpen(true)}
                >
                  <FilePlus2 /> 新建项目
                </DropdownMenuItem>
                <DropdownMenuCheckboxItem
                  checked={c.preferences.showImage}
                  onCheckedChange={(showImage) =>
                    c.setPreferences((value) => ({ ...value, showImage }))
                  }
                >
                  底图
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={c.preferences.showRegions}
                  onCheckedChange={(showRegions) => {
                    c.resetSession();
                    c.setPreferences((value) => ({ ...value, showRegions }));
                  }}
                >
                  区域标注
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={c.hideCards && c.hideBorders}
                  onCheckedChange={(value) => {
                    c.setHideCards(value);
                    c.setHideBorders(value);
                  }}
                >
                  干净预览
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={c.exportPreview}
                  disabled={!c.sourceAsset}
                  onCheckedChange={(value) => {
                    c.resetSession();
                    c.setExportPreview(value);
                  }}
                >
                  导出效果
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant={c.panelOpen ? 'outline' : 'ghost'}
              aria-expanded={c.panelOpen}
              aria-controls="map-inspector"
              aria-label="切换属性栏"
              onClick={() => c.setPanelOpen((value) => !value)}
            >
              <PanelRight />
              <span className="map-tool-label">属性</span>
            </Button>
            <Button
              size="sm"
              variant={c.focusMode ? 'default' : 'ghost'}
              aria-pressed={c.focusMode}
              aria-label={c.focusMode ? '退出专注模式' : '进入专注模式'}
              onClick={() => c.setFocusMode((value) => !value)}
            >
              {c.focusMode ? <Minimize2 /> : <Maximize2 />}
              <span className="map-focus-label">
                {c.focusMode ? '退出专注' : '专注'}
              </span>
            </Button>
            {c.focusMode && <EditorTaskSummary compact />}
          </div>
        </div>
        <MapWorkArea
          c={c}
          inspector={
            <MapInspector
              c={c}
              onUpload={() => layerInput.current?.click()}
              onSettings={openSettings}
            />
          }
        >
          <MapCanvas
            c={c}
            disabled={
              c.busy ||
              settingsOpen ||
              originOpen ||
              helpOpen ||
              exportOpen ||
              Boolean(c.fineSession) || c.imageEditLocked
            }
            onGenerate={() => setOriginOpen(true)}
            onImport={() => sourceInput.current?.click()}
          />
        </MapWorkArea>
        <footer className="map-status-bar" aria-label="地图与制作状态">
          <span
            className="map-selection-status"
            title={`${c.selectedKey ?? '未选卡片'} · ${IMAGE_VIEW_LABELS[c.activeMapLayer]} ${activeCount}/${c.tiles.length}`}
          >
            {c.selectedKey ?? '未选卡片'} ·{' '}
            {IMAGE_VIEW_LABELS[c.activeMapLayer]} {activeCount}/{c.tiles.length}
          </span>
          <span className="map-mode-status">
            {c.mode === 'region'
              ? `${REGION_LAYER_META[c.activeRegionLayer].label} · ${{ select: '选择', rectangle: '矩形', polygon: '多边形', free: '自由套索', delete: '删除' }[c.regionTool]}`
              : c.mode === 'pixel'
                ? '像素精修'
                : '地图浏览'}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="map-status-hint"
              title={c.busy ? '正在处理文件…' : c.hint}
              aria-label="展开完整操作提示"
            >
              {c.busy ? '正在处理文件…' : c.hint}
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" className="map-hint-detail">
              <p>{c.busy ? '正在处理文件…' : c.hint}</p>
              <p>
                {c.imageCount} 图 · {c.shapes.length} 区域
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
          <EditorTaskSummary />
        </footer>
        <MapOriginGenerator open={originOpen && !workspace.loading} onOpenChange={setOriginOpen} c={c} />
        <input
          ref={sourceInput}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp,.jfif"
          multiple
          aria-label="导入地图图片"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            c.perform(() => c.importImages(files));
          }}
        />
        <input
          ref={layerInput}
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,image/webp,.jfif"
          multiple
          aria-label="当前卡片图片"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            c.perform(() => c.uploadToLayer(files));
          }}
        />
        <input
          ref={stateInput}
          className="sr-only"
          type="file"
          accept=".zip,.json,image/png,image/jpeg,image/webp"
          multiple
          aria-label="打开地图状态或 Godot"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length) c.perform(() => c.openProject(files));
          }}
        />
        <input
          ref={directoryInput}
          className="sr-only"
          type="file"
          multiple
          {...{ webkitdirectory: '' }}
          aria-label="打开 Godot 资源文件夹"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length) c.perform(() => c.openProject(files));
          }}
        />
        {settingsOpen && (
          <MapApiSettingsDialog
            api={c.api}
            prompt={c.prompt}
            setPrompt={c.setPrompt}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        <Dialog
          open={newProjectOpen}
          onOpenChange={(open) => {
            if (!creating) setNewProjectOpen(open);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新建空白地图项目</DialogTitle>
              <DialogDescription>
                清空当前画布、编辑历史、提示词和项目参数，取消本页生成队列。
                旧项目保留为本机草稿，API 设置和面板布局保留。 已发送的图片 API
                请求可能仍会在服务端完成，结果不会写入新项目。
              </DialogDescription>
            </DialogHeader>
            <Button disabled={creating} onClick={createProject}>
              {creating ? '正在新建…' : '新建空白项目'}
            </Button>
            <Button
              variant="outline"
              disabled={creating}
              onClick={() => setNewProjectOpen(false)}
            >
              取消
            </Button>
          </DialogContent>
        </Dialog>
        <Dialog open={exportOpen} onOpenChange={setExportOpen}>
          <DialogContent className="map-export-dialog">
            <DialogHeader>
              <DialogTitle>导出地图</DialogTitle>
              <DialogDescription>
                标注显隐不会停用区域。已排除输出的卡片只保留在完整编辑源中。
              </DialogDescription>
            </DialogHeader>
            <div className="map-export-options">
              {(
                [
                  ['png', '当前图片视图 PNG'],
                  ['composite', '导出效果 PNG'],
                  ['all-png', '全部图片层 PNG · ZIP'],
                  ['top-png', '顶层区域 PNG'],
                  ['psd', '分层 PSD'],
                  ['godot', 'Godot 包 · 含完整编辑源'],
                  ['state', 'Pixelwork 编辑状态'],
                ] as const
              ).map(([format, label]) => (
                <Button
                  key={format}
                  variant="outline"
                  disabled={
                    c.busy ||
                    (format === 'top-png' &&
                      !c.shapes.some((shape) => shape.layer === 'top'))
                  }
                  onClick={() => doExport(format)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
          <DialogContent className="map-help-dialog">
            <DialogHeader>
              <DialogTitle>地图编辑操作</DialogTitle>
              <DialogDescription>
                图片视图、区域标注和像素精修分别操作。
              </DialogDescription>
            </DialogHeader>
            <div className="map-help-copy">
              <p>
                拖动属性栏左侧边界可调整宽度；方向键也可调整，双击恢复默认。较窄窗口使用抽屉，关闭后可从工具栏重新打开。专注模式保留编辑工具，点击“退出专注”恢复项目栏和状态栏。
              </p>
              <p>
                先选地图块，再切换整体、地表或物件视图。在区域页签选择类别和工具后直接绘制。
              </p>
              <p>
                矩形点击两次；多边形按 Enter / C
                完成；自由套索按住左键绘制，松开闭合。区域显隐只控制辅助标注。
              </p>
              <p>
                中键、右键或空格 + 左键平移。0 适配画布，H 切换卡片标签。Esc
                依次取消草稿、选择和编辑；Ctrl / Cmd + Z 撤销，Shift + Ctrl /
                Cmd + Z 重做。
              </p>
              <p>
                “新建项目”进入空白状态，再通过“生成原图”或画布上的“导入地图图片”开始；“打开工程”恢复已有项目。草稿自动保存在本机，也可从“更多”下载编辑源文件。新
                Godot 包包含完整编辑源；旧包可能只能恢复合成图片。
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setHelpOpen(false);
                  directoryInput.current?.click();
                }}
              >
                打开资源文件夹（清单与图片）
              </Button>
              <Link href="/tools/map-stitcher-legacy">打开旧版编辑器</Link>
            </div>
          </DialogContent>
        </Dialog>
        {c.fineSession && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) c.closeFineEdit();
            }}
          >
            <DialogContent className="map-fine-dialog" showCloseButton={false}>
              <DialogHeader>
                <DialogTitle>
                  像素精修 · {IMAGE_VIEW_LABELS[c.fineSession.ticket.layer]}
                </DialogTitle>
                <DialogDescription>
                  只修改当前卡片图片。保存后可从地图历史撤销。
                </DialogDescription>
              </DialogHeader>
              <div className="map-stitcher-surface map-fine-container">
                <ImageFineEditor
                  width={c.fineSession.original.width}
                  height={c.fineSession.original.height}
                  imageUrl={c.fineSession.original.url}
                  tileKey={c.fineSession.ticket.tileKey}
                  layerLabel={IMAGE_VIEW_LABELS[c.fineSession.ticket.layer]}
                  onCancel={c.closeFineEdit}
                  onApply={async (blob) => {
                    try {
                      await c.applyFineEdit(blob);
                    } catch (error) {
                      c.report(error);
                    }
                  }}
                />
              </div>
            </DialogContent>
          </Dialog>
        )}
      </main>
      {imageEdit && <ImageEditWorkspace
        onNavigationChange={writeImageEditNavigation}
        target={imageEdit.target}
        initialEditId={imageEdit.navigation?.editId}
        initialCandidateVersion={imageEdit.navigation?.candidateVersion}
        readOnly={!imageEdit.guard}
        contextLayers={contextLayers}
        beforeApply={() => {
          if (!imageEditRef.current?.guard) throw new Error('当前目标不可写；历史候选只读。');
          workspace.assertImageGuard(imageEditRef.current.guard);
        }}
        onAdopt={async receipt => {
          const current = imageEditRef.current;
          if (!current?.guard) throw new Error('当前目标不可写，已采用结果保留在服务端。');
          const guard = await workspace.acceptAdopted(receipt, current.guard);
          const next = { ...current, guard };
          imageEditRef.current = next;
          setImageEdit(next);
        }}
        onClose={() => { imageEditRef.current = null; setImageEdit(null); c.endImageEdit(); clearImageEditNavigation(); }}
      />}
    </Toaster>
  );
}
