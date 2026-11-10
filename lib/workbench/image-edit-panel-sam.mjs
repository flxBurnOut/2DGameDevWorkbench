import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { PANEL_MAX_EDGE, panelRegion, snapPanelMask } from '../../features/image-edit/metal-panel.mjs';

const run = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let running = false;

function makeParts({ frame: { width, height }, allowed }, { splitRows, points }) {
  if (splitRows.some(y => y <= 0 || y >= height) || points.some(p => p.x >= width || p.y >= height || (p.include && !allowed[p.y * width + p.x])))
    throw Object.assign(new Error('分板提示超出当前板面范围。'), { status: 400 });
  const cuts = [0, ...new Set(splitRows.toSorted((a, b) => a - b)), height];
  return cuts.slice(1).map((bottom, i) => {
    const top = cuts[i], hints = points.filter(p => p.y >= top && p.y < bottom);
    return { id: `board_${i}`, box: [0, top, width, bottom], points: hints.map(p => [p.x, p.y]), labels: hints.map(p => Number(p.include)) };
  });
}

/** Analysis only. The caller supplies verified immutable pixels; every path in
 * the subprocess job is server-owned. The final user mask is frozen on submit. */
export async function suggestPanelRegion(root, crop, base, input) {
  const parts = makeParts(crop, input);
  if (running) throw Object.assign(new Error('本地分板正在处理另一张图片，请稍后再试。'), { status: 409, code: 'PANEL_SAM_BUSY' });
  running = true;
  let scratch;
  try {
    const tool = path.join(root, 'Tools', 'VisualStructure');
    const profile = JSON.parse(await readFile(path.join(tool, 'runtime-profile.json'), 'utf8'));
    const runtime = path.join(root, profile.runtimeDirectory);
    const python = process.env.FORGE_STRUCTURE_PYTHON || path.join(runtime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const weights = process.env.FORGE_STRUCTURE_WEIGHTS || path.join(runtime, 'checkpoints', 'sam2.1_hiera_tiny.pt');
    try { await Promise.all([access(python), access(weights)]); }
    catch { throw Object.assign(new Error('本机未配置 SAM 分割。可用补选和减去修正板面。'), { status: 422, code: 'PANEL_SAM_UNAVAILABLE' }); }
    scratch = await mkdtemp(path.join(tmpdir(), 'forge-panel-sam-'));
    const { frame } = crop, { width, height } = frame;
    // Let the predictor see adjoining boards, fasteners and the rest of the
    // object. Only the confirmed frame and original allowed mask can be returned.
    const contextWidth = Math.min(PANEL_MAX_EDGE, base.width), contextHeight = Math.min(PANEL_MAX_EDGE, base.height);
    const left = Math.max(0, Math.min(base.width - contextWidth, frame.x - Math.floor((contextWidth - width) / 2)));
    const top = Math.max(0, Math.min(base.height - contextHeight, frame.y - Math.floor((contextHeight - height) / 2)));
    const dx = frame.x - left, dy = frame.y - top;
    const prompts = parts.map(part => ({ ...part, box: [dx, dy + part.box[1], dx + width, dy + part.box[3]],
      points: part.points.map(([x, y]) => [dx + x, dy + y]) }));
    const source = path.join(scratch, 'source.png'), output = path.join(scratch, 'result'), job = path.join(scratch, 'job.json');
    const bytes = await sharp(base.pixels, { raw: { width: base.width, height: base.height, channels: 4 } })
      .extract({ left, top, width: contextWidth, height: contextHeight }).png().toBuffer();
    const sourceHash = sha(bytes);
    await writeFile(source, bytes);
    await writeFile(job, JSON.stringify({ source, source_sha256: sourceHash, output, weights, weights_sha256: profile.weightsSha256,
      parts: prompts, semantics_origin: 'image-edit-panel-hints' }));
    try { await run(python, [path.join(tool, 'worker.py'), 'segment', '--job', job], { timeout: 90000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 512 * 1024 }); }
    catch { throw Object.assign(new Error('本地 SAM 分板未完成，请检查视觉结构运行环境，或手动修正选区。'), { status: 422, code: 'PANEL_SAM_FAILED' }); }
    const receipt = JSON.parse(await readFile(path.join(output, 'receipt.json'), 'utf8'));
    if (receipt.source_sha256 !== sourceHash || receipt.weights_sha256 !== profile.weightsSha256 || receipt.width !== contextWidth || receipt.height !== contextHeight || receipt.parts.length !== parts.length)
      throw new Error('分板回执与输入不符。');
    const selected = new Uint8Array(width * height);
    for (const [index, part] of parts.entries()) {
      const record = receipt.parts[index];
      const png = await readFile(path.join(output, part.id + '.png'));
      if (record.id !== part.id || sha(png) !== record.sha256) throw new Error('分板蒙版校验失败。');
      const result = sharp(png, { limitInputPixels: contextWidth * contextHeight });
      const meta = await result.metadata();
      if (meta.width !== contextWidth || meta.height !== contextHeight) throw new Error('分板尺寸不符。');
      const data = await result.extract({ left: dx, top: dy, width, height }).greyscale().raw().toBuffer();
      if (data.length !== width * height) throw new Error('分板通道不符。');
      for (let i = part.box[1] * width; i < part.box[3] * width; i++) if (crop.allowed[i] && data[i]) selected[i] = 1;
    }
    if (!selected.includes(1)) throw Object.assign(new Error('未找到板面，请补充定位点或手工涂选。'), { status: 422 });
    const snapped = snapPanelMask(selected, crop.allowed, frame, input.cellSize ?? 1);
    return { region: panelRegion(snapped, frame, base.width), frame, model: 'SAM 2.1 Tiny', weightsSha256: profile.weightsSha256 };
  } finally {
    try { if (scratch) await rm(scratch, { recursive: true, force: true }); }
    finally { running = false; }
  }
}
