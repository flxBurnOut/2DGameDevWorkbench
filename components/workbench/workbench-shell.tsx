'use client';
/* oxlint-disable next/no-html-link-for-pages, next/no-img-element -- Native navigation is saved and guarded by WorkbenchProvider; previews are local pixel art. */
import { useEffect, useState, type ReactNode } from 'react';
import { Archive, ArrowRight, ChevronRight } from 'lucide-react';
import { workbenchDestinations, workspaceGroups } from '@/lib/workbench/navigation';
import { workItemTitle, type WorkItem, type WorkItemState } from '@/lib/workbench/work-items';
import { ModuleIcon } from './module-icon';
import { useWorkbench } from './workbench-provider';
import { useRecordSummary } from './shared-navigation';
import { SampleAnimation, SampleCharacter, SampleInteractable } from './home-samples';

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
const statePriority: Record<WorkItemState, number> = { attention: 0, running: 1, editing: 2, saved: 3, completed: 4 };
const stateLabels: Record<WorkItemState, string> = { attention: '需要处理', running: '制作中', editing: '编辑中', saved: '已保存', completed: '已完成' };
const actionLabels: Record<WorkItemState, string> = { attention: '处理', running: '查看进度', editing: '继续', saved: '继续', completed: '查看' };

/** Which asset kinds can stand in for each tool's preview, most specific first. */
const previewKinds: Record<string, string[]> = {
  'reference-art': ['character'],
  'sprite-generator': ['animation'],
  // Confirmed state images are catalogued as props; the editor keeps its own preference order.
  'interactable-motion': ['prop'],
  'interactable-editor': ['interactable', 'prop'],
};
const samples: Record<string, () => ReactNode> = {
  'reference-art': SampleCharacter,
  'sprite-generator': SampleAnimation,
  'interactable-motion': SampleInteractable,
  'interactable-editor': SampleInteractable,
};

async function readAssets(params: Record<string, string>, signal: AbortSignal) {
  const query = new URLSearchParams({ query: '', scope: 'active', offset: '0', ...params });
  const response = await fetch(`/api/workbench/assets?${query}`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('assets unavailable');
  const data = (await response.json()) as { assets: HomeAsset[]; total: number };
  return data.assets.filter((asset) => asset.availability === 'available' && asset.previewKind !== 'none');
}

/** Latest asset per kind plus the most recent pieces; failures leave the samples in place. */
function useHomeAssets() {
  const [recent, setRecent] = useState<HomeAsset[] | null>(null);
  const [byKind, setByKind] = useState<Record<string, HomeAsset>>({});
  useEffect(() => {
    const controller = new AbortController();
    void readAssets({ limit: '6' }, controller.signal)
      .then(setRecent, () => { if (!controller.signal.aborted) setRecent([]); });
    for (const kind of ['character', 'animation', 'interactable', 'prop'])
      void readAssets({ limit: '1', kind }, controller.signal)
        .then(([asset]) => { if (asset) setByKind((current) => ({ ...current, [kind]: asset })); }, () => undefined);
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

export function WorkbenchShell() {
  const wb = useWorkbench();
  const { recent, byKind } = useHomeAssets();
  const tools = workspaceGroups.flatMap((line) => line.tools.map((tool) => ({ tool, line })));
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

      <div className="wb-tool-cards">
        {tools.map(({ tool, line }) => {
          const asset = previewKinds[tool.id]?.map((kind) => byKind[kind]).find(Boolean);
          const Sample = samples[tool.id];
          const size = asset && pixelSize(asset, 128);
          return (
            <a className="wb-tool-card" key={tool.id} href={tool.href} data-accent={tool.accent}>
              <span className="wb-tool-card-preview">
                {asset ? (
                  <img src={asset.previewUrl} alt="" {...size} decoding="async" />
                ) : Sample ? (
                  <Sample />
                ) : null}
              </span>
              <span className="wb-tool-card-body">
                <span className="wb-tool-card-title">
                  <ModuleIcon icon={tool.icon} className="size-5" />
                  {tool.name}
                  <ArrowRight size={16} className="wb-tool-card-arrow" />
                </span>
                <span className="wb-tool-card-hint">{tool.starterHint}</span>
                <span className="wb-tool-card-meta">
                  <span className="wb-tag">{lineLabels[line.id] || line.name}</span>
                  <span className="wb-tool-card-stages" title={tool.stages.join(' → ')}>{tool.stages.join(' → ')}</span>
                </span>
              </span>
            </a>
          );
        })}
      </div>

      <RecentWork items={wb.items} onShowAll={() => wb.setQueueOpen(true)} />
      <RecentAssets assets={recent} />
    </main>
  );
}

function RecentWork({ items, onShowAll }: { items: WorkItem[]; onShowAll: () => void }) {
  const wb = useWorkbench();
  const { running, attention } = useRecordSummary();
  const shown = [...items]
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
