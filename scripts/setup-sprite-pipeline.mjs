import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pipeline = path.join(root, 'Tools', 'SpritePipeline');
const venv = path.join(pipeline, '.venv');
const python = path.join(
  venv,
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ||
        `Command failed (exit ${result.status}): ${command}`,
    );
  }
}
function supported(command, args = []) {
  const result = spawnSync(
    command,
    [
      ...args,
      '-c',
      'import sys, venv; sys.exit(0 if sys.version_info >= (3, 11) else 1)',
    ],
    { stdio: 'ignore', windowsHide: true, timeout: 10000 },
  );
  return !result.error && result.status === 0;
}
try {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--api-only')) throw new Error('Usage: sprite-pipeline:setup [--api-only]');
  const apiOnly = args.includes('--api-only');
  if (fs.existsSync(python)) {
    if (!supported(python))
      throw new Error(
        '项目 .venv 无法使用或 Python 低于 3.11。请将旧 .venv 移走后重新初始化；不同操作系统之间不能复制虚拟环境。',
      );
  } else {
    if (fs.existsSync(venv))
      throw new Error(
        '发现不完整或来自其他系统的 .venv。请将其移走后重新初始化。',
      );
    const explicit = process.env.SPRITE_PIPELINE_PYTHON?.trim();
    /** @type {Array<[string, string[]]>} */
    const candidates = explicit
      ? [[explicit, []]]
      : process.platform === 'win32'
        ? [
            ['py', ['-3']],
            ['python', []],
            ['python3', []],
            [
              path.join(
                process.env.USERPROFILE || '',
                '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
              ),
              [],
            ],
          ]
        : [
            ['python3', []],
            ['python', []],
          ];
    const selected = candidates.find(([command, args]) =>
      supported(command, args),
    );
    if (!selected)
      throw new Error(
        '未找到 Python 3.11+（含 venv）。请安装 Python，或通过 SPRITE_PIPELINE_PYTHON 指定解释器完整路径。',
      );
    run(selected[0], [...selected[1], '-m', 'venv', venv]);
  }
  const lock = path.join(pipeline, 'requirements.lock');
  if (apiOnly) {
    run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-c', lock,
      '-e', path.join(root, 'Tools', 'PixelProp'), '-e', pipeline + '[api]']);
  } else {
    run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r',
      fs.existsSync(lock) ? lock : path.join(pipeline, 'requirements.txt')]);
    run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-e', path.join(root, 'Tools', 'PixelProp')]);
  }
  run(python, ['-m', 'pip', 'check']);
  const modules = apiOnly ? 'fastapi, uvicorn, PIL, numpy, pixel_prop' : 'fastapi, uvicorn, gradio, PIL, pixel_prop';
  run(python, ['-c', `import ${modules}; print("SpritePipeline and PixelProp dependencies ready")`]);
  console.log(`SpritePipeline 已就绪：${python}\n运行 npm run dev${apiOnly ? ' -- --api-only' : ''} 启动工作台。`);
} catch (error) {
  console.error(`SpritePipeline 初始化失败：${error.message}`);
  process.exitCode = 1;
}
