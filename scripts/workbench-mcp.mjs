#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { assetInputs, assetTools } from '../lib/workbench/asset-contract.mjs';
import { documentInputs, documentTools } from '../lib/workbench/document-contract.mjs';
import { imageEditInputs, imageEditTools } from '../lib/workbench/image-edit-contract.mjs';
import { sceneSplitInputs, sceneSplitTools } from '../lib/workbench/scene-split-contract.mjs';
import { sceneWorkflowInputs, sceneWorkflowTools } from '../lib/workbench/scene-workflow-contract.mjs';
import { sceneWorkflowPath } from '../lib/workbench/scene-workflow-presentation.mjs';
import { mcpContent } from '../lib/workbench/presentation.mjs';
import { previewInputs, previewTools } from '../lib/workbench/preview-follow-contract.mjs';
import { WorkBuddyPreview } from '../lib/workbench/workbuddy-preview.mjs';
import { guidanceTopics } from '../lib/workbench/agent-guidance.mjs';
import { queuePresentation } from '../lib/workbench/preview-follow.mjs';
import { KINDS } from '../features/interactable-editor/contract.mjs';

import {
  repositoryRoot,
  agentRequest,
  findAgentCapability,
  agentCapabilities,
  loadManifest,
  prepareTask,
  publicCapability,
  refreshTask,
  runConnector,
  summarizeTask,
} from '../lib/workbench/runtime.mjs';

import {gameExportInputs,gameExportTools} from '../lib/workbench/game-export-contract.mjs';

const server = new McpServer(
  {
    name: '2d-game-workbench',
    version: '0.12.1',
  },
  {
    instructions: [
      'Forge provides asset production, versioned editing and Godot delivery. Discover an unfamiliar capability and its schema; reuse confirmed schemas during the session.',
      'list_capabilities returns a short overview and topic index. Read workbench_get_guidance(topic) only for the current task; production and engineering are workflow routers.',
      'Continue within the user\'s existing scope and budget, including delegated inspection and selection. Ask for unresolved consequential choices or scope changes. Read-only discussion creates no production task; prepare_task optionally saves input validation for authorized work.',
      'Poll the original task/job. Resolve unknown paid submissions using their saved receipts and provider IDs before a new attempt. Shared editing uses current version/hash guards and stable commandId.',
      'On the first WorkBuddy user message, check workbench_get_environment; start offline frontend services once, poll readiness for at most 60 seconds and stop on conflicts. Follow guidance topic presentation for host opening. WorkBuddy requires a visible preview for this session before production: discover the host present_files schema, open preview.hostAction and confirm the session page. preview_required creates no task or provider call; continue with the same parameters after connecting. Use previewPolicy only for an explicit user refusal/dismissal or verified host-tool failure. Use workbench_present at step/selection changes and workbench_get_frontend_context to confirm arrival. Respect paused, closed and unsaved pages. Other clients remain headless unless they present. Page acknowledgement confirms arrival, not artwork quality.',
      'Direct map-stitcher adapter operations remain outside MCP. Scene-workflow tools support bounded map creation/extension only under their explicit frozen policy and quotas; read scene-collaboration guidance first. Explicit webpage requests can use available host browser tools. Report actual assets, checks and target-engine evidence with appropriate detail.',
    ].join(' '),
  },
);

