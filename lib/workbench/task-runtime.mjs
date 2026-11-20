import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';

import {
  adapterConfigured,
  executeAdapter,
  refreshAdapter,
  validateAdapterInput,
} from './adapters/index.mjs';
import { writeAtomicSnapshot } from './atomic-snapshot.mjs';
import { getPublicImageGenerationSettings } from './image-generation-settings.mjs';
import { imageTargetRefSchema } from './image-edit-contract.mjs';
import { taskPresentation } from './presentation.mjs';
import { mapTaskRecords, readTaskAtVersion, readTaskSummaries, writeTaskSummary } from './task-history-index.mjs';
import { recoverTaskPublication, saveTaskPublication } from './task-publication.mjs';

import { findCapability, repositoryRoot } from './workbench-manifest.mjs';
export { agentCapabilities, findAgentCapability, findCapability, loadManifest, manifestPath, repositoryRoot } from './workbench-manifest.mjs';

function valueMatchesType(value, expectedType) {
  if (Array.isArray(expectedType)) return expectedType.some(type => valueMatchesType(value, type));
  if (expectedType === 'null') return value === null;
  if (expectedType === 'array') return Array.isArray(value);
  if (expectedType === 'integer') return Number.isInteger(value);
  if (expectedType === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expectedType === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === expectedType;
}

function canonicalJson(value) {
  const sort = item => Array.isArray(item) ? item.map(sort) :
    item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Evaluate the manifest's JSON Schema vocabulary at every level, including
// restriction-only subschemas inside conditions and alternatives.
function schemaErrors(schema, value, name) {
  if (schema === true) return [];
  if (schema === false) return [`Forbidden field: ${name}`];
  if (schema.type && !valueMatchesType(value, schema.type)) return [`${name} must be ${schema.type}.`];
  const errors = [];
  if (valueMatchesType(value, 'object')) {
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) errors.push(`Missing required field: ${name}.${required}`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.propertyNames) errors.push(...schemaErrors(schema.propertyNames, key, `${name} key ${key}`));
      const defined = schema.properties && Object.hasOwn(schema.properties, key);
      if (!defined && schema.additionalProperties === false) errors.push(`Unknown field: ${name}.${key}`);
      const definition = defined ? schema.properties[key] : schema.additionalProperties;
      if (definition !== undefined && (defined || definition !== false)) errors.push(...schemaErrors(definition, child, `${name}.${key}`));
    }
  }
  if ((Object.hasOwn(schema, 'const') && canonicalJson(schema.const) !== canonicalJson(value)) ||
      (schema.enum && !schema.enum.some(item => canonicalJson(item) === canonicalJson(value)))) errors.push(`${name} is not an allowed value.`);
  if (typeof value === 'string') {
    // JSON Schema counts Unicode code points. Keep large ASCII image inputs cheap.
    const length = /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(value) ? Array.from(value).length : value.length;
    if ((schema.minLength !== undefined && length < schema.minLength) ||
        (schema.maxLength !== undefined && length > schema.maxLength) ||
        (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))) errors.push(`${name} has an invalid format or length.`);
  }
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) ||
      (schema.maximum !== undefined && value > schema.maximum))) errors.push(`${name} is outside its allowed range.`);
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) ||
        (schema.maxItems !== undefined && value.length > schema.maxItems)) errors.push(`${name} has an invalid item count.`);
    if (schema.uniqueItems && new Set(value.map(canonicalJson)).size !== value.length) errors.push(`${name} must not contain duplicates.`);
    if (schema.items !== undefined) value.forEach((child, index) => errors.push(...schemaErrors(schema.items, child, `${name}[${index}]`)));
  }
  for (const clause of schema.allOf || []) errors.push(...schemaErrors(clause, value, name));
  if (schema.anyOf && !schema.anyOf.some(clause => schemaErrors(clause, value, name).length === 0))
    errors.push(`${name} does not match any allowed structure.`);
  if (schema.if) {
    const branch = schemaErrors(schema.if, value, name).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...schemaErrors(branch, value, name));
  }
  return errors;
}

export function validateInput(capability, input) {
  if (!valueMatchesType(input, 'object')) return ['Input must be a JSON object.'];
  const errors = schemaErrors(capability.inputSchema, input, 'input');
  return errors.length ? errors : validateAdapterInput(capability, input);
}

function createTaskId(capabilityId) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  return `${capabilityId}-${timestamp}-${suffix}`;
}

function taskFilePath(manifest, taskId) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(taskId)) throw new Error('Task ID contains unsupported characters.');
  return path.resolve(repositoryRoot, manifest.workspace.taskDirectory, `${taskId}.json`);
}

