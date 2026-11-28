#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createSpritePipelineLaunch,
  probeSpritePipeline,
  resolveSpritePipelineTarget,
  waitForSpritePipeline,
} from '../lib/workbench/sprite-pipeline-supervisor.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const projectEnvPath = path.join(repositoryRoot, '.env');
if (fs.existsSync(projectEnvPath)) process.loadEnvFile(projectEnvPath);
const defaultRuntimeUrl = 'http://127.0.0.1:8790';
const children = new Map();
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void finish(0));
}

void startWorkbench().catch(async (error) => {
  if (stopping) return;
  console.error(`Workbench 启动失败：${error instanceof Error ? error.message : error}`);
  await finish(1);
});

async function startWorkbench() {
  await ensureRuntimeBridge();
  if (!process.argv.includes('--without-sprite-pipeline')) await ensureSpritePipeline();
  if (stopping) return;
  start('Web', process.execPath, ['node_modules/vinext/dist/cli.js', 'dev']);
}

async function ensureRuntimeBridge() {
  const configuredUrl = process.env.WORKBENCH_RUNTIME_URL?.trim();
  const baseUrl = (configuredUrl || defaultRuntimeUrl).replace(/\/+$/, '');
  if (baseUrl !== defaultRuntimeUrl) {
    console.log(`Runtime Bridge 已配置为 ${baseUrl}，跳过本地自动启动。`);
    return;
  }

  const current = await probeRuntimeBridge(baseUrl);
  if (current.state === 'ready') {
    console.log(`Runtime Bridge 已在 ${baseUrl} 运行 · v${current.version}`);
    return;
  }
  if (current.state === 'conflict') throw new Error(current.reason);

  const runtime = start('Runtime Bridge', process.execPath, [
    'scripts/workbench-http.mjs',
  ]);
  const ready = await waitForRuntimeBridge(baseUrl, runtime);
  console.log(`Runtime Bridge 已就绪 · v${ready.version}`);
}

async function ensureSpritePipeline() {
  const target = resolveSpritePipelineTarget(process.env);
  if (target.mode === 'external') {
    console.log(`SpritePipeline：${target.reason}`);
    return;
  }

  const apiOnly = process.argv.includes('--api-only');
  const token = process.env.SPRITE_PIPELINE_API_TOKEN?.trim();
  const current = await probeSpritePipeline(target, { token, requireUi: !apiOnly, requireMotion: true });
  if (current.state === 'ready') {
    console.log(`SpritePipeline 已在 ${target.baseUrl} 运行 · v${current.version}`);
    return;
  }
  if (current.state === 'conflict') throw new Error(current.reason);

  const launch = createSpritePipelineLaunch(repositoryRoot, target, process.env, { apiOnly });
  console.log(`正在启动 SpritePipeline：${target.baseUrl}`);
  const pipeline = start('SpritePipeline', launch.command, launch.args, {
    env: launch.env,
  });
  const ready = await waitForSpritePipeline(target, {
    child: pipeline,
    token,
    shouldStop: () => stopping,
    requireUi: !apiOnly,
  });
  console.log(`SpritePipeline 已就绪 · v${ready.version}`);
}

function start(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: options.env || process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  children.set(child, label);
  child.once('error', (error) => {
    if (!stopping) {
      console.error(`${label} 无法启动：${error.message}`);
      void finish(1);
    }
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      const detail = signal ? `信号 ${signal}` : `退出码 ${code ?? 'unknown'}`;
      console.error(`${label} 意外退出（${detail}）。`);
      void finish(1);
    }
  });
  return child;
}

async function finish(code) {
  if (stopping) return;
  stopping = true;
  const runningChildren = [...children.keys()];
  await Promise.all(runningChildren.map(terminateChild));
  await Promise.all(
    runningChildren.map((child) => waitForChildExit(child, 5_000)),
  );
  process.exitCode = code;
}

async function probeRuntimeBridge(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${baseUrl}/health`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (
      response.ok &&
      payload?.ok === true &&
      payload.service === '2d-game-workbench-runtime' &&
      (typeof payload.version === 'number' || typeof payload.version === 'string')
    ) {
      return { state: 'ready', version: payload.version };
    }
    return {
      state: 'conflict',
      reason: '127.0.0.1:8790 响应的不是受支持的 Workbench Runtime Bridge。',
    };
  } catch {
    return { state: 'offline' };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForRuntimeBridge(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (stopping) throw new Error('Runtime Bridge 启动已取消。');
    if (child.exitCode !== null) {
      throw new Error(`Runtime Bridge 在就绪前退出，退出码 ${child.exitCode}。`);
    }
    const status = await probeRuntimeBridge(baseUrl);
    if (status.state === 'ready') return status;
    if (status.state === 'conflict') throw new Error(status.reason);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Runtime Bridge 在 15 秒内未就绪。');
}

function terminateChild(child) {
  if (child.exitCode !== null || !child.pid) return Promise.resolve();
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const killer = spawn(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
    killer.once('error', () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    });
    killer.once('exit', resolve);
  });
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, timeoutMs);
    timeout.unref();
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
