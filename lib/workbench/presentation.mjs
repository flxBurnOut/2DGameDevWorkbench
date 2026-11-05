// Read-only presentation shared by MCP, HTTP and CLI. No task creation or browser side effects.
export function imageEditViewPath(manifest, target, editId, candidateVersion) {
  const query = new URLSearchParams({ imageEdit: editId });
  if (candidateVersion) query.set('imageCandidate', candidateVersion);
  let route;
  if (target.kind === 'map-layer') { route = manifest.capabilities.find(c => c.id === 'map-stitcher')?.ui?.route; query.set('map', target.projectId); }
  else if (target.kind === 'interactable') { route = manifest.capabilities.find(c => c.id === 'interactable-editor')?.ui?.route; query.set('document', target.documentId); query.set('object', target.definitionId); }
  else if (['scene-layer','scene-instance','scene-split-part'].includes(target.kind)) { route = manifest.editorModules.find(c => c.id === 'scene-composer')?.ui?.route; query.set('document', target.documentId); }
  else if (target.kind === 'image-task') { route = manifest.agentAssets.assetCatalog.route; query.set('asset', `image:${target.taskId}`); }
  return route ? `${route}?${query}` : null;
}
export function imageEditPresentation(manifest, edit, candidateVersion) {
  const candidate = edit.candidates.find(item => item.version === candidateVersion) || (!candidateVersion ? edit.candidates.at(-1) : null);
  const selected = candidateVersion || candidate?.version || 'source';
  const viewPath = imageEditViewPath(manifest, edit.target.targetRef, edit.editId, selected);
  return { title: edit.target.name || '局部调整', state: candidate?.status || 'editing', summary: candidate?.status === 'completed' ? '局部候选已保存并检查；采用是独立步骤，请查看会话采用记录。' : candidate ? '读取同一编辑会话和任务；关闭页面不会取消请求。' : '查看已保存的图片编辑会话。', viewPath, viewUrl: viewPath ? new URL(viewPath, manifest.workspace.frontend.url).href : null, actions: viewPath ? [{ kind: 'open', label: '查看局部调整', viewPath }] : [] };
}
export function taskViewPath(manifest, task, result = null, candidateIndex) {
  if (task.capabilityId === 'image-assets' && task.imageEditContext) {
    const { target, editId, candidateVersion } = task.imageEditContext;
    return imageEditViewPath(manifest, target, editId, candidateVersion);
  }
  const route = manifest.capabilities.find((c) => c.id === task.capabilityId)
    ?.ui?.route;
  if (!route) return null;
  const query = new URLSearchParams();
  if (task.capabilityId === 'sprite-generator') {
    const work = task.adapter?.openWorkId || task.input?.openWorkId || result?.openWorkId || result?.jobRecord?.request?.open_plan?.work_id;
    if (work) {
      const version = task.adapter?.openWorkRevision || result?.work?.revision || result?.jobRecord?.request?.open_plan?.revision;
      const selected = candidateIndex ?? task.input?.candidateIndex;
      return `${route}?work=${encodeURIComponent(work)}${version ? `&version=${version}` : ''}${Number.isInteger(selected) ? `&candidate=${selected}` : ''}`;
    }
    const job = task.adapter?.remoteJobId || task.input?.jobId || result?.jobId;
    if (!job) return `/advanced?task=${encodeURIComponent(task.id)}`;
    query.set('job', job);
    const candidate = candidateIndex ?? task.input?.candidateIndex;
    if (Number.isInteger(candidate) && candidate > 0)
      query.set('candidate', String(candidate));
  } else if (task.capabilityId === 'image-assets') {
    const kind = result?.kind || (task.input?.operation === 'generate-prop' ? 'prop' : task.input?.kind || 'background');
    const target = manifest.capabilities.find((c) => c.id === (kind === 'prop' ? 'interactable-editor' : 'map-stitcher'))?.ui?.route;
    return target ? `${target}?imageTask=${encodeURIComponent(task.id)}` : null;
  } else if (task.capabilityId === 'reference-art') {
    if (task.input?.subject === 'prop') {
      const propRoute = manifest.capabilities.find((c) => c.id === 'interactable-editor')?.ui?.route;
      return propRoute ? `${propRoute}?artTask=${encodeURIComponent(task.id)}` : null;
    }
    query.set('task', task.input?.sourceTaskId || task.id);
  } else {
    query.set('task', task.id);
  }
  return `${route}?${query}`;
}

