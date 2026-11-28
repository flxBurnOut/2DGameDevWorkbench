import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'Tools', 'VisualStructure');
const profile = JSON.parse(
  fs.readFileSync(path.join(tool, 'runtime-profile.json'), 'utf8'),
);
const runtime = path.join(root, profile.runtimeDirectory);
const pythonRelative =
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
const python = path.join(runtime, 'venv', pythonRelative);
const source = path.join(runtime, 'sam2');
const weights = path.join(runtime, 'checkpoints', 'sam2.1_hiera_tiny.pt');
const checkOnly = process.argv.includes('--check');
const cpu = process.argv.includes('--cpu');
const run = (command, args, capture = false) => {
  const result = spawnSync(command, args, {
    cwd: root,
    windowsHide: true,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: {
      ...process.env,
      SAM2_BUILD_CUDA: '0',
      ...(cpu ? { FORGE_STRUCTURE_DEVICE: 'cpu' } : {}),
    },
  });
  if (result.error || result.status !== 0)
    throw new Error(
      result.error?.message || result.stderr || `命令失败：${command}`,
    );
  return result.stdout?.trim();
};
const sha = (filename) =>
  createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

try {
  if (!checkOnly) {
    fs.mkdirSync(runtime, { recursive: true });
    if (!fs.existsSync(python)) {
      const bootstrap =
        process.env.FORGE_STRUCTURE_BOOTSTRAP_PYTHON ||
        path.join(root, 'Tools/SpritePipeline/.venv', pythonRelative);
      run(bootstrap, [
        '-c',
        'import sys; assert sys.version_info[:2] == (3,12), "Use Python 3.12 or FORGE_STRUCTURE_BOOTSTRAP_PYTHON"',
      ]);
      run(bootstrap, ['-m', 'venv', path.join(runtime, 'venv')]);
    }
    if (!fs.existsSync(source)) {
      run('git', [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        profile.samRepository,
        source,
      ]);
      run('git', ['-C', source, 'checkout', '--detach', profile.samCommit]);
    }
    if (
      run('git', ['-C', source, 'rev-parse', 'HEAD'], true) !==
        profile.samCommit ||
      run('git', ['-C', source, 'status', '--porcelain'], true)
    ) {
      throw new Error(
        '独立 SAM 源码版本不符或存在改动，已停止；不会覆盖本地代码。',
      );
    }
    run(python, [
      '-m',
      'pip',
      'install',
      '-r',
      path.join(tool, 'requirements.common.lock'),
    ]);
    run(python, [
      '-m',
      'pip',
      'install',
      'torch==2.7.1',
      'torchvision==0.22.1',
      ...(process.platform === 'darwin'
        ? []
        : [
            '--index-url',
            `https://download.pytorch.org/whl/${cpu ? 'cpu' : 'cu128'}`,
          ]),
    ]);
    run(python, [
      '-m',
      'pip',
      'install',
      '--no-build-isolation',
      '--no-deps',
      '-e',
      source,
    ]);
    fs.mkdirSync(path.dirname(weights), { recursive: true });
    if (!fs.existsSync(weights)) {
      const response = await fetch(profile.weightsUrl);
      if (!response.ok || !response.body)
        throw new Error(`权重下载失败：${response.status}`);
      const temporary = weights + '.download';
      await pipeline(
        Readable.fromWeb(response.body),
        fs.createWriteStream(temporary),
      );
      if (sha(temporary) !== profile.weightsSha256)
        throw new Error('下载权重哈希不符，已保留下载文件供排查，不会加载。');
      fs.renameSync(temporary, weights);
    }
  }
  if (sha(weights) !== profile.weightsSha256)
    throw new Error('分割权重哈希不符');
  if (
    run('git', ['-C', source, 'rev-parse', 'HEAD'], true) !== profile.samCommit
  )
    throw new Error('SAM 源码版本不符');
  run(python, ['-m', 'pip', 'check']);
  if (!checkOnly) {
    fs.writeFileSync(
      path.join(runtime, 'device.json'),
      JSON.stringify({ device: cpu ? 'cpu' : 'auto' }),
    );
  }
  run(python, [path.join(tool, 'worker.py'), 'doctor']);
  console.log(
    '独立结构工具检查完成；未调用外部模型，未修改 SpritePipeline 环境。',
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
