/* oxlint-disable next/no-img-element -- Browser regression for the real workspace preview. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ImageEditWorkspace } from '../../components/image-edit/image-edit-workspace';
import { ImageAttributePlan } from '../../components/image-edit/image-attribute-plan';
import { attributeDefaults } from '../../features/image-edit/attribute-plan.mjs';
import type { RegionSpec } from '../../features/image-edit/core.mjs';
import { base64ToBytes, bytesToBase64, rgbaHash } from '../../features/image-edit/client';
import type { ImageEditSession, ImagePixels, ImageTargetInfo, ImageTargetRef } from '../../features/image-edit/client';
import { readImageEditNavigation, writeImageEditNavigation } from '../../features/image-edit/navigation';
import '../../app/globals.css';

// Open through the isolated ui-server.mjs, never the production app. All API
// requests are intercepted here; no fixture can reach a provider or real document.
const root = createRoot(document.getElementById('root')!);
const results = document.getElementById('results')!, passed: string[] = [];
const check = (condition: unknown, note: string) => { if (!condition) throw new Error(note); passed.push(note); };
const until = async (predicate: () => boolean) => {
  const deadline = performance.now() + 8000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('UI timeout: ' + document.body.innerText.slice(-1500)); await new Promise(resolve => setTimeout(resolve, 15)); }
};
const button = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.trim() === name);
const click = async (name: string) => { await until(() => !!button(name) && !button(name)!.disabled); button(name)!.click(); };
const checkbox = (name: string) => Array.from(document.querySelectorAll<HTMLLabelElement>('label')).find(item => item.textContent?.trim() === name)?.querySelector<HTMLInputElement>('input[type=checkbox]');
const fixturePixels = async (rgba: [number, number, number, number]): Promise<ImagePixels> => {
  const width = 8, height = 4, bytes = new Uint8Array(width * height * 4);
  for (let i = 0; i < bytes.length; i += 4) bytes.set(rgba, i);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(bytes), width, height), 0, 0);
  const imageBase64 = canvas.toDataURL('image/png').split(',')[1];
  return { width, height, imageBase64, imageMimeType: 'image/png', sha256: await rgbaHash(base64ToBytes(imageBase64)), rgbaSha256: await rgbaHash(bytes), rgbaBase64: bytesToBase64(bytes), rgbaByteLength: bytes.length, pixelFormat: 'sRGB-RGBA8-straight' };
};
// Stored only for prototype restoration below, never called without a receiver.
// oxlint-disable-next-line typescript/unbound-method
const originalFetch = window.fetch, originalToBlob = HTMLCanvasElement.prototype.toBlob;
let blobCalls = 0, createCalls = 0;
const editPayloads: { constraints: { preserveAlpha: boolean }; commandId: string }[] = [];
try {
  const original = await fixturePixels([110, 81, 30, 255]), candidate = await fixturePixels([22, 132, 144, 255]);
  const originalUrl = `data:image/png;base64,${original.imageBase64}`, candidateUrl = `data:image/png;base64,${candidate.imageBase64}`;
  const target: ImageTargetRef = { kind: 'scene-instance', documentId: 'workspace-fixture', instanceId: 'gate', slot: 'visual' };
  let currentTarget: ImageTargetInfo = { targetId: 'imgtarget:workspace-fixture', targetRef: target, revision: 1, sha256: original.sha256, rgbaSha256: original.rgbaSha256, width: 8, height: 4, editable: true, locked: false, kind: 'prop', name: '本机浏览器回归素材', aiEdit: { supported: true, provider: 'fixture-no-provider', width: 8, height: 4, minPixels: 1, maxPixels: 32, maxEdge: 8, dimensionStep: 1, maxAspectRatio: 3, maxReferences: 8, maxImageBytes: 1024, maxTotalImageBytes: 8192, constraints: { preserveOutsideRegion: true, preserveDimensions: true, preserveAlpha: true } } };
  const sessions = new Map<string, ImageEditSession>([['edit-original', { editId: 'edit-original', revision: 1, target: structuredClone(currentTarget), source: { sha256: original.sha256, rgbaSha256: original.rgbaSha256 }, candidates: [{ version: 'candidate-teal', status: 'completed', operation: { type: 'pixel-patch' }, baseCandidateVersion: 'source', createdAt: new Date().toISOString() }], adoptions: [] }]]);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/workbench/image-edit/')) throw new Error('Browser regression forbids non-fixture fetch: ' + url.pathname);
    if (typeof init?.body !== 'string') throw new Error('Fixture requests require a JSON string body');
    const body = JSON.parse(init.body), operation = url.pathname.split('/').at(-1);
    if (operation === 'inspect') return Response.json({ target: currentTarget, sessions: [...sessions.values()].map(edit => ({ editId: edit.editId, revision: edit.revision, createdAt: new Date().toISOString() })) });
    if (operation === 'session-create') {
      const edit: ImageEditSession = { editId: `edit-created-${++createCalls}`, revision: 1, target: structuredClone(currentTarget), source: { sha256: original.sha256, rgbaSha256: original.rgbaSha256 }, candidates: [], adoptions: [] };
      sessions.set(edit.editId, edit); return Response.json({ edit });
    }
    if (operation === 'resolve') return Response.json({ regionRef: 'region-fixture' });
    const edit = sessions.get(body.editId);
    if (!edit) throw new Error('Unknown fixture session');
    if (operation === 'session-get') return Response.json({ edit: { ...edit, ...(body.includePixels ? { pixels: body.candidateVersion === 'source' ? original : candidate, selectedVersion: body.candidateVersion } : {}) } });
    if (operation === 'apply') {
      const image = body.candidateVersion === 'source' ? original : candidate;
      currentTarget = { ...currentTarget, revision: Number(currentTarget.revision) + 1, sha256: image.sha256, rgbaSha256: image.rgbaSha256 };
      const adoption = { status: 'adopted', sha256: image.sha256, commandId: body.commandId };
      edit.adoptions.push(adoption); edit.revision++;
      return Response.json({ target: currentTarget, revision: currentTarget.revision, currentRevision: currentTarget.revision, adoption });
    }
    if (operation === 'edit') {
      editPayloads.push(structuredClone(body));
      const version = `candidate-ui-${editPayloads.length}`;
      edit.revision++; edit.candidates.push({ version, status: 'completed', createdAt: new Date().toISOString(), operation: body.operation, constraints: body.constraints, baseCandidateVersion: body.baseCandidateVersion });
      return Response.json({ edit, candidateVersion: version, status: 'completed' });
    }
    throw new Error('Unexpected fixture operation: ' + operation);
  };
  // Deliberately never resolve Canvas.toBlob. Old saved-image preview code stalls
  // here; restored pixels must appear without depending on that delayed callback.
  HTMLCanvasElement.prototype.toBlob = function () { blobCalls++; };
  history.replaceState({ fixtureRouterState: 'retained' }, '', '?document=workspace-fixture&imageEdit=edit-original&imageCandidate=candidate-teal#gate');
  const render = (editId: string, candidateVersion: string) => root.render(<ImageEditWorkspace target={target} initialEditId={editId} initialCandidateVersion={candidateVersion} onNavigationChange={writeImageEditNavigation} onAdopt={async () => {}} onClose={() => root.render(null)} renderContext={src => <img data-fixture-preview src={src} alt="版本同步回归预览" />} />);
  render('edit-original', 'candidate-teal');
  await until(() => !!checkbox('场景上下文')); checkbox('场景上下文')!.click();
  const previewSource = () => document.querySelector<HTMLImageElement>('[data-fixture-preview]')?.getAttribute('src');
  await until(() => previewSource() === candidateUrl);
  check(blobCalls === 0, 'Saved candidate appears without Canvas.toBlob');
  await click('采用此候选'); await until(() => document.body.innerText.includes('已采用到指定目标'));
  await click('恢复会话原图'); await until(() => document.body.innerText.includes('原始图片已恢复为新的目标版本'));
  check(previewSource() === originalUrl, 'Restore success and original preview are committed in the same render');
  check(blobCalls === 0, 'Restoration does not wait for a delayed Canvas encoding');
  await click('基于当前图片继续精修');
  await until(() => readImageEditNavigation()?.editId === 'edit-created-1');
  check(readImageEditNavigation()?.candidateVersion === 'source', 'New session URL clears the previous candidate');
  check(new URL(location.href).searchParams.get('document') === 'workspace-fixture' && location.hash === '#gate', 'Session navigation preserves the host document and anchor');
  check(history.state.fixtureRouterState === 'retained', 'Session navigation preserves router history state');
  const selection = readImageEditNavigation()!;
  root.render(null); await until(() => !document.querySelector('dialog'));
  render(selection.editId, selection.candidateVersion!);
  await until(() => !!button('AI 局部修改'));
  check(createCalls === 1, 'Reopening the copied URL reads the same session without creating another');
  await click('AI 局部修改');
  await until(() => !!checkbox('保留原图透明度'));
  check(checkbox('保留原图透明度')!.checked, 'AI defaults to preserving base Alpha');
  checkbox('保留原图透明度')!.click();
  await click('选整图');
  const prompt = document.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Fixture-only recolor'); prompt.dispatchEvent(new Event('input', { bubbles: true }));
  await click('生成 AI 候选（调用模型）');
  await until(() => editPayloads.length === 1 && document.body.innerText.includes('候选已保存，请对比效果'));
  check(editPayloads[0].constraints.preserveAlpha === false, 'Turning off Alpha preservation reaches the frozen request');
  await until(() => readImageEditNavigation()?.candidateVersion === 'candidate-ui-1');
  check(readImageEditNavigation()?.editId === 'edit-created-1', 'Completed candidate URL remains in the new session');
  check(editPayloads.length === 1, 'Preview, restore and navigation do not submit another edit');
  const plannerSession=sessions.get(selection.editId)!;
  const maximum:RegionSpec={type:'all'},box:RegionSpec={type:'rectangle',x:1,y:0,width:2,height:2};
  const manual:RegionSpec={type:'rectangle',x:4,y:1,width:2,height:1};
  const instruction='Replace badge';
  let submitted:{targetRegion?:RegionSpec;influenceRegion?:RegionSpec}|undefined;
  window.fetch=async(url,init)=>{
    if(typeof url!=='string' || typeof init?.body!=='string')throw Error('Expected an image edit fixture request');
    const op=url.split('/').at(-1);
    if(op==='resolve')return Response.json({regionRef:'maximum'});
    if(op==='part-context')return Response.json({part:{status:'completed',partRef:'fixture',instruction,views:[],
      service:{configured:true,endpoint:'http://localhost/',profile:{model:'fixture'}},
      suggestion:{decision:'propose',part:'badge',reason:'fixture',kind:'replace',policy:attributeDefaults.part,
        changesSilhouette:false,successCriteria:['visible badge'],target:box,influence:{...box,x:3}}}});
    if(op==='plan-prepare'){
      submitted=JSON.parse(init.body);
      return Response.json({plan:{part:'badge',scope:{count:2},maxImageCalls:1,previewPng:original.imageBase64,warnings:[]}});
    }
    throw Error('Unexpected planner fixture request '+op);
  };
  const draw=(region:RegionSpec)=>root.render(<ImageAttributePlan target={currentTarget} session={plannerSession} baseVersion="source"
    region={region} prompt={instruction} references={[]} preserveAlpha disabled={false} offerPlanner onBusy={()=>{}}
    onSelectRegion={draw} onExecute={()=>{throw Error('Unexpected generation');}}/>);
  draw(maximum);
  await until(()=>!document.querySelector('.ie-workspace') && !!document.querySelector('.ie-part-planner'));
  await click('准备部件定位视图（本地）');
  await click('使用核对后的框和属性');
  await until(()=>document.body.textContent!.includes('已指定影响区'));
  draw(manual);
  await until(()=>document.body.textContent!.includes('画布选区已改变'));
  await click('只载入属性，保留手选范围');
  await click('准备计划并预览范围');
  await until(()=>!!submitted);
  check(JSON.stringify(submitted?.targetRegion)===JSON.stringify(manual) && !submitted?.influenceRegion,'A redrawn selection replaces the suggested target and influence in the prepared request');
  results.textContent = JSON.stringify({ status: 'passed', checks: passed.length, assertions: passed, fixtureEditRequests: editPayloads.length, realProviderRequests: 0, canvasEncodingCalls: blobCalls }, null, 2);
  results.dataset.status = 'passed';
} catch (cause) {
  results.textContent = JSON.stringify({ status: 'failed', passed, error: cause instanceof Error ? cause.stack : String(cause), realProviderRequests: 0 }, null, 2); results.dataset.status = 'failed';
} finally {
  root.unmount(); window.fetch = originalFetch; HTMLCanvasElement.prototype.toBlob = originalToBlob;
}
