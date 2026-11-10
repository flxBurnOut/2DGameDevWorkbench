'use client';
/* oxlint-disable next/no-html-link-for-pages -- Native navigation is saved and guarded by WorkbenchProvider. */
import { useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Box,
  ExternalLink,
  Layers3,
  LoaderCircle,
  Save,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useWorkbench } from './workbench-provider';
import { workStateLabels, type WorkItem } from '@/lib/workbench/work-items';
import { ModuleIcon } from './module-icon';
import { SharedWorkbenchNavigation, WorkbenchBreadcrumb } from './shared-navigation';
import { currentWorkbenchPage } from '@/lib/workbench/navigation';
import { ContextHelp, Onboarding } from './workbench-help';

export function WorkbenchChrome({ children }: { children: ReactNode }) {
  const wb = useWorkbench();
  const capabilityModule = currentWorkbenchPage(wb.pathname).tool;
  const session = wb.sessions.find(
    (s) => s.capabilityId === capabilityModule?.id,
  );
  const active = session?.items[0];
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!session) return;
    setSaving(true);
    try {
      await session.save();
      wb.setNavigationError('');
    } catch (error) {
      wb.setNavigationError(
        error instanceof Error ? error.message : '保存失败，请下载源文件。',
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="wb-app">
      <header className="wb-header">
        <SharedWorkbenchNavigation />
      </header>
      {capabilityModule && (
        <section
          className="wb-tool-context"
          data-accent={capabilityModule.accent}
          aria-label="当前作品与制作记录"
        >
          <div className="wb-context-title">
            <WorkbenchBreadcrumb />
            {active && (
              <div className="wb-current-work">
                <span className="wb-muted">当前任务</span>
                <strong title={active.title}>{active.title}</strong>
                <span className="wb-state" data-state={active.state}>
                  <i />
                  {active.detail}
                </span>
              </div>
            )}
          </div>
          <div className="wb-context-actions">
            {session &&
              (capabilityModule.id === 'sprite-generator' ? (
                <span className="wb-muted">任务与素材自动保存在本机</span>
              ) : (
                <>
                  <span className="wb-muted">
                    {session.dirty
                      ? '正在保存修改…'
                      : active?.savedAt
                        ? '本机草稿已保存'
                        : '准备素材'}
                  </span>
                  <button
                    className="wb-button"
                    disabled={saving || !session.items.length}
                    onClick={() => void save()}
                  >
                    {saving ? (
                      <LoaderCircle size={14} className="wb-spin" />
                    ) : (
                      <Save size={14} />
                    )}
                    保存草稿
                  </button>
                </>
              ))}
            <button
              className="wb-button"
              onClick={() => wb.setQueueOpen(true)}
              aria-haspopup="dialog"
            >
              <Layers3 size={15} />
              制作记录
            </button>
            {capabilityModule.productionLine === 'scene' && (
              <a className="wb-button wb-ghost" href="/scene">
                场景流程
                <ArrowRight size={14} />
              </a>
            )}
          </div>
        </section>
      )}
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
      <ProductionStatus />
      <Onboarding />
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
        <strong>{item.title}</strong>
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

function ProductionStatus() {
  const wb = useWorkbench();
  const [history, setHistory] = useState(false);
  const active = wb.items.filter((item) => item.state !== 'completed');
  const shown = history
    ? wb.items.filter((item) => item.state === 'completed')
    : active;
  const offline =
    wb.runtimeOnline === false ||
    (wb.spriteOnline === false &&
      wb.items.some((i) => i.capabilityId === 'sprite-generator'));
  return (
    <>
      <footer className="wb-status" aria-label="制作状态栏">
        <button
          className="wb-status-heading"
          onClick={() => wb.setQueueOpen(true)}
          aria-expanded={wb.queueOpen}
        >
          <Layers3 size={16} />
          制作中 <span>{active.length}</span>
        </button>
        <div className="wb-status-items">
          {active.length ? (
            active.slice(0, 2).map((item) => (
              <a href={item.href} key={item.id} className="wb-status-item">
                <span className="wb-state" data-state={item.state}>
                  <i />
                </span>
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
              </a>
            ))
          ) : (
            <span className="wb-muted">
              {wb.refreshing && wb.runtimeOnline === null
                ? '正在读取制作记录…'
                : '从工作区选择制作工具，开始第一件作品。'}
            </span>
          )}
        </div>
        {offline && (
          <a className="wb-status-offline" href="/advanced?tab=services">
            状态连接中断
          </a>
        )}
        <button
          className="wb-button wb-ghost"
          onClick={() => wb.setQueueOpen(true)}
          aria-label="展开制作记录"
        >
          展开{wb.items.length > 0 && ` · ${wb.items.length}`}
        </button>
      </footer>
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
            <button
              className="wb-button wb-ghost"
              onClick={() => void wb.refresh()}
              disabled={wb.refreshing}
            >
              {wb.refreshing ? '刷新中…' : '刷新'}
            </button>
          </div>
          {offline && (
            <output className="wb-notice">
              部分服务暂时无法连接，服务任务显示的是上次读取的状态。本机草稿仍可打开。
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
