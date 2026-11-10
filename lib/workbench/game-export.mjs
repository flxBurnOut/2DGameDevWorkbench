import {
  mkdir,
  readFile,
  writeFile,
  lstat,
  realpath,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

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
  /^(scenes|forge_sprites|forge_maps|forge_packages|addons\/workbench_interaction(?:_copyworms)?)\//;

/** Reject junctions/symlinks beneath an explicitly selected root, including existing parents. */
export async function containedPath(root, relative, createParents = false) {
  safePackagePath(relative);
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await exists(current);
    if (
      info?.isSymbolicLink() ||
      (info && i < parts.length - 1 && !info.isDirectory())
    )
      throw new Error('目标路径包含链接或非目录，已停止写入。');
    if (!info && createParents && i < parts.length - 1) await mkdir(current);
  }
  if (
    !path.relative(root, current) ||
    path.relative(root, current).startsWith('..') ||
    path.isAbsolute(path.relative(root, current))
  )
    throw new Error('目标路径越界。');
  return current;
}
async function atomicJson(root, relative, value) {
  const dest = await containedPath(root, relative, true),
    temporary = dest + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, jsonBytes(value), { flag: 'wx' });
  await rename(temporary, dest);
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
  const deliveryId =
    'delivery-' + sha(project.path + '\n' + packageSha256).slice(0, 32);
  const records = await registry(root, manifest);
  const existing = await exists(path.join(records, deliveryId + '.json'));
  if (existing) {
    const current = await getGameExport(root, manifest, { deliveryId });
    return {
      ...summary(current),
      reused: true,
      nextTool: 'workbench_get_game_export',
    };
  }
  const inbox = 'forge_imports/' + deliveryId;
  const destination = await containedPath(
    project.path,
    inbox + '/package.zip',
    true,
  );
  await writeFile(
    await containedPath(project.path, 'forge_imports/.gdignore', true),
    '',
    { flag: 'a' },
  );
  // Exclusive create and immutable packages make retries safe; no project or gameplay files are replaced.
  try {
    await writeFile(destination, prepared.bytes, { flag: 'wx' });
  } catch (e) {
    if (
      e.code !== 'EEXIST' ||
      sha(await readFile(destination)) !== packageSha256
    )
      throw e;
  }
  const record = {
    format: 'forge-game-delivery',
    version: 1,
    deliveryId,
    title: String(title).slice(0, 200),
    createdAt: now(),
    updatedAt: now(),
    status: 'awaiting_agent',
    project: { path: project.path, name: project.name },
    source,
    package: prepared.manifest,
    packageSha256,
    inboxPath: path.join(project.path, inbox),
    integration: null,
  };
  await atomicJson(project.path, inbox + '/delivery.json', record);
  await writeFile(
    await containedPath(project.path, inbox + '/README.txt', true),
    'Forge 游戏项目交付\n\npackage.zip 是可解压到项目根目录的实际资源包。WorkBuddy 通过 Forge MCP 读取此交付并接入当前游戏。此目录是保留的原始交付，不会被 Godot 当作脚本导入。\n当前状态：等待 Agent 检查项目并完成接入。\n',
  );
  await atomicJson(records, deliveryId + '.json', record);
  await atomicJson(records, 'selected-project.json', { path: project.path });
  return {
    ...summary(record),
    reused: false,
    nextTool: 'workbench_get_game_export',
  };
}
export async function listGameExports(
  root,
  manifest,
  { pendingOnly = true, offset = 0, limit = 20, snapshot } = {},
) {
  const records = await registry(root, manifest),
    all = [];
  for (const name of await readdir(records))
    if (/^delivery-[a-f0-9]{32}\.json$/.test(name))
      all.push(await readJson(await containedPath(records, name)));
  const selected = all
    .filter((r) => !pendingOnly || r.status !== 'integrated')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.deliveryId.localeCompare(b.deliveryId));
  const currentSnapshot = sha(JSON.stringify(selected.map((record) => [record.deliveryId, record.updatedAt, record.status])));
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
async function readDeliveryRecord(root, manifest, deliveryId) {
  if (!/^delivery-[a-f0-9]{32}$/.test(deliveryId))
    throw new Error('无效的游戏交付记录。');
  const record = await readJson(
    await containedPath(await registry(root, manifest), deliveryId + '.json'),
  );
  if (
    record.deliveryId !== deliveryId ||
    record.format !== 'forge-game-delivery'
  )
    throw new Error('交付记录身份不一致。');
  return record;
}
/** Read saved progress even when the destination project is currently unavailable.
 * Package integrity and project inspection remain the responsibility of getGameExport.
 */
