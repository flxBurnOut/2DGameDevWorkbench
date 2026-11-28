import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createSpritePipelineLaunch,
  resolveSpritePipelineTarget,
} from '../lib/workbench/sprite-pipeline-supervisor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  if (fs.existsSync(path.join(root, '.env')))
    process.loadEnvFile(path.join(root, '.env'));
  const mode = process.argv[2] || 'ui';
  if (!['ui', 'api'].includes(mode)) throw new Error('Mode must be ui or api.');
  const target = resolveSpritePipelineTarget();
  if (target.mode !== 'managed')
    throw new Error(
      '当前配置使用外部服务；请用 npm run dev 连接，或先移除外部服务地址配置。',
    );
  const launch = createSpritePipelineLaunch(root, target, process.env, { apiOnly: mode === 'api' });
  const child = spawn(launch.command, launch.args, {
    cwd: root,
    env: launch.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      stopping = true;
      child.kill(signal);
    });
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode =
      stopping || [130, -1073741510, 3221225786].includes(code)
        ? 0
        : (code ?? 1);
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
