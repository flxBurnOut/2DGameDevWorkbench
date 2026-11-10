import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkbenchProvider, useWorkbench } from '../../components/workbench/workbench-provider';
import { WorkbenchChrome } from '../../components/workbench/workbench-chrome';
import { SharedDocumentPicker } from '../../components/workbench/shared-document-picker';
import { WorkflowStepDetails, WorkflowAcceptanceDetails } from '../../components/scene-composer/scene-workflow-plan-details';
import { sharedDocumentHref } from '../../features/editor-documents/library';
import { publishEditorSession, removeEditorSession, markEditorSaved } from '../../lib/workbench/editor-session';
import { createScene } from '../../features/scene-composer/model.mjs';
import '../../app/globals.css';
import '../../components/workbench/workbench.css';
import '../../components/scene-composer/scene-workflow.css';

const scene = createScene('详情验收');
scene.instances = [{ id: 'gate', name: '铁门', materialId: 'gate-art', x: 0, y: 0, scale: 1, flipH: false, anchor: { x: 0, y: 0 }, locked: false, hidden: false, included: true }];
const steps = [
  { id: 'generate', title: '制作旧灯', kind: 'generate', input: JSON.stringify({ purpose: 'object', materialId: 'lamp-art', definitionId: 'lamp', name: '旧灯', prompt: '保留生锈金属的细节，透明背景。', visualWidth: 48, visualHeight: 72 }) },
  { id: 'layout', title: '摆放灯并移动铁门', kind: 'scene', input: JSON.stringify({ commands: [{ type: 'add-instance', materialId: 'lamp-art', instanceId: 'lamp', x: 400, y: 600 }, { type: 'move-instances', ids: ['gate'], dx: 4, dy: -2 }] }) },
  { id: 'image', title: '调整铁门打开状态', kind: 'image', input: JSON.stringify({ target: { kind: 'scene-instance', instanceId: 'gate', slot: 'toggle-state', index: 1 }, region: { type: 'rectangle', x: 10, y: 20, width: 30, height: 40 }, operation: { type: 'ai-edit', prompt: '只清除锈迹，保留金属边框。' }, preserveAlpha: true }) },
  { id: 'old', title: '历史未知格式', kind: 'old-format', input: '<script>this is plain text, never execute</script>' },
];
const plan = { steps, visualCriteria: [{ id: 'appearance', description: '铁门边框保持完整', requirementIds: ['r1'], region: { x: 10, y: 20, width: 30, height: 40 } }], acceptance: [{ id: 'behavior', description: '铁门触发后隐藏并关闭碰撞', requirementIds: ['r1'], events: [{ type: 'request', instanceId: 'gate' }, { type: 'tick', seconds: 1 }], expectEvents: [{ name: 'interaction_completed', instanceId: 'gate', count: 1 }], expectStates: [{ instanceId: 'gate', visible: false, solidEnabled: false }] }] };
function Fixture() {
  const wb = useWorkbench();
  const [open, setOpen] = useState(false), [kind, setKind] = useState<'scene' | 'interactable'>('scene');
  const [guard, setGuard] = useState('clean');
  function changeGuard(value: string) {
    setGuard(value); removeEditorSession('shared-project-fixture');
    if (value !== 'clean') publishEditorSession({ capabilityId: 'shared-project-fixture', items: [], dirty: true, busy: false, save: async () => { if (value === 'save-failed') throw new Error('验收：当前草稿保存失败，原内容保留'); sessionStorage.setItem('shared-project-fixture-saved', 'yes'); markEditorSaved('shared-project-fixture'); }, beforeLeave: () => { if (value === 'conflict') throw new Error('验收：版本冲突，草稿保留'); } });
  }
  return <WorkbenchChrome><main className="wb-page" style={{ height: '100%', overflowY: 'auto' }}>
    <h1>共享工程与方案详情隔离验收</h1>
    <p>打开目标：{new URLSearchParams(location.search).get('document') || '尚未选择'} · 离页前保存：{sessionStorage.getItem('shared-project-fixture-saved') || '未触发'}</p>
    <label>打开保护<select aria-label="打开保护" value={guard} onChange={event => changeGuard(event.target.value)}><option value="clean">无未保存内容</option><option value="dirty">需要保存</option><option value="save-failed">保存失败</option><option value="conflict">版本冲突</option></select></label>
    <p><button className="wb-button" onClick={() => { setKind('scene'); setOpen(true); }}>打开共享场景</button> <button className="wb-button" onClick={() => { setKind('interactable'); setOpen(true); }}>打开共享交互物</button></p>
    <p><button className="wb-button" onClick={() => void fetch('/__service?mode=error')}>服务返回错误</button> <button className="wb-button" onClick={() => void fetch('/__service?mode=slow')}>慢响应</button> <button className="wb-button" onClick={() => void fetch('/__service?mode=ready')}>服务正常</button></p>
    <section className="sw-task" style={{ maxWidth: 820 }}><h2>保存方案的只读详情</h2><ol>{steps.map(step => <li key={step.id}><strong>{step.title}</strong><WorkflowStepDetails step={step} scene={scene} steps={steps} /></li>)}</ol><WorkflowAcceptanceDetails plan={plan} scene={scene} /></section>
    <SharedDocumentPicker open={open} kind={kind} onClose={() => setOpen(false)} onOpen={async document => { setOpen(false); await wb.navigate(sharedDocumentHref(location.pathname, document.id)); }} />
  </main></WorkbenchChrome>;
}
createRoot(document.getElementById('root')!).render(<WorkbenchProvider><Fixture /></WorkbenchProvider>);
