'use client';
/* oxlint-disable next/no-html-link-for-pages -- Native navigation is saved and guarded by WorkbenchProvider. */
import { Archive, ArrowRight, Box, Layers3, PersonStanding } from 'lucide-react';
import { workbenchDestinations, workspaceGroups } from '@/lib/workbench/navigation';
import { ModuleIcon } from './module-icon';
import { useWorkbench } from './workbench-provider';

export function WorkbenchShell() {
  const { setQueueOpen } = useWorkbench();
  return (
    <main className="wb-page wb-home">
      <h1>开始制作游戏资产</h1>
      <p className="wb-intro">选择要制作的内容直接进入工具，也可从资产库选用已有素材。</p>
      <div className="wb-production-lines">
        {workspaceGroups.map((line) => (
          <article className="wb-production-card" key={line.id} data-accent={line.accent}>
            <div className="wb-production-preview" aria-hidden="true">
              {line.id === 'player' ? (
                <div className="wb-frame-strip">
                  {[1, 2, 3].map((i) => (
                    <div className="wb-frame" key={i}>
                      <PersonStanding strokeWidth={1.6} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="wb-map-preview">
                  {[1, 2, 3].map((i) => (
                    <div className="wb-map-block" key={i}>
                      <Box strokeWidth={1} />
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="wb-production-copy">
              <h2>{line.name}</h2>
              <p>{line.description}</p>
              <p className="wb-card-flow">{line.summary.join(' → ')}</p>
            </div>
            <div className="wb-production-tools">
              {line.tools.map((tool) => (
                <a className="wb-production-tool" key={tool.id} href={tool.href}>
                  <ModuleIcon icon={tool.icon} className="size-5" />
                  <span>
                    <strong>{tool.name}</strong>
                    <small>{tool.starterHint}</small>
                  </span>
                  <ArrowRight size={16} />
                </a>
              ))}
            </div>
          </article>
        ))}
      </div>
      <div className="wb-home-footer">
        <button className="wb-button" onClick={() => setQueueOpen(true)}>
          <Layers3 size={15} />
          继续上一次制作
        </button>
        <a className="wb-button wb-ghost" href={`${workbenchDestinations.assets.href}?import=package`}>
          <Archive size={15} />
          导入 Forge 素材包
        </a>
      </div>
    </main>
  );
}
