import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import sharp from 'sharp';
import {
  documentDirectory,
  getDocument,
  saveDocument,
} from './editor-documents.mjs';
import {
  atomic,
  fingerprint,
  hash,
  json,
  lock,
  safe,
} from './image-edit-store.mjs';
import {
  installMapSplit,
  removeMapSplitElements,
  splitCollisionTransfer,
  validateMapSplit,
} from '../../features/scene-composer/map-split.mjs';
import { mergeSplitRevision } from './scene-split-merge.mjs';
import { mapSplitPartRenderEntries } from '../../features/scene-composer/render-model.mjs';
import { sceneSplitInputs } from './scene-split-contract.mjs';
import { freezeMapPixels, buildSplitElements } from './map-split-pixels.mjs';
import { coarseMapSpecs, mapSplitSettings } from './map-split-vision.mjs';

const active = new Set();
const failure = (message, code = 'INVALID_SCENE_SPLIT', status = 400) =>
  Object.assign(new Error(message), { code, status });
const directory = (root, manifest, docId) =>
  path.join(documentDirectory(root, manifest), 'map-splits', hash(docId));
const headPath = (dir, id) => path.join(dir, id, 'head.json');
const versionPath = (dir, id, rev) => path.join(dir, id, `v${rev}.json`);
const hasSam = (selection) =>
  selection.type === 'sam' || (selection.selections || []).some(hasSam);
const usesSam = (specs = []) =>
  specs.some((spec) => spec.parts.some((part) => hasSam(part.selection)));
