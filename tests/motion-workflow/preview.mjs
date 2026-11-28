import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-motion-'));
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const [name, child] of children) {
    if (name === 'examples') child.stdin.end();
    else child.kill();
  }
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

// Reserve distinct ports before starting the three loopback listeners.
const reservations = [];
for (let i = 0; i < 3; i++) {
  const socket = net.createServer().listen(0, 'localhost');
  await once(socket, 'listening');
  reservations.push(socket);
}
const [apiPort, bridgePort, webPort] = reservations.map(
  (s) => s.address().port,
);
await Promise.all(
  reservations.map((s) => new Promise((resolve) => s.close(resolve))),
);
const home = 'http://localhost:' + webPort;
const loopback = (port) => 'http://127.0.0.1:' + port;
// Only pass OS/runtime locations and the selected local endpoints into the dev worker.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    /^(path|pathext|systemroot|systemdrive|windir|comspec|tmp|tmpdir|temp|home|userprofile|localappdata|appdata|os|lang|lc_all|number_of_processors|processor_architecture)$/i.test(
      k,
    ),
  ),
);
Object.assign(env, {
  WORKBENCH_TEST_RUN: 'motion-' + randomUUID(),
  WORKBENCH_FRONTEND_URL: home,
  WORKBENCH_RUNTIME_URL: loopback(bridgePort),
  WORKBENCH_RUNTIME_PORT: String(bridgePort),
  SPRITE_PIPELINE_API_URL: loopback(apiPort),
  NEXT_PUBLIC_SPRITE_PIPELINE_UI_URL: loopback(apiPort),
  FORGE_MOTION_PREVIEW_DIR: directory,
  VINEXT_NO_DEV_LOCK: '1',
  MINIFLARE_REGISTRY_PATH: path.join(directory, 'worker-registry'),
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
  GRADIO_ANALYTICS_ENABLED: 'False',
  PYTHONUTF8: '1',
});
if (process.env.FORGE_MOTION_REPLAY_ROOT)
  env.FORGE_MOTION_REPLAY_ROOT = process.env.FORGE_MOTION_REPLAY_ROOT;
function start(name, bin, args) {
  const child = spawn(bin, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio:
      name === 'examples'
        ? ['pipe', 'pipe', 'inherit']
        : ['ignore', 'inherit', 'inherit'],
  });
  children.push([name, child]);
  child.on('error', (error) => {
    console.error(name, error.message);
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
  return child;
}
const python =
  process.env.WORKBENCH_TEST_PYTHON ||
  path.join(
    root,
    'Tools/SpritePipeline/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
const examples = start('examples', python, [
  '-B',
  '-X',
  'utf8',
  '-u',
  'tests/motion-workflow/preview.py',
  path.join(directory, 'examples'),
  String(apiPort),
]);
for await (const line of createInterface({ input: examples.stdout })) {
  const ids = JSON.parse(line);
  start('bridge', process.execPath, ['scripts/workbench-http.mjs']);
  start('web', process.execPath, [
    'node_modules/vinext/dist/cli.js',
    'dev',
    '--port',
    String(webPort),
  ]);
  console.log('\n离线验收，独立数据目录 ' + directory);
  console.log(
    '角色    ' + home + '/tools/sprite-generator?work=' + ids.character,
  );
  console.log(
    '交互物  ' + home + '/tools/interactable-motion?work=' + ids.interactable,
  );
  console.log('启动完成后打开链接。可检查、手工改帧和导出。按 Ctrl+C 结束。');
  break;
}
