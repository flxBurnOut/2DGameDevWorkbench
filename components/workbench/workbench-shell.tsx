'use client';
/* oxlint-disable next/no-html-link-for-pages, next/no-img-element -- Native navigation is saved and guarded by WorkbenchProvider; previews are local pixel art. */
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Archive, ArrowRight, ChevronRight } from 'lucide-react';
import { workbenchDestinations, workspaceGroups } from '@/lib/workbench/navigation';
import { workItemTitle, type WorkItem, type WorkItemState } from '@/lib/workbench/work-items';
import { ModuleIcon } from './module-icon';
import { useWorkbench } from './workbench-provider';
import { useRecordSummary } from './shared-navigation';
import { SampleAnimation, SampleCharacter, SampleClip, SampleInteractable, interactableClips } from './home-samples';

type HomeAsset = {
  id: string;
  title: string;
  kind: string;
  previewKind?: string;
  previewUrl: string;
  viewPath: string;
  availability: string;
  width?: number;
  height?: number;
};

const lineLabels: Record<string, string> = { player: '角色', interactable: '交互物' };
const kindLabels: Record<string, string> = { character: '角色原图', prop: '物品原图', animation: '动画', interactable: '交互物' };
type RecentWorkState = Exclude<WorkItemState, 'not_submitted'>;
const statePriority: Record<RecentWorkState, number> = { attention: 0, running: 1, editing: 2, saved: 3, completed: 4 };
const stateLabels: Record<RecentWorkState, string> = { attention: '需要处理', running: '制作中', editing: '编辑中', saved: '已保存', completed: '已完成' };
const actionLabels: Record<RecentWorkState, string> = { attention: '处理', running: '查看进度', editing: '继续', saved: '继续', completed: '查看' };

/** Which asset kinds can stand in for each tool's preview, most specific first. */
const previewKinds: Record<string, string[]> = {
  'reference-art': ['character'],
  'sprite-generator': ['animation'],
  // Confirmed state images are still frames; the panel shows playable built-in clips instead.
  'interactable-editor': ['interactable', 'prop'],
};
const samples: Record<string, () => ReactNode> = {
  'reference-art': SampleCharacter,
  'sprite-generator': SampleAnimation,
  'interactable-editor': SampleInteractable,
};
const previewLimit = 3;

type PreviewSlide = { key: string; label: string; node: ReactNode; ms: number };