async function sceneAt(root, manifest, documentId, revision, current = false) {
  const record = await getDocument(root, manifest, {
    documentId,
    ...(revision ? { revision } : {}),
  });
  if (current && revision !== record.currentRevision)
    throw Object.assign(
      failure(
        '场景已有新版本，请保留草稿并核对新版。',
        'REVISION_CONFLICT',
        409,
      ),
      { currentRevision: record.currentRevision },
    );
  if (record.document.kind !== 'scene' || !record.document.content.map)
    throw failure('请先在已保存的场景中选择地图。');
  return record.document;
}
async function head(root, dir, id) {
  const value = await json(await safe(root, headPath(dir, id)));
  if (!value || value.candidateId !== id)
    throw failure('分层候选不存在。', 'SPLIT_NOT_FOUND', 404);
  return value;
}
async function readVersion(root, dir, h, rev) {
  if (!rev || !h.versions.some((v) => v.revision === rev))
    throw failure('该候选修订版本不存在。', 'SPLIT_VERSION_NOT_FOUND', 404);
  const value = await json(
    await safe(root, versionPath(dir, h.candidateId, rev)),
  );
  if (
    !value ||
    value.candidateId !== h.candidateId ||
    value.revision !== rev ||
    value.documentId !== h.documentId
  )
    throw failure('分层候选记录损坏。', 'CORRUPT_SPLIT', 500);
  return value;
}
async function publish(root, dir, h, record, input) {
  record.split = validateMapSplit(record.split);
  await atomic(root, versionPath(dir, h.candidateId, record.revision), record);
  h.versions.push({
    revision: record.revision,
    commandId: input.commandId,
    requestHash: fingerprint(input),
    executionId: h.executionId,
  });
  h.status = 'ready';
  delete h.error;
  if (h.job?.commandId === input.commandId)
    h.job.resultRevision = record.revision;
  else delete h.job;
  await atomic(root, headPath(dir, h.candidateId), h);
}
function elementInfo(el) {
  return {
    ...el,
    parts: el.parts.map(({ source, mask, ...part }) => ({
      ...part,
      sha256: hash(Buffer.from(source.split(',')[1], 'base64')),
      hasMask: Boolean(mask),
    })),
  };
}
function compactConflicts(value) {
  if (Array.isArray(value)) return value.map(compactConflicts);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, compactConflicts(v)]),
    );
  return typeof value === 'string' && value.startsWith('data:')
    ? { sha256: hash(Buffer.from(value.split(',')[1], 'base64')) }
    : value;
}
function summary(h, record, includeSpecs = false) {
  const status =
    h.status === 'running' && !active.has(h.executionId)
      ? 'attention_required'
      : h.status;
  return {
    candidateId: h.candidateId,
    documentId: h.documentId,
    status,
    revision: record?.revision || 0,
    sourceRevision: record?.sourceRevision ?? h.sourceRevision,
    createdAt: h.createdAt,
    mode: h.mode,
    ...(h.job
      ? {
          execution: {
            id: h.executionId,
            operation: h.job.operation,
            commandId: h.job.commandId,
            candidateRevision: h.job.input.candidateRevision,
            resultRevision: h.job.resultRevision,
          },
        }
      : {}),
    ...(includeSpecs &&
    h.job &&
    status !== 'running' &&
    status !== 'ready' &&
    (h.location || h.job.operation === 'revise' || (h.mode !== 'vision' && h.status === 'running'))
      ? { recoveryRequest: { operation: h.job.operation, input: h.job.input } }
      : {}),
    ...(h.error ? { error: h.error } : {}),
    ...(h.receipt ? { receipt: h.receipt } : {}),
    ...(h.service
      ? { service: h.service, reservedVisionCalls: h.reservedVisionCalls }
      : {}),
    ...(record
      ? {
          width: record.width,
          height: record.height,
          origin: record.split.origin,
          sourceHash: record.split.sourceHash,
          review: record.split.review,
          elements: record.split.elements.map(elementInfo),
          conflicts: compactConflicts(record.split.conflicts),
          reviewEvidence: record.reviewEvidence,
          warnings: record.warnings,
          method: record.method,
          usage: record.usage,
          ownership: record.ownership,
          analysis: record.analysis,
          matches: record.split.matches ?? [],
          resolutions: record.split.resolutions ?? [],
          ...(includeSpecs
            ? {
                specs: record.specs,
                remainderKind: record.remainderKind,
                explicitMatches: record.matches,
              }
            : {}),
        }
      : {}),
    ...(h.adoption ? { adoption: h.adoption } : {}),
  };
}
function committedSummary(h, record, input, operation) {
  const version = h.versions.find(
    (entry) => entry.commandId === input.commandId,
  );
  return summary(
    {
      ...h,
      status: 'ready',
      error: undefined,
      executionId:
        version.executionId ?? `${h.candidateId}:${version.revision}`,
      job: {
        operation,
        commandId: input.commandId,
        input,
        resultRevision: version.revision,
      },
    },
    record,
  );
}
async function buildRecord(
  scene,
  frozen,
  h,
  revision,
  sourceRevision,
  specs,
  options,
) {
  const ownership = [];
  let prompts;
  if (usesSam(specs)) {
    prompts = specs;
    const result = await coarseMapSpecs(frozen, {
      ...options.pixelOptions,
      mode: 'sam',
      specs,
    });
    specs = result.specs;
    options = {
      ...options,
      analysis: { ...options.analysis, samReceipts: result.samReceipts },
      usage: { ...options.usage, localSamCalls: result.samReceipts.length },
    };
  }
  const elements = await buildSplitElements(frozen, specs, {
    ...options.pixelOptions,
    map: scene.map,
    remainderKind: options.remainderKind,
    onOwnership: (entry) => ownership.push(entry),
  });
  const incoming = {
    version: 1,
    candidateId: h.candidateId,
    candidateRevision: revision,
    sourceHash: frozen.sourceHash,
    origin: frozen.origin,
    review: 'unverified',
    stale: false,
    baseline: elements,
    elements,
    conflicts: [],
  };
  const split = await mergeSplitRevision(scene.mapSplit, incoming, {
    matches: options.matches,
    resolutions: options.resolutions,
    priorConflicts: options.priorConflicts,
  });
  installMapSplit(structuredClone(scene), split);
  return {
    candidateId: h.candidateId,
    documentId: h.documentId,
    revision,
    sourceRevision,
    width: frozen.width,
    height: frozen.height,
    specs,
    split,
    prompts,
    remainderKind: options.remainderKind,
    method: options.method,
    warnings: options.warnings || [],
    usage: options.usage || null,
    matches: options.matches || [],
    resolutions: split.resolutions || [],
    reviewEvidence: null,
    ownership,
    analysis: options.analysis || null,
  };
}
function assertSameRequest(stored, input) {
  if (stored !== fingerprint(input))
    throw failure(
      '同一 commandId 的请求参数已改变。',
      'COMMAND_ID_REUSED',
      409,
    );
}
function reviseSpecs(previous, { specs, upsert = [], remove = [] }) {
  if (specs) return specs;
  const replacements = new Map();
  for (const spec of upsert) {
    if (!replacements.has(spec.id)) replacements.set(spec.id, []);
    replacements.get(spec.id).push(spec);
  }
  const replaced = new Set(),
    deleted = new Set(remove),
    result = [];
  // Declaration order breaks ownership ties. Updating an existing item must
  // not move it behind its neighbours and silently give away their overlap.
  for (const spec of previous) {
    if (replacements.has(spec.id)) {
      if (!replaced.has(spec.id)) result.push(...replacements.get(spec.id));
      replaced.add(spec.id);
    } else if (!deleted.has(spec.id)) result.push(spec);
  }
  for (const [id, group] of replacements)
    if (!replaced.has(id)) result.push(...group);
  return result;
}
async function prepare(root, manifest, dir, input) {
  const candidateId =
    'split_' + hash(input.documentId + '\0' + input.commandId).slice(0, 32);
  let start = false;
  const h = await lock(root, dir, candidateId, async () => {
    const previous = await json(await safe(root, headPath(dir, candidateId)));
    if (previous) {
      assertSameRequest(previous.requestHash, input);
      if (
        !previous.versions.length &&
        !active.has(previous.executionId) &&
        (previous.location || (previous.mode !== 'vision' && previous.status === 'running'))
      ) {
        previous.status = 'running';
        delete previous.error;
        await atomic(root, headPath(dir, candidateId), previous);
        active.add(previous.executionId);
        start = true;
      }
      return previous;
    }
    await sceneAt(
      root,
      manifest,
      input.documentId,
      input.expectedRevision,
      true,
    );
    const created = {
      candidateId,
      executionId: randomUUID(),
      documentId: input.documentId,
      sourceRevision: input.expectedRevision,
      mode: input.mode,
      createdAt: new Date().toISOString(),
      requestHash: fingerprint(input),
      status: 'running',
      versions: [],
      job: { operation: 'prepare', commandId: input.commandId, input },
      ...(input.mode === 'vision'
        ? { service: mapSplitSettings(manifest), reservedVisionCalls: 1 }
        : {}),
    };
    await atomic(root, headPath(dir, candidateId), created);
    active.add(created.executionId);
    start = true;
    return created;
  });
  if (start) {
    const execute = async () => {
      try {
        const { content } = await sceneAt(
          root,
          manifest,
          input.documentId,
          input.expectedRevision,
        );
        const frozen = await freezeMapPixels(content);
        const generated =
          input.specs && input.mode === 'local'
            ? { specs: input.specs, method: 'declared', warnings: [] }
            : await coarseMapSpecs(frozen, {
                root,
                manifest,
                mode: input.mode,
                specs: input.specs,
                useSam: input.useSam,
                service: h.service,
                requestIdentity: candidateId,
                locatedPlan: h.location,
                onLocated: async (plan) => {
                  h.location = plan;
                  await atomic(root, headPath(dir, candidateId), h);
                },
                onReceipt: async (receipt) => {
                  h.receipt = receipt;
                  await atomic(root, headPath(dir, candidateId), h);
                },
              });
        const record = await buildRecord(
          content,
          frozen,
          h,
          1,
          input.expectedRevision,
          generated.specs,
          {
            ...generated,
            remainderKind: input.remainderKind ?? 'surface',
            pixelOptions: { root, manifest },
            analysis: {
              method: generated.method,
              sam: generated.sam && {
                available: generated.sam.available,
                model: generated.sam.model,
              },
              samReceipts: generated.samReceipts,
              evidence: generated.evidence,
            },
          },
        );
        await publish(root, dir, h, record, input);
      } catch (e) {
        h.status = e.code?.includes('UNKNOWN')
          ? 'attention_required'
          : 'failed';
        h.error = { code: e.code || 'SPLIT_FAILED', message: e.message };
        await atomic(root, headPath(dir, candidateId), h);
      } finally {
        active.delete(h.executionId);
      }
    };
    if (input.mode !== 'local' || usesSam(input.specs))
      void execute().catch(() => {
        active.delete(h.executionId);
      });
    else await execute();
  }
  return {
    candidate: h.versions.length
      ? committedSummary(
          h,
          await readVersion(root, dir, h, 1),
          input,
          'prepare',
        )
      : summary(h, null),
    replayed: !start,
  };
}
async function revise(root, manifest, dir, input) {
  return lock(root, dir, input.candidateId, async () => {
    const h = await head(root, dir, input.candidateId);
    const previous = h.versions.find((v) => v.commandId === input.commandId);
    if (previous) {
      assertSameRequest(previous.requestHash, input);
      return {
        candidate: committedSummary(
          h,
          await readVersion(root, dir, h, previous.revision),
          input,
          'revise',
        ),
        replayed: true,
      };
    }
    if (h.status === 'running' && active.has(h.executionId)) {
      if (h.job?.commandId !== input.commandId)
        throw failure('此候选仍在修订，请查询原任务。', 'SPLIT_BUSY', 409);
      assertSameRequest(h.job.requestHash, input);
      return {
        candidate: summary(
          h,
          await readVersion(root, dir, h, input.candidateRevision),
        ),
        replayed: true,
      };
    }
    const resuming =
      h.job?.operation === 'revise' && h.job.commandId === input.commandId;
    if (resuming) assertSameRequest(h.job.requestHash, input);
    if (h.versions.at(-1)?.revision !== input.candidateRevision)
      throw failure(
        '候选已修订，请读取最新版本。',
        'SPLIT_VERSION_CONFLICT',
        409,
      );
    const old = await readVersion(root, dir, h, input.candidateRevision);
    const { content } = await sceneAt(
      root,
      manifest,
      input.documentId,
      input.expectedRevision,
      !resuming,
    );
    const frozen = await freezeMapPixels(content);
    if (frozen.sourceHash !== old.split.sourceHash)
      throw failure(
        '源地图已经变化，请为新版创建迁移候选。',
        'SPLIT_SOURCE_CHANGED',
        409,
      );
    if (old.sourceRevision !== input.expectedRevision) {
      const { content: original } = await sceneAt(
        root,
        manifest,
        input.documentId,
        old.sourceRevision,
      );
      // Equal composite pixels can conceal a replaced source layer or a
      // different polygon at a previously confirmed collision index.
      const oldLayers = original.map.layers.filter((layer) => layer.included);
      const layers = content.map.layers.filter((layer) => layer.included);
      const relevant = new Set([
        'actor',
        ...oldLayers.map((layer) => layer.id),
      ]);
      const transferChanged = old.specs.some((spec) =>
        spec.collision?.mapIndices?.some(
          (index) =>
            JSON.stringify(original.map.collisions[index]) !==
            JSON.stringify(content.map.collisions[index]),
        ),
      );
      if (
        original.map.source !== content.map.source ||
        oldLayers.length !== layers.length ||
        oldLayers.some(
          (layer) =>
            layer.source !==
            layers.find((next) => next.id === layer.id)?.source,
        ) ||
        original.order.filter((id) => relevant.has(id)).join('/') !==
          content.order.filter((id) => relevant.has(id)).join('/') ||
        transferChanged
      ) {
        throw failure(
          '源图层、绘制顺序或已确认的地图碰撞发生变化，请为新版创建迁移候选。',
          'SPLIT_SOURCE_CHANGED',
          409,
        );
      }
    }
    let next;
    if (input.review) {
      if (
        input.specs ||
        input.upsert ||
        input.remove ||
        input.matches ||
        input.resolutions ||
        input.remainderKind !== undefined ||
        old.sourceRevision !== input.expectedRevision
      )
        throw failure('请先保存修订并查看成品，再记录本版本的核验。');
      const ids = new Set(input.review.elementIds);
      if ([...ids].some((id) => !old.split.elements.some((e) => e.id === id)))
        throw failure('核验对象不属于该版本。');
      const checked = [
        ...new Set([...(old.reviewEvidence?.elementIds || []), ...ids]),
      ];
      next = {
        ...old,
        revision: old.revision + 1,
        split: {
          ...old.split,
          candidateRevision: old.revision + 1,
          review:
            checked.length === old.split.elements.length
              ? 'reviewed'
              : 'unverified',
        },
        reviewEvidence: {
          elementIds: checked,
          note: input.review.note,
          checkedCandidateRevision: old.revision,
          checkedAt: new Date().toISOString(),
        },
      };
    } else {
      if (input.specs && (input.upsert || input.remove))
        throw failure('请传完整 specs 或指定对象的 upsert/remove。');
      const specs = reviseSpecs(old.specs, input);
      if (
        input.resolutions?.some(
          (r) => !old.split.conflicts.some((c) => c.id === r.conflictId),
        )
      )
        throw failure(
          '裁决引用的冲突不属于指定版本。',
          'SPLIT_CONFLICT_CHANGED',
          409,
        );
      const decisions = new Map(
        (old.resolutions || []).map((decision) => [
          decision.conflictId,
          decision,
        ]),
      );
      for (const decision of input.resolutions || [])
        decisions.set(decision.conflictId, decision);
      const build = () =>
        buildRecord(
          content,
          frozen,
          h,
          old.revision + 1,
          input.expectedRevision,
          specs,
          {
            ...old,
            remainderKind: input.remainderKind ?? old.remainderKind,
            matches: input.matches ?? old.matches,
            resolutions: [...decisions.values()],
            pixelOptions: { root, manifest },
            priorConflicts: old.split.conflicts,
          },
        );
      if (usesSam(specs)) {
        h.status = 'running';
        delete h.error;
        if (!resuming) h.executionId = randomUUID();
        h.job = {
          operation: 'revise',
          commandId: input.commandId,
          input,
          requestHash: fingerprint(input),
        };
        await atomic(root, headPath(dir, h.candidateId), h);
        active.add(h.executionId);
        const execute = async () => {
          try {
            const record = await build();
            await lock(root, dir, h.candidateId, async () => {
              const current = await head(root, dir, h.candidateId);
              if (current.executionId !== h.executionId)
                throw failure(
                  '候选执行身份已变化。',
                  'SPLIT_EXECUTION_CHANGED',
                  409,
                );
              await publish(root, dir, current, record, input);
            });
          } catch (error) {
            await lock(root, dir, h.candidateId, async () => {
              const current = await head(root, dir, h.candidateId);
              if (current.executionId !== h.executionId) return;
              current.status = 'failed';
              current.error = {
                code: error.code || 'SPLIT_FAILED',
                message: error.message,
              };
              await atomic(root, headPath(dir, h.candidateId), current);
            });
          } finally {
            active.delete(h.executionId);
          }
        };
        void execute().catch(() => active.delete(h.executionId));
        return { candidate: summary(h, old), replayed: resuming };
      }
      next = await build();
    }
    await publish(root, dir, h, next, input);
    return { candidate: summary(h, next) };
  });
}

