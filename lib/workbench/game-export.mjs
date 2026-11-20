import {
  link,
  mkdir,
  readFile,
  writeFile,
  lstat,
  realpath,
  readdir,
  rename,
  unlink,
  rmdir,
} from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  prepareGodotPackage,
  readGodotZip,
  safePackagePath,
  MAX_GODOT_BYTES,
} from '../../features/godot-export/package.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = async (p) => {
  try {
    return await lstat(p);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
};
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const jsonBytes = (value) => JSON.stringify(value, null, 2) + '\n';
const now = () => new Date().toISOString();
const packageRoot =
  /^(forge_sprites|forge_packages|addons\/workbench_interaction)\//;
const deliveryPattern = /^delivery-[a-f0-9]{32}$/;
const deliveryInbox = (deliveryId) => 'forge_imports/' + deliveryId;
const deliveryRevision = (record) => record.deliveryRevision ?? 0;
const deliveryIdentity = (projectPath, packageSha256) =>
  'delivery-' + sha(projectPath + '\n' + packageSha256).slice(0, 32);

/** Reject junctions/symlinks beneath an explicitly selected root, including existing parents. */
export async function containedPath(root, relative, createParents = false) {
  safePackagePath(relative);
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let info = await exists(current);
    if (!info && createParents && i < parts.length - 1) {
      try {
        await mkdir(current);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        info = await lstat(current);
      }
    }
    if (
      info?.isSymbolicLink() ||
      (info && i < parts.length - 1 && !info.isDirectory())
    )
      throw new Error('目标路径包含链接或非目录，已停止写入。');
  }
  if (
    !path.relative(root, current) ||
    path.relative(root, current).startsWith('..') ||
    path.isAbsolute(path.relative(root, current))
  )
    throw new Error('目标路径越界。');
  return current;
}
async function publishFile(destination, bytes, { replace = false } = {}) {
  const temporary = destination + '.forge-' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, bytes, { flag: 'wx', flush: true });
  } catch (error) {
    if (error.code === 'EEXIST') throw error;
    await unlink(temporary).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup; });
    throw error;
  }
  try {
    // Linking publishes a fully written file and still refuses to replace a
    // file created by another installer or the game developer.
    if (replace) {
      await rename(temporary, destination);
      return;
    }
    await link(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup; });
    throw error;
  }
  await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
