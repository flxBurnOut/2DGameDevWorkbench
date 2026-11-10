import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile),
  sha = (value) => createHash('sha256').update(value).digest('hex');
const failure = (message, code = 'MAP_SPLIT_SAM_INVALID', status = 422) =>
  Object.assign(new Error(message), { code, status });
let running = false;
async function cleanScratch(scratch) {
  if (!scratch) return;
  const resolved = path.resolve(scratch),
    expectedPrefix = path.join(path.resolve(tmpdir()), 'forge-map-sam-');
  if (
    !resolved.startsWith(expectedPrefix) ||
    path.dirname(resolved) !== path.resolve(tmpdir())
  )
    throw failure('拒绝清理不属于本次请求的临时目录。');
  await rm(resolved, { recursive: true, force: true });
}

async function configuration(root) {
  if (!root || !path.isAbsolute(root))
    throw failure('本地分割器需要工作台根目录。');
  const tool = path.join(root, 'Tools', 'VisualStructure');
  let profile;
  try {
    profile = JSON.parse(
      await readFile(path.join(tool, 'runtime-profile.json'), 'utf8'),
    );
  } catch {
    throw failure('缺少本地 SAM 运行配置。', 'MAP_SPLIT_SAM_UNAVAILABLE');
  }
  if (
    !/^[a-f0-9]{64}$/.test(profile.weightsSha256 ?? '') ||
    typeof profile.runtimeDirectory !== 'string'
  )
    throw failure('本地 SAM 运行配置无效。');
  const runtime = path.resolve(root, profile.runtimeDirectory);
  const python =
    process.env.FORGE_STRUCTURE_PYTHON ||
    path.join(
      runtime,
      'venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
  const weights =
    process.env.FORGE_STRUCTURE_WEIGHTS ||
    path.join(runtime, 'checkpoints', 'sam2.1_hiera_tiny.pt');
  return { tool, profile, python, weights };
}

/** Presence only; inference still validates checkpoint, imports and dimensions.
 * This read never starts a model, downloads dependencies or contacts a service. */
export async function mapSplitSamStatus(root) {
  let config;
  try {
    config = await configuration(root);
  } catch (error) {
    return {
      available: false,
      model: 'SAM 2.1 Tiny',
      maxEdge: 1024,
      networkCalls: 0,
      code: error.code,
      missing: ['runtime-profile'],
      message: error.message,
    };
  }
  const checks = await Promise.allSettled([
    access(config.python),
    access(config.weights),
    access(path.join(config.tool, 'worker.py')),
    access(path.join(config.tool, 'map_auto.py')),
  ]);
  const missing = ['python', 'weights', 'worker'].filter(
    (_, index) => checks[index].status === 'rejected',
  );
  const automaticMissing = ['python', 'weights', 'automatic-worker'].filter(
    (_, index) => checks[[0, 1, 3][index]].status === 'rejected',
  );
  return {
    available: !missing.length,
    model: 'SAM 2.1 Tiny',
    weightsSha256: config.profile.weightsSha256,
    maxEdge: 1024,
    automaticAvailable: !automaticMissing.length,
    automaticMissing,
    networkCalls: 0,
    missing,
    ...(missing.length
      ? {
          code: 'MAP_SPLIT_SAM_UNAVAILABLE',
          message: `本机 SAM 未就绪：缺少 ${missing.join('、')}。可使用本地像素粗分或精确选区。`,
        }
      : {}),
  };
}

function automaticParameters(input = {}) {
  const integer = (value, fallback, low, high, name) => {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < low || value > high)
      throw failure(`SAM 自动分割 ${name} 超出 ${low}..${high} 限制。`);
    return value;
  };
  const threshold = (value, fallback, low, high) => {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < low || value > high)
      throw failure('SAM 自动分割过滤阈值超出限制。');
    return value;
  };
  return {
    maxEdge: integer(input.maxEdge, 1024, 32, 1024, 'maxEdge'),
    parameters: {
      points_per_side: integer(input.pointsPerSide, 24, 8, 24, 'pointsPerSide'),
      points_per_batch: integer(
        input.pointsPerBatch,
        32,
        1,
        32,
        'pointsPerBatch',
      ),
      max_candidates: integer(input.maxCandidates, 96, 1, 96, 'maxCandidates'),
      minimum_area: integer(
        input.minimumArea,
        8,
        1,
        1024 * 1024,
        'minimumArea',
      ),
      predicted_iou_threshold: threshold(
        input.predictedIouThreshold,
        0.7,
        0.5,
        0.95,
      ),
      stability_threshold: threshold(input.stabilityThreshold, 0.9, 0.75, 0.99),
    },
  };
}

