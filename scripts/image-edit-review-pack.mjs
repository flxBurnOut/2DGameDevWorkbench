import { readFile, writeFile, mkdir, copyFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { json, save, sha, validateBatch } from './image-edit-evaluation/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [sourceDirectory, destination] = process.argv.slice(2);
if (!sourceDirectory || !destination) throw new Error('Usage: node scripts/image-edit-review-pack.mjs <frozen-work-directory> <new-work-directory>');
const insideWork = value => {
  const target = path.resolve(root, value), relative = path.relative(path.join(root, 'work'), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Review packs belong inside work/.');
  return target;
};
const source = insideWork(sourceDirectory), output = insideWork(destination);
const exists = file => access(file).then(() => true, () => false);
if (await exists(output)) throw new Error('Use a new review directory; do not replace existing ratings.');
const batch = validateBatch(await json(path.join(source, 'batch.json'))), baseline = await json(path.join(source, 'baseline.json'));
if (sha(JSON.stringify(batch)) !== baseline.batchSha256) throw new Error('Batch changed after freezing.');
await mkdir(output, { recursive: true });
const anonymous = batch.cases.map(c => ({ case: c, id: randomBytes(6).toString('hex'), left: randomBytes(1)[0] % 2 ? 'source' : 'candidate' })).sort((a, b) => a.id.localeCompare(b.id));
const forms = [], key = [], cards = [];
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
for (const item of anonymous) {
  const c = item.case, dir = path.join(source, 'cases', c.id), frozen = await json(path.join(dir, 'frozen.json'));
  const ready = await exists(path.join(dir, 'image.png'));
  if (sha(await readFile(path.join(dir, 'source.png'))) !== frozen.sourceSha256) throw new Error('Source integrity check failed.');
  const result = await exists(path.join(dir, 'result.json')) ? await json(path.join(dir, 'result.json')) : null;
  const sourceName = `${item.id}-source.png`, candidateName = `${item.id}-candidate.png`;
  await copyFile(path.join(dir, 'source.png'), path.join(output, sourceName));
  if (ready) {
    const bytes = await readFile(path.join(dir, 'image.png'));
    const pixels = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer();
    if (sha(pixels) !== result?.metrics?.candidateRgbaSha256) throw new Error('Candidate integrity check failed.');
    await writeFile(path.join(output, candidateName), bytes, { flag: 'wx' });
    const r = c.crop ?? c.annotation.allowed;
    if (r.type === 'rectangle') {
      const left = Math.max(0, r.x - 24), top = Math.max(0, r.y - 24);
      const crop = { left, top, width: Math.min(frozen.width, r.x + r.width + 24) - left, height: Math.min(frozen.height, r.y + r.height + 24) - top };
      for (const [label, name] of [['source', sourceName], ['candidate', candidateName]]) await sharp(path.join(output, name)).extract(crop).resize({ width: Math.min(crop.width * 3, 700), kernel: c.style === 'pixel' ? 'nearest' : 'lanczos3' }).png().toFile(path.join(output, `${item.id}-${label}-detail.png`));
    }
  }
  key.push({ anonymousId: item.id, caseId: c.id, family: c.family, method: 'A', sourceSha256: frozen.sourceSha256, candidateRgbaSha256: result?.metrics?.candidateRgbaSha256 ?? null, hardProtection: result?.metrics?.hardProtection ?? null, alphaChanged: result?.metrics?.alphaChanged ?? null, status: result?.status ?? 'not-run' });
  forms.push({ anonymousId: item.id, targetAchieved: null, preservedContent: null, boundaryAndAlpha: null, usableAtPlacementSize: null, severeArtifact: null, verdict: null, defects: [], activeReviewMinutes: null, repairMinutes: null, repairCompleted: null, comment: '' });
  const order = item.left === 'source' ? ['source', 'candidate'] : ['candidate', 'source'];
  const figures = order.map(label => `<figure><figcaption>${label === 'source' ? '基准' : '候选'}</figcaption>${label === 'candidate' && !ready ? '<p>缺少可评图片；保留此记录</p>' : `<a href="${item.id}-${label}.png"><img src="${item.id}-${label}.png" style="width:${c.displayWidth}px;image-rendering:${c.style === 'pixel' ? 'pixelated' : 'auto'}"></a>`}</figure>`).join('');
  const details = ready && await exists(path.join(output, `${item.id}-source-detail.png`)) ? `<details><summary>局部与边界放大</summary><div class="pair">${order.map(label => `<figure><figcaption>${label}</figcaption><img class="detail" src="${item.id}-${label}-detail.png"></figure>`).join('')}</div></details>` : '';
  cards.push(`<article><h2>${item.id}</h2><p>${escape(c.instruction)}</p><p>保持：${escape(c.keep)}</p><p>查看顺序：摆放尺寸 → 1:1 原像素（点击图片）→ 局部边界。摆放宽度 ${c.displayWidth}px。</p>${c.operation.type === 'palette-map' ? `<details><summary>指定色表</summary><pre>${escape(JSON.stringify(c.operation.pairs, null, 2))}</pre></details>` : ''}<div class="pair">${figures}</div>${details}</article>`);
}
await save(path.join(output, 'review-key-private.json'), { batchId: batch.id, instructions: 'Do not give this mapping to the independent reviewers before ratings are complete.', key });
for (const id of ['a', 'b']) await save(path.join(output, `reviewer-${id}.json`), { schemaVersion: 1, reviewer: null, reviewerType: 'human', independent: null, startedAt: null, finishedAt: null, rubric: { values: 'true / false / null (uncertain)', verdicts: ['pass', 'fail', 'uncertain'], defects: 'Each defect needs original-pixel x/y or bounding box, observable issue and severity.', pass: 'Target, preservation and boundaries must all pass. Hard checks are merged after content judgments. Time fields remain null unless measured.' }, records: forms });
await writeFile(path.join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>P0 independent review pack</title><style>body{font:16px system-ui;max-width:1600px;margin:32px auto;padding:0 24px;background:#eee;color:#222}article{padding:20px;margin:24px 0;background:white}.pair{display:flex;gap:32px;flex-wrap:wrap}figure{margin:8px}img{max-width:100%;background:repeating-conic-gradient(#ccc 0% 25%,#eee 0% 50%) 0/16px 16px}body.dark img{background:#202020}body.light img{background:#fafafa}.detail{width:auto;max-width:700px}pre{max-height:240px;overflow:auto}button{font:inherit;padding:8px 16px}</style><h1>P0 候选独立复核包</h1><p>24 个匿名候选位置，顺序和左右已打乱；本包只有 A 组，尚不构成方法对比。请两位评审分别填写 reviewer-a.json / reviewer-b.json，勿先看映射或模型自评。</p><p><button onclick="document.body.className='light'">明底</button> <button onclick="document.body.className='dark'">暗底</button> <button onclick="document.body.className=''">棋盘底</button></p>${cards.join('\n')}`);
console.log(JSON.stringify({ reviewPack: output, records: forms.length, ready: key.filter(k => k.status === 'completed').length, humanRatings: 0 }));
