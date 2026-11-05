import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createProject, normalizeProject } from '../../features/interactable-editor/contract.mjs';
import { createScene, validateScene } from '../../features/scene-composer/model.mjs';
import { updateSplitSourceState } from '../../features/scene-composer/map-split-source.mjs';
import { readAsset } from '../../features/interactable-editor/godot-builder.mjs';
import { documentId, documentInputs } from './document-contract.mjs';
import { applySceneCommands, applyInteractableCommands } from './editor-commands.mjs';
import { sceneWarnings } from '../../features/scene-composer/model.mjs';
import { createDocumentSimulation, replaySimulationEvents, simulationInstanceState } from '../../features/scene-composer/simulation-replay.mjs';

const locks = new Map();
const MAX_CONTENT_BYTES = 340 * 1024 * 1024;
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
export const documentError = (message, status = 400, code = 'INVALID_DOCUMENT', details = {}) => Object.assign(new Error(message), { status, code, ...details });
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = (operation, input) => hash(JSON.stringify(canonical({ operation, input })));
export function documentDirectory(root, manifest) {
  // Test storage stays inside its task namespace, including private candidate
  // workspaces. An older manifest cannot redirect tests to production documents.
  const namespace = path.posix.dirname(manifest.workspace.taskDirectory.replaceAll('\\', '/'));
  const configured = manifest.workspace.documentDirectory;
  const allowed = configured && (!process.env.WORKBENCH_TEST_RUN || inside(path.resolve(root, namespace), path.resolve(root, configured)));
  const relative = allowed ? configured : `${namespace}/editor-documents`;
  const directory = path.resolve(root, relative);
  if (!inside(path.resolve(root), directory)) throw documentError('Document directory must be inside the workspace.');
  return directory;
}
const inside = (base, target) => { const relative = path.relative(base, target); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
const directoryFor = (root, manifest, id) => path.join(documentDirectory(root, manifest), `document-${hash(documentId.parse(id)).slice(0, 40)}`);
async function safePath(root, target, createDirectory = false) {
  const base = await realpath(root);
  let ancestor = target;
  while (true) {
    try {
      const resolved = await realpath(ancestor);
      if (resolved !== base && !inside(base, resolved)) throw documentError('Document storage crosses a workspace symlink boundary.', 400, 'UNSAFE_DOCUMENT_PATH');
      const expected = path.resolve(base, path.relative(path.resolve(root), ancestor));
      if (path.relative(expected, resolved) !== '') throw documentError('Document storage cannot be redirected by a symlink.', 400, 'UNSAFE_DOCUMENT_PATH');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw documentError('Document storage has no workspace ancestor.');
      ancestor = parent;
    }
  }
  if (createDirectory) await mkdir(target, { recursive: true });
  return target;
}
async function readHead(root, manifest, id) {
  try {
    const headFile = path.join(directoryFor(root, manifest, id), 'head.json');
    await safePath(root, headFile);
    const head = JSON.parse(await readFile(headFile, 'utf8'));
    if (head.id !== id || !['scene', 'interactable'].includes(head.kind) || !Number.isSafeInteger(head.revision) || head.revision < 1 || !Array.isArray(head.versions) || head.versions.length !== head.revision) throw documentError('Document history is corrupt.', 500, 'CORRUPT_DOCUMENT');
    for (let i = 0; i < head.versions.length; i++) {
      const v = head.versions[i];
      if (v.revision !== i + 1 || !/^[a-f0-9]{64}$/.test(v.sha256) || v.file !== `versions/${v.revision}-${v.sha256}.json` || typeof v.commandId !== 'string' || !/^[a-f0-9]{64}$/.test(v.fingerprint)) throw documentError('Document history is corrupt.', 500, 'CORRUPT_DOCUMENT');
    }
    return head;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function readVersion(root, manifest, head, revision = head.revision) {
  const version = head.versions.find(v => v.revision === revision);
  if (!version) throw documentError('Document revision does not exist.', 404, 'REVISION_NOT_FOUND');
  const base = await realpath(directoryFor(root, manifest, head.id));
  await safePath(root, base);
  const file = await realpath(path.join(base, version.file));
  if (!inside(base, file) || (await stat(file)).size > MAX_CONTENT_BYTES) throw documentError('Invalid document snapshot path.', 500, 'CORRUPT_DOCUMENT');
  const bytes = await readFile(file);
  if (hash(bytes) !== version.sha256) throw documentError('Document snapshot has changed or is corrupt.', 500, 'CORRUPT_DOCUMENT');
  const document = JSON.parse(bytes.toString('utf8'));
  if (document.id !== head.id || document.kind !== head.kind || document.revision !== revision || document.contentHash !== hash(JSON.stringify(document.content))) throw documentError('Document snapshot identity mismatch.', 500, 'CORRUPT_DOCUMENT');
  return document;
}
async function locked(root, manifest, id, fn) {
  const key = directoryFor(root, manifest, id);
  const current = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, current);
  try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
}
function contentIdentity(kind, content) { return kind === 'scene' ? content.id : content.projectId; }
function validateContent(kind, input, id) {
  const clean = kind === 'scene' ? validateScene(input) : normalizeProject(input);
  if (contentIdentity(kind, clean) !== id) throw documentError('Document identity cannot change. Create a new document to fork it.');
  return clean;
}
async function freezeContent(root, manifest, kind, input, id) {
  const content = validateContent(kind, input, id);
  const references = kind === 'scene' ? [
    ...(content.map ? [{ owner: content.map, mime: 'application/zip', name: 'map source' }, ...content.map.layers.map(layer => ({ owner: layer, mime: 'image/png', name: layer.name, width: layer.width, height: layer.height }))] : []),
    ...[...(content.mapSplit?.baseline || []), ...(content.mapSplit?.elements || [])].flatMap(element =>
      element.parts.flatMap(part => (part.mask ? ['source','mask'] : ['source']).map(key =>
        ({owner:part,key,mime:'image/png',name:element.name,width:part.width,height:part.height})))),
    ...content.materials.flatMap(m => m.project.assets.map(asset => ({ owner: asset, mime: asset.mime, name: asset.name }))),
  ] : content.assets.map(asset => ({ owner: asset, mime: asset.mime, name: asset.name }));
  let total = 0;
  const cache = new Map();
  const base = await realpath(root);
  const allowed = [path.resolve(base, manifest.workspace.outputDirectory), path.resolve(base, 'work/assets/interactables')];
  for (const ref of references) {
    const source = ref.owner[ref.key || 'source'];
    const key = `${ref.mime}\0${source}`;
    let frozen = cache.get(key);
    if (frozen && ref.width) {
      const metadata = await sharp(Buffer.from(frozen.slice(frozen.indexOf(',') + 1), 'base64'), { limitInputPixels: 64 * 1024 * 1024 }).metadata();
      if (metadata.width !== ref.width || metadata.height !== ref.height) throw documentError('Media dimensions do not match the layer declaration.');
    }
    if (!frozen) {
      let bytes;
      if (source.startsWith('data:')) {
        const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(source);
        if (!match || match[1] !== ref.mime || match[2].length % 4 !== 0) throw documentError(`Invalid embedded media: ${ref.name}`);
        bytes = Buffer.from(match[2], 'base64');
      } else {
        if (path.isAbsolute(source)) throw documentError('Media source must be a workspace-relative asset path.');
        const file = await realpath(path.resolve(base, source));
        if (!allowed.some(directory => inside(directory, file)) || !inside(base, file)) throw documentError('Media source must be a saved output or imported interactable asset.');
        if (!(await stat(file)).isFile() || (await stat(file)).size > MAX_MEDIA_BYTES) throw documentError('Invalid media file.');
        bytes = await readFile(file);
      }
      if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw documentError('Media is empty or too large.');
      total += bytes.length;
      if (total > MAX_MEDIA_BYTES) throw documentError('Document media exceeds 256 MB.');
      if (ref.mime.startsWith('image/')) {
        const meta = await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 }).metadata();
        const expected = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[ref.mime];
        if (meta.format !== expected || (meta.pages || 1) !== 1 || (ref.width && (meta.width !== ref.width || meta.height !== ref.height))) throw documentError('Media dimensions or format do not match its declaration.');
        await sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 }).raw().toBuffer();
      }
      if (ref.owner.generation && hash(bytes) !== ref.owner.generation.sha256) throw documentError('Generated media hash does not match the selected original asset.');
      frozen = `data:${ref.mime};base64,${bytes.toString('base64')}`;
      cache.set(key, frozen);
    }
    // Verify provenance even when identical media bytes occur in multiple assets.
    if (ref.owner.generation) await readAsset({ ...ref.owner, source: frozen }, root);
    ref.owner[ref.key || 'source'] = frozen;
  }
  if (Buffer.byteLength(JSON.stringify(content)) > MAX_CONTENT_BYTES) throw documentError('Document content is too large.', 413);
  return validateContent(kind, content, id);
}
const viewPath = (kind, id) => `${kind === 'scene' ? '/tools/scene-composer' : '/tools/interactable-editor'}?document=${encodeURIComponent(id)}`;
async function commit(root, manifest, head, { id, kind, content, commandId, fingerprint: requestHash, commandResults = [], restoredFrom }) {
  content = structuredClone(content);
  const revision = (head?.revision || 0) + 1;
  if (kind === 'scene') content.revision = revision;
  const frozen = await freezeContent(root, manifest, kind, content, id);
  const now = new Date().toISOString();
  const document = { schemaVersion: 1, id, kind, revision, name: frozen.name, createdAt: head?.createdAt || now, updatedAt: now, contentHash: hash(JSON.stringify(frozen)), content: frozen, viewPath: viewPath(kind, id), commandId, commandResults, ...(restoredFrom ? { restoredFrom } : {}) };
  const bytes = `${JSON.stringify(document)}\n`;
  const sha256 = hash(bytes);
  const file = `versions/${revision}-${sha256}.json`;
  const directory = directoryFor(root, manifest, id);
  await safePath(root, path.join(directory, 'versions'), true);
  // Immutable snapshots are published before the single atomic head pointer.
  await writeFile(path.join(directory, file), bytes, { flag: 'wx' });
  const next = { schemaVersion: 1, id, kind, name: document.name, revision, contentHash: document.contentHash, createdAt: document.createdAt, updatedAt: now, versions: [...(head?.versions || []), { revision, file, sha256, commandId, fingerprint: requestHash, name: document.name, contentHash: document.contentHash, updatedAt: now }] };
  const temporary = path.join(directory, `head-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(next)}\n`, { flag: 'wx' });
  await rename(temporary, path.join(directory, 'head.json'));
  return { document, currentRevision: revision, replayed: false };
}
async function mutate(root, manifest, operation, input, modify) {
  const parsed = documentInputs[operation].parse(input);
  return locked(root, manifest, parsed.documentId, async () => {
    const head = await readHead(root, manifest, parsed.documentId);
    if (!head) throw documentError('Document does not exist.', 404, 'DOCUMENT_NOT_FOUND');
    const requestHash = fingerprint(operation, parsed);
    const previous = head.versions.find(v => v.commandId === parsed.commandId);
    if (previous) {
      if (previous.fingerprint !== requestHash) throw documentError('commandId was already used with a different request.', 409, 'COMMAND_ID_REUSED', { currentRevision: head.revision });
      return { document: await readVersion(root, manifest, head, previous.revision), currentRevision: head.revision, replayed: true };
    }
    if (head.revision !== parsed.expectedRevision) throw documentError('Document changed in another editor. Refresh before applying this edit; keep the local draft.', 409, 'REVISION_CONFLICT', { currentRevision: head.revision, expectedRevision: parsed.expectedRevision });
    const current = await readVersion(root, manifest, head);
    const change = await modify(parsed, current, head);
    return commit(root, manifest, head, { id: head.id, kind: head.kind, ...change, commandId: parsed.commandId, fingerprint: requestHash });
  });
}
export async function createDocument(root, manifest, input) {
  const parsed = documentInputs['document-create'].parse(input);
  const id = parsed.documentId || (parsed.content && contentIdentity(parsed.kind, parsed.content)) || `${parsed.kind}-${hash(`${parsed.kind}\0${parsed.commandId}`).slice(0, 32)}`;
  documentId.parse(id);
  return locked(root, manifest, id, async () => {
    const head = await readHead(root, manifest, id);
    const requestHash = fingerprint('document-create', parsed);
    if (head) {
      const previous = head.versions.find(v => v.commandId === parsed.commandId);
      if (previous?.fingerprint === requestHash) return { document: await readVersion(root, manifest, head, previous.revision), currentRevision: head.revision, replayed: true };
      throw documentError('Document ID already exists. Read it before editing.', 409, 'DOCUMENT_EXISTS', { currentRevision: head.revision });
    }
    let content = parsed.content;
    if (content === undefined) {
      content = parsed.kind === 'scene' ? createScene(parsed.name) : createProject();
      if (parsed.kind === 'scene') content.id = id; else content.projectId = id;
    }
    if (parsed.name) content = { ...content, name: parsed.name };
    return commit(root, manifest, null, { id, kind: parsed.kind, content, commandId: parsed.commandId, fingerprint: requestHash });
  });
}
export async function getDocument(root, manifest, input) {
  const parsed = documentInputs['document-get'].parse(input);
  const head = await readHead(root, manifest, parsed.documentId);
  if (!head) throw documentError('Document does not exist.', 404, 'DOCUMENT_NOT_FOUND');
  if (parsed.metadataOnly) {
    const version = head.versions.find(v => v.revision === (parsed.revision || head.revision));
    if (!version) throw documentError('Document revision does not exist.', 404, 'REVISION_NOT_FOUND');
    if (version.contentHash) return { document: { schemaVersion: 1, id: head.id, kind: head.kind, revision: version.revision, name: version.name, contentHash: version.contentHash, createdAt: head.createdAt, updatedAt: version.updatedAt, viewPath: viewPath(head.kind, head.id) }, currentRevision: head.revision };
  }
  const document = await readVersion(root, manifest, head, parsed.revision);
  if (parsed.metadataOnly) { const { content: _content, commandResults: _results, ...metadata } = document; return { document: metadata, currentRevision: head.revision }; }
  return { document, currentRevision: head.revision };
}
export async function listDocuments(root, manifest, input = {}) {
  const parsed = documentInputs.documents.parse(input);
  let entries;
  try { await safePath(root, documentDirectory(root, manifest)); entries = await readdir(documentDirectory(root, manifest)); } catch (error) { if (error.code === 'ENOENT') return { documents: [], total: 0, nextOffset: null }; throw error; }
  const documents = []; const issues = [];
  for (const entry of entries.filter(name => /^document-[a-f0-9]{40}$/.test(name))) {
    try {
      const record = JSON.parse(await readFile(path.join(documentDirectory(root, manifest), entry, 'head.json'), 'utf8'));
      const head = await readHead(root, manifest, record.id);
      if (!head || path.basename(directoryFor(root, manifest, head.id)) !== entry) throw new Error();
      if (parsed.kind && head.kind !== parsed.kind) continue;
      documents.push({ id: head.id, kind: head.kind, name: head.name, revision: head.revision, createdAt: head.createdAt, updatedAt: head.updatedAt, viewPath: viewPath(head.kind, head.id) });
    } catch { issues.push({ record: entry, message: 'Document history is unreadable.' }); }
  }
  documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { documents: documents.slice(parsed.offset, parsed.offset + parsed.limit), total: documents.length, nextOffset: parsed.offset + parsed.limit < documents.length ? parsed.offset + parsed.limit : null, ...(issues.length ? { issues } : {}) };
}
export const applyDocumentCommands = (root, manifest, input) => mutate(root, manifest, 'document-apply', input, (parsed, current) => current.kind === 'scene' ? applySceneCommands(current.content, parsed.commands) : applyInteractableCommands(current.content, parsed.commands));
export const saveDocument = (root, manifest, input, { respectLocks = false } = {}) => mutate(root, manifest, 'document-save', input, async (parsed, current, head) => {
  const content = current.kind === 'scene' && current.content.mapSplit ? structuredClone(parsed.content) : parsed.content;
  if (current.kind === 'scene') {
    let previous = current.content;
    const split = content.mapSplit;
    if (previous.mapSplit?.stale && split && !split.stale && split.candidateId === previous.mapSplit.candidateId && split.candidateRevision === previous.mapSplit.candidateRevision) {
      // Undo after a shared save must prove the restored source against the
      // active version, rather than the replacement map that retired it.
      let matched = false;
      for (let revision = current.revision - 1; revision > 0; revision--) {
        const { content: prior } = await readVersion(root, manifest, head, revision);
        const priorSplit = prior.mapSplit;
        if (priorSplit?.candidateId !== split.candidateId || priorSplit.candidateRevision !== split.candidateRevision) break;
        if (!priorSplit.stale && priorSplit.sourceHash === split.sourceHash) {
          previous = prior;
          matched = true;
          break;
        }
      }
      if (!matched) { split.stale = true; split.review = 'unverified'; }
    }
    updateSplitSourceState(previous, content);
  }
  if (respectLocks && current.kind === 'scene') {
    const next = validateScene(content);
    for (const instance of current.content.instances.filter(node => node.locked)) {
      const replacement = next.instances.find(node => node.id === instance.id);
      const placement = node => node && ({ materialId: node.materialId, x: node.x, y: node.y, scale: node.scale, flipH: node.flipH, anchor: node.anchor });
      if (JSON.stringify(placement(instance)) !== JSON.stringify(placement(replacement))) throw documentError('AI snapshot saves cannot move, replace or remove locked instances. Unlock them in a separate typed command first.', 400, 'LOCKED_NODE');
    }
    for (const element of current.content.mapSplit?.elements.filter(node => node.locked) || []) {
      const nextElement = next.mapSplit?.elements.find(node => node.id === element.id);
      if (!nextElement || fingerprint('split-element', {...nextElement,locked:true}) !== fingerprint('split-element', element))
        throw documentError('请先单独解锁此分层物件，再修改或移除它。', 409, 'LOCKED_NODE');
    }
  }
  return { content };
});
export const restoreDocument = (root, manifest, input) => mutate(root, manifest, 'document-restore', input, async (parsed, current, head) => ({ content: (await readVersion(root, manifest, head, parsed.revision)).content, restoredFrom: parsed.revision }));

