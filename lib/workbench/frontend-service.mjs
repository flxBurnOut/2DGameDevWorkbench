import { spawn } from 'node:child_process';
import {
  open,
  readFile,
  writeFile,
  mkdir,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { repositoryRoot } from './workbench-manifest.mjs';

import { workspaceIdentity } from './workspace-identity.mjs';
import { bridgeProtocolVersion, bridgeBaseUrl, expectedBridgeWorkspace } from './service-endpoints.mjs';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function localUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('自动启动前端仅支持本机 HTTP 根地址。');
  return url;
}

function connectionRefused(error) {
  // Node can aggregate IPv4/IPv6 errors. Every address must refuse the connection.
  if (Array.isArray(error?.errors) && error.errors.length)
    return error.errors.every(connectionRefused);
  return error?.code === 'ECONNREFUSED';
}

async function confirmPortRefused(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return await new Promise((resolve) => {
      const socket = net.createConnection({
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      });
      const timeout = setTimeout(() => finish(false), 2000);
      function finish(refused) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(refused);
      }
      socket.once('connect', () => finish(false));
      socket.once('error', (error) => finish(connectionRefused(error)));
    });
  } catch {
    return false;
  }
}

export async function probeFrontendService(url, service, expectedWorkspace) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    const payload = await response.json().catch(() => null);
    return response.ok && payload?.ok === true && payload.service === service &&
      (!service.startsWith('2d-game-workbench-') || (payload.version === bridgeProtocolVersion && typeof payload.workspaceId === 'string')) &&
      (!expectedWorkspace || payload.workspaceId === expectedWorkspace)
      ? { state: 'ready' }
      : { state: 'conflict', message: '地址已响应，但不是预期的工作台服务。' };
  } catch (error) {
    // A closed listener may first surface as ECONNRESET/UND_ERR_SOCKET on a pooled
    // fetch connection. Confirm with a fresh TCP connection, never infer offline
    // from an HTTP failure or timeout while another process still owns the port.
    const refused =
      connectionRefused(error.cause) || (await confirmPortRefused(url));
    return refused
      ? { state: 'offline' }
      : {
          state: 'unreachable',
          message: '服务探测超时或不可达，请检查现有进程。',
        };
  }
}

export async function getFrontend(manifest) {
  const url = localUrl(manifest.workspace.frontend.url).origin;
  const runtimeUrl = bridgeBaseUrl().replace(/\/+$/, '');
  const workspaceId = workspaceIdentity(repositoryRoot);
  const [web, runtime] = await Promise.all([
    probeFrontendService(
      `${url}${manifest.workspace.frontend.healthPath}`,
      '2d-game-workbench-web', workspaceId,
    ),
    probeFrontendService(`${runtimeUrl}/health`, '2d-game-workbench-runtime', expectedBridgeWorkspace(runtimeUrl, workspaceId)),
  ]);
  return {
    url,
    ...web,
    ready: web.state === 'ready' && runtime.state === 'ready',
    runtime: { url: runtimeUrl, ...runtime },
    hostAction: {
      host: 'WorkBuddy',
      tool: 'present_files',
      arguments: {
        files: [url],
        cwd: repositoryRoot,
        explanation: '打开 2D 游戏制作工作台',
      },
    },
  };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

// Fixed launch specifications come from startFrontend, never from tool arguments.
export async function startManagedFrontendProcess(root, name, launch, probe) {
  const directory = path.join(root, 'work/services');
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, `${name}.lock`);
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A crashed owner must not block subsequent sessions forever.
    try {
      const owner = JSON.parse(await readFile(lockPath, 'utf8'));
      const info = await stat(lockPath);
      if (!alive(owner.pid) && Date.now() - info.mtimeMs > 10_000) {
        await unlink(lockPath);
        return startManagedFrontendProcess(root, name, launch, probe);
      }
    } catch {}
    return { status: 'starting', message: '已有启动请求；请查询环境状态。' };
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    const current = await probe();
    if (current.state === 'ready') return { status: 'reused' };
    if (current.state !== 'offline') return { status: 'blocked', ...current };
    const statePath = path.join(directory, `${name}.json`);
    let previous;
    try {
      previous = JSON.parse(await readFile(statePath, 'utf8'));
    } catch {}
    if (alive(previous?.pid))
      return {
        status: 'starting',
        pid: previous.pid,
        logPath: previous.logPath,
      };
    const logPath = path.join(directory, `${name}.log`);
    const log = await open(logPath, 'a');
    let child;
    try {
      child = spawn(process.execPath, launch.args, {
        cwd: root,
        env: launch.env || process.env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      await writeFile(statePath, JSON.stringify({ pid: child.pid, logPath }));
    } finally {
      await log.close();
    }
    return { status: 'starting', pid: child.pid, logPath };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function startFrontend(manifest) {
  const frontend = await getFrontend(manifest);
  if (frontend.ready) return { status: 'reused', frontend };
  const target = localUrl(frontend.url);
  if (
    !['ready', 'offline'].includes(frontend.state) ||
    !['ready', 'offline'].includes(frontend.runtime.state)
  )
    return {
      status: 'blocked',
      frontend,
      message: '服务地址冲突或暂时不可达，不重复启动。',
    };
  if (frontend.runtime.state === 'offline') {
    let runtimeTarget;
    try { runtimeTarget = localUrl(frontend.runtime.url); } catch {
      return { status: 'external', frontend, message: '已配置的外部 Bridge 离线，请在该服务所在位置启动。' };
    }
    const runtime = await startManagedFrontendProcess(
      repositoryRoot,
      `runtime-${runtimeTarget.port || 80}`,
      {
        args: ['scripts/workbench-http.mjs'],
        env: {
          ...process.env,
          WORKBENCH_RUNTIME_HOST: runtimeTarget.hostname,
          WORKBENCH_RUNTIME_PORT: runtimeTarget.port || '80',
        },
      },
      () =>
        probeFrontendService(
          `${runtimeTarget.origin}/health`,
          '2d-game-workbench-runtime', expectedBridgeWorkspace(runtimeTarget.origin, workspaceIdentity(repositoryRoot)),
        ),
    );
    if (runtime.status === 'blocked') return { ...runtime, frontend };
  }
  let web = { status: 'reused' };
  if (frontend.state === 'offline')
    web = await startManagedFrontendProcess(
      repositoryRoot,
      `frontend-${target.port || 80}`,
      {
        args: [
          'node_modules/vinext/dist/cli.js',
          'dev',
          '--hostname',
          target.hostname,
          '--port',
          target.port || '80',
        ],
      },
      () =>
        probeFrontendService(
          `${target.origin}${manifest.workspace.frontend.healthPath}`,
          '2d-game-workbench-web', workspaceIdentity(repositoryRoot),
        ),
    );
  return {
    ...web,
    status: web.status === 'blocked' ? 'blocked' : 'starting',
    frontend: await getFrontend(manifest),
    message:
      '查询 get_environment，待 frontend.ready 为 true 后由 WorkBuddy 调用 hostAction。本工具只启动本地服务，尚未打开内部浏览器。',
  };
}
