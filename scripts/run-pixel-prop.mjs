import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(root, 'Tools/SpritePipeline/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const child = spawn(python, ['-m', 'pixel_prop.cli', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('请先运行 npm run sprite-pipeline:setup 安装 PixelProp。'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