// A local database per task provides an OS-released writer lock across the
// bridge, MCP and CLI. The task JSON remains the authority for all data.
// SQLite's synchronous calls are non-blocking on contention; wait in JS.
async function withTaskLock(manifest, taskId, operation) {
  const taskPath = taskFilePath(manifest, taskId);
  const directory = path.join(path.dirname(taskPath), '.locks');
  await mkdir(directory, { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const lock = new DatabaseSync(path.join(directory, `${taskId.toLowerCase()}.sqlite`));
  const deadline = Date.now() + 30_000;
  try {
    while (true) {
      try {
        lock.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if (error.errcode !== 5) throw error;
        if (Date.now() >= deadline) throw Object.assign(new Error('The original task is busy. Poll its existing identity.'), { code: 'TASK_BUSY', status: 409, taskId });
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    return await operation();
  } finally { lock.close(); }
}

export const commandIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;

export function commandTaskId(commandId) {
  if (typeof commandId !== 'string' || !commandIdPattern.test(commandId))
    throw Object.assign(new Error('commandId must be 1–200 letters, digits, underscores, dots, colons or hyphens, starting with a letter or digit.'), { status: 400, code: 'INVALID_COMMAND_ID' });
  return `command-${hash(commandId).slice(0, 32)}`;
}

export async function persistTask(manifest, task) {
  const directory = path.resolve(repositoryRoot, manifest.workspace.taskDirectory);
  await mkdir(directory, { recursive: true });
  const taskPath = taskFilePath(manifest, task.id);
  const info = await writeAtomicSnapshot(taskPath, `${JSON.stringify(task, null, 2)}\n`, { observe: true });
  await writeTaskSummary(taskPath, info, task, historyIndexOptions);
  return projectRelative(taskPath);
}

export function publicCapability(capability) {
  const connector = capability.connector;
  const imageGeneration = Array.isArray(connector.providers) || connector.providerSource
    ? getPublicImageGenerationSettings(connector)
    : null;
  return {
    id: capability.id,
    name: capability.name,
    description: capability.description,
    connector: {
      type: connector.type,
      adapter: connector.adapter,
      configured: adapterConfigured(capability),
      ...(connector.urlEnv ? { urlEnv: connector.urlEnv } : {}),
      ...(imageGeneration
        ? {
            providers: imageGeneration.providers,
            externalGenerationConfigured: imageGeneration.providers.some((provider) => provider.configured),
            activeGenerationProvider: imageGeneration.active ? imageGeneration.provider : null,
          }
        : {}),
    },
    requiredInputs: capability.inputSchema.required ?? [],
    outputs: capability.outputs,
  };
}

function validateTaskInput(capability, input) {
  const errors = validateInput(capability, input);
  if (errors.length > 0) throw new Error(`Input validation failed:\n- ${errors.join('\n- ')}`);
}

export async function prepareTask(manifest, capability, input, status = 'prepared', imageEditContext) {
  validateTaskInput(capability, input);
  return createTask(manifest, capability, input, { status, imageEditContext });
}

async function createTask(manifest, capability, input, { status = 'prepared', imageEditContext, command, id, claim = false } = {}) {
  const now = new Date().toISOString();
  if (imageEditContext && (capability.id !== 'image-assets' || Object.keys(imageEditContext).some(key => !['editId', 'candidateVersion', 'target'].includes(key)) || typeof imageEditContext.editId !== 'string' || typeof imageEditContext.candidateVersion !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(imageEditContext.editId) || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(imageEditContext.candidateVersion))) throw new Error('Invalid internal image editing task context.');
  const task = {
    schemaVersion: 1,
    id: id ?? (command ? commandTaskId(command.id) : createTaskId(capability.id)),
    capabilityId: capability.id,
    status,
    createdAt: now,
    updatedAt: now,
    input,
    outputs: [],
    ...(command ? { command } : {}),
    ...(imageEditContext ? { imageEditContext: { editId: imageEditContext.editId, candidateVersion: imageEditContext.candidateVersion, target: imageTargetRefSchema.parse(imageEditContext.target) } } : {}),
  };
  if (claim) claimExecution(task);
  const taskPath = await persistTask(manifest, task);
  return { task, taskPath };
}

const fingerprintTaskInput = task => hash(canonicalJson({ capabilityId: task.capabilityId, input: task.input }));
const taskRequestSha256 = task => task.execution?.requestSha256 || task.command?.requestSha256 || fingerprintTaskInput(task);

function claimExecution(task) {
  const now = new Date().toISOString();
  task.status = 'running';
  task.updatedAt = now;
  task.submissionPid = process.pid;
  delete task.error;
  delete task.presentation;
  delete task.adapter;
  task.execution = {
    version: 1, taskId: task.id, requestSha256: taskRequestSha256(task), phase: 'preparing',
    owner: { pid: process.pid, token: randomUUID(), claimedAt: now },
  };
}

async function checkpointExecution(manifest, task, phase, adapter) {
  const next = { ...task, execution: { ...task.execution, phase }, ...(adapter ? { adapter } : {}) };
  await persistTask(manifest, next);
  Object.assign(task, next);
}

async function commandTask(manifest, capability, input, options, run) {
  const { commandId } = options;
  const taskId = commandTaskId(commandId);
  const requestSha256 = hash(canonicalJson({ capabilityId: capability.id, input }));
  return withTaskLock(manifest, taskId, async () => {
    let previous = await readTask(manifest, taskId).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (previous && (previous.command?.id !== commandId || previous.command?.requestSha256 !== requestSha256))
      throw Object.assign(new Error('commandId was already used with a different task request.'), { code: 'COMMAND_ID_REUSED', status: 409, taskId });
    const taskPath = projectRelative(taskFilePath(manifest, taskId));
    if (previous && !run) return { task: previous, taskPath, replayed: true };
    if (previous && previous.status !== 'prepared') {
      const refreshed = await refreshTaskOnce(manifest, taskId);
      if (refreshed.task.status !== 'prepared') return { ...refreshed, replayed: true };
      previous = refreshed.task;
    }
    if (previous && (fingerprintTaskInput(previous) !== requestSha256 ||
      (options.imageEditContext && canonicalJson(previous.imageEditContext) !== canonicalJson(options.imageEditContext))))
      throw Object.assign(new Error('Prepared task no longer matches the original request.'), { code: 'COMMAND_ID_REUSED', status: 409, taskId });
    if (!previous) validateTaskInput(capability, input);
    const record = await withTaskLock(manifest, 'workbench-history', async () => {
      if (!previous) return createTask(manifest, capability, input, {
        command: { id: commandId, requestSha256 }, imageEditContext: options.imageEditContext, claim: run,
      });
      claimExecution(previous);
      await persistTask(manifest, previous);
      return { task: previous, taskPath };
    });
    if (!run) return record;
    return { ...await executeConnector(manifest, capability, record, options), ...(previous ? { replayed: true } : {}) };
  });
}

export function prepareAgentTask(manifest, capability, input, options = {}) {
  if (options.commandId === undefined) return prepareTask(manifest, capability, input);
  return commandTask(manifest, capability, input, options, false);
}

export async function runConnector(manifest, capability, input, options = {}) {
  if (options.commandId !== undefined) return commandTask(manifest, capability, input, options, true);
  validateTaskInput(capability, input);
  const id = createTaskId(capability.id);
  return withTaskLock(manifest, id, async () => {
    const record = await withTaskLock(manifest, 'workbench-history', () => createTask(manifest, capability, input, {
      id, claim: true, imageEditContext: options.imageEditContext,
    }));
    return executeConnector(manifest, capability, record, options);
  });
}

function executeConnector(manifest, capability, record, options) {
  if (capability.connector.type === 'local-adapter') {
    return runLocalAdapter(manifest, capability, record, options);
  }
  if (options.onPrepared) throw new Error('Durable submission hooks require a local adapter.');
  return runHttpConnector(manifest, capability, record);
}

const backgroundExecutions = new Map();

function atomicJson(file, value) {
  return writeAtomicSnapshot(file, `${JSON.stringify(value, null, 2)}\n`);
}

const leaseFile = outputDirectory => path.join(outputDirectory, '.background-lease.json');
const writeBackgroundLease = (outputDirectory, token) => atomicJson(leaseFile(outputDirectory), { token, pid: process.pid, heartbeatAt: Date.now() });

const guardedSubmission = (task) =>
  task.capabilityId === 'image-assets' && task.input.operation !== 'process-image' ||
  task.capabilityId === 'reference-art' && task.input.operation === 'generate' ||
  task.capabilityId === 'sprite-generator' && ['create', 'create-and-generate', 'generate-existing', 'plan-motion', 'revise-motion', 'generate-motion'].includes(task.input.operation);

class TaskPublicationError extends Error {}
class TaskClaimLost extends Error {}

function publicationFailure(task, taskPath, cause) {
  const message = '本地任务发布待核验。刷新会核对发布记录并恢复通过校验的原有产物。';
  return { task: { ...task, status: 'attention_required', derivedState: true,
    execution: { ...task.execution, phase: 'publication_pending' }, error: message }, taskPath, refreshError: cause.message };
}

function finishTaskExecution(next, execution) {
  if (!next.execution || typeof execution.deferred === 'function') return;
  const unknown = next.status === 'attention_required' && (execution.submissionUnknown || next.adapter?.nativeLookupPending || next.adapter?.nativeSubmissionPending);
  const phase = next.status === 'running' || unknown ? 'awaiting_receipt' :
    next.status === 'not_submitted' || next.status === 'awaiting_configuration' ? 'not_submitted' : 'finished';
  const { owner: _owner, ...identity } = next.execution;
  next.execution = { ...identity, phase };
}

async function runLocalAdapter(manifest, capability, { task: claimed, taskPath }, options) {
  let task = claimed;
  let background = false;
  const outputDirectory = path.resolve(repositoryRoot, manifest.workspace.outputDirectory, task.id);
  const asBackgroundOwner = operation => withTaskLock(manifest, task.id, async () => {
    const current = await readTask(manifest, task.id);
    if (current.execution?.owner?.token !== task.execution?.owner?.token) throw new TaskClaimLost('Task is owned by a different executor.');
    return operation();
  });
  try {
    await mkdir(outputDirectory, { recursive: true });
    // The caller records this identity durably before any adapter can submit.
    // A failed hook aborts execution; retrying the caller never creates a new task.
    await options.onPrepared?.({ task, taskPath });
    if (!guardedSubmission(task)) await checkpointExecution(manifest, task, 'working');
    const execution = await executeAdapter(capability, {
      manifest,
      input: task.input,
      task,
      repositoryRoot,
      outputDirectory,
      saveAdapter: adapter => checkpointAdapter(manifest, task, adapter),
      beginSubmission: adapter => {
        const save = () => checkpointExecution(manifest, task, 'submitting', adapter);
        return background ? asBackgroundOwner(save) : save();
      },
    });
    if (typeof execution.deferred === 'function') {
      const token = task.execution.owner.token;
      await writeBackgroundLease(outputDirectory, token);
      execution.adapter = { ...execution.adapter, backgroundExecution: true, backgroundPid: process.pid, backgroundToken: token, backgroundExpiresAt: Date.now() + 600_000 };
    }
    const initial = await applyAdapterExecution(
      manifest,
      task,
      taskPath,
      outputDirectory,
      execution,
    );
    if (typeof execution.deferred === 'function') {
      const key = taskFilePath(manifest, task.id);
      // Persist the identity before a paid submission. Polling never submits again.
      const snapshot = structuredClone(initial);
      task = initial.task;
      background = true;
      let leaseWrites = Promise.resolve();
      const heartbeat = setInterval(() => {
        leaseWrites = leaseWrites.then(() => writeBackgroundLease(outputDirectory, execution.adapter.backgroundToken)).catch(() => undefined);
      }, 5000);
      heartbeat.unref();
      const pending = Promise.resolve().then(execution.deferred).then(async final => {
        clearInterval(heartbeat);
        await leaseWrites;
        await asBackgroundOwner(() => applyAdapterExecution(manifest, task, taskPath, outputDirectory, final));
      }).catch(async error => {
        if (error instanceof TaskPublicationError || error instanceof TaskClaimLost) return;
        const code = typeof error?.code === 'string' && /^E[A-Z]+$/.test(error.code) ? ` (${error.code})` : '';
        await asBackgroundOwner(() => applyAdapterExecution(manifest, task, taskPath, outputDirectory, {
          status: 'attention_required',
          adapter: task.adapter,
          submissionUnknown: task.execution?.phase === 'submitting',
          error: `后台图片任务中断${code}，提交结果可能未知。请检查现有任务产物与服务商记录；不会自动重新提交。`,
        }));
      }).finally(() => { clearInterval(heartbeat); backgroundExecutions.delete(key); });
      backgroundExecutions.set(key, pending);
      // Keep persistence failures handled even if the original HTTP client disconnects.
      pending.catch(() => undefined);
      return snapshot;
    }
    return initial;
  } catch (error) {
    if (error instanceof TaskPublicationError) return publicationFailure(task, taskPath, error);
    if (task.adapter?.materializationPending)
      return saveMaterializationFailure(manifest, task, taskPath, error);
    if (task.execution?.phase === 'submitting' && (error.status === undefined || error.status >= 500)) {
      return applyAdapterExecution(manifest, task, taskPath, outputDirectory, {
        status: 'attention_required', submissionUnknown: true,
        error: '提交响应未收到。刷新此任务可核对原请求和上游记录。',
      });
    }
    if (task.adapter) {
      delete task.adapter.nativeLookupPending;
      delete task.adapter.nativeSubmissionPending;
    }
    task.status = 'failed';
    delete task.submissionPid;
    task.updatedAt = new Date().toISOString();
    task.error = error instanceof Error ? error.message : String(error);
    finishTaskExecution(task, {});
    await persistTask(manifest, task);
    throw Object.assign(new Error(`Task ${task.id} failed: ${task.error}`), { taskId: task.id });
  }
}

async function runHttpConnector(manifest, capability, { task, taskPath }) {
  const url = process.env[capability.connector.urlEnv];
  if (!url) {
    return applyAdapterExecution(manifest, task, taskPath, repositoryRoot, {
      status: 'awaiting_configuration', requiredEnvironment: capability.connector.urlEnv,
    });
  }
  const token = capability.connector.tokenEnv ? process.env[capability.connector.tokenEnv] : undefined;
  const outputDirectory = path.resolve(repositoryRoot, manifest.workspace.outputDirectory, task.id);
  try {
    await mkdir(outputDirectory, { recursive: true });
    await checkpointExecution(manifest, task, 'submitting');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ taskId: task.id, capabilityId: capability.id, input: task.input }),
    });
    const responseText = await response.text();
    let responseBody;
    try {
      responseBody = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseBody = { text: responseText };
    }
    if (!response.ok) throw Object.assign(new Error(`Connector returned HTTP ${response.status}: ${response.statusText}`), { status: response.status });
    return await applyAdapterExecution(manifest, task, taskPath, outputDirectory, { status: 'completed', result: responseBody });
  } catch (error) {
    if (error instanceof TaskPublicationError) return publicationFailure(task, taskPath, error);
    if (task.execution?.phase === 'submitting' && (error.status === undefined || error.status >= 500))
      return applyAdapterExecution(manifest, task, taskPath, outputDirectory, {
        status: 'attention_required', submissionUnknown: true, error: '提交响应未收到。请核对原请求和上游记录。',
      });
    task.status = 'failed';
    delete task.submissionPid;
    task.updatedAt = new Date().toISOString();
    task.error = error instanceof Error ? error.message : String(error);
    finishTaskExecution(task, {});
    await persistTask(manifest, task);
    throw Object.assign(new Error(`Task ${task.id} failed: ${task.error}`), { taskId: task.id });
  }
}

