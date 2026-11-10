import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { bearerHeaders, endpointUrl, requestJson } from './http.mjs';

const ID = /^[a-z0-9][a-z0-9_-]{0,199}$/i;
const PROP_PREFIX = 'A single inanimate 2D pixel-art game prop, side view, isolated on a transparent background, complete silhouette inside the canvas, no characters, no scene, no text. Object description: ';

export function validateReferenceArtInput(input) {
  const errors = [];
  if (input.operation === 'import') {
    const hasPath = typeof input.sourceImagePath === 'string' && Boolean(input.sourceImagePath.trim());
    const hasImage = typeof input.sourceImage === 'string' && Boolean(input.sourceImage.trim());
    if (hasPath === hasImage) errors.push('import requires exactly one sourceImagePath or sourceImage.');
    if (input.subject === 'prop') errors.push('import currently accepts character references only.');
    if (input.seed !== undefined) errors.push('import does not use a generation seed.');
  } else if (input.sourceImagePath !== undefined) errors.push('sourceImagePath is only valid for import.');
  if (input.operation !== 'import' && input.sourceImage !== undefined) errors.push('sourceImage is only valid for import.');
  if (input.operation !== 'transfer' && input.identityDescription !== undefined) errors.push('identityDescription is only valid for transfer.');
  if (input.subject === 'prop' && input.size !== undefined && input.size !== 128) errors.push('物品原图尺寸保持 128×128。');
  if (input.subject === 'prop' && typeof input.prompt === 'string' && input.prompt.length > 1800)
    errors.push('物品描述最多 1800 字符。');
  if (
    ['generate','import'].includes(input.operation) &&
    (typeof input.prompt !== 'string' || !input.prompt.trim())
  )
    errors.push('prompt is required for generate/import.');
  if (
    input.operation === 'transfer' &&
    (typeof input.sourceTaskId !== 'string' || !ID.test(input.sourceTaskId))
  )
    errors.push('sourceTaskId is required for transfer.');
  if (input.operation !== 'transfer' && input.sourceTaskId !== undefined)
    errors.push('sourceTaskId is only valid for transfer.');
  if (
    input.operation === 'transfer' &&
    ['prompt', 'facing', 'seed', 'name', 'subject', 'size'].some((key) => input[key] !== undefined)
  )
    errors.push('transfer uses the saved source task fields.');
  return errors;
}

export async function referenceServiceRequest(connector, route, options = {}) {
  const base = process.env[connector.urlEnv]?.trim() || connector.defaultUrl;
  try {
    return await requestJson(endpointUrl(base, `/v1/reference-art${route}`), {
      ...options,
      headers: bearerHeaders(process.env[connector.tokenEnv]),
      timeoutMs: 75_000,
    });
  } catch (error) {
    if (error.status === 404)
      throw new Error('请重启或更新 SpritePipeline 服务以加载原图接口。');
    if (error.status) throw error;
    throw new Error(
      options.method === 'POST' && route === '/jobs'
        ? '原图提交结果无法确认，未自动重试。请检查 PixelLab 账户任务后再决定是否重新生成。'
        : '无法连接序列帧服务，请使用 npm run dev 启动完整工作台。',
    );
  }
}

export async function executeReferenceArt(context) {
  const { capability, input } = context;
  if (input.operation === 'transfer') return transferReference(context);
  if (input.operation === 'import') return importReference(context);
  if (input.operation !== 'generate') throw new Error('Unsupported reference-art operation.');
  let settings;
  try {
    settings = await referenceServiceRequest(capability.connector, '/settings');
  } catch (error) {
    return {
      status: 'awaiting_configuration',
      requiredEnvironment: 'SPRITE_PIPELINE_API_URL',
      result: { message: error.message },
    };
  }
  if (!settings.configured)
    return {
      status: 'awaiting_configuration',
      requiredEnvironment: 'PIXELLAB_API_KEY',
      result: {
        message: '请在原图或序列帧设置中保存 PixelLab API Key，两个工具共用。',
      },
    };
  const result = await referenceServiceRequest(capability.connector, '/jobs', {
    method: 'POST',
    body: JSON.stringify({
      prompt: input.subject === 'prop' ? PROP_PREFIX + input.prompt.trim() : input.prompt.trim(),
      facing: input.facing ?? 'right',
      size: input.size ?? 128,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    }),
  });
  if (
    typeof result.jobId !== 'string' ||
    !ID.test(result.jobId) ||
    result.status !== 'running'
  )
    throw new Error('原图服务未返回有效任务 ID，未自动重试。');
  return {
    status: 'running',
    adapter: { referenceJobId: result.jobId, lastPolledAt: Date.now(), ...(input.subject === 'prop' ? { effectivePrompt: PROP_PREFIX + input.prompt.trim() } : {}) },
    result: { model: 'pixflux', width: input.size ?? 128, height: input.size ?? 128 },
  };
}

export async function refreshReferenceArt({
  capability,
  task,
  outputDirectory,
}) {
  const jobId = task.adapter?.referenceJobId;
  if (typeof jobId !== 'string' || !ID.test(jobId))
    throw new Error('原图任务缺少 PixelLab 任务 ID。');
  if (Date.now() - (task.adapter.lastPolledAt ?? 0) < 5000) return null;
  const result = await referenceServiceRequest(
    capability.connector,
    `/jobs/${encodeURIComponent(jobId)}`,
  );
  const adapter = { ...task.adapter, lastPolledAt: Date.now() };
  if (result.status === 'running')
    return {
      status: 'running',
      adapter,
      result: { model: 'pixflux', width: 128, height: 128 },
    };
  if (result.status === 'failed')
    return {
      status: 'failed',
      adapter,
      error: result.error || '原图生成失败。',
    };
  if (
    result.status !== 'completed' ||
    typeof result.image !== 'string' ||
    result.image.length > 2_000_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(result.image)
  )
    throw new Error('原图服务返回了无效图片。');
  const buffer = Buffer.from(result.image, 'base64');
  await validateImage(buffer, task.input.size ?? 128);
  await writeFile(path.join(outputDirectory, 'reference.png'), buffer);
  return {
    status: 'completed',
    adapter,
    generatedOutputNames: ['reference.png'],
    result: {
      model: 'pixflux',
      width: task.input.size ?? 128,
      height: task.input.size ?? 128,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      subject: task.input.subject || 'character',
    },
  };
}