export async function validateDocument(root, manifest, input) {
  const parsed = documentInputs['document-validate'].parse(input);
  const { document } = await getDocument(root, manifest, parsed);
  const content = await freezeContent(root, manifest, document.kind, document.content, document.id);
  return { documentId: document.id, revision: document.revision, contentHash: document.contentHash, valid: true, diagnostics: document.kind === 'scene' ? sceneWarnings(content).map(message => ({ severity: 'warning', message })) : [], counts: document.kind === 'scene' ? { materials: content.materials.length, instances: content.instances.length, mapLayers: content.map?.layers.length || 0, links: content.links.length } : { objects: content.objects.length, assets: content.assets.length }, engineValidated: false };
}
export async function simulateDocument(root, manifest, input) {
  const parsed = documentInputs['document-simulate'].parse(input);
  const { document } = await getDocument(root, manifest, { documentId: parsed.documentId, revision: parsed.revision });
  const simulation = createDocumentSimulation(document.kind, document.content);
  const replay = replaySimulationEvents(simulation, parsed.events);
  const { events, eventCount, steps, states, truncated, linkDiagnostics, linkAttempts } = replay;
  const checks = (parsed.expectEvents || []).map(expected => { const actual = events.filter(event => event.name === expected.name && (!expected.instanceId || event.instanceId === expected.instanceId)).length; return { ...expected, actual, passed: actual >= expected.count }; });
  for (const expected of parsed.expectStates || []) {
    const actual = simulationInstanceState(simulation, expected.instanceId);
    const fields = Object.keys(expected).filter(key => key !== 'instanceId');
    checks.push({ type: 'state', ...expected, actual, passed: Boolean(actual && fields.length && fields.every(key => expected[key] === actual[key])) });
  }
  return { documentId: document.id, revision: document.revision, contentHash: document.contentHash, passed: !truncated && linkDiagnostics.length === 0 && checks.every(check => check.passed), time: simulation.time, actor: simulation.actor, focus: simulation.focus?.id || null, active: simulation.active?.id || null, waiting: simulation.waiting?.type || null, states, events, eventCount, truncated, checks, steps, linkDiagnostics, linkAttempts, engineValidated: false, limitations: ['Uses the existing deterministic interaction simulator; does not simulate Godot physics, navigation, audio playback or persistent game saves.'] };
}
export async function documentRequest(root, manifest, operation, input, { agent = false } = {}) {
  const handlers = { documents: listDocuments, 'document-get': getDocument, 'document-create': createDocument, 'document-apply': applyDocumentCommands, 'document-restore': restoreDocument, 'document-validate': validateDocument, 'document-simulate': simulateDocument };
  if (operation === 'document-save') return saveDocument(root, manifest, input, { respectLocks: agent });
  if (operation === 'document-adopt-image') {
    const { adoptDocumentImage } = await import('./document-assets.mjs');
    return adoptDocumentImage(root, manifest, documentInputs[operation].parse(input));
  }
  if (operation === 'document-export') {
    const { exportSceneDocument } = await import('./scene-export.mjs');
    return exportSceneDocument(root, manifest, documentInputs[operation].parse(input));
  }
  if (operation === 'document-observe') {
    const parsed = documentInputs[operation].parse(input);
    const { document } = await getDocument(root, manifest, { documentId: parsed.documentId, revision: parsed.revision });
    if (document.kind !== 'scene') throw documentError('Visual observation currently supports scene documents.');
    const { observeScene } = await import('./scene-observation.mjs');
    const { documentId: _documentId, ...options } = parsed;
    return observeScene(root, manifest, document, options);
  }
  if (!handlers[operation]) throw documentError('Unknown document operation.');
  return handlers[operation](root, manifest, input);
}