async function atomicJson(root, relative, value) {
  const destination = await containedPath(root, relative, true);
  await publishFile(destination, jsonBytes(value), { replace: true });
}
async function registry(root, manifest) {
  const relative = manifest.workspace.gameExportDirectory;
  const probe = await containedPath(root, relative + '/probe', true);
  return path.dirname(probe);
}
export async function inspectGameProject(selected, { inventory = false } = {}) {
  if (
    typeof selected !== 'string' ||
    !path.isAbsolute(selected) ||
    selected.length > 2000
  )
    throw new Error('请选择游戏项目的绝对路径。');
  if (path.basename(selected).toLowerCase() === 'project.godot')
    selected = path.dirname(selected);
  const root = await realpath(selected);
  if (!(await lstat(root)).isDirectory())
    throw new Error('所选路径不是文件夹。');
  const configPath = await containedPath(root, 'project.godot');
  const info = await exists(configPath);
  if (!info?.isFile() || info.size > 1024 * 1024)
    throw new Error(
      '此目录没有有效的 project.godot，请选择已有游戏项目的根目录。',
    );
  const config = await readFile(configPath, 'utf8');
  if (!/\[application\]/.test(config))
    throw new Error('project.godot 不是有效的 Godot 项目配置。');
  const name =
    /^config\/name="((?:\\.|[^"\\])*)"/m.exec(config)?.[1] ||
    path.basename(root);
  const version =
    /^config\/features=.*?"(\d+\.\d+(?:\.\d+)?)"/m.exec(config)?.[1] || null;
  const result = {
    path: root,
    name,
    projectRevision: sha(config),
    version,
    mainScene: /^run\/main_scene="([^"]+)"/m.exec(config)?.[1] || null,
    autoloads: config.match(/\[autoload\][\s\S]*?(?=\n\[|$)/)?.[0] || '',
    files: [],
    inventoryTruncated: false,
  };
  if (version && !version.startsWith('4.')) throw new Error('当前资源包需要 Godot 4 项目。');
  result.versionWarning = version && !/^4\.7(?:\.|$)/.test(version) ? `项目版本为 Godot ${version}，导出基线为 4.7.x；接入后需按目标版本验收。` : null;
  if (inventory) {
    const queue = [''];
    let examined = 0;
    while (queue.length && examined < 4000) {
      const rel = queue.shift();
      for (const entry of await readdir(path.join(root, rel), {
        withFileTypes: true,
      })) {
        if (++examined >= 4000) {
          result.inventoryTruncated = true;
          break;
        }
        if (
          entry.isSymbolicLink() ||
          ['.git', '.godot', 'node_modules', 'forge_imports'].includes(
            entry.name,
          )
        )
          continue;
        const name = rel ? rel + '/' + entry.name : entry.name;
        if (entry.isDirectory() && name.split('/').length < 6) queue.push(name);
        else if (
          entry.isFile() &&
          /\.(tscn|gd|tres)$|(^|\/)AGENTS\.md$/.test(name)
        )
          result.files.push(name);
      }
    }
    result.inventoryTruncated ||= queue.length > 0;
  }
  return result;
}
export async function selectedGameProject(root, manifest) {
  try {
    const saved = await readJson(
      path.join(await registry(root, manifest), 'selected-project.json'),
    );
    return await inspectGameProject(saved.path);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { unavailable: true, message: e.message };
  }
}
export async function selectGameProject(root, manifest, projectPath) {
  const project = await inspectGameProject(projectPath);
  await atomicJson(await registry(root, manifest), 'selected-project.json', {
    path: project.path,
  });
  return project;
}
function summary(record) {
  return {
    deliveryId: record.deliveryId,
    title: record.title,
    kind: record.package.kind,
    status: record.status,
    project: record.project,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    inboxPath: record.inboxPath,
    packageSha256: record.packageSha256,
    deliveryRevision: deliveryRevision(record),
    packageId: record.package.packageId,
    source: record.source,
    integration: record.integration || null,
  };
}
export async function deliverGodotPackage(
  root,
  manifest,
  { bytes, title = 'Godot 资产', source = null, projectPath },
) {
  const project = projectPath
    ? await inspectGameProject(projectPath)
    : await selectedGameProject(root, manifest);
  if (!project || project.unavailable)
    throw new Error('请先选择有效的游戏项目。');
  const prepared = await prepareGodotPackage(bytes),
    packageSha256 = sha(prepared.bytes);
  const deliveryId = deliveryIdentity(project.path, packageSha256);
  const records = await registry(root, manifest);
  return withDeliveryLock(project, deliveryId, async () => {
    const inbox = deliveryInbox(deliveryId);
    const indexed = await indexedDelivery(records, deliveryId);
    const saved = await projectDelivery(project.path, deliveryId, packageSha256);
    if (indexed && (indexed.packageSha256 !== packageSha256 || indexed.project.path !== project.path))
      throw new Error('交付记录身份不一致。');
    if (saved || indexed) {
      const record = saved ?? indexed;
      await readDeliveryPackage(project.path, record);
      if (!saved) await writeProjectDelivery(record);
      await mirrorDelivery(records, record, indexed);
      await atomicJson(records, 'selected-project.json', { path: project.path });
      return { ...summary(record), reused: true, nextTool: 'workbench_get_game_export' };
    }
    const destination = await containedPath(project.path, inbox + '/package.zip', true);
    await writeFile(await containedPath(project.path, 'forge_imports/.gdignore', true), '', { flag: 'a' });
    // Exclusive creation also allows a retry to reuse a ZIP published before delivery registration.
    try {
      await publishFile(destination, prepared.bytes);
    } catch (error) {
      if (error.code !== 'EEXIST' || sha(await readFile(destination)) !== packageSha256) throw error;
    }
    const recordedAt = now();
    const record = {
      format: 'forge-game-delivery',
      version: 1,
      deliveryRevision: 1,
      deliveryId,
      title: String(title).slice(0, 200),
      createdAt: recordedAt,
      updatedAt: recordedAt,
      status: 'awaiting_agent',
      project: { path: project.path, name: project.name },
      source,
      package: prepared.manifest,
      packageSha256,
      inboxPath: path.join(project.path, inbox),
      integration: null,
    };
    await publishFile(
      await containedPath(project.path, inbox + '/README.txt', true),
      'Forge 游戏项目交付\n\npackage.zip 是可解压到项目根目录的实际资源包。WorkBuddy 通过 Forge MCP 读取此交付并接入当前游戏。此目录是保留的原始交付，不会被 Godot 当作脚本导入。\n当前状态：等待 Agent 检查项目并完成接入。\n',
      { replace: true },
    );
    // Once the ZIP exists, register its location even if initial receipt publication is interrupted.
    await mirrorDelivery(records, record, null);
    await writeProjectDelivery(record);
    await atomicJson(records, 'selected-project.json', { path: project.path });
    return { ...summary(record), reused: false, nextTool: 'workbench_get_game_export' };
  });
}
export async function listGameExports(
  root,
  manifest,
  { pendingOnly = true, offset = 0, limit = 20, snapshot } = {},
) {
  const records = await registry(root, manifest),
    all = [];
  for (const name of await readdir(records)) {
    if (!/^delivery-[a-f0-9]{32}\.json$/.test(name)) continue;
    const record = await indexedDelivery(records, name.slice(0, -5));
    if (record) all.push(await historyDelivery(record));
  }
  const selected = all
    .filter((r) => !pendingOnly || r.status !== 'integrated')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.deliveryId.localeCompare(b.deliveryId));
  const currentSnapshot = sha(JSON.stringify(selected.map((record) =>
    [record.deliveryId, deliveryRevision(record), record.updatedAt, record.status])));
  if (snapshot && snapshot !== currentSnapshot)
    throw Object.assign(new Error('交付记录已更新，请刷新列表后继续查看。'), { status: 409 });
  return {
    deliveries: selected.slice(offset, offset + limit).map(summary),
    total: selected.length,
    nextOffset: offset + limit < selected.length ? offset + limit : null,
    snapshot: currentSnapshot,
    createsTask: false,
  };
}
async function readDeliveryCopy(directory, relative, deliveryId) {
  if (!deliveryPattern.test(deliveryId))
    throw new Error('无效的游戏交付记录。');
  let record;
  try {
    record = await readJson(await containedPath(directory, relative));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (
    record?.deliveryId !== deliveryId ||
    record.format !== 'forge-game-delivery' ||
    !path.isAbsolute(record.project?.path ?? '') ||
    !/^[a-f0-9]{64}$/.test(record.packageSha256) ||
    !Number.isSafeInteger(deliveryRevision(record)) || deliveryRevision(record) < 0
  )
    throw new Error('交付记录身份不一致。');
  return record;
}
function indexedDelivery(records, deliveryId) {
  return readDeliveryCopy(records, deliveryId + '.json', deliveryId);
}
async function requireIndexedDelivery(records, deliveryId) {
  const record = await indexedDelivery(records, deliveryId);
  if (!record) throw Object.assign(new Error('找不到游戏交付记录。'), { code: 'ENOENT' });
  return record;
}
async function projectDelivery(projectPath, deliveryId, packageSha256) {
  const record = await readDeliveryCopy(projectPath, deliveryInbox(deliveryId) + '/delivery.json', deliveryId);
  if (record && (
    record.project.path !== projectPath || record.packageSha256 !== packageSha256 ||
    deliveryIdentity(projectPath, packageSha256) !== deliveryId
  )) throw new Error('交付记录身份不一致。');
  return record;
}
async function historyDelivery(indexed) {
  try {
    if (await realpath(indexed.project.path) === indexed.project.path)
      return await projectDelivery(indexed.project.path, indexed.deliveryId, indexed.packageSha256) ?? indexed;
  } catch {
    // A saved history receipt remains available while the project is offline or unreadable.
  }
  return indexed;
}
/** Read saved progress even when the destination project is currently unavailable.
 * Package integrity and project inspection remain the responsibility of getGameExport.
 */
export async function readGameExportSummary(root, manifest, { deliveryId }) {
  const record = await historyDelivery(await requireIndexedDelivery(await registry(root, manifest), deliveryId));
  return {
    ...summary(record),
    package: { kind: record.package.kind, details: record.package.details || {} },
    createsTask: false,
  };
}
async function readDeliveryPackage(projectPath, record) {
  const bytes = await readFile(
    await containedPath(
      projectPath,
      deliveryInbox(record.deliveryId) + '/package.zip',
    ),
  );
  if (sha(bytes) !== record.packageSha256)
    throw new Error('交付包已改变，请从原资产重新导出。');
  return bytes;
}
async function readDelivery(records, deliveryId) {
  const indexed = await requireIndexedDelivery(records, deliveryId);
  const project = await inspectGameProject(indexed.project.path);
  if (indexed.project.path !== project.path || deliveryIdentity(project.path, indexed.packageSha256) !== deliveryId)
    throw new Error('交付记录身份不一致。');
  const saved = await projectDelivery(project.path, deliveryId, indexed.packageSha256);
  const record = saved ?? indexed;
  const bytes = await readDeliveryPackage(project.path, record);
  return { record, indexed, saved, project, bytes };
}
async function installPlan(project, bytes) {
  const files = await readGodotZip(bytes),
    plan = [],
    conflicts = [];
  const ledgerPath = await containedPath(project.path, 'forge_imports/install-ledger.json');
  let ledgerBefore = null;
  try {
    ledgerBefore = await readFile(ledgerPath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const ledger = ledgerBefore ? JSON.parse(ledgerBefore) : { files: {} };
  for (const [name, data] of files) {
    if (!packageRoot.test(name) || /(^|\/)project.godot$/i.test(name))
      throw new Error('包内包含不可安装的文件。');
    const destination = await containedPath(project.path, name),
      info = await exists(destination);
    if (info && !info.isFile())
      throw new Error('目标位置不是普通文件：' + name);
    const previous = info ? sha(await readFile(destination)) : null,
      next = sha(data);
    const action =
      previous === next
        ? 'reuse'
        : !previous
          ? 'create'
          : ledger.files?.[name]?.sha256 === previous
            ? 'update'
            : 'conflict';
    plan.push({ path: name, action, sha256: next, previousSha256: previous });
    if (action === 'conflict') conflicts.push(name);
  }
  return { files, ledger, ledgerPath, ledgerBefore, plan, conflicts };
}
export async function getGameExport(root, manifest, { deliveryId }) {
  const { record, project, bytes } = await readDelivery(
    await registry(root, manifest),
    deliveryId,
  );
  const inspection = await inspectGameProject(project.path, {
      inventory: true,
    }),
    { plan, conflicts } = await installPlan(project, bytes);
  return {
    ...record,
    deliveryRevision: deliveryRevision(record),
    inspection,
    installPlan: plan,
    conflicts,
    guide: manifest.agentAssets.engineering.deliveryGuide,
    createsTask: false,
  };
}
function reviseDelivery(record, changes) {
  return { ...record, ...changes, deliveryRevision: deliveryRevision(record) + 1, updatedAt: now() };
}
async function writeProjectDelivery(record) {
  await atomicJson(
    record.project.path,
    deliveryInbox(record.deliveryId) + '/delivery.json',
    record,
  );
}
async function mirrorDelivery(records, record, indexed) {
  if (!isDeepStrictEqual(record, indexed))
    await atomicJson(records, record.deliveryId + '.json', record);
}

const installBusy = () => Object.assign(new Error('此游戏项目正在接入另一份资源，请稍后重试。'), { status: 409 });
async function installLockOwner(lock) {
  try {
    if (!(await lstat(lock)).isDirectory()) return null;
    const names = await readdir(lock);
    if (names.length !== 1 || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(names[0])) return null;
    const file = path.join(lock, names[0]);
    const info = await lstat(file);
    if (!info.isFile() || info.size > 4096) return null;
    const owner = await readJson(file);
    if (owner.format !== 'forge-game-install-lock' || owner.version !== 1 ||
        !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.host !== hostname() ||
        !/^delivery-[a-f0-9]{32}$/.test(owner.deliveryId) ||
        `${owner.token}.json` !== names[0]) return null;
    return owner;
  } catch {
    // Missing, partial, legacy or unreadable ownership cannot prove a dead holder.
    return null;
  }
}
function installLockHolderExited(owner) {
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // A reused PID, permission error or unknown process state must keep the lock.
    return error.code === 'ESRCH';
  }
}
async function removeOwnedInstallLock(lock, owner) {
  try {
    await unlink(path.join(lock, `${owner.token}.json`));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  // Only the remover of this unique owner entry may remove the directory.
  // A competing recovery cannot rmdir a replacement holder's lock: its unlink
  // of the old token fails, even if a new directory already occupies this path.
  await rmdir(lock);
  return true;
}
async function acquireInstallLock(project, deliveryId) {
  const lock = await containedPath(project.path, 'forge_imports/install.lock', true);
  const owner = { format: 'forge-game-install-lock', version: 1, pid: process.pid,
    host: hostname(), token: randomUUID(), deliveryId };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await mkdir(lock);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await installLockOwner(lock);
      if (!previous || !installLockHolderExited(previous)) throw installBusy();
      await removeOwnedInstallLock(lock, previous);
      continue;
    }
    try {
      await writeFile(path.join(lock, `${owner.token}.json`), jsonBytes(owner), { flag: 'wx' });
      return { lock, owner };
    } catch (error) {
      // No other acquirer can recover this live holder or its unpublished owner.
      await unlink(path.join(lock, `${owner.token}.json`)).catch((cleanupError) => {
        if (cleanupError.code !== 'ENOENT') throw cleanupError;
      });
      await rmdir(lock);
      throw error;
    }
  }
  throw installBusy();
}
async function withDeliveryLock(project, deliveryId, run) {
  const acquired = await acquireInstallLock(project, deliveryId);
  try {
    return await run();
  } finally {
    await removeOwnedInstallLock(acquired.lock, acquired.owner);
  }
}
async function withCurrentDelivery(root, manifest, deliveryId, run) {
  const records = await registry(root, manifest);
  const indexed = await requireIndexedDelivery(records, deliveryId);
  const project = await inspectGameProject(indexed.project.path);
  if (indexed.project.path !== project.path) throw new Error('目标工程路径已变化。');
  return withDeliveryLock(project, deliveryId, async () => {
    const current = await readDelivery(records, deliveryId);
    if (current.project.path !== project.path) throw new Error('目标工程路径已变化。');
    return run(records, current);
  });
}
const versionConflict = () => Object.assign(new Error('项目或交付版本已变化，请重新检查后接入。'), { status: 409 });

export async function installGameExport(
  root,
  manifest,
  { deliveryId, packageSha256, projectRevision, deliveryRevision: expectedRevision },
) {
  return withCurrentDelivery(root, manifest, deliveryId, async (records, { record, indexed, saved, project, bytes }) => {
    if (record.packageSha256 !== packageSha256 || project.projectRevision !== projectRevision)
      throw versionConflict();
    const { files, ledger, ledgerPath, ledgerBefore, plan, conflicts } = await installPlan(project, bytes);
    const installation = ledger.installs?.[deliveryId];
    // The ledger can be newer than the project receipt after an interrupted
    // install. Reuse the files and finish recording that install on retry.
    const changed = plan.some((item) => item.action !== 'reuse' ||
      (ledger.files[item.path] && ledger.files[item.path].sha256 !== item.sha256));
    const recordInstall = !record.installedAt || changed ||
      (installation !== undefined && installation !== record.installRevision);
    if (conflicts.length)
      return {
        ...summary(record),
        installed: false,
        conflicts,
        message:
          '发现目标中的自定义或未知文件，未覆盖任何资源。Agent 应检查并保留这些修改，再决定合并方式。',
      };
    if (expectedRevision !== undefined && expectedRevision !== deliveryRevision(record) && recordInstall)
      throw versionConflict();
    return commitInstall(records, { record, indexed, saved, project, files, ledger, ledgerPath, ledgerBefore, plan, recordInstall });
  });
}

async function commitInstall(records, { record, indexed, saved, project, files, ledger, ledgerPath, ledgerBefore, plan, recordInstall }) {
  const { deliveryId } = record;
  const written = [];
  let ledgerWritten = false;
  let installed = record;
  try {
    for (const item of plan) {
      if (item.action === 'reuse') continue;
      const destination = await containedPath(project.path, item.path, true);
      let before = null;
      if (await exists(destination)) before = await readFile(destination);
      if ((before ? sha(before) : null) !== item.previousSha256)
        throw new Error('接入期间目标文件发生变化：' + item.path);
      if (before) {
        let backup = await containedPath(
          project.path,
          'forge_imports/' + deliveryId + '/backups/' + item.path,
          true,
        );
        // Preserve the original backup path for the first install. Returning
        // to this delivery from another version requires its own backup.
        if (await exists(backup) && sha(await readFile(backup)) !== item.previousSha256) {
          backup = await containedPath(project.path,
            `forge_imports/${deliveryId}/backups-by-sha256/${item.previousSha256}/${item.path}`, true);
        }
        if (await exists(backup)) {
          if (sha(await readFile(backup)) !== item.previousSha256)
            throw new Error('现有备份与待替换文件不一致。');
        } else await publishFile(backup, before);
      }
      await publishFile(destination, files.get(item.path), { replace: before !== null });
      written.push({ ...item, before, destination });
    }
    let updateLedger = false;
    for (const item of plan) {
      if (ledger.files[item.path]?.sha256 === item.sha256) continue;
      ledger.files[item.path] = { sha256: item.sha256, deliveryId };
      updateLedger = true;
    }
    if (recordInstall) {
      installed = reviseDelivery(record, {
        status: 'assets_installed',
        installedAt: now(),
        installRevision: deliveryRevision(record) + 1,
        installedFiles: plan.map(({ path, sha256 }) => ({ path, sha256 })),
        integration: null,
      });
    }
    if (installed.installRevision !== undefined && ledger.installs?.[deliveryId] !== installed.installRevision) {
      (ledger.installs ??= {})[deliveryId] = installed.installRevision;
      updateLedger = true;
    }
    if (updateLedger) {
      await atomicJson(project.path, 'forge_imports/install-ledger.json', ledger);
      ledgerWritten = true;
    }
    if (recordInstall || !saved) await writeProjectDelivery(installed);
  } catch (error) {
    for (const item of written.reverse())
      if ((await exists(item.destination))?.isFile() && sha(await readFile(item.destination)) === item.sha256) {
        if (item.before) await publishFile(item.destination, item.before, { replace: true });
        else await unlink(item.destination);
      }
    if (ledgerWritten) {
      if (ledgerBefore) await publishFile(ledgerPath, ledgerBefore, { replace: true });
      else await unlink(ledgerPath);
    }
    throw error;
  }
  // The project receipt and resources have committed. A failed mirror write
  // cannot roll either back; a later request can republish that same receipt.
  await mirrorDelivery(records, installed, indexed);
  return {
    ...summary(installed),
    installed: true,
    entryScenes: installed.package.entryScenes,
    spriteFrames: installed.package.spriteFrames,
    runtime: installed.package.runtime,
    details: installed.package.details,
    changedFiles: written.map((f) => f.path),
    next: '按工程 Skill 检查真实场景与脚本，接好挂载、动画和交互信号，然后记录接入及引擎验收结果。',
  };
}
export async function completeGameExport(root, manifest, input) {
  return withCurrentDelivery(root, manifest, input.deliveryId, async (records, { record, indexed, saved, project, bytes }) => {
    if (input.packageSha256 !== undefined && input.packageSha256 !== record.packageSha256)
      throw versionConflict();
    if (input.status === 'integrated') {
      if (!record.installedAt) throw new Error('尚未安装资源，不能标记接入完成。');
      if (!input.files.length) throw new Error('请提供实际接入的场景或脚本文件。');
      const { plan, ledger } = await installPlan(project, bytes);
      if (ledger.installs?.[record.deliveryId] !== record.installRevision ||
          plan.some((item) => item.action !== 'reuse' || ledger.files[item.path]?.sha256 !== item.sha256))
        throw new Error('已安装的交付资源发生变化，请重新检查并安装此交付后再记录接入。');
    }
    if (
      input.engine.status === 'passed' &&
      (!/^4\.\d+(?:\.|$)/.test(input.engine.version || '') || !input.engine.evidence.trim())
    )
      throw new Error('引擎通过需要实际 Godot 4 版本和执行证据。');
    const evidence = [];
    for (const suppliedPath of input.files) {
      const name = suppliedPath.replace(/^res:\/\//, '');
      if (!/\.(gd|tscn|tres)$/.test(name))
        throw new Error('接入证据应为实际场景、资源或脚本。');
      const file = await containedPath(project.path, name);
      const info = await lstat(file);
      if (!info.isFile()) throw new Error('接入证据应为实际场景、资源或脚本。');
      if (info.size > 16 * 1024 * 1024) throw new Error('接入证据文件过大。');
      evidence.push({ path: name, sha256: sha(await readFile(file)) });
    }
    const integration = {
      summary: input.summary,
      files: evidence,
      engine: { ...input.engine, baselineValidated: input.engine.status === 'passed' && /^4\.7(?:\.|$)/.test(input.engine.version || '') },
      evidenceSource: 'agent-reported',
      recordedAt: record.integration?.recordedAt,
    };
    const repeated = record.status === input.status && isDeepStrictEqual(record.integration, integration);
    if (!repeated && input.deliveryRevision !== undefined && input.deliveryRevision !== deliveryRevision(record))
      throw versionConflict();
    const completed = repeated ? record : reviseDelivery(record, {
      status: input.status, integration: { ...integration, recordedAt: now() },
    });
    if (!repeated || !saved) await writeProjectDelivery(completed);
    await mirrorDelivery(records, completed, indexed);
    return summary(completed);
  });
}
export async function readGamePackageRequest(request) {
  if (
    (request.headers['content-type'] || '').split(';')[0] !== 'application/zip'
  )
    throw new Error('请提供 Godot ZIP。');
  let size = 0;
  const chunks = [];
  for await (const c of request) {
    size += c.length;
    if (size > MAX_GODOT_BYTES) throw new Error('Godot 包超过 256 MB。');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