function success(value, name) {
  if (value.plan?.previewPng) {
    const {previewPng,localPreviewPng,softReferencePreviewPng,...plan}=value.plan;
    const images=[{role:'writable-area',data:previewPng,mimeType:'image/png'}];
    if (softReferencePreviewPng) images.push({role:plan.softReference.kind==='rgb'?'rgb-control':'diffuse-shading',data:softReferencePreviewPng,mimeType:'image/png'});
    if (localPreviewPng) images.push({role:'clean-crop',data:localPreviewPng,mimeType:'image/png'});
    return success({...value,plan,images},name);
  }
  if (value.analysis?.previews) {
    const {previews,...analysis}=value.analysis;
    const images=Object.entries(previews).map(([role,data])=>({role,data,mimeType:'image/png'}));
    return success({...value,analysis,images},name);
  }
  if(value.check?.views?.some(view=>view.png)){
    const views=value.check.views;
    return success({...value,check:{...value.check,views:views.map(({png:_png,...metadata})=>metadata)},
      images:views.map(view=>({role:view.role,data:view.png,mimeType:'image/png'}))},name);
  }
  if (value.part?.views?.some(view => view.png)) {
    const { views, suggestion, ...context } = value.part;
    const images = views.map(view => ({ role: view.role, data: view.png, mimeType: 'image/png' }));
    const { previewPng, ...fields } = suggestion ?? {};
    if (previewPng) images.push({ role: 'suggested-scope', data: previewPng, mimeType: 'image/png' });
    const part = { ...context, views: views.map(({ png: _png, ...view }) => view), ...(suggestion ? { suggestion: fields } : {}) };
    return success({ ...value, part, images }, name);
  }
  if (Array.isArray(value.images) && value.images.some(image => image.data)) {
    const metadata = { ...value, images: value.images.map(({ data: _data, ...image }) => image) };
    return { content: [{ type: 'text', text: mcpContent(name, metadata) }, ...value.images.filter(image => image.data).map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }))], structuredContent: metadata };
  }
  return {
    content: [{ type: 'text', text: mcpContent(name, value) }],
    structuredContent: value,
  };
}

function failure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: message.match(/^Task ([a-z0-9_-]+) failed:/i)
          ? JSON.stringify({
              summary:
                '本次操作未完成。请读取原任务的错误和已有结果，避免重复生成。',
              taskId: message.match(/^Task ([a-z0-9_-]+) failed:/i)[1],
              nextTool: 'workbench_get_result',
            })
          : message,
      },
    ],
    structuredContent: {
      error: {
        message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.status ? { status: error.status } : {}),
        ...(error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}),
        ...(message.match(/^Task ([a-z0-9_-]+) failed:/i)
          ? {
              taskId: message.match(/^Task ([a-z0-9_-]+) failed:/i)[1],
              recovery:
                'Read this task and its existing remoteJobId before taking further action; do not blindly regenerate.',
            }
          : {}),
      },
    },
  };
}