/** One real local AMG inference on a bounded full-map overview. Output counts
 * address the immutable original canvas, sampled by global pixel centres.
 * This mapping does not turn coarse overview edges into native-detail masks. */
export async function automaticMapSegments(root, frozen, options = {}) {
  const { maxEdge, parameters } = automaticParameters(options.automatic);
  if (!Buffer.isBuffer(frozen?.png) || sha(frozen.png) !== frozen.sourceHash)
    throw failure('冻结地图像素已改变。', 'MAP_SPLIT_SOURCE_CHANGED', 409);
  const status = await mapSplitSamStatus(root);
  if (!status.automaticAvailable)
    throw failure(
      `本机 SAM 自动分割未就绪：${(status.automaticMissing ?? status.missing).join('、')}。`,
      'MAP_SPLIT_SAM_UNAVAILABLE',
    );
  if (running)
    throw failure(
      '本机地图 SAM 正在处理另一份请求。',
      'MAP_SPLIT_SAM_BUSY',
      409,
    );
  let scratch;
  running = true;
  try {
    const config = await configuration(root);
    scratch = await mkdtemp(path.join(tmpdir(), 'forge-map-sam-'));
    const overview = await sharp(frozen.png, { limitInputPixels: 64_000_000 })
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: 'nearest',
      })
      .png()
      .toBuffer();
    const meta = await sharp(overview).metadata(),
      sourceHash = sha(overview);
    const source = path.join(scratch, 'overview.png'),
      output = path.join(scratch, 'result'),
      jobFile = path.join(scratch, 'job.json');
    await writeFile(source, overview);
    await writeFile(
      jobFile,
      JSON.stringify({
        source,
        output,
        source_sha256: sourceHash,
        source_map_hash: frozen.sourceHash,
        original_size: { width: frozen.width, height: frozen.height },
        weights: config.weights,
        weights_sha256: config.profile.weightsSha256,
        parameters,
      }),
    );
    try {
      await run(
        config.python,
        [path.join(config.tool, 'map_auto.py'), '--job', jobFile],
        {
          timeout: 180000,
          killSignal: 'SIGKILL',
          windowsHide: true,
          maxBuffer: 512 * 1024,
        },
      );
    } catch {
      throw failure(
        '本地 SAM 自动分割未完成；请检查运行环境或改用纯像素粗分。没有重试、下载或外发图片。',
        'MAP_SPLIT_SAM_FAILED',
      );
    }
    const receipt = JSON.parse(
      await readFile(path.join(output, 'receipt.json'), 'utf8'),
    );
    if (
      receipt.operation !== 'map-automatic' ||
      receipt.source_sha256 !== sourceHash ||
      receipt.source_map_hash !== frozen.sourceHash ||
      receipt.original_size?.width !== frozen.width ||
      receipt.original_size?.height !== frozen.height ||
      receipt.width !== meta.width ||
      receipt.height !== meta.height ||
      receipt.weights_sha256 !== config.profile.weightsSha256 ||
      !Array.isArray(receipt.parts) ||
      receipt.parts.length > parameters.max_candidates ||
      Object.entries(parameters).some(
        ([key, value]) => receipt.parameters?.[key] !== value,
      ) ||
      receipt.parameters.crop_n_layers !== 0 ||
      receipt.network_calls !== 0 ||
      receipt.paid_calls !== 0
    )
      throw failure('SAM 自动分割回执与冻结概览、参数或固定权重不符。');
    const selections = [],
      seen = new Set();
    let totalBoxPixels = 0;
    for (const record of receipt.parts) {
      const bounds = record.bbox;
      if (
        !/^auto_[0-9]{3}$/.test(record.id) ||
        seen.has(record.id) ||
        record.file !== record.id + '.png' ||
        !bounds ||
        ![bounds.x, bounds.y, bounds.width, bounds.height].every(
          Number.isInteger,
        ) ||
        bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.width < 1 ||
        bounds.height < 1 ||
        bounds.x + bounds.width > meta.width ||
        bounds.y + bounds.height > meta.height
      )
        throw failure('SAM 自动候选身份或窗口无效。');
      seen.add(record.id);
      totalBoxPixels += bounds.width * bounds.height;
      if (totalBoxPixels > meta.width * meta.height * 4)
        throw failure('SAM 自动候选超出总窗口像素预算。');
      const png = await readFile(path.join(output, record.file));
      if (sha(png) !== record.sha256)
        throw failure('SAM 自动候选 PNG 哈希不符。');
      const image = sharp(png, { limitInputPixels: 1024 * 1024 }),
        info = await image.metadata();
      if (
        info.format !== 'png' ||
        info.width !== bounds.width ||
        info.height !== bounds.height
      )
        throw failure('SAM 自动候选 PNG 尺寸不符。');
      const pixels = await image.removeAlpha().greyscale().raw().toBuffer();
      const x = Math.floor((bounds.x * frozen.width) / meta.width),
        y = Math.floor((bounds.y * frozen.height) / meta.height);
      const width =
          Math.ceil(((bounds.x + bounds.width) * frozen.width) / meta.width) -
          x,
        height =
          Math.ceil(
            ((bounds.y + bounds.height) * frozen.height) / meta.height,
          ) - y;
      const counts = [];
      let bit = 0,
        count = 0,
        area = 0;
      for (let py = y; py < y + height; py++) {
        const sy =
          Math.floor(((py + 0.5) * meta.height) / frozen.height) - bounds.y;
        for (let px = x; px < x + width; px++) {
          const sx =
            Math.floor(((px + 0.5) * meta.width) / frozen.width) - bounds.x;
          const next = Number(
            sx >= 0 &&
              sy >= 0 &&
              sx < bounds.width &&
              sy < bounds.height &&
              pixels[sy * bounds.width + sx] > 0,
          );
          if (next !== bit) {
            counts.push(count);
            count = 0;
            bit = next;
          }
          count++;
          area += next;
        }
      }
      counts.push(count);
      if (area)
        selections.push({
          id: record.id,
          selection: { type: 'rle', x, y, width, height, counts },
          overviewBounds: bounds,
          area,
          overviewArea: record.area,
          predictedIou: record.predicted_iou,
          stabilityScore: record.stability_score,
          scoresAreAccuracy: false,
        });
    }
    const result = {
      ...receipt,
      kind: 'local-sam-automatic',
      sourceMapHash: frozen.sourceHash,
      model: 'SAM 2.1 Tiny',
      verification: 'unverified',
      overview: {
        width: meta.width,
        height: meta.height,
        originalWidth: frozen.width,
        originalHeight: frozen.height,
        scaleX: meta.width / frozen.width,
        scaleY: meta.height / frozen.height,
      },
      mapping: 'nearest-global-pixel-centres',
      nativePixelAccuracy: false,
      networkCalls: 0,
    };
    await options.onSamReceipt?.(result);
    return { selections, receipt: result };
  } finally {
    try {
      await cleanScratch(scratch);
    } finally {
      running = false;
    }
  }
}

