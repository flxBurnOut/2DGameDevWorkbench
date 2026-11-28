import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { createMacImageCredentials } from './macos-image-credentials.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
let cachedEnvelope;
let cachedSettings;
const macCredentials = createMacImageCredentials();

export function imageSettingsPath() {
  const run = process.env.WORKBENCH_TEST_RUN;
  if (run && !/^[a-zA-Z0-9_-]+$/.test(run)) throw new Error('Invalid test run identifier.');
  // Preserve the on-disk path and envelope so existing installations need no migration.
  return path.join(root, 'work', ...(run ? ['test-runs', run] : []), 'config', 'map-generation.json');
}

export function readImageSettings() {
  const file = imageSettingsPath();
  if (!existsSync(file)) return { keys: {} };
  try {
    const raw = readFileSync(file, 'utf8');
    if (raw === cachedEnvelope) return structuredClone(cachedSettings);
    const envelope = JSON.parse(raw);
    if (envelope.version !== 1 || typeof envelope.value !== 'string') throw new Error();
    const clear = envelope.protection === 'windows-dpapi-current-user'
      ? dpapi(envelope.value, true)
      : envelope.protection === 'macos-keychain' && process.platform === 'darwin'
        ? macCredentials.open(envelope.value)
      : envelope.protection === 'restricted-local-file' && process.platform !== 'win32'
        ? envelope.value : null;
    if (!clear) throw new Error();
    const settings = JSON.parse(clear);
    if (!settings || typeof settings.keys !== 'object' || Array.isArray(settings.keys) || !settings.keys) throw new Error();
    if (Object.values(settings.keys).some(value => typeof value !== 'string')) throw new Error();
    if (settings.active !== undefined && settings.active !== null && typeof settings.active !== 'string') throw new Error();
    if (settings.preferred !== undefined && typeof settings.preferred !== 'string') throw new Error();
    if (process.platform === 'darwin' && envelope.protection === 'restricted-local-file') writeImageSettings(settings);
    else {
      cachedEnvelope = raw;
      cachedSettings = settings;
    }
    return structuredClone(settings);
  } catch {
    throw new Error(process.platform === 'darwin' ? '无法读取已保存的图片 API 配置，请解锁登录钥匙串并允许访问后重试。' : '无法读取已保存的图片 API 配置，请检查本机账户和配置文件。');
  }
}

export function writeImageSettings(settings) {
  const file = imageSettingsPath();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const clear = JSON.stringify(settings);
    const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    const account = existing?.protection === 'macos-keychain' ? JSON.parse(existing.value).account : undefined;
    const raw = JSON.stringify({
      version: 1,
      protection: process.platform === 'win32' ? 'windows-dpapi-current-user' : process.platform === 'darwin' ? 'macos-keychain' : 'restricted-local-file',
      value: process.platform === 'win32' ? dpapi(clear, false) : process.platform === 'darwin' ? macCredentials.seal(clear, account) : clear,
    });
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, raw, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
    cachedEnvelope = raw;
    cachedSettings = structuredClone(settings);
  } catch {
    throw new Error(process.platform === 'darwin' ? '图片 API 配置保存失败，请检查登录钥匙串访问权限和本机配置目录。' : '图片 API 配置保存失败，请检查本机配置目录的写入权限。');
  } finally {
    rmSync(temporary, { force: true });
  }
}

function dpapi(value, decrypt) {
  if (process.platform !== 'win32') throw new Error('Windows credential protection is unavailable.');
  // Secrets travel only through anonymous pipes, never command arguments or logs.
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$value = [Console]::In.ReadToEnd()
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
${decrypt
    ? '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($value), $null, $scope)\n[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))'
    : '$bytes = [System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes($value), $null, $scope)\n[Console]::Out.Write([Convert]::ToBase64String($bytes))'}`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: value, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout) throw new Error('Credential protection failed.');
  return result.stdout;
}