const workbuddyPreview = new WorkBuddyPreview(repositoryRoot, () => server.server.getClientVersion()?.name);
const sceneOperations = new Map(sceneWorkflowTools.map(([name, operation]) => [name, operation]));
const sceneProduction = new Set(['scene-workflow-create', 'scene-workflow-execute', 'scene-workflow-revise', 'scene-workflow-resume', 'scene-workflow-adopt']);
const sceneFollowing = new Set([...sceneProduction, 'scene-workflow-get', 'scene-workflow-pause']);
const previewPolicySchema = z.enum(['auto', 'user-declined', 'user-dismissed', 'host-unavailable']).optional().describe('WorkBuddy preview exception only for an explicit user choice or verified unavailable host tool. Omit normally. This does not change the production request identity.');
let following = false;
async function followResult(value) {
  if (!following || !value.presentation?.viewPath) return value;
  try {
    return { ...value, frontendPresentation: await queuePresentation(repositoryRoot, await loadManifest(), { ...value.presentation, viewPath: value.presentation.actions?.[0]?.viewPath || value.presentation.viewPath }, { sessionId: workbuddyPreview.enabled ? workbuddyPreview.sessionId : undefined }) };
  } catch {
    // Presentation failures never turn an already-submitted production operation into a retry.
    return { ...value, frontendPresentation: { state: 'unavailable', displayed: false, browserOpened: false } };
  }
}
function registerTool(name, options, handler) {
  server.registerTool(name, options, async (input) => {
    try {
      const sceneOperation = sceneOperations.get(name);
      if (workbuddyPreview.enabled && name === 'workbench_prepare_map_split' && input.mode === 'vision') {
        workbuddyPreview.configure(input.previewPolicy);
        const blocked = await workbuddyPreview.beforeRun(await loadManifest(), `/tools/scene-composer?document=${encodeURIComponent(input.documentId)}`);
        if (blocked) return success(blocked, name);
      }
      if (sceneProduction.has(sceneOperation) && workbuddyPreview.enabled) {
        workbuddyPreview.configure(input.previewPolicy);
        const manifest = await loadManifest();
        const route = sceneOperation === 'scene-workflow-create'
          ? sceneWorkflowPath(manifest, input.spec.documentId)
          : (await agentRequest(manifest, 'scene-workflow-get', { workId: input.workId })).presentation.viewPath;
        const blocked = await workbuddyPreview.beforeRun(manifest, route);
        if (blocked) return success({ ...blocked, next: `Complete preview.next, then call ${name} with the same parameters. No task or provider call was created by this blocked request.` }, name);
        following = !workbuddyPreview.disabledReason;
      }
      if (name === 'workbench_run_task' && workbuddyPreview.enabled) {
        workbuddyPreview.configure(input.previewPolicy);
        const manifest = await loadManifest();
        const capability = findAgentCapability(manifest, input.capabilityId);
        const blocked = await workbuddyPreview.beforeRun(manifest, capability.ui.route);
        if (blocked) return success(blocked, name);
        following = !workbuddyPreview.disabledReason;
      }
      if (workbuddyPreview.enabled && (name === 'workbench_request_candidate_check' || name === 'workbench_request_part_suggestion' || (name === 'workbench_edit_image_region' && input.operation?.type === 'ai-edit'))) {
        workbuddyPreview.configure(input.previewPolicy);
        const manifest = await loadManifest();
        let targetId = input.targetId;
        if (name === 'workbench_request_part_suggestion') targetId = (await agentRequest(manifest, 'image-part-get', {partRef:input.partRef})).part.targetId;
        if (name === 'workbench_request_candidate_check') targetId = (await agentRequest(manifest,'image-critic-get',{reviewRef:input.reviewRef})).check.targetId;
        const target = await agentRequest(manifest, 'image-inspect', targetId ? { targetId } : { target: input.target });
        const kind = target.target.targetRef.kind;
        const moduleId = kind === 'interactable' ? 'interactable-editor' : ['scene-layer', 'scene-instance','scene-split-part'].includes(kind) ? 'scene-composer' : 'map-stitcher';
        const route = kind === 'image-task' ? manifest.agentAssets.assetCatalog.route : [...manifest.capabilities, ...manifest.editorModules].find(module => module.id === moduleId)?.ui?.route;
        const blocked = await workbuddyPreview.beforeRun(manifest, route || '/');
        if (blocked) return success(blocked, name);
        following = !workbuddyPreview.disabledReason;
      }
      let value = await handler(input);
      if (sceneFollowing.has(sceneOperation) || ['workbench_run_task', 'workbench_get_task', 'workbench_edit_image_region', 'workbench_get_image_edit'].includes(name)) value = await followResult(value);
      if (sceneFollowing.has(sceneOperation) || ['workbench_list_capabilities','workbench_describe_capability','workbench_present','workbench_run_task','workbench_get_task','workbench_get_frontend_context','workbench_edit_image_region','workbench_get_image_edit'].includes(name)) {
        value = await workbuddyPreview.decorate(await loadManifest(), value, value.frontendPresentation?.viewPath || value.presentation?.actions?.[0]?.viewPath || value.presentation?.viewPath || value.viewPath || value.capability?.ui?.route || '/');
      }
      if (value.imageBase64 || value.edit?.pixels?.imageBase64 || value.edit?.comparison) {
        const { imageBase64, ...metadata } = value;
        const images = imageBase64 ? [{ data: imageBase64, mimeType: value.imageMimeType || 'image/png' }] : [];
        if (value.edit?.pixels?.imageBase64) {
          const { imageBase64: candidateImage, ...pixels } = value.edit.pixels;
          metadata.edit = { ...value.edit, pixels };
          images.push({ data: candidateImage, mimeType: value.edit.pixels.imageMimeType || 'image/png' });
        }
        if (value.edit?.comparison) {
          const { beforePng, afterPng, ...comparison } = value.edit.comparison;
          metadata.edit = { ...metadata.edit, comparison };
          images.push({ data: beforePng, mimeType: 'image/png' }, { data: afterPng, mimeType: 'image/png' });
        }
        const result = success(metadata, name);
        result.content.push(...images.map(image => ({ type: 'image', ...image })));
        return result;
      }
      return success(value, name);
    } catch (error) {
      const response = failure(error);
      const taskId = response.structuredContent.error.taskId;
      if (following && taskId && name === 'workbench_run_task') {
        try {
          const failed = await followResult(await agentRequest(await loadManifest(), 'result', { taskId }));
          response.structuredContent.frontendPresentation = failed.frontendPresentation;
          response.content.push({ type: 'text', text: JSON.stringify({ frontendPresentation: failed.frontendPresentation }) });
        } catch { /* The original operation error is authoritative. */ }
      }
      return response;
    }
  });
}