function windowFor(frozen, selection) {
  let window = selection.window;
  if (!window) {
    const box = selection.box;
    if (!box) {
      if (frozen.width > 1024 || frozen.height > 1024)
        throw failure(
          '大地图上的 SAM 点提示需要显式给出最长边不超过 1024 的 window。',
        );
      window = { x: 0, y: 0, width: frozen.width, height: frozen.height };
    } else {
      if (box.width > 1024 || box.height > 1024)
        throw failure(
          'SAM 提示框超过 1024 像素；请拆成重叠窗口，以相同对象 ID 返回。',
        );
      const width = Math.min(1024, frozen.width),
        height = Math.min(1024, frozen.height);
      window = {
        x: Math.max(
          0,
          Math.min(
            frozen.width - width,
            Math.floor(box.x + box.width / 2 - width / 2),
          ),
        ),
        y: Math.max(
          0,
          Math.min(
            frozen.height - height,
            Math.floor(box.y + box.height / 2 - height / 2),
          ),
        ),
        width,
        height,
      };
    }
  }
  if (
    ![window.x, window.y, window.width, window.height].every(
      Number.isInteger,
    ) ||
    window.x < 0 ||
    window.y < 0 ||
    window.width < 1 ||
    window.height < 1 ||
    window.width > 1024 ||
    window.height > 1024 ||
    window.x + window.width > frozen.width ||
    window.y + window.height > frozen.height
  )
    throw failure('SAM window 必须位于地图内，且最长边不超过 1024。');
  const box = selection.box;
  if (
    box &&
    (box.width < 1 ||
      box.height < 1 ||
      box.x < window.x ||
      box.y < window.y ||
      box.x + box.width > window.x + window.width ||
      box.y + box.height > window.y + window.height)
  )
    throw failure('SAM 提示框必须完整位于显式窗口内。');
  const points = selection.points ?? [];
  if (
    points.length > 32 ||
    points.some(
      (p) =>
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        p.x < window.x ||
        p.y < window.y ||
        p.x >= window.x + window.width ||
        p.y >= window.y + window.height ||
        typeof p.include !== 'boolean',
    )
  )
    throw failure('SAM 正负点必须位于窗口内，最多 32 个。');
  if (!box && !points.length) throw failure('SAM 需要实际框或正负点提示。');
  return window;
}

