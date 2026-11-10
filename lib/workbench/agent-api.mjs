import { listAssets, getAsset, assetManifest, readAssetGodotPackage } from './asset-catalog.mjs';
import { assetInputs } from './asset-contract.mjs';
import { taskPresentation, nativeTask, imageEditPresentation } from './presentation.mjs';
import { previewInputs } from './preview-follow-contract.mjs';
import { documentInputs } from './document-contract.mjs';
import { documentRequest } from './editor-documents.mjs';
import { forwardDocumentRequest } from './document-client.mjs';
import { imageEditInputs } from './image-edit-contract.mjs';
import { imageEditRequest } from './image-edits.mjs';
import { sceneWorkflowInputs } from './scene-workflow-contract.mjs';
import { sceneWorkflowRequest } from './scene-workflows.mjs';
import { sceneWorkflowPresentation } from './scene-workflow-presentation.mjs';
import { forwardSceneWorkflowRequest } from './scene-workflow-client.mjs';
import { forwardImageEditRequest } from './image-edit-client.mjs';
import { sceneSplitInputs } from './scene-split-contract.mjs';
import { sceneSplitRequest } from './scene-splits.mjs';
import { frontendContext, queuePresentation } from './preview-follow.mjs';
import {
  createProject,
  createObject,
  KINDS,
  normalizeProject,
} from '../../features/interactable-editor/contract.mjs';
import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync } from 'node:fs';
import {
  readFile,
  realpath,
  stat,
  mkdir,
  open,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  findCapability,
  agentCapabilities,
  listTaskPage,
  readTask,
  repositoryRoot,
} from './runtime.mjs';
import { requestJson, bearerHeaders, endpointUrl } from './adapters/http.mjs';
import {
  resolveSpritePipelineTarget,
  createSpritePipelineLaunch,
  probeSpritePipeline,
} from './sprite-pipeline-supervisor.mjs';

import { getFrontend, startFrontend } from './frontend-service.mjs';
import { readGuidance } from './agent-guidance.mjs';

import {gameExportInputs} from './game-export-contract.mjs';
import {listGameExports,getGameExport,deliverGodotPackage,installGameExport,completeGameExport} from './game-export.mjs';

export const AGENT_API_VERSION = 1;

export async function getConversationGuidance(manifest, input = {}) {
  const guide = await readGuidance(repositoryRoot, manifest, input);
  if (guide.topic !== 'overview') return guide;
  return {
    ...guide,
    capabilityIds: agentCapabilities(manifest).map(
      (capability) => capability.id,
    ),
    manualCapabilities: manifest.capabilities
      .filter((c) => c.agent?.mode === 'manual')
      .map((c) => ({
        id: c.id,
        name: c.name,
        viewPath: c.ui.route,
        reason: c.agent.reason,
      })),
    createsTask: false,
    assetCatalog: manifest.agentAssets.assetCatalog,
    engineering: manifest.agentAssets.engineering,
    gameExport: manifest.gameExport,
    presentationPolicy: {
      reply: 'outcome-preview-next-step',
      technicalDetails: 'on-request',
      preview:
        'reuse-existing; do-not-reopen-dismissed; preserve-unsaved-edits',
      hostQuestions:
        'discover-schema-first; one-material-choice; wait-for-answer',
      navigation: 'workbench_present at step changes; frontend acknowledgement required; link-fallback',
      follow: { presentTool: 'workbench_present', contextTool: 'workbench_get_frontend_context', guide: manifest.agentAssets.presentationGuide },
    },
  };
}

async function pipelineRequest(manifest, route) {
  const { connector } = findCapability(manifest, 'sprite-generator');
  return requestJson(
    endpointUrl(process.env[connector.urlEnv] || connector.defaultUrl, route),
    {
      headers: bearerHeaders(process.env[connector.tokenEnv]),
      timeoutMs: 5000,
    },
  );
}

