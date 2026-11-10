import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveMapGenerationProvider, validateMapApiKey } from '../map-generation-settings.mjs';
import { inspectImageBytes, MAX_TOTAL_IMAGE_BYTES, readImageAssetSource, validateImageAssetDimensions } from './image-assets-source.mjs';
import { requestOpenAIImage } from './openai-image-provider.mjs';
import { planMapGenerationSize } from './map-generation-size.mjs';
import { processImagePixels, describeEditMask, validateImageProcessingSize, validateMaskPair } from './image-assets-processing.mjs';

const OPERATIONS = new Set(['generate-background', 'generate-prop', 'edit-image', 'process-image']);
const FIELDS = new Set(['operation', 'prompt', 'name', 'provider', 'width', 'height', 'image', 'references', 'mask', 'kind', 'preserveFrom', 'preserveAlpha', 'alphaCleanupThreshold']);

function editDimensions(source) {
  try { return validateImageAssetDimensions(source.width, source.height); }
  catch { return planMapGenerationSize(source.width, source.height); }
}

export function validateImageAssetsInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['图片请求必须为 JSON 对象。'];
  if (!OPERATIONS.has(input.operation)) errors.push('图片操作无效。');
  if (Object.keys(input).some(key => !FIELDS.has(key))) errors.push('图片请求含不支持的字段。');
  const local = input.operation === 'process-image';
  if (!local && (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000)) errors.push('请填写 1–12000 字的图片提示词。');
  if (local && ['prompt', 'provider', 'references', 'width', 'height'].some(key => input[key] !== undefined)) errors.push('本地处理不接受提示词、供应商、参考图或输出尺寸；不会生成或缩放。');
  if (input.alphaCleanupThreshold !== undefined && (!Number.isInteger(input.alphaCleanupThreshold) || input.alphaCleanupThreshold < 0 || input.alphaCleanupThreshold > 16)) errors.push('透明噪点阈值须为0–16整数。');
  if (input.preserveAlpha !== undefined && (input.operation !== 'edit-image' || typeof input.preserveAlpha !== 'boolean')) errors.push('preserveAlpha仅用于edit-image，须为布尔值。');
  if (input.preserveFrom !== undefined && (!local || typeof input.preserveFrom !== 'string' || !input.preserveFrom)) errors.push('preserveFrom仅用于本地处理的保护源图。');
  if (local && Boolean(input.preserveFrom) !== Boolean(input.mask)) errors.push('本地保护源图与蒙版必须同时提供。');
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)) errors.push('图片名称必须为 1–80 字。');
  if (input.provider !== undefined && input.provider !== 'gpt-image-2.6') errors.push('场景图片使用 GPT Image 2.6。');
  if (input.width !== undefined || input.height !== undefined) {
    try { validateImageAssetDimensions(input.width, input.height); } catch (error) { errors.push(error.message); }
  }
  if (input.references !== undefined && (!Array.isArray(input.references) || input.references.length > 8 || input.references.some(value => typeof value !== 'string' || !value))) errors.push('参考图必须为最多 8 张图片源。');
  if (input.operation === 'edit-image' || local) {
    if (typeof input.image !== 'string' || !input.image) errors.push('图片编辑需要源图片 image。');
    if (input.mask !== undefined && (typeof input.mask !== 'string' || !input.mask)) errors.push('蒙版必须为 PNG 图片源。');
    if (input.kind !== undefined && !['background', 'prop'].includes(input.kind)) errors.push('编辑图片类型必须为 background 或 prop。');
  } else if (input.image !== undefined || input.mask !== undefined || input.kind !== undefined) errors.push('image、mask 与 kind 仅用于 edit-image / process-image。');
  return errors;
}

export const imageAssetsConfigured = () => true;

export async function executeImageAssets(context) {
  const errors = validateImageAssetsInput(context.input);
  if (errors.length) throw new Error(errors.join(' '));
  const { capability, input } = context;
  if (input.operation === 'process-image') return generateImageAsset({ ...context, provider: null, adapter: { id: 'image-assets', operation: input.operation, provider: 'local', externalRequest: false } });
  // References use the edits endpoint, while text-only requests use generations.
  const hasImages = input.operation === 'edit-image' || Boolean(input.references?.length);
  const provider = resolveMapGenerationProvider(capability.connector, input.provider ?? capability.connector.defaultProvider, hasImages ? 'edit-image' : input.operation);
  const adapter = { id: 'image-assets', operation: input.operation, provider: provider?.id, model: provider?.model };
  if (!provider?.apiKey) return { status: 'awaiting_configuration', requiredEnvironment: provider?.apiKeyEnv ?? 'OPENAI_API_KEY', result: null, adapter };
  validateMapApiKey(provider.apiKey);
  if (provider.protocol !== 'openai-images-edits') throw new Error('场景图片需要兼容 OpenAI Images 的服务。');
  return {
    status: 'running', result: null,
    adapter: { ...adapter, backgroundExecution: true },
    deferred: () => generateImageAsset({ ...context, provider, adapter }),
  };
}

