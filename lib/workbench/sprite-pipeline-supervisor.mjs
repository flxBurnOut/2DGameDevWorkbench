import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const DEFAULT_SPRITE_PIPELINE_URL = 'http://127.0.0.1:7860';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function resolveSpritePipelineTarget(environment = process.env) {
  const configuredApiUrl = environment.SPRITE_PIPELINE_API_URL?.trim();
  const configuredUiUrl =
    environment.NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL?.trim();
  const apiUrl = parseBaseUrl(configuredApiUrl || DEFAULT_SPRITE_PIPELINE_URL);
  const uiUrl = parseBaseUrl(configuredUiUrl || DEFAULT_SPRITE_PIPELINE_URL);

  if (apiUrl.origin !== uiUrl.origin || apiUrl.pathname !== uiUrl.pathname) {
    return {
      mode: 'external',
      baseUrl: apiUrl.href,
      reason:
        'SPRITE_PIPELINE_API_URL 与 NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL 指向不同地址，跳过本地自动启动。',
    };
  }

  if (!LOOPBACK_HOSTS.has(apiUrl.hostname) || apiUrl.pathname !== '/') {
    return {
      mode: 'external',
      baseUrl: apiUrl.href,
      reason: '已配置远程或带路径的 SpritePipeline 地址，跳过本地自动启动。',
    };
  }

  return {
    mode: 'managed',
    baseUrl: apiUrl.origin,
    host:
      apiUrl.hostname === 'localhost'
        ? '127.0.0.1'
        : apiUrl.hostname.replace(/^\[|\]$/g, ''),
    port: Number(apiUrl.port || (apiUrl.protocol === 'https:' ? 443 : 80)),
  };
}

export async function probeSpritePipeline(
  target,
  {
    fetchImpl = fetch,
    timeoutMs = 2_500,
    token,
    portProbe = isTcpPortOpen,
    allowOccupied = false,
    requireUi = false,
    requireMotion = false,
  } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(healthUrl(target.baseUrl), {
      cache: 'no-store',
      signal: controller.signal,
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    const payload = await response.json().catch(() => null);
    if (
      response.ok &&
      payload?.ok === true &&
      typeof payload.version === 'string'
    ) {
      if (requireMotion) {
        const schema = await fetchImpl(new URL('/openapi.json', target.baseUrl), {
          signal: AbortSignal.timeout(10_000),
          headers: token ? { authorization: `Bearer ${token}` } : undefined,
        });
        const paths = schema.ok && (await schema.json().catch(() => null))?.paths;
        if (!paths?.['/v1/open-motion/{work_id}/local-frame-edits']?.post ||
            !paths?.['/v1/open-motion/references/from-prop']?.post ||
            !paths?.['/v1/open-motion/{work_id}/interaction']?.get) {
          return { state:'conflict', reason:`端口 ${target.port} 上的服务缺少 COIP 动画接口。请从 COIP 工作区重启服务，或为 COIP 设置独立的本机服务端口。` };
        }
      }
      if (requireUi) {
        const ui = await probeSpritePipelineUi(target.baseUrl, { fetchImpl, timeoutMs });
        if (!ui.ready) return { state: 'conflict', reason: ui.error };
      }
      return { state: 'ready', version: payload.version };
    }
    return {
      state: 'conflict',
      reason: `${target.host}:${target.port} 响应的不是受支持的 SpritePipeline 健康协议。`,
    };
  } catch {
    const occupied = await portProbe(target.host, target.port, timeoutMs);
    return occupied
      ? allowOccupied
        ? { state: 'starting' }
        : {
            state: 'conflict',
            reason: `${target.host}:${target.port} 已被其他服务占用或健康检查超时。`,
          }
      : { state: 'offline' };
  } finally {
    clearTimeout(timeout);
  }
}

/** Check the actual UI, since serve-api also exposes a healthy /health endpoint. */
export async function probeSpritePipelineUi(baseUrl, { fetchImpl = fetch, timeoutMs = 2500 } = {}) {
  try {
    const response = await fetchImpl(baseUrl, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const html = response.ok && response.headers.get('content-type')?.includes('text/html')
      ? await response.text() : '';
    if (response.ok && /<gradio-app\b|window\.gradio_config\s*=/.test(html)) return { ready: true };
    return { ready: false, error: 'SpritePipeline API 已连接，但操作界面不可用。请将本地管线切换为界面模式（npm run sprite-pipeline），再点击重试。' };
  } catch {
    return { ready: false, error: '无法连接序列帧操作界面，请检查界面地址和本地服务后重试。' };
  }
}

export function createSpritePipelineLaunch(
  repositoryRoot,
  target,
  environment = process.env,
  { apiOnly = false } = {},
) {
  const pipelineRoot = path.join(repositoryRoot, 'Tools', 'SpritePipeline');
  const pythonExecutable = path.join(
    pipelineRoot,
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
  const pipelineCli = path.join(pipelineRoot, 'cli.py');

  if (!fs.existsSync(pythonExecutable)) {
    throw new Error(
      'SpritePipeline Python 环境不存在。首次使用请运行 npm run sprite-pipeline:setup。',
    );
  }
  if (!fs.existsSync(pipelineCli)) {
    throw new Error(`SpritePipeline CLI 不存在：${pipelineCli}`);
  }

  return {
    command: pythonExecutable,
    args: [
      pipelineCli,
      apiOnly ? 'serve-api' : 'serve-ui',
      '--host',
      target.host,
      '--port',
      String(target.port),
    ],
    env: {
      ...environment,
      SPRITE_PIPELINE_INSTALL_ROOT: pipelineRoot,
      SPRITE_PIPELINE_IMPORT_USER_ASSETS:
        environment.SPRITE_PIPELINE_IMPORT_USER_ASSETS ?? '1',
      SPRITE_PIPELINE_IMPORT_USER_CREDENTIALS:
        environment.SPRITE_PIPELINE_IMPORT_USER_CREDENTIALS ?? '1',
      SPRITE_PIPELINE_DATA_DIR:
        environment.SPRITE_PIPELINE_DATA_DIR?.trim() ||
        path.join(repositoryRoot, 'work', 'sprite-pipeline'),
      SPRITE_PIPELINE_EXPORTS_DIR:
        environment.SPRITE_PIPELINE_EXPORTS_DIR?.trim() ||
        path.join(repositoryRoot, 'outputs', 'sprite-pipeline'),
    },
  };
}

export async function waitForSpritePipeline(
  target,
  {
    child,
    timeoutMs = 60_000,
    intervalMs = 300,
    token,
    shouldStop = () => false,
    requireUi = false,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop()) throw new Error('SpritePipeline 启动已取消。');
    if (child && child.exitCode !== null) {
      throw new Error(
        `SpritePipeline 在就绪前退出，退出码 ${child.exitCode}。`,
      );
    }

    const status = await probeSpritePipeline(target, {
      timeoutMs: 1_000,
      token,
      allowOccupied: true,
      requireUi,
    });
    if (status.state === 'ready') return status;
    if (status.state === 'conflict') throw new Error(status.reason);
    await delay(intervalMs);
  }
  throw new Error(
    `SpritePipeline 在 ${Math.round(timeoutMs / 1_000)} 秒内未就绪。`,
  );
}

function parseBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`无效的 SpritePipeline 地址：${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`SpritePipeline 地址必须使用 http 或 https：${value}`);
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed;
}

function healthUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/health`;
}

function isTcpPortOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