export function taskPresentation(
  manifest,
  task,
  { result = null, artifacts = [], candidateIndex } = {},
) {
  const operation = task.input?.operation;
  const nativeStatus = task.adapter?.remoteStatus || result?.remoteStatus;
  result = result?.jobRecord
    ? {
        ...result,
        character: result.jobRecord.character,
        action: result.jobRecord.action,
      }
    : result;
  const title =
    result?.work?.plan?.title || result?.work?.spec?.description?.slice(0, 80) ||
    task.input?.name ||
    task.input?.project?.name ||
    (result?.character?.display_name &&
      `${result.character.display_name} · ${result.action?.display_name || result.action?.action_id || '动作'}`) ||
    manifest.capabilities.find((c) => c.id === task.capabilityId)?.name ||
    '作品';
  let state = task.status;
  let summary =
    {
      prepared: '输入已准备，尚未执行。',
      running: '正在处理，可继续查看进度。',
      awaiting_configuration: '需要先完成服务或 API 配置。',
      failed: '本次操作未完成，请查看原因后继续。',
      attention_required: '这份作品需要检查或处理。',
      completed: '本次操作已完成。',
    }[state] || '请查看作品当前状态。';
  if (state === 'completed' && operation === 'create') {
    state = 'saved';
    summary = '作业已保存，尚未生成动画。';
  }
  if (state === 'completed' && operation === 'save-project') {
    state = 'saved';
    summary = '交互物项目已保存，可以继续编辑；尚未导出。';
  }
  if (state === 'completed' && operation === 'transfer')
    summary = '原图已移送为角色，可继续选择动作；尚未生成动画。';
  if (
    state === 'completed' &&
    task.capabilityId === 'reference-art' &&
    operation === 'generate'
  )
    summary = task.input?.subject === 'prop'
      ? '物品原图已保存，可在交互物编辑器预览并采用；尚未配置交互行为或导出。'
      : '角色原图已保存，可以预览或用于制作动作。';
  if (state === 'completed' && task.capabilityId === 'reference-art' && operation === 'import')
    summary = '参考图已本地导入，提示词为补充展示描述；未调用生图 API。';
  if (state === 'completed' && task.capabilityId === 'image-assets')
    summary = (result?.kind || (operation === 'generate-prop' ? 'prop' : task.input?.kind)) === 'prop'
      ? '透明物品候选已保存，可在交互物编辑器检查并采用；尚未配置交互行为。'
      : '背景候选已保存，可在地图编辑器检查并采用；尚未配置地图碰撞或组装场景。';
  if (state === 'completed' && task.capabilityId === 'image-assets' && operation === 'process-image')
    summary = `本地处理版本已保存，原图保留，未调用图片API。${summary}`;
  if (task.capabilityId === 'image-assets' && task.imageEditContext && state === 'completed')
    summary = `${operation === 'process-image' ? '本地处理版本' : '局部修改候选'}已保存；在原编辑会话检查并定点采用。`;
  if (
    !['prepared', 'awaiting_configuration', 'failed'].includes(task.status) &&
    task.capabilityId === 'sprite-generator'
  ) {
    const labels = {
      created: ['saved', '作业已保存，等待生成。'],
      review_required: ['attention_required', '动画已生成，等待播放检查。'],
      approved: ['saved', '动画已通过检查，可以导出。'],
      exported: ['completed', '动画素材已导出。'],
      attention_required: [
        'attention_required',
        '动画需要处理，请查看原任务。',
      ],
      failed: ['attention_required', '动画需要处理，请查看原任务。'],
    };
    if (labels[nativeStatus]) [state, summary] = labels[nativeStatus];
    if (task.status === 'running') {
      state = 'running';
      summary = '动画正在生成或检查，可继续查看进度。';
    }
  }
  if (task.capabilityId === 'sprite-generator' && result?.pendingCheckpoints?.length) {
    state = 'attention_required';
    summary = '当前片段已保存，请检查实际姿势、装备和节奏，确认后继续下一段。';
  }
  if (task.capabilityId === 'sprite-generator' && result?.work && !result.work.job) {
    const planned = {
      planning: ['running', '正在制定制作方案，尚未提交动画生成。'],
      ready: ['saved', '制作方案已保存，请确认后开始制作。'],
      needs_input: ['attention_required', '方案有待确认的要求，请补充后继续。'],
      planning_failed: ['attention_required', '本次规划未完成，记录已保留；未自动重复调用。'],
      budget_exhausted: ['attention_required', '规划调用已到上限，已有提案已保留；尚未生成动画。'],
    };
    if (planned[result.work.status]) [state, summary] = planned[result.work.status];
  }
  if (task.status === 'failed') {
    const error = typeof task.error === 'string' ? task.error : '';
    if (/401|403|API.?Key|credential|密钥/i.test(error))
      summary = '图片服务未接受当前配置，请在工具设置中检查 Key 和模型权限。';
    else if (/429|quota|balance|额度|余额/i.test(error))
      summary = '图片服务额度或请求频率受限，请查看账户用量后再继续。';
    else if (/timeout|fetch failed|ECONN|offline|超时|未连接/i.test(error))
      summary =
        '服务连接中断或超时，请先查看原任务是否已有结果，避免重复生成。';
  }
  const missing = artifacts.some((a) => a.missing);
  if (missing) {
    state = 'attention_required';
    summary = '部分产物无法读取，请检查文件位置；不会自动重新生成。';
  }
  const viewPath = taskViewPath(manifest, task, result, candidateIndex);
  const actions = viewPath
    ? [
        {
          kind: 'open',
          label:
            state === 'running'
              ? '查看进度'
              : state === 'awaiting_configuration'
                ? '打开配置所在工具'
                : '查看作品',
          viewPath,
        },
      ]
    : [];
  if (
    task.capabilityId === 'reference-art' &&
    operation === 'transfer' &&
    task.status === 'completed' &&
    result?.characterId
  ) {
    const route = manifest.capabilities.find((c) => c.id === 'sprite-generator')
      ?.ui.route;
    if (route)
      actions.unshift({
        kind: 'open',
        label: '选择角色动作',
        viewPath: `${route}?character=${encodeURIComponent(result.characterId)}`,
      });
  }
  const image = (
    candidateIndex === undefined ||
    candidateIndex === task.input?.candidateIndex
      ? artifacts
      : []
  ).find((a) => !a.missing && /(?:preview\.gif|reference\.png|\/image\.png)$/.test(a.path));
  return {
    title,
    state,
    summary,
    viewPath,
    viewUrl: viewPath
      ? new URL(viewPath, manifest.workspace.frontend.url).href
      : null,
    actions,
    ...(image
      ? {
          preview: {
            kind: image.path.endsWith('.gif') ? 'animation' : 'image',
            url: `/api/workbench/artifacts?path=${encodeURIComponent(image.path)}`,
            artifactPath: image.path,
          },
        }
      : {}),
    ...(task.error
      ? {
          issue: {
            summary:
              '本次操作未完成。请查看详情，保留当前作品；生成结果不明时不要重新提交。',
            detail: task.error,
          },
        }
      : {}),
    detailsPath: task.id
      ? `/advanced?task=${encodeURIComponent(task.id)}`
      : null,
    browserOpened: false,
  };
}