async function generateImageAsset({ input, task, provider, adapter, repositoryRoot, outputDirectory }) {
  const local = input.operation === 'process-image';
  const kind = input.operation === 'generate-prop' ? 'prop' : input.operation === 'generate-background' ? 'background' : input.kind ?? 'background';
  const names = [], inputs = [];
  const diagnostics = { schemaVersion: 1, operation: input.operation, provider: provider?.id ?? 'local', ...(provider ? { model: provider.model } : {}), stage: 'validating-inputs' };
  const saveDiagnostics = () => writeFile(path.join(outputDirectory, 'generation-diagnostics.json'), `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
  let totalBytes = 0;
  const read = async (value, role, options) => {
    const source = await readImageAssetSource(value, repositoryRoot, options);
    totalBytes += source.bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error('源图片与蒙版总计超过 80 MiB 限制。');
    const file = `${role}.${source.format === 'jpeg' ? 'jpg' : source.format}`;
    await writeFile(path.join(outputDirectory, file), source.buffer, { flag: 'wx' });
    names.push(file);
    const { buffer: _buffer, ...metadata } = source;
    inputs.push({ role, file, ...metadata });
    return source;
  };
  try {
    await saveDiagnostics();
    names.push('generation-diagnostics.json');
    const sources = [];
    if (input.image) sources.push(await read(input.image, local ? 'candidate-image' : 'source-image'));
    for (const [index, reference] of (input.references ?? []).entries()) sources.push(await read(reference, `reference-${String(index + 1).padStart(2, '0')}`));
    const preserveFrom = input.preserveFrom ? await read(input.preserveFrom, 'source-image') : null;
    const mask = input.mask ? await read(input.mask, 'edit-mask', { pngOnly: true }) : null;
    const dimensions = local ? { width: sources[0].width, height: sources[0].height } : input.width !== undefined
      ? validateImageAssetDimensions(input.width, input.height)
      : input.operation === 'edit-image'
        ? editDimensions(sources[0])
        : validateImageAssetDimensions(...(kind === 'prop' ? [1024, 1024] : [1536, 1024]));
    validateImageProcessingSize(dimensions.width, dimensions.height);
    if (mask) validateMaskPair(local ? preserveFrom : sources[0], mask, dimensions);
    if (input.preserveAlpha && (dimensions.width !== sources[0].width || dimensions.height !== sources[0].height)) throw new Error('保留原图透明度时不能缩放源图。');
    const generatedProp = input.operation === 'generate-prop';
    // Existing opaque appearances remain valid props. Editing uses their current
    // transparency; only generation promises a transparent isolated subject.
    const background = kind === 'prop' && (generatedProp || sources[0]?.hasTransparency) ? 'transparent' : 'opaque';
    const instructions = input.operation === 'edit-image'
      ? 'Edit the first supplied image according to the request. Additional images are visual references. The mask is an editing constraint, not artwork: fully transparent mask pixels are the region to reconstruct; opaque mask pixels must retain the first image. Generate the requested content INSIDE the transparent region, keeping its original surrounding context. Never render the mask as a black rectangle, a hole, or an overlay. Do not interpret this edit as map outpainting.'
      : kind === 'prop'
        ? 'Create one isolated 2D game prop with a real transparent background, clear silhouette, no backdrop, interface, text label, border or montage. Additional images are visual references.'
        : 'Create one complete 2D game background with coherent composition, no interface, text label, border or montage. Additional images are visual references.';
    const regionInstruction = !local && mask ? await describeEditMask(mask.buffer) : '';
    const prompt = local ? null : `${input.prompt.trim()}\n\n${instructions} ${regionInstruction}\nReturn exactly ${dimensions.width} x ${dimensions.height} pixels as PNG.${generatedProp ? ' Include visible subject pixels and transparent surrounding pixels.' : ''}`;
    diagnostics.requested = { ...dimensions, background };
    diagnostics.stage = local ? 'processing-local' : 'requesting';
    await saveDiagnostics();
    const bytes = local ? sources[0].buffer : await requestOpenAIImage(provider, { prompt, dimensions, sources, mask, background, onResponseMetadata: async evidence => {
      await writeFile(path.join(outputDirectory, 'provider-usage.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
      names.push('provider-usage.json');
    } });
    // Retain exact provider bytes before decoding, sizing or transparency checks.
    const rawImage = local ? inputs[0].file : 'provider-response.png';
    if (!local) {
      await writeFile(path.join(outputDirectory, rawImage), bytes, { flag: 'wx' });
      names.push(rawImage);
    }
    diagnostics.stage = 'validating-output';
    await saveDiagnostics();
    const rawInfo = await inspectImageBytes(bytes, { pngOnly: !local });
    diagnostics.returned = { width: rawInfo.width, height: rawInfo.height, hasAlpha: rawInfo.hasAlpha, hasTransparency: rawInfo.hasTransparency, sha256: rawInfo.sha256 };
    if (rawInfo.width !== dimensions.width || rawInfo.height !== dimensions.height) throw new Error('图片 API 返回的实际像素尺寸与请求不同；已保留原始响应，未采用到编辑器。');
    if (!local && !rawInfo.hasVisiblePixels) throw new Error('图片为空图，未采用到编辑器。');
    const processed = await processImagePixels(bytes, { ...(mask ? { preserveFrom: (local ? preserveFrom : sources[0]).buffer, mask: mask.buffer } : {}), ...(input.preserveAlpha ? { preserveAlphaFrom: sources[0].buffer } : {}), alphaCleanupThreshold: input.alphaCleanupThreshold ?? (kind === 'prop' ? 1 : 0) });
    await writeFile(path.join(outputDirectory, 'processing-report.json'), `${JSON.stringify(processed.evidence, null, 2)}\n`, { flag: 'wx' });
    names.push('processing-report.json');
    // Existing appearance materials may be opaque, and an explicit local erase
    // may intentionally clear an image. Generation still requires visible art
    // and actual transparency for props; local edits retain their exact pixels.
    const info = await inspectImageBytes(processed.buffer, { pngOnly: true, transparency: generatedProp });
    if (!local && !info.hasVisiblePixels) throw new Error('图片 API 返回全透明空图；未采用到编辑器。');
    await writeFile(path.join(outputDirectory, 'image.png'), processed.buffer, { flag: 'wx' });
    names.push('image.png');
    const result = {
      schemaVersion: 1, image: 'image.png', rawImage, rawSha256: rawInfo.sha256, processingEvidence: 'processing-report.json', metadata: 'image-metadata.json',
      kind, name: input.name?.trim() ?? null, width: info.width, height: info.height,
      hasAlpha: info.hasAlpha, hasTransparency: info.hasTransparency, sha256: info.sha256,
      provider: provider?.id ?? 'local', ...(provider ? { model: provider.model, usageEvidence: 'provider-usage.json' } : {}), requiresAdoption: true,
    };
    const metadata = { ...result, source: local ? 'local-image-processing' : 'image-api', ...(provider ? { providerOrigin: new URL(provider.endpoint).origin, prompt: input.prompt.trim(), effectivePrompt: prompt } : {}), sourceTaskId: task.id, operation: input.operation, createdAt: new Date().toISOString(), requested: diagnostics.requested, inputs, semantics: local ? 'local-processing' : input.operation === 'edit-image' ? 'model-edit-with-local-processing' : 'generation-with-local-processing', preservesSourcePixels: false, preservesPixelsOutsideMask: Boolean(mask), processing: processed.evidence };
    await writeFile(path.join(outputDirectory, result.metadata), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
    names.push(result.metadata);
    diagnostics.stage = 'completed';
    await saveDiagnostics();
    return { status: 'completed', adapter, result, generatedOutputNames: names };
  } catch (error) {
    const status = error?.submissionUnknown ? 'attention_required' : 'failed';
    diagnostics.failedStage = diagnostics.stage;
    diagnostics.stage = status;
    diagnostics.submissionUnknown = error?.submissionUnknown === true;
    await saveDiagnostics();
    return { status, error: error instanceof Error ? error.message : '图片生成失败。', adapter, generatedOutputNames: names };
  }
}