export async function readGameExportSummary(root, manifest, { deliveryId }) {
  const record = await readDeliveryRecord(root, manifest, deliveryId);
  return {
    ...summary(record),
    package: { kind: record.package.kind, details: record.package.details || {} },
    createsTask: false,
  };
}
async function readDelivery(root, manifest, deliveryId) {
  const record = await readDeliveryRecord(root, manifest, deliveryId);
  const project = await inspectGameProject(record.project.path);
  const bytes = await readFile(
    await containedPath(
      project.path,
      'forge_imports/' + deliveryId + '/package.zip',
    ),
  );
  if (sha(bytes) !== record.packageSha256)
    throw new Error('交付包已改变，请从原资产重新导出。');
  return { record, project, bytes };
}
async function installPlan(project, bytes) {
  const files = await readGodotZip(bytes),
    plan = [],
    conflicts = [];
  let ledger = { files: {} };
  try {
    ledger = await readJson(
      await containedPath(project.path, 'forge_imports/install-ledger.json'),
    );
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
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
  return { files, ledger, plan, conflicts };
}
export async function getGameExport(root, manifest, { deliveryId }) {
  const { record, project, bytes } = await readDelivery(
    root,
    manifest,
    deliveryId,
  );
  const inspection = await inspectGameProject(project.path, {
      inventory: true,
    }),
    { plan, conflicts } = await installPlan(project, bytes);
  return {
    ...record,
    inspection,
    installPlan: plan,
    conflicts,
    guide: manifest.agentAssets.engineering.deliveryGuide,
    createsTask: false,
  };
}
async function persistDelivery(root, manifest, record) {
  record.updatedAt = now();
  await atomicJson(
    record.project.path,
    'forge_imports/' + record.deliveryId + '/delivery.json',
    record,
  );
  await atomicJson(
    await registry(root, manifest),
    record.deliveryId + '.json',
    record,
  );
}
export async function installGameExport(
  root,
  manifest,
  { deliveryId, packageSha256, projectRevision },
) {
  const { record, project, bytes } = await readDelivery(
    root,
    manifest,
    deliveryId,
  );
  if (
    record.packageSha256 !== packageSha256 ||
    project.projectRevision !== projectRevision
  )
    throw new Error('项目或交付版本已变化，请重新检查后接入。');
  const lock = await containedPath(
    project.path,
    'forge_imports/install.lock',
    true,
  );
  try {
    await writeFile(lock, deliveryId, { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST')
      throw new Error('此游戏项目正在接入另一份资源，请稍后重试。');
    throw e;
  }
  const written = [];
  const ledgerPath = await containedPath(
    project.path,
    'forge_imports/install-ledger.json',
  );
  const ledgerBefore = (await exists(ledgerPath))
    ? await readFile(ledgerPath)
    : null;
  let ledgerWritten = false;
  try {
    const { files, ledger, plan, conflicts } = await installPlan(
      project,
      bytes,
    );
    if (conflicts.length)
      return {
        ...summary(record),
        installed: false,
        conflicts,
        message:
          '发现目标中的自定义或未知文件，未覆盖任何资源。Agent 应检查并保留这些修改，再决定合并方式。',
      };
    for (const item of plan) {
      if (item.action === 'reuse') continue;
      const destination = await containedPath(project.path, item.path, true);
      let before = null;
      if (await exists(destination)) before = await readFile(destination);
      if ((before ? sha(before) : null) !== item.previousSha256)
        throw new Error('接入期间目标文件发生变化：' + item.path);
      if (before) {
        const backup = await containedPath(
          project.path,
          'forge_imports/' + deliveryId + '/backups/' + item.path,
          true,
        );
        if (await exists(backup)) {
          if (sha(await readFile(backup)) !== sha(before))
            throw new Error('现有备份与待替换文件不一致。');
        } else await writeFile(backup, before, { flag: 'wx' });
      }
      if (before) {
        const temporary = destination + '.forge-' + randomUUID() + '.tmp';
        await writeFile(temporary, files.get(item.path), { flag: 'wx' });
        await rename(temporary, destination);
      } else await writeFile(destination, files.get(item.path), { flag: 'wx' });
      written.push({ ...item, before, destination });
    }
    for (const item of plan)
      ledger.files[item.path] = { sha256: item.sha256, deliveryId };
    await atomicJson(project.path, 'forge_imports/install-ledger.json', ledger);
    ledgerWritten = true;
    if (record.status !== 'integrated') record.status = 'assets_installed';
    record.installedAt = now();
    record.installedFiles = plan.map((p) => ({
      path: p.path,
      sha256: p.sha256,
    }));
    await persistDelivery(root, manifest, record);
    return {
      ...summary(record),
      installed: true,
      entryScenes: record.package.entryScenes,
      spriteFrames: record.package.spriteFrames,
      runtime: record.package.runtime,
      details: record.package.details,
      changedFiles: written.map((f) => f.path),
      next: '按工程 Skill 检查真实场景与脚本，接好挂载、动画和交互信号，然后记录接入及引擎验收结果。',
    };
  } catch (error) {
    for (const item of written.reverse())
      if (sha(await readFile(item.destination)) === item.sha256) {
        if (item.before) await writeFile(item.destination, item.before);
        else await unlink(item.destination);
      }
    if (ledgerWritten) {
      if (ledgerBefore) await writeFile(ledgerPath, ledgerBefore);
      else await unlink(ledgerPath);
    }
    throw error;
  } finally {
    await unlink(lock);
  }
}
export async function completeGameExport(root, manifest, input) {
  const { record, project } = await readDelivery(
    root,
    manifest,
    input.deliveryId,
  );
  if (input.status === 'integrated' && !record.installedAt)
    throw new Error('尚未安装资源，不能标记接入完成。');
  if (input.status === 'integrated' && !input.files.length)
    throw new Error('请提供实际接入的场景或脚本文件。');
  if (
    input.engine.status === 'passed' &&
    (!/^4\.\d+(?:\.|$)/.test(input.engine.version || '') ||
      !input.engine.evidence.trim())
  )
    throw new Error('引擎通过需要实际 Godot 4 版本和执行证据。');
  const evidence = [];
  for (let name of input.files) {
    name = name.replace(/^res:\/\//, '');
    if (!/\.(gd|tscn|tres)$/.test(name))
      throw new Error('接入证据应为实际场景、资源或脚本。');
    const file = await containedPath(project.path, name);
    if ((await lstat(file)).size > 16 * 1024 * 1024)
      throw new Error('接入证据文件过大。');
    evidence.push({ path: name, sha256: sha(await readFile(file)) });
  }
  record.status = input.status;
  record.integration = {
    summary: input.summary,
    files: evidence,
    engine: {...input.engine, baselineValidated:input.engine.status==='passed' && /^4\.7(?:\.|$)/.test(input.engine.version||'')},
    evidenceSource: 'agent-reported',
    recordedAt: now(),
  };
  await persistDelivery(root, manifest, record);
  return summary(record);
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