export function nativeTask(job) {
  return {
    id: null,
    capabilityId: 'sprite-generator',
    status: ['submitting', 'provider_pending', 'saving'].includes(job.status)
      ? 'running'
      : 'completed',
    input: { operation: 'get' },
    adapter: { remoteJobId: job.job_id, remoteStatus: job.status },
  };
}

function compactPresentation(presentation) {
  return {
    ...presentation,
    ...(presentation?.issue
      ? { issue: { summary: presentation.issue.summary } }
      : {}),
  };
}

export function mcpContent(name, value) {
  // Scene clients need the frozen plan/revision and review evidence for their
  // next guarded operation, even when the host only exposes text content.
  if (value.work && name.includes('scene_workflow')) return JSON.stringify(value);
  if (name === 'workbench_get_asset_manifest')
    return JSON.stringify({
      summary: value.summary,
      manifest: value.manifest,
      createsTask: false,
    });
  if (name === 'workbench_get_asset') return JSON.stringify(value);
  if (name === 'workbench_list_assets') return JSON.stringify(value);
  // Keep machine data in structuredContent; routine chat receives only the actionable projection.
  if (value.detailIncluded) return JSON.stringify(value);
  if (value.presentation)
    return JSON.stringify({
      ...(value.taskId || value.task?.id
        ? { taskId: value.taskId || value.task.id }
        : {}),
      ...(value.jobId ? { jobId: value.jobId } : {}),
      status: value.status || value.task?.status,
      presentation: compactPresentation(value.presentation),
      ...(value.frontendPresentation ? { frontendPresentation: value.frontendPresentation } : {}),
      ...(value.preview ? { preview: value.preview } : {}),
      ...(value.refreshError
        ? {
            issue:
              '暂时无法刷新，这是上次保存的状态；请检查服务连接后继续查询原任务。',
          }
        : {}),
      next: 'Use workbench_present at step/selection changes, then check workbench_get_frontend_context for page acknowledgement. After arming, run/get_task automatically publish steps through frontendPresentation. Pending is not displayed. Respect paused/blocked states. Tell the user the outcome and next step; keep IDs, paths and diagnostic details out of routine replies. To read full artifacts and review evidence in text-only clients, call workbench_get_result with detail:true.',
    });
  if (name === 'workbench_list_tasks')
    return JSON.stringify({
      matches: [
        ...(value.tasks || []).map((t) => ({
          taskId: t.id,
          ...compactPresentation(t.presentation),
        })),
        ...(value.nativeJobs || []).map((j) => ({
          jobId: j.job_id,
          ...compactPresentation(j.presentation),
        })),
      ],
      searchedRecentTasks: value.searchedRecentTasks,
      ...(value.nativeError ? { issue: value.nativeError } : {}),
      next: 'Choose by user intent and title; if ambiguous, ask with the available host question tool. Browsing creates no tasks.',
    });
  if (
    name === 'workbench_get_environment' ||
    name === 'workbench_start_frontend' ||
    name === 'workbench_start_services'
  )
    return JSON.stringify(value);
  return JSON.stringify(value);
}
