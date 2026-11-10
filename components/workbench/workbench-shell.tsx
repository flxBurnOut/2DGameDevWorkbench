'use client';
/* oxlint-disable next/no-html-link-for-pages -- Native navigation is saved and guarded by WorkbenchProvider. */
import {
  ArrowRight,
  ArrowUpRight,
  Box,
  Map,
  PersonStanding,
} from 'lucide-react';
import { useWorkbench } from './workbench-provider';
import { ModuleIcon } from './module-icon';
import { WorkbenchBreadcrumb } from './shared-navigation';

export function WorkbenchShell() {
  const { lines, setQueueOpen } = useWorkbench();
  return (
    <main className="wb-page wb-home">
      <div className="wb-eyebrow">ASSET PRODUCTION</div>
      <h1>开始制作游戏资产</h1>
      <p className="wb-intro">选择角色制作或场景制作，也可从资产库选用已有素材。</p>
      <div className="wb-production-lines">
        {lines.map((line) => (
          <a
            className="wb-production-card"
            key={line.id}
            href={line.href}
            data-accent={line.accent}
          >
            <div className="wb-production-preview" aria-hidden="true">
              <span className="wb-preview-label">{line.eyebrow}</span>
              {line.id === 'player' ? (
                <div className="wb-frame-strip">
                  {[1, 2, 3].map((i) => (
                    <div className="wb-frame" key={i}>
                      <PersonStanding strokeWidth={1.6} />
                      <span>F.0{i}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="wb-map-preview">
                  <div className="wb-map-block">
                    <Map strokeWidth={1} />
                  </div>
                  <div className="wb-map-block">
                    <Box strokeWidth={1} />
                  </div>
                  <div className="wb-map-block">
                    <Map strokeWidth={1} />
                  </div>
                </div>
              )}
            </div>
            <div className="wb-production-copy">
              <div>
                <h2>{line.name}</h2>
                <span className="wb-entry-arrow">
                  <ArrowUpRight size={20} />
                </span>
              </div>
              <p>{line.description}</p>
              <div className="wb-card-flow">
                {line.summary.map((stage, i) => (
                  <span key={stage}>
                    {i > 0 && (
                      <span aria-hidden="true">
                        {line.id === 'player' ? '→' : '＋'}
                      </span>
                    )}
                    {stage}
                  </span>
                ))}
              </div>
            </div>
          </a>
        ))}
      </div>
      <div className="wb-home-footer">
        <button className="wb-text-button" onClick={() => setQueueOpen(true)}>
          已有作品？继续上一次制作 <ArrowRight size={14} />
        </button>
        <span>每次专注一件资产</span>
      </div>
    </main>
  );
}

export function SceneWorkflow() {
  const { modules, lines } = useWorkbench();
  const line = lines.find((l) => l.id === 'scene');
  return (
    <main className="wb-page wb-scene" data-accent={line?.accent}>
      <WorkbenchBreadcrumb />
      <div className="wb-eyebrow">BUILD YOUR WORLD</div>
      <h1>{line?.name}</h1>
      <p className="wb-intro">从生成地图原图开始，也可导入已有地图；制作交互物后再组装场景。</p>
      <div className="wb-scene-stages">
        {modules
          .filter((m) => m.productionLine === line?.id)
          .map((m) => (
            <article className="wb-scene-stage" key={m.id}>
              <span className="wb-stage-icon">
                <ModuleIcon icon={m.icon} className="size-6" />
              </span>
              <h2>{m.entryTitle}</h2>
              <p>{m.starterHint}</p>
              <div className="wb-scene-entry-actions">
                {(m.entryActions ?? [{ label: `进入${m.name}`, href: m.href }]).map((action, index) => (
                  <a className={`wb-button${index === 0 ? ' wb-primary' : ''}`} href={action.href} key={action.href}>
                    {action.label}<ArrowRight size={16} />
                  </a>
                ))}
              </div>
            </article>
          ))}
      </div>
      <div className="wb-scene-handoff">
        <div>
          <h2>一起组成你的场景</h2>
          <p>在场景组装中摆放交互物、右键调整遮挡，并导出完整 Godot 场景。</p>
        </div>
      </div>
    </main>
  );
}
