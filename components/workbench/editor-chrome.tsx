'use client';
import { Layers3 } from 'lucide-react';
import { useWorkbench } from './workbench-provider';
import { SharedWorkbenchNavigation } from './shared-navigation';

export function EditorWorkbenchMenu() {
  return <SharedWorkbenchNavigation compact />;
}

export function EditorTaskSummary({ compact = false }: { compact?: boolean }) {
  const wb = useWorkbench();
  const running = wb.items.filter((item) => item.state === 'running').length;
  const attention = wb.items.filter(
    (item) => item.state === 'attention',
  ).length;
  const offline =
    wb.runtimeOnline === false ||
    (wb.spriteOnline === false &&
      wb.items.some((item) => item.capabilityId === 'sprite-generator'));
  const label = [
    running ? `制作中 ${running}` : '制作记录',
    attention ? `待处理 ${attention}` : '',
    offline ? '状态连接中断' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <button
      type="button"
      className="map-task-summary"
      data-attention={attention > 0 || offline}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={wb.queueOpen}
      title={label}
      onClick={() => wb.setQueueOpen(true)}
    >
      <Layers3 size={14} />
      <span>
        {compact
          ? attention || offline
            ? '需处理'
            : running || '记录'
          : label}
      </span>
    </button>
  );
}
