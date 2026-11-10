import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchProvider } from '../../components/workbench/workbench-provider';
import { WorkbenchChrome } from '../../components/workbench/workbench-chrome';
import { WorkbenchShell } from '../../components/workbench/workbench-shell';
import { EditorWorkbenchMenu } from '../../components/workbench/editor-chrome';
import { WorkbenchBreadcrumb } from '../../components/workbench/shared-navigation';
import { publishEditorSession, removeEditorSession } from '../../lib/workbench/editor-session';
import '../../app/globals.css';
import '../../components/workbench/workbench.css';
import '../../components/map-stitcher/frame-ronin-editor.css';

function Fixture() {
  const [guard, setGuard] = useState('clean');
  const compact = location.pathname.startsWith('/tools/');
  const changeGuard = (value: string) => {
    setGuard(value);
    removeEditorSession('navigation-fixture');
    if (value === 'clean') return;
    publishEditorSession({ capabilityId: 'navigation-fixture', items: [], dirty: value === 'save-failed', busy: value === 'busy', save: async () => { throw new Error('验收：草稿保存失败'); }, beforeLeave: () => { if (value === 'busy') throw new Error('验收：导入尚未完成'); if (value === 'conflict') throw new Error('验收：共享工程版本冲突'); } });
  };
  return <WorkbenchChrome>
    {location.pathname === '/' ? <WorkbenchShell /> : <div {...(compact ? { 'data-map-editor': true } : {})}>
      {compact && <header className="map-project-bar"><div className="map-project-title"><EditorWorkbenchMenu /><WorkbenchBreadcrumb compact projectName="导航验收工程" /></div></header>}
      <main className="wb-page"><h1>{location.pathname}</h1><p>仅测试共享导航，所有服务响应均为隔离 fixture。</p><label>离开保护<select aria-label="离开保护" value={guard} onChange={(event) => changeGuard(event.target.value)}><option value="clean">无未保存内容</option><option value="save-failed">保存失败</option><option value="busy">正在导入</option><option value="conflict">版本冲突</option></select></label></main>
    </div>}
  </WorkbenchChrome>;
}
createRoot(document.getElementById('root')!).render(<WorkbenchProvider><Fixture /></WorkbenchProvider>);