function normalizeLegacyReferenceRejection(task) {
  // Older gateways wrapped these explicit submit-time rejections in HTTP 502.
  // Preserve raw history and only derive the state when no receipt or output exists.
  if (task?.capabilityId === 'reference-art' && task.input?.operation === 'generate' &&
      task.status === 'failed' && task.outputs?.length === 0 && !task.adapter?.referenceJobId && !task.adapter?.referenceUsage &&
      /^Adapter returned HTTP 502: PixelLab (?:额度不足。|当前任务过多，请稍后再试。|Key 无效。)$/.test(task.error || ''))
    return { ...task, status: 'not_submitted' };
  return task;
}

export async function readTask(manifest, taskId) {
  try {
    return normalizeLegacyReferenceRejection(JSON.parse(await readFile(taskFilePath(manifest, taskId), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw Object.assign(new Error('Task record was not found.'), { code: 'ENOENT', status: 404, taskId });
  }
}

const pendingRefreshes = new Map();
export async function refreshTask(manifest, taskId) {
  const key = taskFilePath(manifest, taskId);
  if (pendingRefreshes.has(key)) return pendingRefreshes.get(key);
  const pending = withTaskLock(manifest, taskId, () => refreshTaskOnce(manifest, taskId));
  pendingRefreshes.set(key, pending);
  try { return await pending; }
  finally { if (pendingRefreshes.get(key) === pending) pendingRefreshes.delete(key); }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function backgroundAlive(manifest, task) {
  if (backgroundExecutions.has(taskFilePath(manifest, task.id))) return true;
  const { backgroundPid, backgroundExpiresAt, backgroundToken } = task.adapter;
  if (!processAlive(backgroundPid) || !(backgroundExpiresAt > Date.now())) return false;
  const outputDirectory = path.resolve(repositoryRoot, manifest.workspace.outputDirectory, task.id);
  const lease = await readFile(leaseFile(outputDirectory), 'utf8').then(JSON.parse).catch(() => null);
  return Boolean(lease && lease.token === backgroundToken && lease.pid === backgroundPid && lease.heartbeatAt > Date.now() - 20_000);
}

function needsRefresh(task) {
  return task && (task.status === 'running' || task.adapter?.materializationPending || task.adapter?.nativeLookupPending || task.adapter?.nativeSubmissionPending ||
    (task.status === 'attention_required' && task.adapter?.referenceStage === 'checking_receipt') ||
    legacyNativeSubmission(task) ||
    (task.status === 'attention_required' && !task.error &&
      task.capabilityId === 'sprite-generator' && task.adapter?.openWorkId && !task.adapter.adjustmentId));
}

function legacyNativeSubmission(task) {
  return task.status === 'failed' && !task.execution && task.capabilityId === 'sprite-generator' &&
    task.input?.operation === 'create-and-generate' && Boolean(task.adapter?.remoteJobId && task.command?.requestSha256) &&
    task.outputs?.length === 0 && /(?:fetch failed|timed out|socket hang up|response closed|terminated)/i.test(task.error || '');
}

const pendingNativeIdentity = task => task.adapter?.nativeLookupPending || task.adapter?.nativeSubmissionPending ||
  task.adapter?.referenceRequestId || task.adapter?.referenceJobId || task.adapter?.materializationPending;

async function refreshTaskOnce(manifest, taskId) {
  const task = await readTask(manifest, taskId);
  const taskPath = projectRelative(taskFilePath(manifest, taskId));
  if (!needsRefresh(task)) return { task, taskPath };
  const outputDirectory = path.resolve(repositoryRoot, manifest.workspace.outputDirectory, task.id);
  try {
    const published = await recoverTaskPublication(repositoryRoot, outputDirectory, task, () => fingerprintTaskInput(task));
    if (published) {
      await persistTask(manifest, published);
      return { task: published, taskPath };
    }
  } catch (error) {
    return publicationFailure(task, taskPath, error);
  }

  const execution = task.execution?.taskId === task.id ? task.execution : undefined;
  if (task.adapter?.backgroundExecution) {
    if (await backgroundAlive(manifest, task)) return { task, taskPath };
  }
  if (execution?.phase === 'preparing') {
    // An expired heartbeat is insufficient to reclaim a preflight writer that still owns the files.
    if (task.adapter?.backgroundExecution && processAlive(task.adapter.backgroundPid))
      return { task: { ...task, status: 'attention_required', derivedState: true,
        error: '执行进程仍存活，但准备阶段的心跳已过期。请查询原任务。' }, taskPath };
    const prepared = { ...task, status: 'prepared', updatedAt: new Date().toISOString(),
      execution: { version: execution.version, taskId, requestSha256: execution.requestSha256, phase: 'prepared' } };
    delete prepared.submissionPid;
    delete prepared.adapter;
    delete prepared.presentation;
    await persistTask(manifest, prepared);
    return { task: prepared, taskPath };
  }
  if (task.adapter?.backgroundExecution) {
    // Preserve the durable attempt and leave a late completion to its owner.
    return { task: {
      ...task, status: 'attention_required', derivedState: true,
      ...(execution ? { execution: { ...execution, phase: 'awaiting_receipt' } } : {}),
      error: '图片任务的执行进程已退出或等待已超时，提交结果可能未知。请检查已有产物与服务商记录；不会自动重新提交。',
    }, taskPath };
  }
  if (!pendingNativeIdentity(task) && (execution?.owner ||
      (task.submissionPid && !task.adapter && !processAlive(task.submissionPid)) ||
      (task.status === 'running' && !task.adapter && task.capabilityId === 'image-assets')))
    return { task: { ...task, status: 'attention_required', derivedState: true,
      ...(execution ? { execution: { ...execution, phase: 'awaiting_receipt' } } : {}),
      error: '提交进程已退出，服务商可能已接收原请求。请检查原任务与服务商记录。' }, taskPath };

  const capability = findCapability(manifest, task.capabilityId);
  if (capability.connector.type !== 'local-adapter') return { task, taskPath };
  const legacy = legacyNativeSubmission(task);
  if (legacy && task.command?.requestSha256 !== fingerprintTaskInput(task))
    return { task, taskPath, refreshError: '旧任务的请求指纹与记录不符，无法核验原生作业。' };
  await mkdir(outputDirectory, { recursive: true });
  try {
    const execution = await refreshAdapter(capability, {
      manifest,
      input: task.input,
      task,
      repositoryRoot,
      outputDirectory,
      saveAdapter: adapter => checkpointAdapter(manifest, task, adapter),
      legacyNativeSubmission: legacy,
    });
    if (!execution) return { task, taskPath };
    return await applyAdapterExecution(
      manifest,
      task,
      taskPath,
      outputDirectory,
      execution,
    );
  } catch (error) {
    if (error instanceof TaskPublicationError) return publicationFailure(task, taskPath, error);
    if (task.adapter?.materializationPending)
      return saveMaterializationFailure(manifest, task, taskPath, error);
    return {
      task,
      taskPath,
      refreshError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listTaskPage(manifest, {
  limit = 50, offset = 0, query = '', capabilityId, status, refresh = false, snapshot, since, detail = true,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0)
    throw Object.assign(new Error('Invalid task pagination.'), { status: 400, code: 'INVALID_TASK_PAGINATION' });
  if (typeof query !== 'string' || query.length > 2000 ||
      (snapshot !== undefined && typeof snapshot !== 'string') ||
      (since !== undefined && typeof since !== 'string'))
    throw Object.assign(new Error('Invalid task query.'), { status: 400, code: 'INVALID_TASK_QUERY' });
  const directory = path.resolve(repositoryRoot, manifest.workspace.taskDirectory);
  const archived = new Set(await readArchivedTasks(manifest));
  let index = await readTaskSummaries(directory, { ...historyIndexOptions, exclude: archived });
  const normalizedQuery = query.toLowerCase();
  const matches = ({ task }) => (!capabilityId || task.capabilityId === capabilityId) &&
    (!status || task.status === status) &&
    (!normalizedQuery || JSON.stringify({ id: task.id, input: task.input }).toLowerCase().includes(normalizedQuery));
  const order = ({ task: left }, { task: right }) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.id.localeCompare(right.id);
  const fingerprint = rows => hash(JSON.stringify([rows.map(({ task, version }) => [task.id, version, task.status]), index.unavailable]));
  let rows = index.rows.filter(matches).sort(order);
  const stale = () => Object.assign(new Error('制作历史已变化，请从第一页重新查询。'), { status: 409, code: 'STALE_TASK_SNAPSHOT' });
  if (snapshot && snapshot !== fingerprint(rows)) throw stale();
  const outcomes = new Map();
  if (refresh) {
    // Terminal history must not displace actively polled tasks from page one.
    const active = index.active.filter(matches).sort(order).slice(offset, offset + limit);
    await mapTaskRecords(active, async ({ task, version }) => {
      try { outcomes.set(task.id, { ...await refreshTask(manifest, task.id), version }); }
      catch (error) {
        if (error.code !== 'ENOENT') outcomes.set(task.id, { version, refreshError: error instanceof Error ? error.message : String(error) });
      }
    });
    if (active.length) {
      index = await readTaskSummaries(directory, { ...historyIndexOptions, exclude: archived });
      rows = index.rows.map(entry => {
        const outcome = outcomes.get(entry.task.id);
        if (!outcome || outcome.version !== entry.version) return entry;
        const task = outcome.task ? historyTask(outcome.task) : { ...entry.task };
        if (outcome.refreshError) task.refreshError = outcome.refreshError;
        return { ...entry, task };
      }).filter(matches).sort(order);
    }
  }
  // Keep pagination tied to the authoritative file set. Derived refresh state
  // and transient errors also invalidate the conditional revision.
  const pageSnapshot = fingerprint(index.rows.filter(matches).sort(order));
  const revision = hash(JSON.stringify([pageSnapshot, rows.map(({ task }) => [task.id, task.status, task.refreshError || ''])]));
  const coverage = { complete: index.unavailable.length === 0, unavailableTaskIds: index.unavailable };
  if (since && offset === 0 && since === revision)
    return { tasks: [], unchanged: true, total: rows.length, nextOffset: null, snapshot: pageSnapshot, revision, searchedTasks: index.rows.length, coverage };
  const tasks = await mapTaskRecords(rows.slice(offset, offset + limit), async ({ task, version }) => {
    if (!detail) return task;
    const outcome = outcomes.get(task.id);
    if (outcome?.version === version && outcome.task) return { ...outcome.task, ...(outcome.refreshError ? { refreshError: outcome.refreshError } : {}) };
    const exact = await readTaskAtVersion(taskFilePath(manifest, task.id), version);
    if (!exact) throw stale();
    const record = normalizeLegacyReferenceRejection(exact);
    return outcome?.version === version && outcome.refreshError ? { ...record, refreshError: outcome.refreshError } : record;
  });
  return {
    revision,
    tasks,
    total: rows.length,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    snapshot: pageSnapshot,
    searchedTasks: index.rows.length,
    coverage,
  };
}

// Keep the legacy array API for existing adapters and callers.
export async function listTasks(manifest, options = {}) {
  return (await listTaskPage(manifest, options)).tasks;
}

async function readArchivedTasks(manifest) {
  try { return JSON.parse(await readFile(path.resolve(repositoryRoot, manifest.workspace.taskDirectory, '.archived.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Keep durable execution/idempotency evidence and output files, remove history from lists.
export async function archiveTaskHistory(manifest, { checkOnly = false } = {}) {
  return withTaskLock(manifest, 'workbench-history', () => archiveHistoryOnce(manifest, checkOnly));
}

async function archiveHistoryOnce(manifest, checkOnly) {
  const directory = path.resolve(repositoryRoot, manifest.workspace.taskDirectory);
  await mkdir(directory, { recursive: true });
  const archived = new Set(await readArchivedTasks(manifest));
  const index = await readTaskSummaries(directory, { ...historyIndexOptions, exclude: archived });
  if (index.unavailable.length) throw new Error(`部分任务记录无法读取，请检查后再归档：${index.unavailable.join('、')}`);
  const blocked = (await mapTaskRecords(index.active, async ({ task }) => {
    if (task.status !== 'running') return null;
    if (task.adapter?.backgroundExecution) return (await backgroundAlive(manifest, task)) ? task : null;
    if (task.execution?.owner && !processAlive(task.execution.owner.pid)) return pendingNativeIdentity(task) ? task : null;
    if (!task.adapter && (task.submissionPid ? !processAlive(task.submissionPid) : task.capabilityId === 'image-assets')) return null;
    return task;
  })).filter(Boolean);
  if (blocked.length) throw new Error(`后台任务仍在制作，请等待完成后再归档：${blocked.map((task) => task.id).join('、')}`);
  if (!checkOnly) {
    await atomicJson(path.join(directory, '.archived.json'), [...archived, ...index.rows.map(({ task }) => task.id)]);
  }
  return { count: index.rows.length };
}

export function summarizeTask(result) {
  return {
    taskId: result.task.id,
    status: result.task.status,
    ...(result.task.error ? { error: result.task.error } : {}),
    taskPath: result.taskPath,
    outputs: result.task.outputs,
    ...(result.task.command ? { commandId: result.task.command.id, requestSha256: result.task.command.requestSha256 } : {}),
    ...(result.task.execution ? { executionPhase: result.task.execution.phase } : {}),
    ...(result.replayed ? { replayed: true } : {}),
    ...(result.task.adapter ? { adapter: result.task.adapter } : {}),
    ...(result.requiredEnvironment || result.task.requiredEnvironment
      ? { requiredEnvironment: result.requiredEnvironment ?? result.task.requiredEnvironment }
      : {}),
    ...(result.refreshError ? { refreshError: result.refreshError } : {}),
  };
}

function compactTaskInput(input) {
  if (!input) return input;
  const fields = Object.fromEntries(Object.entries(input).filter(([key, value]) =>
    typeof value === 'boolean' || typeof value === 'number' ||
    (typeof value === 'string' && value.length <= 4000 && !/base64/i.test(key) && !/^data:/i.test(value))));
  if (input.project?.projectId || input.project?.name)
    fields.project = { projectId: input.project.projectId, name: input.project.name };
  for (const key of ['motionSpec', 'output', 'outputSize']) {
    if (valueMatchesType(input[key], 'object')) fields[key] = compactTaskInput(input[key]);
  }
  return fields;
}

function historyTask(raw) {
  const { input, presentation: _presentation, resultDigest: _resultDigest, imageEditContext, ...task } = normalizeLegacyReferenceRejection(raw);
  return { ...task, input: compactTaskInput(input), ...(imageEditContext ? { imageEditContext } : {}) };
}

const historyIndexOptions = { project: historyTask, active: needsRefresh };

export function publicTaskRecord(task, detail = false) {
  if (detail) return task;
  const { input, submissionPid: _submissionPid, presentation: _presentation, resultDigest: _resultDigest, command, execution, ...record } = task;
  return { ...record, input: compactTaskInput(input), ...(command ? { commandId: command.id, requestSha256: command.requestSha256 } : {}),
    ...(execution ? { executionPhase: execution.phase } : {}) };
}

export function currentTaskPresentation(manifest, task) {
  return !task.derivedState && task.presentation ? task.presentation : taskPresentation(manifest, task);
}

async function checkpointAdapter(manifest, task, adapter) {
  if (task.execution && adapter.materializationPending) await checkpointExecution(manifest, task, 'materializing', adapter);
  else {
    await persistTask(manifest, { ...task, adapter });
    task.adapter = adapter;
  }
}

async function saveMaterializationFailure(manifest, task, taskPath, cause) {
  const refreshError = cause instanceof Error ? cause.message : String(cause);
  const error = '原生回执已保留，部分产物暂时无法读取。请刷新此任务以重试读取。';
  const status = task.status === 'running' && task.outputs.length ? 'running' : 'attention_required';
  if (task.status !== status || task.error !== error || task.materializationError !== refreshError) {
    task.status = status;
    task.updatedAt = new Date().toISOString();
    task.error = error;
    task.materializationError = refreshError;
    delete task.submissionPid;
    if (status !== 'running') delete task.presentation;
    await persistTask(manifest, task);
  }
  return { task, taskPath, refreshError };
}

async function applyAdapterExecution(
  manifest,
  task,
  taskPath,
  outputDirectory,
  execution,
) {
  const next = { ...task, status: execution.status, outputs: [] };
  if (execution.adapter) next.adapter = execution.adapter;
  if (execution.requiredEnvironment) next.requiredEnvironment = execution.requiredEnvironment;
  else delete next.requiredEnvironment;
  if (typeof execution.deferred !== 'function') delete next.submissionPid;
  delete next.error;
  delete next.materializationError;

  if (execution.result !== null && execution.result !== undefined) {
    const bytes = `${JSON.stringify(execution.result, null, 2)}\n`;
    next.resultDigest = hash(bytes);
    const resultDirectory = task.capabilityId === 'sprite-generator'
      ? path.join(outputDirectory, 'results', next.resultDigest.slice(0, 32)) : outputDirectory;
    const resultPath = path.join(resultDirectory, 'result.json');
    if (task.resultDigest !== next.resultDigest) {
      await mkdir(resultDirectory, { recursive: true });
      if (task.capabilityId === 'sprite-generator') {
        const existing = await readFile(resultPath).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (existing && hash(existing) !== next.resultDigest) throw new Error('Saved sprite result digest collision or modification.');
      }
      await writeAtomicSnapshot(resultPath, bytes);
    }
    next.outputs.push(projectRelative(resultPath));
  } else delete next.resultDigest;
  for (const name of execution.generatedOutputNames ?? []) {
    const outputPath = path.resolve(outputDirectory, name);
    ensureInside(outputDirectory, outputPath, 'Adapter output');
    const info = await stat(outputPath);
    if (!info.isFile()) throw new Error(`Adapter output is not a file: ${name}`);
    next.outputs.push(projectRelative(outputPath));
  }
  next.outputs = [...new Set(next.outputs)];
  if (next.status === 'failed' || (['attention_required', 'not_submitted'].includes(next.status) && execution.error)) {
    next.error = execution.error ?? 'Adapter reported a failed task.';
  }
  next.presentation = taskPresentation(manifest, next, {
    result: execution.result, artifacts: next.outputs.map(path => ({ path })),
  });
  finishTaskExecution(next, execution);
  const changed = Object.keys(next).length !== Object.keys(task).length ||
    Object.entries(next).some(([key, value]) => value !== task[key] && JSON.stringify(value) !== JSON.stringify(task[key]));
  if (changed) {
    next.updatedAt = new Date().toISOString();
    if (next.outputs.length) {
      await saveTaskPublication(repositoryRoot, outputDirectory, task, next, taskRequestSha256(task));
      try { await persistTask(manifest, next); }
      catch (error) { throw new TaskPublicationError(error.message, { cause: error }); }
    } else await persistTask(manifest, next);
  }
  return {
    task: next,
    taskPath,
    ...(execution.requiredEnvironment
      ? { requiredEnvironment: execution.requiredEnvironment }
      : {}),
  };
}

function projectRelative(filePath) {
  const relative = path.relative(repositoryRoot, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the repository: ${filePath}`);
  }
  return relative.replaceAll('\\', '/');
}

function ensureInside(directory, filePath, label) {
  const relative = path.relative(directory, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside its task output directory.`);
  }
}
