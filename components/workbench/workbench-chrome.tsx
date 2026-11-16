'use client';
/* oxlint-disable next/no-html-link-for-pages -- Native navigation is saved and guarded by WorkbenchProvider. */
import { useState, type ReactNode } from 'react';
import { ArrowRight, Box, ExternalLink, Layers3 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useWorkbench } from './workbench-provider';
import { workItemTitle, workStateLabels, type WorkItem } from '@/lib/workbench/work-items';
import { ModuleIcon } from './module-icon';
import { SharedWorkbenchNavigation, useRecordSummary } from './shared-navigation';
import { currentWorkbenchPage } from '@/lib/workbench/navigation';
import { ContextHelp } from './workbench-help';

export function WorkbenchChrome({ children }: { children: ReactNode }) {
  const wb = useWorkbench();
  const capabilityModule = currentWorkbenchPage(wb.pathname).tool;
  return (
    <div className="wb-app">
      <header className="wb-header">
        <SharedWorkbenchNavigation />
      </header>
      {(wb.navigationError || wb.storageError) && (
        <div className="wb-alert" role="alert">
          {wb.navigationError || wb.storageError}
          <button
            className="wb-button wb-ghost"
            onClick={() => wb.setNavigationError('')}
          >
            知道了
          </button>
        </div>
      )}
      <div
        className="wb-route"
        data-tool={Boolean(capabilityModule) || wb.pathname.includes('/tools/')}
      >
        {children}
      </div>
      <p className="wb-width-notice" role="note">
        当前窗口较窄。工作台按 1100 像素以上的宽度设计，编辑器在更宽的窗口中更好用。
      </p>
      <ProductionRecords />
      <ContextHelp />
    </div>
  );
}

export function WorkItemRow({ item }: { item: WorkItem }) {
  const wb = useWorkbench();
  const capabilityModule = wb.modules.find((m) => m.id === item.capabilityId);
  return (
    <article className="wb-work-row">
      <span className="wb-work-icon" data-accent={capabilityModule?.accent}>
        {capabilityModule ? (
          <ModuleIcon icon={capabilityModule.icon} className="size-5" />
        ) : (
          <Box size={20} />
        )}
      </span>
      <div className="wb-work-copy">
        <strong title={item.title}>{workItemTitle(item, capabilityModule?.name)}</strong>
        <span>
          {capabilityModule?.entryTitle} · {item.detail}
        </span>
        <small>
          {item.savedAt
            ? `草稿保存于 ${formatTime(item.savedAt)}`
            : `更新于 ${formatTime(item.updatedAt)}`}
        </small>
      </div>
      <span className="wb-state" data-state={item.state}>
        <i />
        {workStateLabels[item.state]}
      </span>
      <a className="wb-button" href={item.href}>
        {item.state === 'attention'
          ? '查看并处理'
          : item.state === 'running'
            ? '查看进度'
            : item.state === 'completed'
              ? '查看作品'
              : '继续制作'}
        <ArrowRight size={14} />
      </a>
      {Boolean(item.outputs?.length) && (
        <details className="wb-output-list">
          <summary>产物 · {item.outputs?.length}</summary>
          {item.outputs?.map((output) => (
            <a
              key={output}
              href={`/api/workbench/artifacts?path=${encodeURIComponent(output)}`}
              target="_blank"
              rel="noreferrer"
            >
              {output}
              <ExternalLink size={12} />
            </a>
          ))}
        </details>
      )}
    </article>
  );
}

function ProductionRecords() {
  const wb = useWorkbench();
  const [history, setHistory] = useState(false);
  const { offline } = useRecordSummary();
  const active = wb.items.filter((item) => item.state !== 'completed');
  const shown = history
    ? wb.items.filter((item) => item.state === 'completed')
    : active;
  return (
    <>
      <Dialog open={wb.queueOpen} onOpenChange={wb.setQueueOpen}>
        <DialogContent className="wb-dialog wb-records-dialog">
          <DialogHeader>
            <DialogTitle>制作记录</DialogTitle>
            <DialogDescription>
              返回具体作品，继续编辑、处理问题或查看产物。
            </DialogDescription>
          </DialogHeader>
          <div className="wb-record-tabs">
            <a className="wb-button wb-ghost" href="/advanced?tab=data">管理本机数据</a>
            <fieldset className="ui-segmented" aria-label="记录范围">
              <button
                className="wb-button"
                aria-pressed={!history}
                onClick={() => setHistory(false)}
              >
                制作中 · {active.length}
              </button>
              <button
                className="wb-button"
                aria-pressed={history}
                onClick={() => setHistory(true)}
              >
                已完成 · {wb.items.length - active.length}
              </button>
            </fieldset>
            <button
              className="wb-button wb-ghost"
              onClick={() => void wb.refresh()}
              disabled={wb.refreshing}
              aria-busy={wb.refreshing}
            >
              {wb.refreshing ? '刷新中…' : '刷新'}
            </button>
          </div>
          {offline && (
            <output className="wb-notice">
              部分服务暂时无法连接，服务任务显示的是上次读取的状态。本机草稿仍可打开。
              <a href="/advanced?tab=services">查看服务状态</a>
            </output>
          )}
          <div className="wb-records">
            {shown.map((item) => (
              <WorkItemRow key={item.id} item={item} />
            ))}
            {!shown.length && (
              <div className="wb-empty">
                <Layers3 size={28} />
                <p>
                  {history
                    ? '完成并导出的作品会出现在这里。'
                    : '还没有正在制作的作品。'}
                </p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export { WorkbenchManagement as WorkbenchAdvanced } from './workbench-management';
function formatTime(value?: string) {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '时间未记录';
}