export async function getEnvironment(manifest) {
  const python = path.join(
    repositoryRoot,
    'Tools/SpritePipeline/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  const result = {
    agentApiVersion: AGENT_API_VERSION,
    frontend: await getFrontend(manifest),
    gameExports: await listGameExports(repositoryRoot,manifest,{pendingOnly:true,limit:5}),
    nodeVersion: process.version,
    pythonInstalled: existsSync(python),
    pipeline: { online: false, compatible: false, keyConfigured: false },
    capabilities: manifest.capabilities.map((c) => ({
      id: c.id,
      local: !c.connector.urlEnv,
    })),
    setupCommand: 'npm run sprite-pipeline:setup',
  };
  try {
    const health = await pipelineRequest(manifest, '/health');
    if (health.ok !== true || typeof health.version !== 'string')
      throw new Error('Unexpected service');
    result.pipeline.online = true;
    result.pipeline.version = health.version;
    result.pipeline.keyConfigured = health.pixellab_configured === true;
    const spec = await pipelineRequest(manifest, '/openapi.json');
    const required = [
      '/v1/presets',
      '/v1/jobs/{job_id}/candidates/{candidate_index}/check',
      '/v1/jobs/{job_id}/candidates/{candidate_index}/approve',
      '/v1/jobs/{job_id}/candidates/{candidate_index}/recover',
      '/v1/reference-art/jobs',
    ];
    const missingRoutes = required.filter((route) => !spec.paths?.[route]);
    result.pipeline = {
      online: true,
      version: health.version,
      compatible:
        missingRoutes.length === 0 &&
        health.workbench_api_version === AGENT_API_VERSION,
      missingRoutes,
      keyConfigured: health.pixellab_configured === true,
      message:
        missingRoutes.length ||
        health.workbench_api_version !== AGENT_API_VERSION
          ? '服务接口较旧，请重启 SpritePipeline 加载最新代码。'
          : '服务已就绪；Key 配置状态不代表已验证余额。',
    };
  } catch {
    result.pipeline.message = result.pipeline.online
      ? '服务在线，但接口描述不可用；请重启服务加载最新接口。'
      : '无法访问 SpritePipeline；检查服务地址或启动本地服务。';
  }
  return result;
}

export async function startServices(manifest) {
  // Only the known local pipeline may be started. No commands or paths come from callers.
  const target = resolveSpritePipelineTarget();
  if (target.mode !== 'managed' || !target.baseUrl.startsWith('http:'))
    return {
      status: 'external',
      message: '已配置外部服务，本机不会代为启动。',
      environment: await getEnvironment(manifest),
    };
  const current = await probeSpritePipeline(target, {
    token: process.env.SPRITE_PIPELINE_API_TOKEN,
  });
  if (current.state === 'ready')
    return { status: 'reused', environment: await getEnvironment(manifest) };
  if (current.state !== 'offline')
    return { status: 'blocked', message: current.reason };
  const directory = path.join(repositoryRoot, 'work/services');
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, `sprite-${target.port}.lock`);
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return {
      status: 'starting',
      message: '另一启动请求正在进行；请查询环境状态。',
      lockPath,
    };
  }
  try {
    const statePath = path.join(directory, `sprite-${target.port}.json`);
    let previous;
    try {
      previous = JSON.parse(await readFile(statePath, 'utf8'));
    } catch {}
    if (
      Number.isInteger(previous?.pid) &&
      previous.pid > 0 &&
      previous.url === target.baseUrl
    ) {
      let alive = false;
      try {
        process.kill(previous.pid, 0);
        alive = true;
      } catch {}
      if (alive)
        return {
          status: 'starting',
          pid: previous.pid,
          logPath: previous.logPath,
          message: '已有本机服务进程正在启动或需要检查日志，不重复创建进程。',
        };
    }
    const launch = createSpritePipelineLaunch(repositoryRoot, target);
    const logPath = path.join(directory, `sprite-${target.port}.log`);
    const log = openSync(logPath, 'a');
    let child;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: repositoryRoot,
        env: launch.env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log, log],
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } finally {
      closeSync(log);
    }
    child.unref();
    await writeFile(
      path.join(directory, `sprite-${target.port}.json`),
      JSON.stringify({ pid: child.pid, url: target.baseUrl, logPath }),
    );
    return {
      status: 'starting',
      pid: child.pid,
      logPath,
      message:
        '已启动本机服务，请用环境检查等待就绪。服务会在 MCP 会话关闭后继续运行。',
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function listPresets(manifest, { query = '' } = {}) {
  const result = await pipelineRequest(manifest, '/v1/presets');
  const matches = (row) =>
    `${row.id} ${row.name}`.toLowerCase().includes(query.toLowerCase());
  return {
    characters: (result.data?.characters ?? []).filter(matches),
    actions: (result.data?.actions ?? []).filter(matches),
  };
}

export async function searchTasks(
  manifest,
  { query = '', capabilityId, status, limit = 50, offset = 0, snapshot } = {},
) {
  if (capabilityId) findCapability(manifest, capabilityId);
  const page = await listTaskPage(manifest, { query, capabilityId, status, limit, offset });
  let nativeJobs = [];
  let nativeError;
  if (!capabilityId || capabilityId === 'sprite-generator') {
    try {
      const result = await pipelineRequest(manifest, '/v1/jobs');
      nativeJobs = (result.data?.jobs ?? [])
        .filter(
          (job) =>
            (!status || job.status === status) &&
            JSON.stringify(job).toLowerCase().includes(query.toLowerCase()),
        )
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || a.job_id.localeCompare(b.job_id));
    } catch {
      nativeError = '序列帧服务不可用，已返回本地工作台记录。';
    }
  }
  const currentSnapshot = createHash('sha256').update(JSON.stringify([
    page.snapshot, nativeJobs.map((j) => [j.job_id, j.updated_at, j.status]), nativeError || null,
  ])).digest('hex');
  if (snapshot && snapshot !== currentSnapshot) throw new Error('制作历史已变化，请从第一页重新查询。');
  return {
    tasks: page.tasks.map((task) => ({
      ...task,
      presentation: taskPresentation(manifest, task),
    })),
    nativeJobs: nativeJobs.slice(offset, offset + limit).map((job) => ({
      ...job,
      presentation: taskPresentation(manifest, nativeTask(job), {
        result: {
          character: { display_name: job.character_name },
          action: { display_name: job.action_name },
        },
      }),
    })),
    searchedTasks: page.searchedTasks,
    totalTasks: page.total,
    totalNativeJobs: nativeJobs.length,
    nextOffset: offset + limit < Math.max(page.total, nativeJobs.length) ? offset + limit : null,
    snapshot: currentSnapshot,
    ...(nativeError ? { nativeError } : {}),
  };
}