const pngBytes = (source) =>
  Buffer.from(source.slice(source.indexOf(',') + 1), 'base64');
async function renderEntries(entries, frame) {
  const overlays = [];
  for (const { part, left, top } of entries) {
    const x = Math.round(left) - frame.x,
      y = Math.round(top) - frame.y;
    const l = Math.max(0, -x),
      t = Math.max(0, -y);
    const width = Math.min(part.width - l, frame.width - Math.max(x, 0));
    const height = Math.min(part.height - t, frame.height - Math.max(y, 0));
    if (width <= 0 || height <= 0) continue;
    let input = pngBytes(part.source);
    if (l || t || width !== part.width || height !== part.height)
      input = await sharp(input, { limitInputPixels: 64_000_000 })
        .extract({ left: l, top: t, width, height })
        .png()
        .toBuffer();
    overlays.push({ input, left: Math.max(0, x), top: Math.max(0, y) });
  }
  return sharp({
    create: {
      width: frame.width,
      height: frame.height,
      channels: 4,
      background: '#00000000',
    },
  })
    .composite(overlays)
    .png()
    .toBuffer();
}
async function inspect(root, manifest, dir, input) {
  let record;
  if (input.candidateId) {
    const h = await head(root, dir, input.candidateId);
    record = await readVersion(
      root,
      dir,
      h,
      input.candidateRevision ?? h.versions.at(-1)?.revision,
    );
    if (
      input.expectedRevision &&
      input.expectedRevision !== record.sourceRevision
    )
      throw failure('候选与指定场景版本不同。', 'REVISION_CONFLICT', 409);
  }
  const doc = await sceneAt(
    root,
    manifest,
    input.documentId,
    record?.sourceRevision ?? input.expectedRevision,
  );
  const scene = doc.content,
    frozen = await freezeMapPixels(scene);
  const frame = input.crop ?? {
    x: 0,
    y: 0,
    width: frozen.width,
    height: frozen.height,
  };
  if (
    frame.x + frame.width > frozen.width ||
    frame.y + frame.height > frozen.height
  )
    throw failure('裁片超出原图。');
  let png,
    area = frame;
  if (input.view === 'source') {
    png = frozen.png;
    if (input.crop)
      png = await sharp(png, { limitInputPixels: 64_000_000 })
        .extract({
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
        })
        .png()
        .toBuffer();
  } else {
    if (record) installMapSplit(scene, record.split);
    const split = scene.mapSplit;
    if (!split || split.stale) throw failure('此版场景还没有可查看的分层。');
    if (input.view === 'conflict') {
      const conflict = split.conflicts.find((c) => c.id === input.conflictId);
      if (!conflict || !input.side) throw failure('请指定冲突 ID 和比较侧。');
      let value = conflict[input.side];
      if (Array.isArray(value) && input.elementId)
        value = value.find((e) => e?.id === input.elementId) ?? value;
      const raw =
        typeof value === 'string'
          ? value
          : value?.source ||
            value?.parts?.find((p) => !input.partId || p.id === input.partId)
              ?.source;
      if (!raw?.startsWith('data:image/png;base64,'))
        return {
          documentId: doc.id,
          conflictId: conflict.id,
          side: input.side,
          value: compactConflicts(value),
          images: [],
        };
      png = pngBytes(raw);
      const meta = await sharp(png, {
        limitInputPixels: 64_000_000,
      }).metadata();
      area = { x: 0, y: 0, width: meta.width, height: meta.height };
    } else if (input.view === 'candidate') {
      const entries = mapSplitPartRenderEntries(scene, {
        includedOnly: true,
      }).reverse();
      png = await renderEntries(
        entries.map(({ part, element }) => ({
          part,
          left: element.x + part.x,
          top: element.y + part.y,
        })),
        frame,
      );
    } else {
      const el = split.elements.find((e) => e.id === input.elementId);
      if (!el) throw failure('请指定一个存在的 elementId。');
      if (input.view === 'element') {
        if (!el.parts.length) throw failure('物件没有绘制片。');
        const x = Math.floor(Math.min(...el.parts.map((p) => el.x + p.x))),
          y = Math.floor(Math.min(...el.parts.map((p) => el.y + p.y)));
        area = input.crop ?? {
          x,
          y,
          width:
            Math.ceil(Math.max(...el.parts.map((p) => el.x + p.x + p.width))) -
            x,
          height:
            Math.ceil(Math.max(...el.parts.map((p) => el.y + p.y + p.height))) -
            y,
        };
        if (
          area.width > 30000 ||
          area.height > 30000 ||
          area.width * area.height > 64_000_000
        )
          throw failure('物件范围过大，请指定 crop。');
        const entries = mapSplitPartRenderEntries(scene)
          .reverse()
          .filter((e) => e.element.id === el.id);
        png = await renderEntries(
          entries.map(({ part }) => ({
            part,
            left: el.x + part.x,
            top: el.y + part.y,
          })),
          area,
        );
      } else {
        const part = el.parts.find((p) => p.id === input.partId);
        if (!part) throw failure('请指定一个存在的 partId。');
        const source = input.view === 'mask' ? part.mask : part.source;
        if (!source) throw failure('此绘制片没有独立的归属蒙版。');
        area = {
          x: el.x + part.x,
          y: el.y + part.y,
          width: part.width,
          height: part.height,
        };
        png = pngBytes(source);
        if (input.crop) {
          png = await renderEntries(
            [{ part: { ...part, source }, left: area.x, top: area.y }],
            frame,
          );
          area = frame;
        }
      }
    }
  }
  let image = sharp(png, { limitInputPixels: 64_000_000 });
  if (input.background !== 'transparent')
    image = image.flatten({ background: input.background });
  const result = await image
    .resize({
      width: input.maxEdge,
      height: input.maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: 'nearest',
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  return {
    documentId: doc.id,
    sourceRevision: doc.revision,
    sourceHash: frozen.sourceHash,
    origin: frozen.origin,
    area,
    width: result.info.width,
    height: result.info.height,
    images: [
      {
        role: input.view,
        data: result.data.toString('base64'),
        mimeType: 'image/png',
      },
    ],
  };
}

async function saveSceneChange(root, manifest, input, content) {
  const result = await saveDocument(
    root,
    manifest,
    {
      documentId: input.documentId,
      expectedRevision: input.expectedRevision,
      commandId: input.commandId,
      content,
    },
    { respectLocks: true },
  );
  return {
    documentId: input.documentId,
    candidateId: input.candidateId,
    revision: result.document.revision,
    currentRevision: result.currentRevision,
    contentHash: result.document.contentHash,
    replayed: result.replayed,
  };
}
async function adopt(root, manifest, dir, input) {
  return lock(root, dir, input.candidateId, async () => {
    const h = await head(root, dir, input.candidateId);
    const record = await readVersion(root, dir, h, input.candidateRevision);
    if (record.sourceRevision !== input.expectedRevision)
      throw failure(
        '请在最新场景版本上修订候选后再采用。',
        'REVISION_CONFLICT',
        409,
      );
    if (record.split.conflicts.some((c) => !c.resolution))
      throw failure('请先裁决未解决的迁移冲突。', 'SPLIT_UNRESOLVED', 409);
    const { content } = await sceneAt(
      root,
      manifest,
      input.documentId,
      input.expectedRevision,
    );
    installMapSplit(content, record.split);
    const receipt = await saveSceneChange(root, manifest, input, content);
    if (!h.adoption || receipt.revision > h.adoption.revision) {
      h.adoption = {
        revision: receipt.revision,
        candidateRevision: record.revision,
        review: record.split.review,
      };
      await atomic(root, headPath(dir, h.candidateId), h);
    }
    return receipt;
  });
}
async function patchElement(root, manifest, input) {
  const { content } = await sceneAt(
    root,
    manifest,
    input.documentId,
    input.expectedRevision,
  );
  const split = content.mapSplit;
  const unlocking =
    Object.keys(input.changes).length === 1 && input.changes.locked === false;
  if (
    !split ||
    (split.stale && !unlocking) ||
    split.candidateId !== input.candidateId
  )
    throw failure('场景当前未绑定此分层候选。', 'SPLIT_BINDING_CHANGED', 409);
  const el = split.elements.find((e) => e.id === input.elementId);
  if (!el) throw failure('指定物件不存在。', 'SPLIT_ELEMENT_NOT_FOUND', 404);
  const { part, collision, remove, ...fields } = input.changes;
  if (
    el.locked &&
    !(Object.keys(input.changes).length === 1 && fields.locked === false)
  )
    throw failure('请先解锁此分层物件。', 'LOCKED_NODE', 409);
  if (!Object.keys(input.changes).length) throw failure('请指定要修改的字段。');
  if (remove) {
    if (Object.keys(input.changes).length !== 1)
      throw failure('删除物件必须单独提交。');
    removeMapSplitElements(content, [el.id]);
    return saveSceneChange(root, manifest, input, content);
  }
  Object.assign(el, fields);
  if (part) {
    const piece = el.parts.find((p) => p.id === part.id);
    if (!piece) throw failure('指定绘制片不存在。');
    if (part.remove) {
      if (Object.keys(part).length !== 2 || el.parts.length === 1)
        throw failure('请单独删除子片，最后一个子片请通过删除整个物件处理。');
      el.parts = el.parts.filter((p) => p.id !== part.id);
    } else Object.assign(piece, part);
  }
  if (collision) {
    if (collision.mapIndices?.length) {
      if (collision.enabled === false)
        throw failure('接管已有阻挡时保持启用，采用后可单独关闭碰撞。');
      el.collision = splitCollisionTransfer(
        content,
        el.id,
        collision.mapIndices,
        collision.polygons,
      );
    } else if (collision.mapIndices && el.collision.mapIndices.length) {
      el.collision = { enabled: Boolean(collision.polygons?.length && collision.enabled), polygons: collision.polygons ?? [], mapIndices: [] };
    } else Object.assign(el.collision, collision);
  }
  split.review = 'unverified';
  return saveSceneChange(root, manifest, input, content);
}
export async function sceneSplitRequest(root, manifest, operation, raw) {
  const input = sceneSplitInputs[operation].parse(raw);
  const dir = directory(root, manifest, input.documentId);
  if (input.commandId) {
    const key = hash(input.commandId),
      file = path.join(dir, 'commands', key + '.json');
    await lock(root, dir, 'command:' + key, async () => {
      const intent = await json(await safe(root, file)),
        requestHash = fingerprint({ operation, input });
      if (intent && intent.requestHash !== requestHash)
        throw failure(
          '同一 commandId 已有不同分层请求。',
          'COMMAND_ID_REUSED',
          409,
        );
      if (!intent)
        await atomic(root, file, {
          operation,
          requestHash,
          createdAt: new Date().toISOString(),
        });
    });
  }
  switch (operation) {
    case 'scene-split-prepare':
      return prepare(root, manifest, dir, input);
    case 'scene-split-revise':
      return revise(root, manifest, dir, input);
    case 'scene-split-inspect':
      return inspect(root, manifest, dir, input);
    case 'scene-split-adopt':
      return adopt(root, manifest, dir, input);
    case 'scene-split-patch':
      return patchElement(root, manifest, input);
    case 'scene-split-get': {
      if (input.candidateId) {
        const h = await head(root, dir, input.candidateId),
          rev = input.candidateRevision ?? h.versions.at(-1)?.revision;
        return {
          candidate: summary(
            h,
            rev ? await readVersion(root, dir, h, rev) : null,
            input.includeSpecs,
          ),
        };
      }
      await getDocument(root, manifest, {
        documentId: input.documentId,
        metadataOnly: true,
      });
      const names = await readdir(await safe(root, dir)).catch((e) => {
        if (e.code === 'ENOENT') return [];
        throw e;
      });
      const rows = [];
      for (const id of names.filter((n) => /^split_[0-9a-f]{32}$/.test(n))) {
        const h = await head(root, dir, id);
        rows.push({
          candidateId: id,
          status: summary(h, null).status,
          revision: h.versions.at(-1)?.revision ?? 0,
          sourceRevision: h.sourceRevision,
          createdAt: h.createdAt,
          mode: h.mode,
        });
      }
      rows.sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          b.candidateId.localeCompare(a.candidateId),
      );
      return {
        candidates: rows.slice(input.offset, input.offset + input.limit),
        total: rows.length,
      };
    }
  }
}
