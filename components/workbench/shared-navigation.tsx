'use client';
import { useSyncExternalStore } from 'react';
import { Archive, ChevronDown, ChevronRight, CircleHelp, Layers3, Settings2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { assetReturnHref, currentWorkbenchPage, workbenchDestinations, workspaceGroups } from '@/lib/workbench/navigation';
import { useWorkbench } from './workbench-provider';
import { WorkbenchBrand, WorkbenchBrandIcon } from './workbench-brand';
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

export function WorkbenchBreadcrumb({ projectName, compact = false }: { projectName?: string; compact?: boolean }) {
  const wb = useWorkbench();
  const { tool, group, name } = currentWorkbenchPage(wb.pathname);
  return <nav className={`wb-breadcrumb${compact ? ' wb-editor-breadcrumb' : ''}`} aria-label="当前位置">
    {!compact && <><button onClick={() => void wb.navigate('/')}>{workbenchDestinations.home.name}</button><ChevronRight size={12} /></>}
    {tool && group && <span className="wb-breadcrumb-parent"><button onClick={() => void wb.navigate(group.href)}>{group.name}</button><ChevronRight size={12} /></span>}
    <span aria-current={projectName ? undefined : 'page'}>{name}</span>
    {projectName && <><ChevronRight size={12} /><h1 aria-current="page" title={projectName}>{projectName}</h1></>}
    <SourceAssetLink />
  </nav>;
}

export function SharedWorkbenchNavigation({ compact = false }: { compact?: boolean }) {
  const wb = useWorkbench();
  const current = currentWorkbenchPage(wb.pathname);
  const utilities = [
    { ...workbenchDestinations.assets, icon: Archive, action: () => void wb.navigate(workbenchDestinations.assets.href), active: wb.pathname === workbenchDestinations.assets.href },
    { ...workbenchDestinations.records, icon: Layers3, action: () => wb.setQueueOpen(true), active: wb.queueOpen },
    { ...workbenchDestinations.help, icon: CircleHelp, action: () => wb.setHelpOpen(true), active: wb.helpOpen },
    { ...workbenchDestinations.management, icon: Settings2, action: () => void wb.navigate(workbenchDestinations.management.href), active: wb.pathname === workbenchDestinations.management.href },
  ];
  return <div className={`wb-shared-navigation${compact ? ' wb-navigation-compact' : ''}`}>
    <button className="wb-brand wb-home-link" aria-label={`Forge · ${workbenchDestinations.home.name}`} onClick={() => void wb.navigate('/')}>
      {compact ? <WorkbenchBrandIcon size={25} className="wb-compact-brandmark" /> : <WorkbenchBrand />}
    </button>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="wb-workspace-trigger" aria-label="工作区" />}>
        工作区 <ChevronDown size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="wb-workspace-menu">
        {workspaceGroups.map((group) => <DropdownMenuGroup key={group.id}>
          <DropdownMenuLabel data-active={current.group?.id === group.id}>{group.id === 'player' ? '角色制作' : '场景制作'}</DropdownMenuLabel>
          <DropdownMenuItem aria-current={wb.pathname === group.href ? 'page' : undefined} data-active={current.group?.id === group.id} onClick={() => void wb.navigate(group.href)}>{group.name}</DropdownMenuItem>
          {group.tools.map((tool) => <DropdownMenuItem key={tool.id} aria-current={current.tool?.id === tool.id ? 'page' : undefined} onClick={() => void wb.navigate(tool.href)}><ModuleIcon icon={tool.icon} className="size-4" />{tool.name}</DropdownMenuItem>)}
        </DropdownMenuGroup>)}
        <DropdownMenuSeparator />
        {utilities.map(({ name, icon: Icon, action, active }) => <DropdownMenuItem key={name} onClick={action} aria-current={active ? 'page' : undefined}><Icon />{name}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
    {!compact && <nav className="wb-nav" aria-label="工作台导航">{workspaceGroups.map((group) => <button key={group.id} data-accent={group.accent} aria-current={current.group?.id === group.id ? 'page' : undefined} onClick={() => void wb.navigate(group.href)}>{group.name}</button>)}</nav>}
    {!compact && <div className="wb-header-actions">{utilities.map(({ name, icon: Icon, action, active }) => <button key={name} className="wb-button wb-ghost" aria-label={name} aria-current={active ? 'page' : undefined} onClick={action}><Icon size={16} /><span>{name}</span></button>)}</div>}
    <ThemeToggle compact={compact} />
  </div>;
}
