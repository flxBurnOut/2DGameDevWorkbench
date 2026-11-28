import { restoreTaskProject } from './task-project';
import { readSourcePackage } from './source-package.mjs';
import {
  readWorkspaceDraft,
  saveWorkspaceDraft,
} from '@/lib/workbench/browser-store';
import { interactableItemId, type WorkItem } from '@/lib/workbench/work-items';
import { workbenchModules } from '@/lib/workbench/modules';
import {
  normalizeProject,
  selectedProject,
  referencedAssets,
  assetSchema,
  projectSchema,
  describeError,
  makeId,
  type Asset,
  type InteractableProject,
} from './contract.mjs';

const DB = 'workbench-interactable-editor';
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('drafts');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export function interactableWorkItems(
  project: InteractableProject,
  completedIds: readonly string[] = [],
): WorkItem[] {
  const href = workbenchModules.find(
    (m) => m.id === 'interactable-editor',
  )!.href;
  const now = new Date().toISOString();
  return project.objects.map((object) => ({
    id: interactableItemId(project.projectId, object.definitionId),
    capabilityId: 'interactable-editor',
    userInitiated: true,
    title: object.displayName || project.name || '交互物',
    detail: completedIds.includes(object.definitionId)
      ? '交互物已导出'
      : `${project.name} · 本机草稿`,
    state: completedIds.includes(object.definitionId) ? 'completed' : 'saved',
    updatedAt: now,
    savedAt: now,
    draftKey: `interactable-project:${project.projectId}`,
    scopeId: project.projectId,
    href: `${href}?project=${encodeURIComponent(project.projectId)}&object=${encodeURIComponent(object.definitionId)}`,
    stage: completedIds.includes(object.definitionId) ? 1 : 0,
  }));
}
export async function saveDraft(
  project: InteractableProject,
  completedIds: readonly string[] = [],
) {
  await saveWorkspaceDraft(
    `interactable-project:${project.projectId}`,
    project,
    interactableWorkItems(project, completedIds),
    'interactable-current',
  );
}
export async function loadDraft(
  projectId?: string,
): Promise<InteractableProject | null> {
  const key = projectId
    ? `interactable-project:${projectId}`
    : await readWorkspaceDraft<string>('interactable-current');
  if (key) {
    const saved = await readWorkspaceDraft<InteractableProject>(key);
    if (saved) return projectSchema.parse(saved);
    if (!projectId) throw new Error('当前交互物草稿无法读取，原记录已保留。');
  }
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction('drafts').objectStore('drafts').get('current');
      r.onsuccess = () => {
        try {
          // A draft may contain unfinished references while the user edits feedback.
          const saved = r.result ? projectSchema.parse(r.result) : null;
          if (projectId && saved?.projectId !== projectId)
            throw new Error('找不到此交互物的本机草稿，请导入对应源文件。');
          resolve(saved);
        } catch (e) {
          reject(e);
        }
      };
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
const pendingTaskProjects = new Map<string, Promise<InteractableProject>>();
export async function loadTaskProject(taskId: string): Promise<InteractableProject> {
  const pending = pendingTaskProjects.get(taskId);
  if (pending) return pending;
  const loading = restoreTaskProject(taskId, {
    read: readWorkspaceDraft, save: saveWorkspaceDraft, request: fetch, items: interactableWorkItems,
  });
  pendingTaskProjects.set(taskId, loading);
  try { return await loading; }
  finally { if (pendingTaskProjects.get(taskId) === loading) pendingTaskProjects.delete(taskId); }
}

export function dataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () =>
      typeof r.result === 'string'
        ? resolve(r.result)
        : reject(new Error('素材读取失败'));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
export async function importAsset(file: File): Promise<Asset> {
  if (file.size > 64 * 1024 * 1024) throw new Error(`${file.name} 超过 64 MB`);
  const mime =
    file.type ||
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        mp3: 'audio/mpeg',
      } as Record<string, string>
    )[file.name.split('.').at(-1)?.toLowerCase() ?? ''];
  const source = await dataUrl(file.slice(0, file.size, mime));
  return assetSchema.parse({
    id: makeId('asset'),
    name: file.name,
    mime,
    source,
  });
}
export async function importProject(file: File): Promise<InteractableProject> {
  if (file.size > 256 * 1024 * 1024) throw new Error('项目包超过 256 MB');
  if (!file.name.toLowerCase().endsWith('.zip'))
    return normalizeProject(JSON.parse(await file.text()));
  return readSourcePackage(await file.arrayBuffer());
}
export function downloadJson(project: InteractableProject) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'interactable-project.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function exportProject(
  project: InteractableProject,
  selectedDefinitionIds: string[],
) {
  const clean = selectedProject(project, selectedDefinitionIds);
  const assets: Asset[] = [];
  for (const asset of referencedAssets(clean)) {
    if (asset.source.startsWith('data:')) {
      const blob = await (await fetch(asset.source)).blob();
      const response = await fetch('/api/workbench/interactable-assets', {
        method: 'POST',
        headers: {
          'content-type': asset.mime,
          'x-asset-name': encodeURIComponent(asset.name),
        },
        body: blob,
      });
      const result = (await response.json()) as {
        error?: string;
        source: string;
      };
      if (!response.ok || typeof result.source !== 'string')
        throw new Error(result.error ?? '素材上传失败');
      assets.push({ ...asset, source: result.source });
    } else assets.push(asset);
  }
  const response = await fetch('/api/workbench/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capabilityId: 'interactable-editor',
      input: {
        operation: 'export-godot',
        project: { ...clean, assets },
        selectedDefinitionIds,
      },
    }),
  });
  const result = (await response.json()) as {
    error?: string;
    taskId: string;
    status: string;
    outputs: string[];
  };
  if (!response.ok || result.status !== 'completed')
    throw new Error(result.error ?? describeError(result));
  return result as { taskId: string; status: string; outputs: string[] };
}

/** Publish editable source to the durable asset catalog without exporting a Godot package. */
export async function saveProjectToLibrary(project: InteractableProject) {
  const clean = normalizeProject(project);
  const assets: Asset[] = [];
  for (const asset of clean.assets) {
    if (!asset.source.startsWith('data:')) { assets.push(asset); continue; }
    const blob = await (await fetch(asset.source)).blob();
    const uploaded = await fetch('/api/workbench/interactable-assets', {method:'POST',headers:{'content-type':asset.mime,'x-asset-name':encodeURIComponent(asset.name)},body:blob});
    const result = await uploaded.json() as {source?:string;error?:string};
    if (!uploaded.ok || !result.source) throw new Error(result.error || '素材保存失败，当前草稿保留。');
    assets.push({...asset,source:result.source});
  }

  const response = await fetch('/api/workbench/tasks', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capabilityId:'interactable-editor',input:{operation:'save-project',project:{...clean,assets}}})});
  const result = await response.json() as {taskId?:string;status?:string;error?:string};
  if(!response.ok || result.status!=='completed' || !result.taskId) throw new Error(result.error || '保存到资产库失败，当前草稿保留。');
  return result;
}
