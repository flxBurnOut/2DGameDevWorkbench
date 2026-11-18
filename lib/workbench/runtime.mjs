import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
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

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export const repositoryRoot = path.resolve(moduleDirectory, '..', '..');
export const manifestPath = path.join(repositoryRoot, 'workbench', 'manifest.json');

export async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // Test subprocesses inherit this namespace; production continues to use the manifest.
  const testRun = process.env.WORKBENCH_TEST_RUN;
  if (testRun) {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(testRun)) {
      throw new Error('WORKBENCH_TEST_RUN must be a simple test run identifier.');
    }
    manifest.workspace.assetTrashDirectory = `work/test-runs/${testRun}/asset-trash`;
    manifest.workspace.importedAssetDirectory = `work/test-runs/${testRun}/imported-assets`;
    manifest.workspace.packageImportDirectory = `work/test-runs/${testRun}/asset-package-imports`;
    manifest.workspace.taskDirectory = `work/test-runs/${testRun}/tasks`;
    manifest.workspace.presentationDirectory = `work/test-runs/${testRun}/presentation`;
    manifest.workspace.gameExportDirectory = `work/test-runs/${testRun}/game-exports`;

    manifest.workspace.documentDirectory = `work/test-runs/${testRun}/editor-documents`;
    manifest.workspace.imageEditDirectory = `work/test-runs/${testRun}/image-edits`;
    manifest.workspace.outputDirectory = `outputs/test-runs/${testRun}`;
  }
  return manifest;
}

export function agentCapabilities(manifest) {
  return manifest.capabilities.filter((capability) => capability.agent?.mode !== 'manual');
}

export function findAgentCapability(manifest, capabilityId) {
  const capability = findCapability(manifest, capabilityId);
  if (capability.agent?.mode === 'manual') {
    throw new Error(`${capability.name} uses the manual frontend: ${capability.ui.route}. ${capability.agent.reason}`);
  }
  return capability;
}

export function findCapability(manifest, capabilityId) {
  const capability = manifest.capabilities.find((candidate) => candidate.id === capabilityId);
  if (!capability) {
    throw new Error(`Unknown capability "${capabilityId}". List capabilities before choosing one.`);
  }
  return capability;
}

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
  const suffix = Math.random().toString(36).slice(2, 6);
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
  await atomicJson(taskPath, task);
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

async function createTask(manifest, capability, input, { status = 'prepared', imageEditContext, command } = {}) {
  const now = new Date().toISOString();
  if (imageEditContext && (capability.id !== 'image-assets' || Object.keys(imageEditContext).some(key => !['editId', 'candidateVersion', 'target'].includes(key)) || typeof imageEditContext.editId !== 'string' || typeof imageEditContext.candidateVersion !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(imageEditContext.editId) || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(imageEditContext.candidateVersion))) throw new Error('Invalid internal image editing task context.');
  const task = {
    schemaVersion: 1,
    id: command ? commandTaskId(command.id) : createTaskId(capability.id),
    capabilityId: capability.id,
    status,
    createdAt: now,
    updatedAt: now,
    input,
    outputs: [],
    ...(command ? { command } : {}),
    ...(imageEditContext ? { imageEditContext: { editId: imageEditContext.editId, candidateVersion: imageEditContext.candidateVersion, target: imageTargetRefSchema.parse(imageEditContext.target) } } : {}),
  };
  const taskPath = await persistTask(manifest, task);
  return { task, taskPath };
}

async function commandTask(manifest, capability, input, options, run) {
  const { commandId } = options;
  const taskId = commandTaskId(commandId);
  const requestSha256 = hash(canonicalJson({ capabilityId: capability.id, input }));
  return withTaskLock(manifest, taskId, async () => {
    const previous = await readTask(manifest, taskId).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (previous && (previous.command?.id !== commandId || previous.command?.requestSha256 !== requestSha256))
      throw Object.assign(new Error('commandId was already used with a different task request.'), { code: 'COMMAND_ID_REUSED', status: 409, taskId });
    const taskPath = projectRelative(taskFilePath(manifest, taskId));
    if (previous && (!run || previous.status !== 'prepared'))
      return { ...(run ? await refreshTaskOnce(manifest, taskId) : { task: previous, taskPath }), replayed: true };
    if (!previous) validateTaskInput(capability, input);
    const record = previous ? { task: previous, taskPath } :
      await createTask(manifest, capability, input, { command: { id: commandId, requestSha256 } });
    if (!run) return record;
    record.task.status = 'running';
    record.task.updatedAt = new Date().toISOString();
    record.task.submissionPid = process.pid;
    await persistTask(manifest, record.task);
    return { ...await executeConnector(manifest, capability, record, options), ...(previous ? { replayed: true } : {}) };
  });
}

export function prepareAgentTask(manifest, capability, input, options = {}) {
  if (options.commandId === undefined) return prepareTask(manifest, capability, input);
  return commandTask(manifest, capability, input, options, false);
}