export async function segmentMapSelection(
  root,
  frozen,
  selection,
  options = {},
) {
  const window = windowFor(frozen, selection);
  if (!Buffer.isBuffer(frozen.png) || sha(frozen.png) !== frozen.sourceHash)
    throw failure('冻结地图像素已改变。', 'MAP_SPLIT_SOURCE_CHANGED', 409);
  const status = await mapSplitSamStatus(root);
  if (!status.available)
    throw failure(status.message, 'MAP_SPLIT_SAM_UNAVAILABLE');
  if (running)
    throw failure(
      '本机地图 SAM 正在处理另一份请求。',
      'MAP_SPLIT_SAM_BUSY',
      409,
    );
  let scratch;
  running = true;
  try {
    const config = await configuration(root);
    scratch = await mkdtemp(path.join(tmpdir(), 'forge-map-sam-'));
    const png = await sharp(frozen.png, { limitInputPixels: 64_000_000 })
      .extract({
        left: window.x,
        top: window.y,
        width: window.width,
        height: window.height,
      })
      .png()
      .toBuffer();
    const prompt = {
      id: 'map_part',
      points: (selection.points ?? []).map((p) => [
        p.x - window.x,
        p.y - window.y,
      ]),
      labels: (selection.points ?? []).map((p) => Number(p.include)),
      ...(selection.box
        ? {
            box: [
              selection.box.x - window.x,
              selection.box.y - window.y,
              selection.box.x + selection.box.width - window.x,
              selection.box.y + selection.box.height - window.y,
            ],
          }
        : {}),
    };
    const source = path.join(scratch, 'source.png'),
      output = path.join(scratch, 'result'),
      jobFile = path.join(scratch, 'job.json'),
      sourceHash = sha(png);
    await writeFile(source, png);
    await writeFile(
      jobFile,
      JSON.stringify({
        source,
        output,
        source_sha256: sourceHash,
        weights: config.weights,
        weights_sha256: config.profile.weightsSha256,
        parts: [prompt],
        semantics_origin: 'scene-map-split-explicit-prompt',
      }),
    );
    try {
      await run(
        config.python,
        [path.join(config.tool, 'worker.py'), 'segment', '--job', jobFile],
        {
          timeout: 120000,
          killSignal: 'SIGKILL',
          windowsHide: true,
          maxBuffer: 512 * 1024,
        },
      );
    } catch {
      throw failure(
        '本地 SAM 未完成；请检查运行环境或使用精确像素选区。未进行下载或联网调用。',
        'MAP_SPLIT_SAM_FAILED',
      );
    }
    const receipt = JSON.parse(
      await readFile(path.join(output, 'receipt.json'), 'utf8'),
    );
    if (
      receipt.source_sha256 !== sourceHash ||
      receipt.weights_sha256 !== config.profile.weightsSha256 ||
      receipt.width !== window.width ||
      receipt.height !== window.height ||
      receipt.parts?.length !== 1 ||
      receipt.parts[0].id !== 'map_part'
    )
      throw failure('SAM 回执与冻结窗口身份不符。');
    const maskPng = await readFile(path.join(output, 'map_part.png'));
    if (sha(maskPng) !== receipt.parts[0].sha256)
      throw failure('SAM 蒙版哈希与回执不符。');
    const image = sharp(maskPng, { limitInputPixels: 1024 * 1024 }),
      meta = await image.metadata();
    if (
      meta.format !== 'png' ||
      meta.width !== window.width ||
      meta.height !== window.height
    )
      throw failure('SAM 蒙版尺寸不符。');
    const local = await image.removeAlpha().greyscale().raw().toBuffer(),
      mask = new Uint8Array(frozen.width * frozen.height);
    for (let y = 0; y < window.height; y++)
      for (let x = 0; x < window.width; x++)
        if (local[y * window.width + x])
          mask[(y + window.y) * frozen.width + x + window.x] = 1;
    const publicReceipt = {
      ...receipt,
      sourceMapHash: frozen.sourceHash,
      window,
      model: 'SAM 2.1 Tiny',
      verification: 'unverified',
      networkCalls: 0,
    };
    await options.onSamReceipt?.(publicReceipt);
    return { mask, receipt: publicReceipt };
  } finally {
    try {
      await cleanScratch(scratch);
    } finally {
      running = false;
    }
  }
}
