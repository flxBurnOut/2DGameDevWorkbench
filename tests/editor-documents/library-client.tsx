import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchProvider, useWorkbench } from '../../components/workbench/workbench-provider';
import { WorkbenchChrome } from '../../components/workbench/workbench-chrome';
import { SharedDocumentPicker } from '../../components/workbench/shared-document-picker';
import { sharedDocumentHref } from '../../features/editor-documents/library';
import { publishEditorSession, removeEditorSession, markEditorSaved } from '../../lib/workbench/editor-session';
import '../../app/globals.css';
import '../../components/workbench/workbench.css';

function Fixture() {
  const wb = useWorkbench();
  const [open, setOpen] = useState(false);
  const [guard, setGuard] = useState('clean');
  function changeGuard(value: string) {
    setGuard(value); removeEditorSession('shared-project-fixture');
    if (value !== 'clean') publishEditorSession({ capabilityId: 'shared-project-fixture', items: [], dirty: true, busy: false, save: async () => { if (value === 'save-failed') throw new Error('验收：当前草稿保存失败，原内容保留'); sessionStorage.setItem('shared-project-fixture-saved', 'yes'); markEditorSaved('shared-project-fixture'); }, beforeLeave: () => { if (value === 'conflict') throw new Error('验收：版本冲突，草稿保留'); } });
  }
  return <WorkbenchChrome><main className="wb-page" style={{ height: '100%', overflowY: 'auto' }}>
    <h1>共享交互物工程隔离验收</h1>
    <p>打开目标：{new URLSearchParams(location.search).get('document') || '尚未选择'} · 离页前保存：{sessionStorage.getItem('shared-project-fixture-saved') || '未触发'}</p>
    <label>打开保护<select aria-label="打开保护" value={guard} onChange={event => changeGuard(event.target.value)}><option value="clean">无未保存内容</option><option value="dirty">需要保存</option><option value="save-failed">保存失败</option><option value="conflict">版本冲突</option></select></label>
    <p><button className="wb-button" onClick={() => setOpen(true)}>打开共享交互物</button></p>
    <p><button className="wb-button" onClick={() => void fetch('/__service?mode=error')}>服务返回错误</button> <button className="wb-button" onClick={() => void fetch('/__service?mode=slow')}>慢响应</button> <button className="wb-button" onClick={() => void fetch('/__service?mode=ready')}>服务正常</button></p>
    <SharedDocumentPicker open={open} kind="interactable" onClose={() => setOpen(false)} onOpen={async document => { setOpen(false); await wb.navigate(sharedDocumentHref(location.pathname, document.id)); }} />
  </main></WorkbenchChrome>;
}
createRoot(document.getElementById('root')!).render(<WorkbenchProvider><Fixture /></WorkbenchProvider>);
