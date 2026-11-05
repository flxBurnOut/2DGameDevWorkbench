import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createTestViteServer as createServer } from '../helpers/vite-server.mjs';

const server = await createServer({
  root: process.cwd(),
  configFile: false,
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, entries: [] },
  logLevel: 'error',
  resolve: { alias: { '@': resolve(process.cwd()) } },
  server: { middlewareMode: true },
});
const tests = [];
const test = (name, run) => tests.push({ name, run });

try {
  const { workbenchModules: modules, productionLines: lines } =
    await server.ssrLoadModule('/lib/workbench/modules.ts');
  const { workspaceGroups, currentWorkbenchPage, assetReturnHref } =
    await server.ssrLoadModule('/lib/workbench/navigation.ts');
  const { taskWorkItems, spriteWorkItem, mergeWorkItems, interactableItemId } =
    await server.ssrLoadModule('/lib/workbench/work-items.ts');
  const sessions = await server.ssrLoadModule(
    '/lib/workbench/editor-session.ts',
  );
  const { isUntouchedStarterProject, isLegacyEmptyWorkItem } =
    await server.ssrLoadModule(
      '/features/interactable-editor/draft-activity.ts',
    );
  const { createProject } = await server.ssrLoadModule(
    '/features/interactable-editor/contract.mjs',
  );
  const { restoreTaskProject } = await server.ssrLoadModule('/features/interactable-editor/task-project.ts');
  test('shared navigation names every tool once and resolves compatibility deep links', () => {
    assert.deepEqual(workspaceGroups.flatMap((group) => group.tools.map((tool) => tool.id)).sort(), modules.map((tool) => tool.id).sort());
    assert.deepEqual(new Set(modules.map((tool) => tool.name)), new Set(['角色原图', '角色动画', '地图编辑', '交互物编辑', '场景组装']));
    for (const tool of modules) {
      assert.equal(tool.name, tool.shortName);
      assert.equal(tool.name, tool.entryTitle);
      assert.equal(currentWorkbenchPage(tool.href).tool.id, tool.id);
      assert.equal(currentWorkbenchPage(tool.href).group.id, tool.productionLine);
    }
    assert.equal(currentWorkbenchPage('/tools/map-stitcher-legacy').tool.id, 'map-stitcher');
    assert.equal(currentWorkbenchPage('/player').name, '角色制作总览');
    assert.equal(currentWorkbenchPage('/scene').name, '场景制作总览');
  });
  test('asset return links preserve list and detail state and reject other navigation targets', () => {
    const source = '/assets?q=城门&kind=interactable&scope=active&offset=40&asset=example#selected';
    assert.equal(decodeURI(assetReturnHref('?returnTo=' + encodeURIComponent(source))), source);
    for (const target of ['https://evil.example/assets', '//evil.example/assets', '/advanced', '/assets/other', '/assets\\other', '/assets\n', 'javascript:alert(1)', '']) {
      assert.equal(assetReturnHref('?returnTo=' + encodeURIComponent(target)), undefined, target);
    }
    assert.equal(assetReturnHref('?importAsset=example'), undefined);
  });
  test('Agent project resume preserves different local drafts and reuses the imported version', async () => {
    const project = createProject();
    const local = structuredClone(project);
    local.objects[0].displayName = '本机未导出的门';
    const records = new Map([[`interactable-project:${project.projectId}`, local]]);
    let requests = 0;
    const storage = {
      read: async (key) => records.get(key),
      save: async (key, value, _items, mapping) => { records.set(key, value); records.set(mapping, key); },
      items: () => [],
      request: async function (url) { assert.equal(this, undefined, 'Native fetch must be called without the storage receiver'); requests++; return Response.json(url.includes('/tasks/') ? { task: { capabilityId: 'interactable-editor', status: 'completed', input: { operation: 'save-project' }, outputs: ['outputs/t1/interactable-project.json'] } } : project); },
    };
    const loaded = await restoreTaskProject('t1', storage);
    assert.notEqual(loaded.projectId, project.projectId);
    assert.equal(records.get(`interactable-project:${project.projectId}`).objects[0].displayName, '本机未导出的门');
    loaded.objects[0].displayName = '继续编辑 Agent 版本';
    assert.equal((await restoreTaskProject('t1', storage)).objects[0].displayName, '继续编辑 Agent 版本');
    assert.equal(requests, 2);
    await assert.rejects(restoreTaskProject('bad', { ...storage, request: async () => Response.json({ task: { capabilityId: 'map-stitcher', status: 'completed' } }) }), /尚未完成或无法读取/);
  });
  test('saved Agent projects appear saved and link directly to the editor', () => {
    const project = createProject();
    const [item] = taskWorkItems([{ id: 'saved-task', capabilityId: 'interactable-editor', status: 'completed', input: { operation: 'save-project', project } }], modules);
    assert.equal(item.state, 'saved');
    assert.match(item.detail, /尚未导出/);
    assert.match(item.href, /interactable-editor\?task=saved-task/);
    assert.equal(lines.find((line) => line.id === 'player').name, '角色制作总览');
  });

  test('prop generation records open the exact image in scene art, not the character editor', () => {
    const [item] = taskWorkItems([{id:'prop-task',capabilityId:'reference-art',status:'completed',input:{operation:'generate',subject:'prop'}}], modules);
    assert.equal(item.capabilityId,'interactable-editor');
    assert.equal(item.title,'物品原图');
    assert.equal(item.href,'/tools/interactable-editor?artTask=prop-task');
  });
  test('Image 2.6 work items use existing editors without duplicate navigation modules', () => {
    assert.equal(modules.some((entry) => entry.id === 'image-assets'), false);
    for (const [operation, kind, module] of [['generate-background', 'background', 'map-stitcher'], ['generate-prop', 'prop', 'interactable-editor'], ['edit-image', 'prop', 'interactable-editor']]) {
      const [item] = taskWorkItems([{ id: 'image-result', capabilityId: 'image-assets', status: 'completed', input: { operation, kind } }], modules);
      assert.equal(item.capabilityId, module);
      assert.equal(item.href, `/tools/${module}?imageTask=image-result`);
    }
  });
  const at = '2026-09-05T10:00:00.000Z';
  const later = '2026-09-05T10:01:00.000Z';
  const task = (overrides = {}) => ({
    id: 'task-1',
    capabilityId: 'sprite-generator',
    status: 'prepared',
    updatedAt: at,
    input: {},
    ...overrides,
  });

  test('untouched legacy starters are hidden while edits, explicit saves and exports stay visible', () => {
    const draft = createProject();
    const item = {
      id: 'legacy',
      capabilityId: 'interactable-editor',
      state: 'saved',
    };
    assert.equal(isUntouchedStarterProject(draft), true);
    assert.equal(isUntouchedStarterProject(createProject()), true);
    assert.equal(isLegacyEmptyWorkItem(item, draft), true);
    assert.equal(
      isLegacyEmptyWorkItem({ ...item, userInitiated: true }, draft),
      false,
    );
    assert.equal(
      isLegacyEmptyWorkItem({ ...item, outputs: ['object.zip'] }, draft),
      false,
    );
    assert.equal(
      isLegacyEmptyWorkItem({ ...item, taskIds: ['export-1'] }, draft),
      false,
    );
    assert.equal(
      isLegacyEmptyWorkItem({ ...item, state: 'completed' }, draft),
      false,
    );
    assert.equal(isLegacyEmptyWorkItem(item, undefined), false);
    assert.equal(
      isLegacyEmptyWorkItem(item, { ...draft, name: '我的项目' }),
      false,
    );
    const edited = structuredClone(draft);
    edited.objects[0].displayName = '箱子';
    assert.equal(isLegacyEmptyWorkItem(item, edited), false);
    const behavior = structuredClone(draft);
    behavior.objects[0].behavior.repeat = !behavior.objects[0].behavior.repeat;
    assert.equal(isLegacyEmptyWorkItem(item, behavior), false);
    assert.equal(
      isLegacyEmptyWorkItem(item, {
        ...draft,
        assets: [{ id: 'uploaded-art' }],
      }),
      false,
    );
  });
  test('entering and leaving a clean editor never invokes a draft save', async () => {
    let saves = 0;
    let guards = 0;
    sessions.publishEditorSession({
      capabilityId: 'untouched-editor',
      items: [],
      dirty: false,
      busy: false,
      save: async () => {
        saves++;
      },
      beforeLeave: () => {
        guards++;
      },
    });
    await sessions.saveBeforeNavigation();
    await sessions.saveBeforeNavigation();
    await sessions.saveBeforeReplacement('untouched-editor');
    assert.equal(saves, 0);
    assert.equal(guards, 3);
  });

  test('manifest production lines route every tool to a valid workflow', () => {
    assert.deepEqual(
      lines.map((line) => line.id),
      ['player', 'scene'],
    );
    assert.equal(lines.find((line) => line.id === 'player').href, '/player');
    assert.equal(lines.find((line) => line.id === 'scene').href, '/scene');
    for (const capability of modules) {
      assert.ok(lines.some((line) => line.id === capability.productionLine));
      assert.ok(capability.stages.length >= 2);
      assert.ok(capability.entryTitle && capability.starterHint);
    }
    assert.deepEqual(
      modules
        .filter((m) => m.productionLine === 'scene')
        .map((m) => m.id)
        .sort(),
      ['interactable-editor', 'map-stitcher', 'scene-composer'],
    );
  });
  test('prepared and unconfigured tasks never appear completed or running', () => {
    for (const status of ['prepared', 'awaiting_configuration', 'failed']) {
      assert.equal(
        taskWorkItems([task({ status })], modules)[0].state,
        'attention',
      );
    }
    assert.match(taskWorkItems([task()], modules)[0].detail, /尚未执行/);
  });
  test('sprite states distinguish saved, review, generation and actual export', () => {
    const expected = {
      created: 'saved',
      submitting: 'running',
      provider_pending: 'running',
      saving: 'running',
      review_required: 'attention',
      approved: 'saved',
      exported: 'completed',
      failed: 'attention',
      attention_required: 'attention',
      unknown: 'attention',
    };
    for (const [status, state] of Object.entries(expected)) {
      const item = spriteWorkItem(
        {
          job_id: 'job 1',
          status,
          updated_at: at,
          character_name: '主角',
          action_name: '待机',
        },
        '/tools/sprite-generator',
      );
      assert.equal(item.state, state, status);
      assert.equal(item.title, '主角 · 待机');
      assert.equal(item.href, '/tools/sprite-generator?job=job%201');
    }
  });
  test('execution attempts for one sprite merge while different sprites stay separate', () => {
    const items = taskWorkItems(
      [
        task({
          id: 'retry',
          status: 'completed',
          updatedAt: later,
          adapter: { remoteJobId: 'job-a', remoteStatus: 'review_required' },
          outputs: ['outputs/retry/result.json'],
        }),
        task({
          id: 'first',
          status: 'running',
          adapter: { remoteJobId: 'job-a', remoteStatus: 'provider_pending' },
        }),
        task({ id: 'other', adapter: { remoteJobId: 'job-b' } }),
      ],
      modules,
    );
    assert.equal(items.length, 2);
    const item = items.find((item) => item.id === 'sprite:job-a');
    assert.equal(item.state, 'attention');
    assert.deepEqual(item.taskIds, ['first', 'retry']);
    assert.deepEqual(item.outputs, ['outputs/retry/result.json']);
  });
  test('an Agent export without a local draft opens its real task and artifacts', () => {
    const [item] = taskWorkItems(
      [
        task({
          capabilityId: 'interactable-editor',
          status: 'completed',
          input: {
            project: {
              projectId: 'p1',
              objects: [{ definitionId: 'chest', displayName: '宝箱' }],
            },
          },
          outputs: ['outputs/task-1/godot.zip'],
        }),
      ],
      modules,
    );
    assert.equal(item.id, interactableItemId('p1', 'chest'));
    assert.equal(item.href, '/tools/interactable-editor?task=task-1&object=chest');
    assert.equal(item.title, '宝箱');
    assert.equal(item.state, 'completed');
  });
  test('local drafts preserve editable links and names while gathering execution outputs', () => {
    const local = {
      id: 'interactable:p1:chest',
      capabilityId: 'interactable-editor',
      title: '森林宝箱',
      detail: '本机草稿',
      state: 'saved',
      updatedAt: at,
      savedAt: at,
      href: '/tools/interactable-editor?project=p1&object=chest',
      draftKey: 'interactable-project:p1',
    };
    const remote = {
      ...local,
      title: '旧名称',
      state: 'completed',
      updatedAt: later,
      href: '/advanced?task=t1',
      draftKey: undefined,
      savedAt: undefined,
      taskIds: ['t1'],
      outputs: ['outputs/t1/godot.zip'],
    };
    const [item] = mergeWorkItems([local], [remote], [remote]);
    assert.equal(item.title, local.title);
    assert.equal(item.href, local.href);
    assert.equal(item.savedAt, at);
    assert.equal(item.state, 'completed');
    assert.deepEqual(item.outputs, remote.outputs);
    assert.deepEqual(item.taskIds, ['t1']);
    const [edited] = mergeWorkItems(
      [{ ...local, updatedAt: '2026-09-05T11:00:00.000Z' }],
      [remote],
    );
    assert.equal(
      edited.state,
      'saved',
      'editing after export must return to work in progress',
    );
  });
  test('navigation validates all editors before saving any of them', async () => {
    let saves = 0;
    sessions.publishEditorSession({
      capabilityId: 'test-map',
      items: [],
      dirty: false,
      busy: false,
      save: async () => {
        saves++;
      },
    });
    sessions.publishEditorSession({
      capabilityId: 'test-object',
      items: [],
      dirty: false,
      busy: true,
      save: async () => {
        saves++;
      },
      beforeLeave: () => {
        throw new Error('busy');
      },
    });
    await assert.rejects(sessions.saveBeforeNavigation(), /busy/);
    assert.equal(saves, 0);
  });
  test('save failures block navigation and edits during a save are flushed before leaving', async () => {
    sessions.publishEditorSession({
      capabilityId: 'test-map',
      items: [],
      dirty: true,
      busy: false,
      save: async () => {
        throw new Error('disk full');
      },
    });
    await assert.rejects(sessions.saveBeforeNavigation(), /disk full/);
    let saves = 0;
    sessions.publishEditorSession({
      capabilityId: 'test-map',
      items: [],
      dirty: true,
      busy: false,
      save: async () => {
        saves++;
        if (saves === 2) sessions.markEditorSaved('test-map');
      },
    });
    await sessions.saveBeforeNavigation();
    assert.equal(saves, 2);
    assert.equal(sessions.getEditorSessions()[0].dirty, false);
  });
  test('replacing a workspace also respects the active operation guard', async () => {
    let saves = 0;
    sessions.publishEditorSession({
      capabilityId: 'test-map',
      items: [],
      dirty: true,
      busy: true,
      save: async () => {
        saves++;
      },
      beforeLeave: () => {
        throw new Error('queue running');
      },
    });
    await assert.rejects(
      sessions.saveBeforeReplacement('test-map'),
      /queue running/,
    );
    assert.equal(saves, 0);
  });

  test('history reads older pages without losing or duplicating records', async () => {
    const { readTaskHistory } = await server.ssrLoadModule('/lib/workbench/task-history.ts');
    const source = Array.from({ length: 413 }, (_, i) => ({ id: `task-${i}` }));
    const offsets = [];
    const tasks = await readTaskHistory(async (url) => {
      const params = new URL(url, 'http://localhost').searchParams;
      const offset = Number(params.get('offset'));
      offsets.push(offset);
      assert.equal(params.get('refresh'), String(offset === 0));
      if (offset) assert.equal(params.get('snapshot'), 'stable');
      return { tasks: source.slice(offset, offset + 200), snapshot: 'stable', nextOffset: offset + 200 < source.length ? offset + 200 : null };
    });
    assert.deepEqual(offsets, [0, 200, 400]);
    assert.deepEqual(tasks, source);
    await assert.rejects(readTaskHistory(async () => ({ tasks: source.slice(0, 200) })), /重启/);
    await assert.rejects(readTaskHistory(async () => ({ tasks: [], snapshot: 'stable', nextOffset: 0 })), /分页无效/);
    let calls = 0;
    await assert.rejects(readTaskHistory(async () => ++calls === 1
      ? { tasks: source.slice(0, 200), snapshot: 'first', nextOffset: 200 }
      : { tasks: [], snapshot: 'changed', nextOffset: null }), /历史已变化/);
  });

  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } finally {
      for (const session of sessions.getEditorSessions())
        sessions.removeEditorSession(session.capabilityId);
    }
  }
  console.log(`Workbench shell: ${tests.length} tests passed.`);
} finally {
  await server.close();
}