async function resolveArtifact(manifest, taskId, artifactPath) {
  const task = await readTask(manifest, taskId);
  if (!task.outputs.includes(artifactPath))
    throw new Error('文件未登记为该任务产物。');
  const allowed = await realpath(
    path.resolve(repositoryRoot, manifest.workspace.outputDirectory, taskId),
  );
  const outputRoot = await realpath(
    path.resolve(repositoryRoot, manifest.workspace.outputDirectory),
  );
  const taskRelative = path.relative(outputRoot, allowed);
  if (
    !taskRelative ||
    taskRelative.startsWith('..') ||
    path.isAbsolute(taskRelative)
  )
    throw new Error('任务目录越过产物根目录。');
  const resolved = await realpath(path.resolve(repositoryRoot, artifactPath));
  const relative = path.relative(allowed, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('产物越过任务目录边界。');
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('产物不是文件。');
  return { resolved, info };
}

export async function getTaskResult(
  manifest,
  { taskId, jobId, candidateIndex, detail = false },
) {
  if (Boolean(taskId) === Boolean(jobId))
    throw new Error('Provide exactly one of taskId or jobId.');
  if (jobId) {
    const response = await pipelineRequest(
      manifest,
      `/v1/jobs/${encodeURIComponent(jobId)}`,
    );
    const job = response.data?.job;
    if (!job || job.job_id !== jobId) throw new Error('所选动画任务无法读取。');
    if (
      candidateIndex !== undefined &&
      !job.candidates?.some((c) => c.candidate_index === candidateIndex)
    )
      throw new Error('所选动画候选不存在；请重新选择。');
    const presentation = taskPresentation(manifest, nativeTask(job), {
      result: job,
      candidateIndex,
    });
    return {
      jobId,
      detailIncluded: detail,
      status: job.status,
      result: job,
      artifacts: [],
      viewPath: presentation.viewPath,
      presentation,
    };
  }
  const task = await readTask(manifest, taskId);
  const artifacts = [];
  for (const artifactPath of task.outputs) {
    try {
      const { resolved, info } = await resolveArtifact(
        manifest,
        taskId,
        artifactPath,
      );
      artifacts.push({
        path: artifactPath,
        absolutePath: resolved,
        bytes: info.size,
        kind: /\.(png|gif|webp|jpg)$/i.test(artifactPath) ? 'image' : 'file',
      });
    } catch {
      artifacts.push({ path: artifactPath, missing: true });
    }
  }
  const resultPath = task.outputs.find((p) => p.endsWith('/result.json'));
  let result = null;
  if (resultPath && !artifacts.find((a) => a.path === resultPath)?.missing) {
    const { resolved, info } = await resolveArtifact(
      manifest,
      taskId,
      resultPath,
    );
    if (info.size > 8 * 1024 * 1024)
      throw new Error('结果记录过大，请读取任务摘要。');
    result = JSON.parse(await readFile(resolved, 'utf8'));
  }
  if (candidateIndex !== undefined) {
    if (task.capabilityId !== 'sprite-generator')
      throw new Error('candidateIndex only applies to sprite tasks.');
    if (!result?.candidates?.some((c) => c.candidateIndex === candidateIndex))
      throw new Error('所选动画候选不存在；请先刷新原任务。');
  }
  const presentation = taskPresentation(manifest, task, {
    result,
    artifacts,
    candidateIndex,
  });
  return {
    taskId,
    detailIncluded: detail,
    status: task.status,
    operation: task.input.operation,
    result,
    artifacts,
    outputsVerified: artifacts.every((item) => !item.missing),
    ...(task.error ? { error: task.error } : {}),
    viewPath: presentation.viewPath,
    presentation,
  };
}

export async function readArtifact(manifest, { taskId, artifactPath }) {
  const { resolved, info } = await resolveArtifact(
    manifest,
    taskId,
    artifactPath,
  );
  if (info.size > 40 * 1024 * 1024)
    throw new Error('产物超过预览大小限制，请使用返回的文件路径。');
  const buffer = await readFile(resolved);
  const ext = path.extname(resolved).toLowerCase();
  if (['.png', '.webp', '.jpg', '.jpeg', '.gif'].includes(ext)) {
    // Preview only. Original export bytes remain unchanged.
    const preview = await sharp(buffer, { limitInputPixels: 64_000_000 })
      .resize({
        width: 1024,
        height: 1024,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: 'nearest',
      })
      .png()
      .toBuffer();
    return {
      taskId,
      artifactPath,
      absolutePath: resolved,
      mimeType: 'image/png',
      previewNote:
        ext === '.gif'
          ? 'GIF 首帧预览；审核动作需读取 orderedFrames 中的逐帧 PNG。'
          : '预览可能缩小；原文件保持不变。',
      imageBase64: preview.toString('base64'),
    };
  }
  if (ext === '.json' && buffer.length <= 8 * 1024 * 1024)
    return { taskId, artifactPath, value: JSON.parse(buffer.toString('utf8')) };
  return {
    taskId,
    artifactPath,
    absolutePath: resolved,
    bytes: info.size,
    message: '交付文件，请使用此路径下载或打开。',
  };
}

export function interactableTemplate(
  manifest,
  { kind = 'inspect', name } = {},
) {
  if (!KINDS.includes(kind)) throw new Error('Unknown interactable kind.');
  const project = createProject();
  const object = createObject(kind);
  if (name) {
    project.name = name;
    object.displayName = name;
  }
  project.objects = [object];
  return {
    project: normalizeProject(project),
    createsTask: false,
    viewPath: findCapability(manifest, 'interactable-editor').ui.route,
    next: 'Edit the project to match the requested behavior and supplied assets, then run save-project. Export only when requested. No artwork is generated by this template.',
  };
}

// The same handlers are consumed by MCP, CLI and the HTTP bridge.
export async function agentRequest(manifest, operation, input = {}, { previewSessionId, documentAuthority = false } = {}) {
  if (Object.hasOwn(sceneSplitInputs, operation)) {
    return documentAuthority ? sceneSplitRequest(repositoryRoot, manifest, operation, input) : forwardImageEditRequest(operation, input, sceneSplitInputs);
  }
  if (Object.hasOwn(sceneWorkflowInputs, operation)) {
    const value = await (documentAuthority ? sceneWorkflowRequest(repositoryRoot, manifest, operation, input) : forwardSceneWorkflowRequest(operation, input));
    return value.work ? { ...value, presentation: sceneWorkflowPresentation(manifest, value.work) } : value;
  }
  if (Object.hasOwn(imageEditInputs, operation)) {
    const value = await (documentAuthority ? imageEditRequest(repositoryRoot, manifest, operation, input) : forwardImageEditRequest(operation, input));
    return value.edit ? { ...value, presentation: imageEditPresentation(manifest, value.edit, value.candidateVersion || input.candidateVersion) } : value;
  }
  if (Object.hasOwn(documentInputs, operation)) {
    return documentAuthority ? documentRequest(repositoryRoot, manifest, operation, input, { agent: true }) : forwardDocumentRequest(operation, input);
  }
  if (Object.hasOwn(gameExportInputs,operation)) {
    const parsed=gameExportInputs[operation].parse(input);
    if(operation==='export-to-game') {
      const pack=await readAssetGodotPackage(manifest,parsed);
      return deliverGodotPackage(repositoryRoot,manifest,{...pack,projectPath:parsed.projectPath});
    }
    return ({'game-exports':listGameExports,'game-export':getGameExport,'install-game-export':installGameExport,'complete-game-export':completeGameExport})[operation](repositoryRoot,manifest,parsed);
  }
  if (operation === 'frontend-context') return frontendContext(repositoryRoot, manifest, { ...previewInputs[operation].parse(input), sessionId: previewSessionId });
  if (operation === 'present') {
    const selection = previewInputs.present.parse(input);
    const keys = ['taskId', 'jobId', 'assetId', 'capabilityId', 'editId', 'sceneWorkflowId'].filter((key) => selection[key]);
    if (keys.length !== 1) throw new Error('Provide exactly one taskId, jobId, assetId, editId, sceneWorkflowId or capabilityId.');
    if (selection.candidateIndex && !selection.taskId && !selection.jobId) throw new Error('candidateIndex requires taskId or jobId.');
    if (selection.candidateVersion && !selection.editId) throw new Error('candidateVersion requires editId.');
    let presentation;
    if (selection.sceneWorkflowId) {
      presentation = (await agentRequest(manifest, 'scene-workflow-get', { workId: selection.sceneWorkflowId }, { documentAuthority })).presentation;
    } else if (selection.editId) {
      const value = await agentRequest(manifest, 'image-session-get', { editId: selection.editId, ...(selection.candidateVersion ? { candidateVersion: selection.candidateVersion } : {}) }, { documentAuthority });
      if (selection.candidateVersion && selection.candidateVersion !== 'source' && !value.edit.candidates.some(candidate => candidate.version === selection.candidateVersion)) throw new Error('Unknown image edit candidate.');
      presentation = imageEditPresentation(manifest, value.edit, selection.candidateVersion);
    } else if (selection.capabilityId) {
      const editorModule = [...manifest.capabilities, ...manifest.editorModules].find((m) => m.id === selection.capabilityId);
      if (!editorModule?.ui?.route) throw new Error('Unknown editor module.');
      presentation = { title: editorModule.name, viewPath: editorModule.ui.route, state: 'ready', summary: '准备在此工具继续当前工作。' };
    } else if (selection.assetId) {
      const { asset } = await getAsset(manifest, { assetId: selection.assetId });
      presentation = { title: asset.title, viewPath: ['animation', 'interactable', 'prop', 'character'].includes(asset.kind) && asset.editorPath ? asset.editorPath : asset.viewPath, state: asset.status, summary: '查看所选作品。' };
    } else {
      presentation = (await getTaskResult(manifest, selection)).presentation;
    }
    return { ...(await queuePresentation(repositoryRoot, manifest, presentation, { sessionId: previewSessionId })),
      viewUrl: new URL(presentation.viewPath, manifest.workspace.frontend.url).href,
      createsTask: false, next: 'Check workbench_get_frontend_context with requestId. Only displayed confirms page arrival; it does not prove artwork loading or visual review. Never force paused/blocked pages or reopen dismissed previews.' };
  }
  const assetHandlers = {
    assets: listAssets,
    asset: getAsset,
    'asset-manifest': assetManifest,
  };
  if (Object.hasOwn(assetHandlers, operation))
    return assetHandlers[operation](
      manifest,
      assetInputs[operation].parse(input),
    );
  const handlers = {
    guidance: getConversationGuidance,
    'interactable-template': interactableTemplate,
    environment: getEnvironment,
    start: startServices,
    frontend: startFrontend,
    presets: listPresets,
    tasks: searchTasks,
    result: getTaskResult,
    artifact: readArtifact,
  };
  if (!Object.hasOwn(handlers, operation))
    throw new Error('Unknown agent operation.');
  const allowed = {
    guidance: ['topic'],
    'interactable-template': ['kind', 'name'],
    environment: [],
    start: [],
    frontend: [],
    presets: ['query'],
    tasks: ['query', 'capabilityId', 'status', 'limit', 'offset', 'snapshot'],
    result: ['taskId', 'jobId', 'candidateIndex', 'detail'],
    artifact: ['taskId', 'artifactPath'],
  }[operation];
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw new Error('Invalid agent operation input.');
  for (const [key, value] of Object.entries(input)) {
    if (
      key === 'detail'
        ? typeof value !== 'boolean'
        : key === 'offset'
          ? !Number.isSafeInteger(value) || value < 0
        : ['limit', 'candidateIndex'].includes(key)
          ? !Number.isInteger(value) ||
            value < 1 ||
            value > (key === 'limit' ? 200 : 1000)
          : typeof value !== 'string' || value.length > 2000
    )
      throw new Error(`Invalid ${key}.`);
  }
  if (operation === 'artifact' && !input.taskId)
    throw new Error('taskId is required.');
  if (operation === 'artifact' && !input.artifactPath)
    throw new Error('artifactPath is required.');
  return handlers[operation](manifest, input);
}
