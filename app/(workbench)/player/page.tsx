'use client';
/* oxlint-disable next/no-html-link-for-pages -- Navigation is guarded by WorkbenchProvider. */
import { ArrowRight } from 'lucide-react';
import { useWorkbench } from '@/components/workbench/workbench-provider';
import { ModuleIcon } from '@/components/workbench/module-icon';
import { WorkbenchBreadcrumb } from '@/components/workbench/shared-navigation';

export default function PlayerPage() {
  const { modules, lines } = useWorkbench();
  return (
    <main className="wb-page wb-scene" data-accent="violet">
      <WorkbenchBreadcrumb />
      <div className="wb-eyebrow">CHARACTER / MOTION</div>
      <h1>{lines.find((line) => line.id === 'player')?.name}</h1>
      <p className="wb-intro">
        先用描述制作像素原图；已有参考图，也可以直接制作序列帧。
      </p>
      <div className="wb-scene-stages">
        {modules
          .filter((module) => module.productionLine === 'player')
          .map((module) => (
            <article className="wb-scene-stage" key={module.id}>
              <span className="wb-stage-icon">
                <ModuleIcon icon={module.icon} className="size-6" />
              </span>
              <h2>{module.entryTitle}</h2>
              <p>{module.starterHint}</p>
              <a className="wb-button wb-primary" href={module.href}>
                进入{module.name} <ArrowRight size={16} />
              </a>
            </article>
          ))}
      </div>
    </main>
  );
}