async function validateImage(buffer, size = 128) {
  const metadata = await sharp(buffer, {
    limitInputPixels: 128 * 128,
  }).metadata();
  if (
    metadata.format !== 'png' ||
    metadata.width !== size ||
    metadata.height !== size ||
    !metadata.hasAlpha
  )
    throw new Error(`原图必须是带透明背景的 ${size}×${size} PNG。`);
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let visible = false;
  let transparent = false;
  for (let offset = 3; offset < data.length; offset += info.channels) {
    visible ||= data[offset] > 0;
    transparent ||= data[offset] < 255;
  }
  if (!visible || !transparent) throw new Error('原图为空或缺少透明背景。');
}

async function inside(root, target) {
  const resolvedRoot = await realpath(root);
  const resolved = await realpath(target);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('原图路径超出任务目录。');
  return resolved;
}

async function transferReference({
  capability,
  input,
  manifest,
  repositoryRoot,
}) {
  const taskRoot = path.resolve(
    repositoryRoot,
    manifest.workspace.taskDirectory,
  );
  const recordPath = await inside(
    taskRoot,
    path.join(taskRoot, `${input.sourceTaskId}.json`),
  );
  const source = JSON.parse(await readFile(recordPath, 'utf8'));
  if (
    source.id !== input.sourceTaskId ||
    source.capabilityId !== capability.id ||
    source.status !== 'completed' ||
    !['generate','import'].includes(source.input.operation) ||
    source.input.subject === 'prop'
  )
    throw new Error('请选择已经完成的角色原图生成任务；物品原图请用于交互物。');
  const outputRoot = path.resolve(
    repositoryRoot,
    manifest.workspace.outputDirectory,
  );
  const sourceRoot = await inside(outputRoot, path.join(outputRoot, source.id));
  const imagePath = await inside(
    sourceRoot,
    path.join(sourceRoot, 'reference.png'),
  );
  const relative = path
    .relative(repositoryRoot, imagePath)
    .replaceAll('\\', '/');
  if (!source.outputs.includes(relative))
    throw new Error('任务没有登记此原图产物。');
  const image = await readFile(imagePath);
  await validateImage(image, source.input.size ?? 128);
  const saved = JSON.parse(
    await readFile(
      await inside(sourceRoot, path.join(sourceRoot, 'result.json')),
      'utf8',
    ),
  );
  if (saved.sha256 !== createHash('sha256').update(image).digest('hex'))
    throw new Error('原图文件已变化，请使用原始生成产物。');
  const characterId = `reference_${createHash('sha256').update(source.id).digest('hex').slice(0, 24)}`;
  const result = await referenceServiceRequest(
    capability.connector,
    '/import',
    {
      method: 'POST',
      body: JSON.stringify({
        characterId,
        image: image.toString('base64'),
        size: source.input.size ?? 128,
        reuseIdentity: !input.identityDescription?.trim(),
        prompt: input.identityDescription?.trim() || (source.input.prompt.trim().length <= 300 ? source.input.prompt.trim() : 'Preserve the exact identity, outfit, proportions, equipment, silhouette, and colors from the approved reference image.'),
        facing: source.input.facing ?? 'right',
        name: source.input.name?.trim() || '生成的角色',
      }),
    },
  );
  if (result.characterId !== characterId) throw new Error('角色导入响应无效。');
  const sprite = manifest.capabilities.find(
    (entry) => entry.id === 'sprite-generator',
  );
  return {
    status: 'completed',
    result: {
      characterId,
      sourceTaskId: source.id,
      href: `${sprite.ui.route}?character=${encodeURIComponent(characterId)}`,
    },
  };
}

async function importReference({input, repositoryRoot, outputDirectory}) {
  let bytes, sourcePath;
  if (input.sourceImage !== undefined) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.sourceImage);
    if (!match || match[1].length % 4 || match[1].length > 2_666_668) throw new Error('导入原图必须是 2 MB 以内的 PNG 文件。');
    bytes = Buffer.from(match[1], 'base64');
    if (bytes.toString('base64') !== match[1]) throw new Error('导入原图的 PNG 编码无效。');
  } else {
    sourcePath = await inside(repositoryRoot, path.resolve(repositoryRoot, input.sourceImagePath));
    const info = await stat(sourcePath);
    if (!info.isFile() || info.size > 2_000_000) throw new Error('导入原图必须是 2 MB 以内的 PNG 文件。');
    bytes = await readFile(sourcePath);
  }
  if (bytes.length > 2_000_000) throw new Error('导入原图超过 2 MB。');
  await validateImage(bytes, input.size ?? 128);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(path.join(outputDirectory, 'reference.png'), bytes);
  return {status:'completed', generatedOutputNames:['reference.png'],
    result:{model:null, width:input.size ?? 128, height:input.size ?? 128, sha256, subject:'character',
      provenance:{type:'import', generatedHere:false, providerCalled:false,
        ...(sourcePath ? { sourcePath:path.relative(repositoryRoot,sourcePath).replaceAll('\\','/') } : { sourceType:'browser-image' }), sourceSha256:sha256,
        promptOrigin:'description-added-on-import'}}};
}
