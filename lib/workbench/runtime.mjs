import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
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
import { getPublicMapGenerationSettings } from './map-generation-settings.mjs';
import { imageTargetRefSchema } from './image-edit-contract.mjs';

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
    manifest.workspace.sceneExportDirectory = `work/test-runs/${testRun}/scene-exports`;
    manifest.workspace.presentationDirectory = `work/test-runs/${testRun}/presentation`;
    manifest.workspace.gameExportDirectory = `work/test-runs/${testRun}/game-exports`;

    manifest.workspace.mapProjectDirectory = `work/test-runs/${testRun}/map-projects`;
    manifest.workspace.documentDirectory = `work/test-runs/${testRun}/editor-documents`;
    manifest.workspace.imageEditDirectory = `work/test-runs/${testRun}/image-edits`;
    manifest.workspace.sceneWorkflowDirectory = `work/test-runs/${testRun}/scene-workflows`;
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
  if (expectedType === 'array') return Array.isArray(value);
  if (expectedType === 'integer') return Number.isInteger(value);
  if (expectedType === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expectedType === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === expectedType;
}

// Nested task inputs must be checked before persistence, including unknown
// fields. Otherwise an invalid nested key could be written before the adapter
// rejects it. Keep constraints in the manifest rather than a second catalog.
function validateNested(schema, value, name) {
  if (!valueMatchesType(value, schema.type)) return [`${name} must be ${schema.type}.`];
  const errors = [];
  if (schema.type === 'object') {
    for (const required of schema.required || []) if (!(required in value)) errors.push(`Missing required field: ${name}.${required}`);
    for (const [key, child] of Object.entries(value)) {
      const definition = schema.properties?.[key];
      if (!definition) { if (schema.additionalProperties === false) errors.push(`Unknown field: ${name}.${key}`); continue; }
      errors.push(...validateNested(definition, child, `${name}.${key}`));
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${name} is not an allowed value.`);
  if (typeof value === 'string' && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) errors.push(`${name} has an invalid format or length.`);
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) || (schema.maximum !== undefined && value > schema.maximum))) errors.push(`${name} is outside its allowed range.`);
  if (schema.type === 'array' && schema.items) value.forEach((child, index) => errors.push(...validateNested(schema.items, child, `${name}[${index}]`)));
  return errors;
}

export function validateInput(capability, input) {
  const schema = capability.inputSchema;
  const errors = [];
  if (!valueMatchesType(input, 'object')) return ['Input must be a JSON object.'];

  for (const requiredName of schema.required ?? []) {
    if (!(requiredName in input)) errors.push(`Missing required field: ${requiredName}`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in schema.properties)) errors.push(`Unknown field: ${key}`);
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties[key];
    if (!property) continue;
    if (!valueMatchesType(value, property.type)) {
      errors.push(`${key} must be ${property.type}.`);
      continue;
    }
    if (property.type === 'object') errors.push(...validateNested(property, value, key));
    if (property.enum && !property.enum.includes(value)) {
      errors.push(`${key} must be one of: ${property.enum.join(', ')}.`);
    }
    if (property.type === 'string') {
      if (property.minLength !== undefined && value.length < property.minLength) {
        errors.push(`${key} must contain at least ${property.minLength} characters.`);
      }
      if (property.maxLength !== undefined && value.length > property.maxLength) {
        errors.push(`${key} must contain at most ${property.maxLength} characters.`);
      }
    }
    if (property.type === 'array') {
      if (property.minItems !== undefined && value.length < property.minItems) {
        errors.push(`${key} must contain at least ${property.minItems} items.`);
      }
      if (property.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
        errors.push(`${key} must not contain duplicates.`);
      }
      if (property.items?.type) {
        value.forEach((item, index) => {
          if (!valueMatchesType(item, property.items.type)) {
            errors.push(`${key}[${index}] must be ${property.items.type}.`);
          }
          if (property.items.enum && !property.items.enum.includes(item)) {
            errors.push(`${key}[${index}] must be one of: ${property.items.enum.join(', ')}.`);
          }
        });
      }
    }
    if (property.type === 'integer' || property.type === 'number') {
      if (property.minimum !== undefined && value < property.minimum) {
        errors.push(`${key} must be at least ${property.minimum}.`);
      }
      if (property.maximum !== undefined && value > property.maximum) {
        errors.push(`${key} must be at most ${property.maximum}.`);
      }
    }
  }
  errors.push(...validateAdapterInput(capability, input));
  return errors;
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

export async function persistTask(manifest, task) {
  const directory = path.resolve(repositoryRoot, manifest.workspace.taskDirectory);
  await mkdir(directory, { recursive: true });
  const taskPath = taskFilePath(manifest, task.id);
  await atomicJson(taskPath, task);
  return projectRelative(taskPath);
}

export function publicCapability(capability) {
  const connector = capability.connector;
  const mapGeneration = Array.isArray(connector.providers) || connector.providerSource
    ? getPublicMapGenerationSettings(connector)
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
      ...(mapGeneration
        ? {
            providers: mapGeneration.providers,
            externalGenerationConfigured: mapGeneration.providers.some((provider) => provider.configured),
            activeGenerationProvider: mapGeneration.active ? mapGeneration.provider : null,
          }
        : {}),
    },
    requiredInputs: capability.inputSchema.required ?? [],
    outputs: capability.outputs,
  };
}

export async function prepareTask(manifest, capability, input, status = 'prepared', imageEditContext) {
  const errors = validateInput(capability, input);
  if (errors.length > 0) throw new Error(`Input validation failed:\n- ${errors.join('\n- ')}`);
  const now = new Date().toISOString();
  if (imageEditContext && (capability.id !== 'image-assets' || Object.keys(imageEditContext).some(key => !['editId', 'candidateVersion', 'target'].includes(key)) || typeof imageEditContext.editId !== 'string' || typeof imageEditContext.candidateVersion !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(imageEditContext.editId) || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(imageEditContext.candidateVersion))) throw new Error('Invalid internal image editing task context.');
  const task = {
    schemaVersion: 1,
    id: createTaskId(capability.id),
    capabilityId: capability.id,
    status,
    createdAt: now,
    updatedAt: now,
    input,
    outputs: [],
    ...(imageEditContext ? { imageEditContext: { editId: imageEditContext.editId, candidateVersion: imageEditContext.candidateVersion, target: imageTargetRefSchema.parse(imageEditContext.target) } } : {}),
  };
  const taskPath = await persistTask(manifest, task);
  return { task, taskPath };
}

export async function runConnector(manifest, capability, input, options = {}) {
  if (capability.connector.type === 'local-adapter') {
    return runLocalAdapter(manifest, capability, input, options);
  }
  if (options.onPrepared) throw new Error('Durable submission hooks require a local adapter.');
  return runHttpConnector(manifest, capability, input);
}

const backgroundExecutions = new Map();

function atomicJson(file, value) {
  return writeAtomicSnapshot(file, `${JSON.stringify(value, null, 2)}\n`);
}

const leaseFile = outputDirectory => path.join(outputDirectory, '.background-lease.json');
const writeBackgroundLease = (outputDirectory, token) => atomicJson(leaseFile(outputDirectory), { token, pid: process.pid, heartbeatAt: Date.now() });

async function runLocalAdapter(manifest, capability, input, options = {}) {
  const { task, taskPath } = await prepareTask(manifest, capability, input, 'running', options.imageEditContext);
  const outputDirectory = path.resolve(repositoryRoot, manifest.workspace.outputDirectory, task.id);
  await mkdir(outputDirectory, { recursive: true });
  try {
    // The caller records this identity durably before any adapter can submit.
    // A failed hook aborts execution; retrying the caller never creates a new task.
    await options.onPrepared?.({ task, taskPath });
    const execution = await executeAdapter(capability, {
      manifest,
      input,
      task,
      repositoryRoot,
      outputDirectory,
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
        await applyAdapterExecution(manifest, task, taskPath, outputDirectory, final);
      }).catch(async error => {
        task.status = 'attention_required';
        task.updatedAt = new Date().toISOString();
        const code = typeof error?.code === 'string' && /^E[A-Z]+$/.test(error.code) ? ` (${error.code})` : '';
        task.error = `后台图片任务中断${code}，提交结果可能未知。请检查现有任务产物与服务商记录；不会自动重新提交。`;
        await persistTask(manifest, task);
      }).finally(() => { clearInterval(heartbeat); backgroundExecutions.delete(key); });
      backgroundExecutions.set(key, pending);
      // Keep persistence failures handled even if the original HTTP client disconnects.
      pending.catch(() => undefined);
      return snapshot;
    }
    return initial;
  } catch (error) {
    task.status = 'failed';
    task.updatedAt = new Date().toISOString();
    task.error = error instanceof Error ? error.message : String(error);
    await persistTask(manifest, task);
    throw new Error(`Task ${task.id} failed: ${task.error}`);
  }
}

async function runHttpConnector(manifest, capability, input) {
  const url = process.env[capability.connector.urlEnv];
  if (!url) {
    const prepared = await prepareTask(manifest, capability, input, 'awaiting_configuration');
    return { ...prepared, requiredEnvironment: capability.connector.urlEnv };
  }
  const { task, taskPath } = await prepareTask(manifest, capability, input, 'running');
  const token = capability.connector.tokenEnv ? process.env[capability.connector.tokenEnv] : undefined;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ taskId: task.id, capabilityId: capability.id, input }),
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
    const resultPath = path.join(outputDirectory, 'result.json');
    await writeFile(resultPath, `${JSON.stringify(responseBody, null, 2)}\n`, 'utf8');
    task.status = 'completed';
    task.updatedAt = new Date().toISOString();
    task.outputs = [projectRelative(resultPath)];
    await persistTask(manifest, task);
    return { task, taskPath };
  } catch (error) {
    task.status = 'failed';
    task.updatedAt = new Date().toISOString();
    task.error = error instanceof Error ? error.message : String(error);
    await persistTask(manifest, task);
    throw new Error(`Task ${task.id} failed: ${task.error}`);
  }
}

export async function readTask(manifest, taskId) {
  return JSON.parse(await readFile(taskFilePath(manifest, taskId), 'utf8'));
}

const pendingRefreshes = new Map();
export async function refreshTask(manifest, taskId) {
  const key = taskFilePath(manifest, taskId);
  if (pendingRefreshes.has(key)) return pendingRefreshes.get(key);
  const pending = refreshTaskOnce(manifest, taskId);
  pendingRefreshes.set(key, pending);
  try { return await pending; }
  finally { if (pendingRefreshes.get(key) === pending) pendingRefreshes.delete(key); }
}

async function refreshTaskOnce(manifest, taskId) {
  const task = await readTask(manifest, taskId);
  const taskPath = projectRelative(taskFilePath(manifest, taskId));
  if (task.status !== 'running') return { task, taskPath };

  if (task.adapter?.backgroundExecution) {
    if (backgroundExecutions.has(taskFilePath(manifest, task.id))) return { task, taskPath };
    // MCP and the HTTP bridge share task files but may run in separate processes.
    // Observe a live owner's bounded lease; polling never takes over submission.
    const { backgroundPid, backgroundExpiresAt, backgroundToken } = task.adapter;
    if (Number.isInteger(backgroundPid) && backgroundPid > 0 && backgroundExpiresAt > Date.now()) {
      let alive = false;
      try { process.kill(backgroundPid, 0); alive = true; }
      catch (error) { alive = error.code === 'EPERM'; }
      const outputDirectory = path.resolve(repositoryRoot, manifest.workspace.outputDirectory, taskId);
      const lease = await readFile(leaseFile(outputDirectory), 'utf8').then(JSON.parse).catch(() => null);
      if (alive && lease?.token === backgroundToken && lease?.pid === backgroundPid && lease?.heartbeatAt > Date.now() - 20_000) return { task, taskPath };
    }
    // A completion committed during the liveness check takes precedence.
    const latest = await readTask(manifest, taskId);
    if (latest.status !== 'running') return { task: latest, taskPath };
    // An observer cannot atomically prove the worker will never finish. Return
    // derived diagnostics without overwriting a concurrent completion commit.
    // The persisted orphan remains running; a non-refresh read alone is not
    // evidence of an active worker. Only the owner commits its terminal state.
    return { task: {
      ...latest, status: 'attention_required', derivedState: true,
      error: '图片任务的执行进程已退出或等待已超时，提交结果可能未知。请检查已有产物与服务商记录；不会自动重新提交。',
    }, taskPath };
  }

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
    return {
      task,
      taskPath,
      refreshError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listTaskPage(manifest, {
  limit = 50, offset = 0, query = '', capabilityId, status, refresh = false, snapshot,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0)
    throw new Error('Invalid task pagination.');
  if (typeof query !== 'string' || query.length > 2000 ||
      (snapshot !== undefined && typeof snapshot !== 'string')) throw new Error('Invalid task query.');
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
          return JSON.parse(await readFile(path.join(directory, name), 'utf8'));
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
    JSON.stringify({ id: task.id, input: task.input }).toLowerCase().includes(query.toLowerCase());
  const order = (left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.id.localeCompare(right.id);
  const fingerprint = (rows) => createHash('sha256').update(JSON.stringify(rows.map((t) => [t.id, t.updatedAt, t.status]))).digest('hex');
  let rows = visible.filter(matches).sort(order);
  if (snapshot && snapshot !== fingerprint(rows)) throw new Error('制作历史已变化，请从第一页重新查询。');
  if (refresh) {
    const updates = new Map(await Promise.all(rows.slice(offset, offset + limit).map(async (task) => {
      if (task.status !== 'running') return [task.id, task];
      const refreshed = await refreshTask(manifest, task.id);
      return [task.id, refreshed.refreshError ? { ...refreshed.task, refreshError: refreshed.refreshError } : refreshed.task];
    })));
    rows = visible.map((t) => updates.get(t.id) || t).filter(matches).sort(order);
  }
  return {
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
  const directory = path.resolve(repositoryRoot, manifest.workspace.taskDirectory);
  await mkdir(directory, { recursive: true });
  const names = (await readdir(directory)).filter((name) => /^[a-z0-9][a-z0-9_-]*\.json$/i.test(name));
  const records = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  const archived = new Set(await readArchivedTasks(manifest));
  const blocked = records.filter((task) => task.status === 'running');
  if (blocked.length) throw new Error(`后台任务仍在制作，请等待完成后再归档：${blocked.map((task) => task.id).join('、')}`);
  if (!checkOnly) {
    const temporary = path.join(directory, `.archived-${process.pid}-${Date.now()}.tmp`);
    await writeFile(temporary, JSON.stringify(records.map((task) => task.id)));
    await rename(temporary, path.join(directory, '.archived.json'));
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
    ...(result.task.adapter ? { adapter: result.task.adapter } : {}),
    ...(result.requiredEnvironment || result.task.requiredEnvironment
      ? { requiredEnvironment: result.requiredEnvironment ?? result.task.requiredEnvironment }
      : {}),
    ...(result.refreshError ? { refreshError: result.refreshError } : {}),
  };
}

async function applyAdapterExecution(
  manifest,
  task,
  taskPath,
  outputDirectory,
  execution,
) {
  task.status = execution.status;
  task.updatedAt = new Date().toISOString();
  task.outputs = [];
  if (execution.adapter) task.adapter = execution.adapter;
  if (execution.requiredEnvironment) task.requiredEnvironment = execution.requiredEnvironment;
  else delete task.requiredEnvironment;
  delete task.error;

  if (execution.result !== null && execution.result !== undefined) {
    const resultPath = path.join(outputDirectory, 'result.json');
    await writeFile(resultPath, `${JSON.stringify(execution.result, null, 2)}\n`, 'utf8');
    task.outputs.push(projectRelative(resultPath));
  }
  for (const name of execution.generatedOutputNames ?? []) {
    const outputPath = path.resolve(outputDirectory, name);
    ensureInside(outputDirectory, outputPath, 'Adapter output');
    const info = await stat(outputPath);
    if (!info.isFile()) throw new Error(`Adapter output is not a file: ${name}`);
    task.outputs.push(projectRelative(outputPath));
  }
  task.outputs = [...new Set(task.outputs)];
  if (task.status === 'failed' || (task.status === 'attention_required' && execution.error)) {
    task.error = execution.error ?? 'Adapter reported a failed task.';
  }
  await persistTask(manifest, task);
  return {
    task,
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
