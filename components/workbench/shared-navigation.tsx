'use client';
import { useSyncExternalStore } from 'react';
import { Archive, ChevronDown, ChevronRight, CircleHelp, Layers3, Settings2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { assetReturnHref, currentWorkbenchPage, workbenchDestinations, workspaceGroups } from '@/lib/workbench/navigation';
import { useWorkbench } from './workbench-provider';
import { WorkbenchBrand } from './workbench-brand';
import { ThemeToggle } from './theme-toggle';
import { ModuleIcon } from './module-icon';

const subscribeLocation = (callback: () => void) => {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
};

export function SourceAssetLink() {
  const wb = useWorkbench();
  const search = useSyncExternalStore(subscribeLocation, () => location.search, () => '');
  const href = assetReturnHref(search);
  return href ? <button className="wb-source-link" aria-label="返回来源资产" title="返回来源资产" onClick={() => void wb.navigate(href)}><Undo2 size={13} />返回来源资产</button> : null;
}

/** Tool pages show where they are in the header: production line › tool › current work. */
export function WorkbenchBreadcrumb() {
  const wb = useWorkbench();
  const { tool, group, name } = currentWorkbenchPage(wb.pathname);
  const projectName = wb.pageTitle;
  return <nav className="wb-breadcrumb" aria-label="当前位置">
    {group && group.href !== tool?.href && <span className="wb-breadcrumb-parent"><button onClick={() => void wb.navigate(group.href)}>{group.name}</button><ChevronRight size={12} /></span>}
    <span className="wb-breadcrumb-current" aria-current={projectName ? undefined : 'page'}>{name}</span>
    {projectName && <><ChevronRight size={12} /><strong aria-current="page" title={projectName}>{projectName}</strong></>}
    <SourceAssetLink />
  </nav>;
}

/** Running and attention counts plus connection problems, shown on the records button. */
export function useRecordSummary() {
  const wb = useWorkbench();
  const running = wb.items.filter((item) => item.state === 'running').length;
  const attention = wb.items.filter((item) => item.state === 'attention').length;
  const offline = wb.runtimeOnline === false ||
    (wb.spriteOnline === false && wb.items.some((item) => item.capabilityId === 'sprite-generator'));
  const label = [running ? `制作中 ${running}` : '', attention ? `待处理 ${attention}` : '', offline ? '状态连接中断' : '']
    .filter(Boolean).join(' · ');
  return { running, attention, offline, label };
}

export function SharedWorkbenchNavigation() {
  const wb = useWorkbench();
  const current = currentWorkbenchPage(wb.pathname);
  const records = useRecordSummary();
  const utilities = [
    { ...workbenchDestinations.assets, icon: Archive, action: () => void wb.navigate(workbenchDestinations.assets.href), active: wb.pathname === workbenchDestinations.assets.href },
    { ...workbenchDestinations.records, icon: Layers3, action: () => wb.setQueueOpen(true), active: wb.queueOpen },
    { ...workbenchDestinations.help, icon: CircleHelp, action: () => wb.setHelpOpen(true), active: wb.helpOpen },
    { ...workbenchDestinations.management, icon: Settings2, action: () => void wb.navigate(workbenchDestinations.management.href), active: wb.pathname === workbenchDestinations.management.href },
  ];
  const badge = records.attention || records.offline
    ? <span className="wb-badge" data-tone="attention">{records.attention || '!'}</span>
    : records.running ? <span className="wb-badge">{records.running}</span> : null;
  return <div className="wb-shared-navigation">
    <button className="wb-brand wb-home-link" aria-label={`Forge · ${workbenchDestinations.home.name}`} onClick={() => void wb.navigate('/')}>
      <WorkbenchBrand />
    </button>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="wb-workspace-trigger" aria-label="工作区" />}>
        工作区 <ChevronDown size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="wb-workspace-menu">
        {workspaceGroups.map((group) => <DropdownMenuGroup key={group.id}>
          <DropdownMenuLabel data-active={current.group?.id === group.id}>{group.id === 'player' ? '角色制作' : '交互物制作'}</DropdownMenuLabel>
          {group.tools.every((tool) => tool.href !== group.href) && <DropdownMenuItem aria-current={wb.pathname === group.href ? 'page' : undefined} data-active={current.group?.id === group.id} onClick={() => void wb.navigate(group.href)}>{group.name}</DropdownMenuItem>}
          {group.tools.map((tool) => <DropdownMenuItem key={tool.id} aria-current={current.tool?.id === tool.id ? 'page' : undefined} onClick={() => void wb.navigate(tool.href)}><ModuleIcon icon={tool.icon} className="size-4" />{tool.name}</DropdownMenuItem>)}
        </DropdownMenuGroup>)}
        <DropdownMenuSeparator />
        {utilities.map(({ name, icon: Icon, action, active }) => <DropdownMenuItem key={name} onClick={action} aria-current={active ? 'page' : undefined}><Icon />{name}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
    {current.tool
      ? <WorkbenchBreadcrumb />
      : <nav className="wb-nav" aria-label="工作台导航">{workspaceGroups.map((group) => <button key={group.id} data-accent={group.accent} aria-current={current.group?.id === group.id ? 'page' : undefined} onClick={() => void wb.navigate(group.href)}>{group.name}</button>)}</nav>}
    <div className="wb-header-actions">{utilities.map(({ name, icon: Icon, action, active }) => {
      const isRecords = name === workbenchDestinations.records.name;
      const label = isRecords && records.label ? `${name}（${records.label}）` : name;
      return <button key={name} className="wb-button wb-ghost" aria-label={label} title={label} aria-current={active ? 'page' : undefined}
        {...(isRecords ? { 'aria-haspopup': 'dialog' as const, 'aria-expanded': wb.queueOpen } : {})} onClick={action}>
        <Icon size={16} /><span>{name}</span>{isRecords && badge}
      </button>;
    })}</div>
    <ThemeToggle />
  </div>;
}