async function readAssets(params: Record<string, string>, signal: AbortSignal) {
  const query = new URLSearchParams({ query: '', scope: 'active', offset: '0', ...params });
  const response = await fetch(`/api/workbench/assets?${query}`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('assets unavailable');
  const data = (await response.json()) as { assets: HomeAsset[]; total: number };
  return data.assets.filter((asset) => asset.availability === 'available' && asset.previewKind !== 'none');
}

/** Latest assets per kind plus the most recent pieces; failures leave the samples in place. */
function useHomeAssets() {
  const [recent, setRecent] = useState<HomeAsset[] | null>(null);
  const [byKind, setByKind] = useState<Record<string, HomeAsset[]>>({});
  useEffect(() => {
    const controller = new AbortController();
    void readAssets({ limit: '6' }, controller.signal)
      .then(setRecent, () => { if (!controller.signal.aborted) setRecent([]); });
    for (const kind of ['character', 'animation', 'interactable', 'prop'])
      void readAssets({ limit: String(previewLimit), kind }, controller.signal)
        .then((assets) => { if (assets.length) setByKind((current) => ({ ...current, [kind]: assets })); }, () => undefined);
    return () => controller.abort();
  }, []);
  return { recent, byKind };
}

/** Pixel art is shown at a whole-number scale so every pixel stays square. */
function pixelSize(asset: HomeAsset, box: number) {
  const side = Math.max(asset.width || 0, asset.height || 0);
  if (!side) return undefined;
  const scale = side > box ? box / side : Math.max(1, Math.floor(box / side));
  return { width: Math.round((asset.width || side) * scale), height: Math.round((asset.height || side) * scale) };
}

/** The user's own pieces come first; built-in samples fill the card when the library has none. */
function previewSlides(toolId: string, byKind: Record<string, HomeAsset[]>): PreviewSlide[] {
  if (toolId === 'interactable-motion')
    return interactableClips.map((clip) => ({
      key: clip.src, label: `示例 · ${clip.label}`, node: <SampleClip clip={clip} />, ms: Math.round((clip.frames / clip.fps) * 2000),
    }));
  const kinds = previewKinds[toolId] || [];
  const assets = kinds.flatMap((kind) => byKind[kind] || []).slice(0, previewLimit);
  // Only animations rotate; a still tool keeps its latest piece.
  const shown = toolId === 'sprite-generator' ? assets : assets.slice(0, 1);
  if (shown.length)
    return shown.map((asset) => ({
      key: asset.id, label: asset.title,
      node: <img src={asset.previewUrl} alt="" {...pixelSize(asset, 128)} decoding="async" />, ms: 4500,
    }));
  const Sample = samples[toolId];
  return Sample ? [{ key: 'sample', label: '', node: <Sample />, ms: 0 }] : [];
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

function ToolPreview({ slides }: { slides: PreviewSlide[] }) {
  const [index, setIndex] = useState(0);
  const reduced = useReducedMotion();
  const current = slides[index % Math.max(1, slides.length)];
  useEffect(() => {
    if (reduced || slides.length < 2 || !current) return;
    const timer = window.setTimeout(() => setIndex((value) => (value + 1) % slides.length), current.ms);
    return () => window.clearTimeout(timer);
  }, [current, reduced, slides.length]);
  return (
    <span className="wb-tool-card-preview">
      {current && <span className="wb-preview-slide" key={current.key}>{current.node}</span>}
      {current?.label && <span className="wb-preview-label">{current.label}</span>}
      {slides.length > 1 && (
        <span className="wb-preview-dots" aria-hidden="true">
          {slides.map((slide, i) => <span key={slide.key} data-active={i === index % slides.length || undefined} />)}
        </span>
      )}
    </span>
  );
}

export function WorkbenchShell() {
  const wb = useWorkbench();
  const { recent, byKind } = useHomeAssets();
  return (
    <main className="wb-page wb-home">
      <header className="wb-home-head">
        <div>
          <h1>开始制作</h1>
          <p className="wb-intro">选择一个工具开始，做过的作品和素材都在下面。</p>
        </div>
        <a className="wb-button wb-ghost" href={`${workbenchDestinations.assets.href}?import=package`}>
          <Archive size={16} />
          导入素材包
        </a>
      </header>

      <div className="wb-tool-lines">
        {workspaceGroups.map((line) => (
          <section className="wb-tool-line" key={line.id} aria-labelledby={`home-line-${line.id}`} data-accent={line.accent}>
            <h2 className="wb-tool-line-title" id={`home-line-${line.id}`}>{lineLabels[line.id] || line.name}</h2>
            <div className="wb-tool-line-cards">
              {line.tools.map((tool, index) => (
                <Fragment key={tool.id}>
                  {index > 0 && <ArrowRight size={16} className="wb-tool-line-arrow" aria-hidden="true" />}
                  <a className="wb-tool-card" href={tool.href} data-accent={tool.accent}>
                    <ToolPreview slides={previewSlides(tool.id, byKind)} />
                    <span className="wb-tool-card-body">
                      <span className="wb-tool-card-title">
                        <ModuleIcon icon={tool.icon} className="size-5" />
                        {tool.name}
                        <ArrowRight size={16} className="wb-tool-card-arrow" />
                      </span>
                      <span className="wb-tool-card-hint">{tool.starterHint}</span>
                      <span className="wb-tool-card-stages" title={tool.stages.join(' → ')}>{tool.stages.join(' → ')}</span>
                    </span>
                  </a>
                </Fragment>
              ))}
            </div>
          </section>
        ))}
      </div>

      <RecentWork items={wb.items} onShowAll={() => wb.setQueueOpen(true)} />
      <RecentAssets assets={recent} />
    </main>
  );
}

function RecentWork({ items, onShowAll }: { items: WorkItem[]; onShowAll: () => void }) {
  const wb = useWorkbench();
  const { running, attention } = useRecordSummary();
  const shown = items.filter((item): item is WorkItem & { state: RecentWorkState } => item.state !== 'not_submitted')
    .sort((a, b) => statePriority[a.state] - statePriority[b.state] || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
  const counts = [attention ? `需要处理 ${attention}` : '', running ? `制作中 ${running}` : ''].filter(Boolean).join(' · ');
  return (
    <section className="wb-home-section" aria-labelledby="home-work">
      <div className="wb-section-head">
        <h2 id="home-work">继续制作</h2>
        {counts && <span className="wb-muted">{counts}</span>}
        {items.length > 0 && (
          <button className="wb-text-button" onClick={onShowAll}>
            全部记录 · {items.length}
            <ChevronRight size={14} />
          </button>
        )}
      </div>
      {shown.length ? (
        <ol className="wb-recent-work">
          {shown.map((item) => {
            const tool = wb.modules.find((module) => module.id === item.capabilityId);
            const title = workItemTitle(item, tool?.name);
            return (
              <li key={item.id}>
                <a className="wb-recent-row" href={item.href} data-accent={tool?.accent}>
                  <span className="wb-recent-icon">
                    {tool && <ModuleIcon icon={tool.icon} className="size-5" />}
                  </span>
                  <span className="wb-recent-title" title={item.title}>
                    <strong>{title}</strong>
                    {tool && !title.startsWith(tool.name) && <small>{tool.name}</small>}
                  </span>
                  <span className="wb-pill" data-state={item.state}>{stateLabels[item.state]}</span>
                  <time className="wb-recent-time" dateTime={item.updatedAt}>{formatTime(item.updatedAt)}</time>
                  <span className="wb-recent-action">
                    {actionLabels[item.state]}
                    <ChevronRight size={14} />
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="wb-home-empty">还没有作品，从上面选一个工具开始。</p>
      )}
    </section>
  );
}

function RecentAssets({ assets }: { assets: HomeAsset[] | null }) {
  if (assets && !assets.length) return null;
  return (
    <section className="wb-home-section" aria-labelledby="home-assets">
      <div className="wb-section-head">
        <h2 id="home-assets">最近素材</h2>
        <a className="wb-text-button" href={workbenchDestinations.assets.href}>
          打开资产库
          <ChevronRight size={14} />
        </a>
      </div>
      <ul className="wb-recent-assets" aria-busy={!assets}>
        {(assets || Array.from({ length: 6 }, () => null)).map((asset, i) => (
          <li key={asset?.id || i}>
            {asset ? (
              <a href={asset.viewPath} title={asset.title}>
                <span className="wb-recent-thumb">
                  <img src={asset.previewUrl} alt="" {...pixelSize(asset, 128)} loading="lazy" decoding="async" />
                </span>
                <span className="wb-recent-asset-name">{asset.title}</span>
                <small>{kindLabels[asset.kind] || asset.kind}</small>
              </a>
            ) : (
              <span className="wb-recent-thumb wb-skeleton" />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatTime(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return date.toLocaleString('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
