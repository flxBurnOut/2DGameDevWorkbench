'use client';
/* oxlint-disable next/no-html-link-for-pages -- Native navigation is saved and guarded by WorkbenchProvider. */
import { useSyncExternalStore } from 'react';
import { Archive, CircleHelp, Layers3, Settings2, Undo2 } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { assetReturnHref, currentWorkbenchPage, workbenchDestinations, workspaceGroups } from '@/lib/workbench/navigation';
import { useWorkbench } from './workbench-provider';
import { WorkbenchBrand } from './workbench-brand';
import { ThemeToggle } from './theme-toggle';
import { ModuleIcon } from './module-icon';

const subscribeLocation = (callback: () => void) => {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
};

/** "Back to the asset" for editors opened from an asset detail page; tools render it in their own toolbar. */
export function SourceAssetLink() {
  const wb = useWorkbench();
  const search = useSyncExternalStore(subscribeLocation, () => location.search, () => '');
  const href = assetReturnHref(search);
  return href ? <button type="button" className="wb-source-link" onClick={() => void wb.navigate(href)}><Undo2 size={14} />返回来源资产</button> : null;
}

/** Running and attention counts plus connection problems, shown on the records button. */
export function useRecordSummary() {
  const wb = useWorkbench();
  const running = wb.items.filter((item) => item.state === 'running').length;
  const attention = wb.items.filter((item) => item.state === 'attention').length;
  const offline = wb.runtimeOnline === false ||
    (wb.spriteOnline === false && wb.items.some((item) => item.capabilityId === 'sprite-generator'));
  const label = [attention ? `需要处理 ${attention} 项` : '', running ? `制作中 ${running} 项` : '', offline ? '状态连接中断' : '']
    .filter(Boolean).join(' · ');
  return { running, attention, offline, label };
}

/**
 * One header on every page: the three tools and the asset library on the
 * left, records and the icon utilities on the right. The current page is
 * underlined; the item being opened shows as pressed until the page leaves.
 */
export function SharedWorkbenchNavigation() {
  const wb = useWorkbench();
  const current = currentWorkbenchPage(wb.pathname);
  const records = useRecordSummary();
  const destinations = [
    ...workspaceGroups.flatMap((group) => group.tools.map((tool) => ({
      id: tool.id, name: tool.name, href: tool.href, accent: tool.accent,
      icon: <ModuleIcon icon={tool.icon} className="size-4" />,
      active: current.tool?.id === tool.id,
    }))),
    {
      id: 'assets', name: workbenchDestinations.assets.name, href: workbenchDestinations.assets.href, accent: 'violet' as const,
      icon: <Archive size={16} aria-hidden="true" />,
      active: wb.pathname === workbenchDestinations.assets.href,
    },
  ];
  const pendingPath = wb.pendingHref ? new URL(wb.pendingHref, 'http://forge.local').pathname : '';
  const badge = records.attention || records.offline
    ? <span className="wb-badge" data-tone="attention" aria-hidden="true">{records.attention || '!'}</span>
    : records.running ? <span className="wb-badge-dot" aria-hidden="true" /> : null;
  const recordsLabel = records.label ? `${workbenchDestinations.records.name}（${records.label}）` : workbenchDestinations.records.name;
  const managementActive = wb.pathname === workbenchDestinations.management.href;
  return <div className="wb-shared-navigation">
    <a className="wb-brand wb-home-link" href="/" aria-label={`Forge · ${workbenchDestinations.home.name}`} aria-current={wb.pathname === '/' ? 'page' : undefined}>
      <WorkbenchBrand />
    </a>
    <nav className="wb-nav" aria-label="工作台导航">
      {destinations.map((item) => <a key={item.id} href={item.href} data-accent={item.accent}
        aria-current={item.active ? 'page' : undefined} data-pending={pendingPath === item.href || undefined}>
        {item.icon}{item.name}
      </a>)}
    </nav>
    <div className="wb-header-actions">
      <Tooltip label={records.label || '查看制作中和已完成的作品'}>
        <button type="button" className="wb-button wb-ghost wb-records-button" aria-label={recordsLabel}
          aria-haspopup="dialog" aria-expanded={wb.queueOpen} onClick={() => wb.setQueueOpen(true)}>
          <Layers3 size={16} /><span>{workbenchDestinations.records.name}</span>{badge}
        </button>
      </Tooltip>
      <Tooltip label={workbenchDestinations.help.name}>
        <button type="button" className="wb-icon-button" aria-label={workbenchDestinations.help.name}
          aria-haspopup="dialog" aria-expanded={wb.helpOpen} onClick={() => wb.setHelpOpen(true)}>
          <CircleHelp size={18} />
        </button>
      </Tooltip>
      <Tooltip label={workbenchDestinations.management.name}>
        <a className="wb-icon-button" href={workbenchDestinations.management.href} aria-label={workbenchDestinations.management.name}
          aria-current={managementActive ? 'page' : undefined}>
          <Settings2 size={18} />
        </a>
      </Tooltip>
      <ThemeToggle compact />
    </div>
  </div>;
}
