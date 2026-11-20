import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Render the actual management component with an isolated records-tab state.
// Child components and effects are outside this result-selection regression.
const source = await readFile(new URL('../../components/workbench/workbench-management.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
});
const TaskResultCard = () => null;
const jsx = (type, props) => ({ type, props });
function renderResult(tasks, requestedTask = '') {
  const state = ['records', requestedTask, requestedTask, 'all', null];
  let nextState = 0;
  const item = { id: 'sprite:one', title: '角色动作', state: 'completed', updatedAt: tasks[0]?.updatedAt || '', taskIds: tasks.map(task => task.id), href: '/tools/sprite-generator?job=one' };
  const wb = { items: tasks.length ? [item] : [], tasks, modules: [], refreshing: false };
  const modules = {
    react: { useState: () => [state[nextState++], () => {}], useEffect() {} },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './workbench-provider': { useWorkbench: () => wb },
    './task-result-card': { TaskResultCard },
    './clear-history': { ClearHistory: () => null },
    './game-delivery-history': { GameDeliveryHistory: () => null },
    '@/lib/workbench/work-items': { workStateLabels: { completed: '已完成' }, operationLabel: () => '制作' },
  };
  const exports = {};
  runInNewContext(outputText, {
    exports,
    require(name) {
      assert.ok(name in modules, `Unexpected component dependency: ${name}`);
      return modules[name];
    },
  });
  const nodes = [];
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    visit(node.props?.children);
  };
  visit(exports.WorkbenchManagement());
  return nodes.find(node => node.type === TaskResultCard)?.props.taskId;
}

// Runtime history is newest first. The work item can merge a failed attempt
// with its successful retry, while an explicit task deep link stays exact.
const latest = { id: 'retry-success', status: 'completed', updatedAt: '2026-11-16T12:00:00.000Z' };
const previous = { id: 'first-failure', status: 'failed', updatedAt: '2026-11-16T11:00:00.000Z' };
assert.equal(renderResult([latest, previous]), latest.id);
assert.equal(renderResult([latest, previous], previous.id), previous.id);
assert.equal(renderResult([latest]), latest.id);
assert.equal(renderResult([]), undefined);
console.log('Management results: newest merged attempt, exact task deep links, single attempt and empty history passed.');