export async function runConnector(manifest, capability, input, options = {}) {
  if (options.commandId !== undefined) return commandTask(manifest, capability, input, options, true);
  const record = await prepareTask(manifest, capability, input, 'running', options.imageEditContext);
  return withTaskLock(manifest, record.task.id, () => executeConnector(manifest, capability, record, options));
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

async function runLocalAdapter(manifest, capability, { task, taskPath }, options) {
  const outputDirectory = path.resolve(repositoryRoot, manifest.workspace.outputDirectory, task.id);
  try {
    await mkdir(outputDirectory, { recursive: true });
    // The caller records this identity durably before any adapter can submit.
    // A failed hook aborts execution; retrying the caller never creates a new task.
    await options.onPrepared?.({ task, taskPath });
    const execution = await executeAdapter(capability, {
      manifest,
      input: task.input,
      task,
      repositoryRoot,
      outputDirectory,
      saveAdapter: adapter => checkpointAdapter(manifest, task, adapter),
    });
    if (typeof execution.deferred === 'function') {
      const token = randomUUID();
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
      let leaseWrites = Promise.resolve();
      const heartbeat = setInterval(() => {
        leaseWrites = leaseWrites.then(() => writeBackgroundLease(outputDirectory, execution.adapter.backgroundToken)).catch(() => undefined);
      }, 5000);
      heartbeat.unref();
      const pending = Promise.resolve().then(execution.deferred).then(async final => {
        clearInterval(heartbeat);
        await leaseWrites;
        await withTaskLock(manifest, task.id, () => applyAdapterExecution(manifest, initial.task, taskPath, outputDirectory, final));
      }).catch(async error => {
        const code = typeof error?.code === 'string' && /^E[A-Z]+$/.test(error.code) ? ` (${error.code})` : '';
        await withTaskLock(manifest, task.id, () => applyAdapterExecution(manifest, initial.task, taskPath, outputDirectory, {
          status: 'attention_required',
          adapter: initial.task.adapter,
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
    if (task.adapter?.materializationPending)
      return saveMaterializationFailure(manifest, task, taskPath, error);
    if (task.adapter?.nativeLookupPending) {
      if (error.status === undefined || error.status >= 500) {
        task.status = 'attention_required';
        task.error = '规划响应未收到。刷新此任务可按原请求标识检查已接收的作品。';
        task.updatedAt = new Date().toISOString();
        delete task.submissionPid;
        await persistTask(manifest, task);
        return { task, taskPath };
      }
      delete task.adapter.nativeLookupPending;
    }
    task.status = 'failed';
    delete task.submissionPid;
    task.updatedAt = new Date().toISOString();
    task.error = error instanceof Error ? error.message : String(error);
    await persistTask(manifest, task);
    throw new Error(`Task ${task.id} failed: ${task.error}`);
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
  try {
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
    if (!response.ok) throw new Error(`Connector returned HTTP ${response.status}: ${response.statusText}`);
    const outputDirectory = path.resolve(repositoryRoot, manifest.workspace.outputDirectory, task.id);
    await mkdir(outputDirectory, { recursive: true });
    return applyAdapterExecution(manifest, task, taskPath, outputDirectory, { status: 'completed', result: responseBody });
  } catch (error) {
    task.status = 'failed';
    delete task.submissionPid;
    task.updatedAt = new Date().toISOString();
    task.error = error instanceof Error ? error.message : String(error);
    await persistTask(manifest, task);
    throw new Error(`Task ${task.id} failed: ${task.error}`);
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
  return task && (task.status === 'running' || task.adapter?.materializationPending || task.adapter?.nativeLookupPending ||
    (task.status === 'attention_required' && !task.error &&
      task.capabilityId === 'sprite-generator' && task.adapter?.openWorkId && !task.adapter.adjustmentId));
}

async function refreshTaskOnce(manifest, taskId) {
  const task = await readTask(manifest, taskId);
  const taskPath = projectRelative(taskFilePath(manifest, taskId));
  if (!needsRefresh(task)) return { task, taskPath };

  if (task.adapter?.backgroundExecution) {
    if (await backgroundAlive(manifest, task)) return { task, taskPath };
    // Preserve the durable attempt and leave a late completion to its owner.
    return { task: {
      ...task, status: 'attention_required', derivedState: true,
      error: '图片任务的执行进程已退出或等待已超时，提交结果可能未知。请检查已有产物与服务商记录；不会自动重新提交。',
    }, taskPath };
  }
  if (task.submissionPid && !task.adapter && !processAlive(task.submissionPid))
    return { task: { ...task, status: 'attention_required', derivedState: true,
      error: '提交进程已退出，服务商可能已接收原请求。请检查原任务与服务商记录。' }, taskPath };

  const capability = findCapability(manifest, task.capabilityId);
  if (capability.connector.type !== 'local-adapter') return { task, taskPath };
  const outputDirectory = path.resolve(
    repositoryRoot,
    manifest.workspace.outputDirectory,
    task.id,
  );
  await mkdir(outputDirectory, { recursive: true });
  try {
    const execution = await refreshAdapter(capability, {
      manifest,
      input: task.input,
      task,
      repositoryRoot,
      outputDirectory,
      saveAdapter: adapter => checkpointAdapter(manifest, task, adapter),
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
  limit = 50, offset = 0, query = '', capabilityId, status, refresh = false, snapshot, since,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0)
    throw new Error('Invalid task pagination.');
  if (typeof query !== 'string' || query.length > 2000 ||
      (snapshot !== undefined && typeof snapshot !== 'string') ||
      (since !== undefined && typeof since !== 'string')) throw new Error('Invalid task query.');
  const directory = path.resolve(repositoryRoot, manifest.workspace.taskDirectory);
  const archived = new Set(await readArchivedTasks(manifest));
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') names = [];
    else throw error;
  }
  const tasks = await Promise.all(
    names
      .filter((name) => /^[a-z0-9][a-z0-9_-]*\.json$/i.test(name))
      .map(async (name) => {
        try {
          return normalizeLegacyReferenceRejection(JSON.parse(await readFile(path.join(directory, name), 'utf8')));
        } catch {
          return null;
        }
      }),
  );
  const visible = tasks
    .filter(Boolean)
    .filter((task) => !archived.has(task.id));
  const matches = (task) => (!capabilityId || task.capabilityId === capabilityId) &&
    (!status || task.status === status) &&
    (!query || JSON.stringify({ id: task.id, input: compactTaskInput(task.input) }).toLowerCase().includes(query.toLowerCase()));
  const order = (left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.id.localeCompare(right.id);
  const fingerprint = (rows) => createHash('sha256').update(JSON.stringify(rows.map((t) => [t.id, t.updatedAt, t.status]))).digest('hex');
  let rows = visible.filter(matches).sort(order);
  if (snapshot && snapshot !== fingerprint(rows)) throw new Error('制作历史已变化，请从第一页重新查询。');
  if (refresh) {
    const updates = new Map(await Promise.all(rows.slice(offset, offset + limit).map(async (task) => {
      if (!needsRefresh(task)) return [task.id, task];
      const refreshed = await refreshTask(manifest, task.id);
      return [task.id, refreshed.refreshError ? { ...refreshed.task, refreshError: refreshed.refreshError } : refreshed.task];
    })));
    rows = visible.map((t) => updates.get(t.id) || t).filter(matches).sort(order);
  }
  // `revision` also covers transient refresh errors. Pages that already hold
  // this exact history pass it back as `since` and skip the record payload.
  const revision = createHash('sha256').update(JSON.stringify(rows.map((t) => [t.id, t.updatedAt, t.status, t.refreshError || '']))).digest('hex');
  if (since && offset === 0 && since === revision)
    return { tasks: [], unchanged: true, total: rows.length, nextOffset: null, snapshot: fingerprint(rows), revision, searchedTasks: visible.length };
  return {
    revision,
    tasks: rows.slice(offset, offset + limit),
    total: rows.length,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
    snapshot: fingerprint(rows),
    searchedTasks: visible.length,
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
  const names = (await readdir(directory)).filter((name) => /^[a-z0-9][a-z0-9_-]*\.json$/i.test(name));
  const records = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  const archived = new Set(await readArchivedTasks(manifest));
  const blocked = (await Promise.all(records.map(async task => {
    if (task.status !== 'running') return null;
    if (task.adapter?.backgroundExecution) return (await backgroundAlive(manifest, task)) ? task : null;
    if (!task.adapter && task.submissionPid && !processAlive(task.submissionPid)) return null;
    return task;
  }))).filter(Boolean);
  if (blocked.length) throw new Error(`后台任务仍在制作，请等待完成后再归档：${blocked.map((task) => task.id).join('、')}`);
  if (!checkOnly) {
    await atomicJson(path.join(directory, '.archived.json'), [...new Set([...archived, ...records.map(task => task.id)])]);
  }
  return { count: records.filter((task) => !archived.has(task.id)).length };
}

export function summarizeTask(result) {
  return {
    taskId: result.task.id,
    status: result.task.status,
    ...(result.task.error ? { error: result.task.error } : {}),
    taskPath: result.taskPath,
    outputs: result.task.outputs,
    ...(result.task.command ? { commandId: result.task.command.id } : {}),
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

export function publicTaskRecord(task, detail = false) {
  if (detail) return task;
  const { input, submissionPid: _submissionPid, presentation: _presentation, resultDigest: _resultDigest, command, ...record } = task;
  return { ...record, input: compactTaskInput(input), ...(command ? { commandId: command.id } : {}) };
}

export function currentTaskPresentation(manifest, task) {
  return !task.derivedState && task.presentation ? task.presentation : taskPresentation(manifest, task);
}

async function checkpointAdapter(manifest, task, adapter) {
  await persistTask(manifest, { ...task, adapter });
  task.adapter = adapter;
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
  delete next.submissionPid;
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
  const changed = Object.keys(next).length !== Object.keys(task).length ||
    Object.entries(next).some(([key, value]) => value !== task[key] && JSON.stringify(value) !== JSON.stringify(task[key]));
  if (changed) {
    next.updatedAt = new Date().toISOString();
    await persistTask(manifest, next);
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

export { agentRequest } from "./agent-api.mjs";