registerTool(
  'workbench_list_capabilities',
  {
    title: 'List 2D workbench capabilities',
    description:
      'List registered production capabilities, a short workflow overview and the on-demand guidance topic index.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const manifest = await loadManifest();
    return {
      capabilities: agentCapabilities(manifest).map(publicCapability),
      conversationGuidance: await agentRequest(manifest, 'guidance'),
    };
  },
);

registerTool(
  'workbench_get_guidance',
  {
    title: 'Read a workbench guidance topic',
    description: 'Read one registered workflow or reference without creating tasks or contacting a provider. Omit topic for the overview and topic index.',
    inputSchema: { topic: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional().describe('Topic ID returned by list_capabilities, or overview.') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async input => agentRequest(await loadManifest(), 'guidance', input),
);

registerTool(
  'workbench_describe_capability',
  {
    title: 'Describe a 2D workbench capability',
    description:
      'Read the full input schema, connector contract, workflow path, and output types for one registered capability.',
    inputSchema: {
      capabilityId: z.string().min(1).describe('Registered capability ID.'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ capabilityId }) => {
    const manifest = await loadManifest();
    return { capability: findAgentCapability(manifest, capabilityId),
      guidanceTopics: guidanceTopics(manifest).filter(topic => topic.capabilityId === capabilityId) };
  },
);

const taskInputSchema = {
  capabilityId: z.string().min(1).describe('Registered capability ID.'),
  input: z
    .record(z.string(), z.unknown())
    .describe('Input object matching the capability input schema.'),
};

registerTool(
  'workbench_prepare_task',
  {
    title: 'Prepare a 2D workbench task',
    description:
      'Validate a request and write a local task record without running its adapter or calling an external service.',
    inputSchema: taskInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ capabilityId, input }) => {
    const manifest = await loadManifest();
    const capability = findAgentCapability(manifest, capabilityId);
    const execution = await prepareTask(manifest, capability, input);
    return {
      ...summarizeTask(execution),
      presentation: (
        await agentRequest(manifest, 'result', { taskId: execution.task.id })
      ).presentation,
    };
  },
);

registerTool(
  'workbench_run_task',
  {
    title: 'Run a 2D workbench task',
    description:
      'Run an authorized operation. In WorkBuddy, first open preview.hostAction with the host-native present_files tool and confirm this session is visible. preview_required means NO task or provider call was created. Once connected, progress follows automatically. previewPolicy may disable presentation only for an explicit user choice or verified host-tool failure. Unconfigured providers return awaiting_configuration.',
    inputSchema: { ...taskInputSchema, previewPolicy: z.enum(['auto','user-declined','user-dismissed','host-unavailable']).optional().describe('WorkBuddy preview exception only: preserve a user opt-out/dismissal, or report a verified host-tool failure. Omit normally. This is not a way to skip tool discovery.') },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ capabilityId, input }) => {
    const manifest = await loadManifest();
    const capability = findAgentCapability(manifest, capabilityId);
    const execution = await runConnector(manifest, capability, input);
    return {
      ...summarizeTask(execution),
      presentation: (
        await agentRequest(manifest, 'result', { taskId: execution.task.id })
      ).presentation,
    };
  },
);

registerTool(
  'workbench_get_task',
  {
    title: 'Get a 2D workbench task',
    description:
      'Read a workbench task. If its adapter job is still running, poll that existing job once and persist the refreshed status and artifacts without starting new generation.',
    inputSchema: {
      taskId: z.string().min(1).describe('Task ID returned by this server.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ taskId }) => {
    const manifest = await loadManifest();
    const refreshed = await refreshTask(manifest, taskId);
    return {
      task: refreshed.task,
      presentation: (await agentRequest(manifest, 'result', { taskId }))
        .presentation,
      ...(refreshed.refreshError
        ? { refreshError: refreshed.refreshError }
        : {}),
    };
  },
);

const discoveryTools = [
  [
    'workbench_interactable_template',
    'interactable-template',
    'Return a complete editable interactable project template without writing a task. Choose inspect, toggle, pickup or sequence; preserve returned IDs while editing. Save with save-project, open get_result.viewPath for frontend editing, and export-godot only when requested.',
    {
      kind: z.enum(KINDS).optional(),
      name: z.string().min(1).max(200).optional(),
    },
  ],
  [
    'workbench_start_frontend',
    'frontend',
    'Start or reuse the local frontend and runtime bridge without generation, installing dependencies, or opening a browser. Query get_environment until frontend.ready, then let WorkBuddy call the host-native present_files using the returned session-specific preview.hostAction.arguments. Stop if blocked.',
    {},
  ],
  [
    'workbench_get_environment',
    'environment',
    'Check installed runtime, live service compatibility and saved PixelLab key status; no generation or balance request.',
    {},
  ],
  [
    'workbench_start_services',
    'start',
    'Start only the configured local SpritePipeline if offline; reuse existing services. Never installs dependencies or generates assets. Poll get_environment until ready.',
    {},
  ],
  [
    'workbench_list_presets',
    'presets',
    'Discover actual character and action IDs. Search by ID or display name; never invent preset IDs.',
    { query: z.string().max(2000).optional() },
  ],
  [
    'workbench_list_tasks',
    'tasks',
    'Search all unarchived workbench tasks and native SpritePipeline jobs before pagination. Follow nextOffset with snapshot for older history. Native jobs use job_id, not workbench taskId. Archiving history does not remove assets.',
    {
      query: z.string().max(2000).optional(),
      capabilityId: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).optional(),
      snapshot: z.string().max(2000).optional(),
    },
  ],
  [
    'workbench_get_result',
    'result',
    'Read a workbench taskId OR a native sprite jobId (exactly one). Optional candidateIndex selects an existing candidate. Returns a concise presentation and exact viewUrl plus structured results. Does not refresh, generate, create tasks or open a browser.',
    {
      taskId: z.string().min(1).optional(),
      jobId: z.string().min(1).max(200).optional(),
      candidateIndex: z.number().int().min(1).max(1000).optional(),
      detail: z
        .boolean()
        .optional()
        .describe(
          'Return full technical JSON in text content for clients without structuredContent; use for frame review or debugging.',
        ),
    },
  ],
  [
    'workbench_read_artifact',
    'artifact',
    'Read only a registered task artifact. Returns PNG image content for visual inspection. GIF preview is its first frame: inspect orderedFrames to assess motion before approval.',
    { taskId: z.string().min(1), artifactPath: z.string().min(1) },
  ],
];
for (const [name,operation,description] of gameExportTools) {
  registerTool(name,{description,inputSchema:gameExportInputs[operation].shape,annotations:{readOnlyHint:['game-exports','game-export'].includes(operation),destructiveHint:false,idempotentHint:true,openWorldHint:false}},async input=>agentRequest(await loadManifest(),operation,input));
}
for (const [name, operation, description] of sceneWorkflowTools) {
  registerTool(name, { description, inputSchema: { ...sceneWorkflowInputs[operation].shape, ...(sceneProduction.has(operation) ? { previewPolicy: previewPolicySchema } : {}) },
    annotations: { readOnlyHint: ['scene-workflow-list', 'scene-workflow-get', 'scene-workflow-observe'].includes(operation), destructiveHint: false, idempotentHint: true,
      openWorldHint: ['scene-workflow-create', 'scene-workflow-execute', 'scene-workflow-revise', 'scene-workflow-resume'].includes(operation) } },
  async input => {
    const { previewPolicy: _previewPolicy, ...request } = input;
    return agentRequest(await loadManifest(), operation, request);
  });
}
registerTool('workbench_get_scene_workflow_settings', { description: 'Read scene expert model profiles and credential readiness only; no model call or key values.', inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  async () => agentRequest(await loadManifest(), 'scene-workflow-settings', {}));
for (const [name, operation, description] of documentTools) {
  registerTool(name, { description, inputSchema: documentInputs[operation].shape, annotations: { readOnlyHint: ['documents', 'document-get', 'document-observe', 'document-validate', 'document-simulate'].includes(operation), destructiveHint: false, idempotentHint: operation !== 'document-export', openWorldHint: false } }, async input => agentRequest(await loadManifest(), operation, input));
}
for (const [name, operation, description] of imageEditTools) {
  registerTool(name, { description, inputSchema: imageEditInputs[operation].shape, annotations: { readOnlyHint: ['image-inspect', 'image-session-get', 'image-panel-suggest', 'image-plan-get', 'image-analysis-get', 'image-part-get', 'image-critic-get'].includes(operation), destructiveHint: false, idempotentHint: true, openWorldHint: ['image-edit', 'image-part-suggest', 'image-critic-run'].includes(operation) } }, async input => agentRequest(await loadManifest(), operation, input));
}
for (const [name, operation, description] of sceneSplitTools) {
  const inputSchema = { ...sceneSplitInputs[operation].shape, ...(operation === 'scene-split-prepare' ? {previewPolicy:previewPolicySchema} : {}) };
  registerTool(name, {description,inputSchema,annotations:{readOnlyHint:['scene-split-get','scene-split-inspect'].includes(operation),destructiveHint:false,idempotentHint:true,openWorldHint:operation==='scene-split-prepare'}},
    async ({previewPolicy: _policy,...input}) => agentRequest(await loadManifest(),operation,input));
}
for (const [name, operation, description] of previewTools) {
  registerTool(name, {
    description, inputSchema: previewInputs[operation].shape,
    annotations: { readOnlyHint: operation !== 'present', destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    const result = await agentRequest(await loadManifest(), operation, input, { previewSessionId: workbuddyPreview.enabled ? workbuddyPreview.sessionId : undefined });
    if (operation === 'present') following = true;
    return result;
  });
}
for (const [name, operation, description] of assetTools) {
  registerTool(
    name,
    {
      description,
      inputSchema: assetInputs[operation].shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => agentRequest(await loadManifest(), operation, input),
  );
}

for (const [name, operation, description, inputSchema] of discoveryTools) {
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: {
        readOnlyHint: !['start', 'frontend'].includes(operation),
        destructiveHint: false,
        idempotentHint: operation !== 'interactable-template',
        openWorldHint: ['environment', 'presets', 'tasks'].includes(operation),
      },
    },
    async (input) => {
      try {
        let value = await agentRequest(
          await loadManifest(),
          operation,
          input,
        );
        if (['workbench_get_environment','workbench_start_frontend','workbench_get_result'].includes(name)) value = await workbuddyPreview.decorate(await loadManifest(), value, value.presentation?.actions?.[0]?.viewPath || value.presentation?.viewPath || '/');
        if (value.imageBase64) {
          const { imageBase64, ...metadata } = value;
          const result = success(metadata, name);
          result.content.push({
            type: 'image',
            data: imageBase64,
            mimeType: 'image/png',
          });
          return result;
        }
        return success(value, name);
      } catch (error) {
        return failure(error);
      }
    },
  );
}

server.registerResource(
  'workbench-manifest',
  'workbench://manifest',
  {
    title: '2D Game Dev Workbench manifest',
    description:
      'Canonical capability catalog shared by the visual console, CLI, and agent clients.',
    mimeType: 'application/json',
  },
  async () => {
    const manifest = await loadManifest();
    return {
      contents: [
        {
          uri: 'workbench://manifest',
          mimeType: 'application/json',
          text: JSON.stringify(manifest, null, 2),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('2D Game Dev Workbench MCP server ready on stdio.');
