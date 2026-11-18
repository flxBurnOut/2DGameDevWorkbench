import '../helpers/runtime-workspace.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {imageEditRequest} from '../../lib/workbench/image-edits.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { loadManifest, findCapability, validateInput, runConnector, refreshTask } from '../../lib/workbench/runtime.mjs';
import { taskViewPath, taskPresentation } from '../../lib/workbench/presentation.mjs';
import { createTestViteServer } from '../helpers/vite-server.mjs';
import { verifyPlanningProgress } from './planning-progress.mjs';
import { verifyMotionObjects } from './object-model.mjs';
import { listPresets } from '../../lib/workbench/agent-api.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve('work/test-runs', process.env.WORKBENCH_TEST_RUN, 'open-motion');
await mkdir(root, { recursive: true });
const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(r => reservation.close(r));
const python = process.env.SPRITE_TEST_PYTHON || path.resolve('Tools/SpritePipeline/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const child = spawn(python, ['Tools/SpritePipeline/tests/open_motion_server.py', root, String(port), '--checkpoints', '--expert-reviews', '--hold-first-reviews'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
const base = `http://127.0.0.1:${port}`;
const request = async (route, body) => {
  const response = await fetch(base + route, body ? { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) } : {});
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
};
const delay = ms => new Promise(r => setTimeout(r, ms));
const previous = process.env.SPRITE_PIPELINE_API_URL;
let vite, client;
async function mcp(name, args) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response));
  return response.structuredContent;
}
async function observeHeldReview(taskId, scope, fixtureScope) {
  const marker = path.join(root, `${fixtureScope}.entered`);
  for (let n = 0; n < 150; n++) {
    if (await access(marker).then(() => true, () => false)) break;
    assert.ok(n < 149, `fixture did not enter ${fixtureScope}`);
    await delay(100);
  }
  try {
    const polled = await mcp('workbench_get_task', { taskId });
    assert.equal(polled.task.status, 'running');
    assert.equal(polled.presentation.state, 'running');
    assert.match(polled.presentation.summary, /逐帧观察，已用 1\/5 次/);
    assert.deepEqual(polled.presentation.reviewProgress, {
      candidateIndex: 1, scope, ...(scope === 'stage' ? { stageIndex: 0 } : {}),
      state: 'running', phase: 'observe', callsUsed: 1, callsCompleted: 0, maxCalls: 5, verdict: 'uncertain',
    });
    const presented = await mcp('workbench_present', { taskId });
    assert.equal(presented.summary, polled.presentation.summary);
    for (const [identity, pollTool] of [[{ taskId }, 'workbench_get_task'], [{ jobId: polled.task.adapter.remoteJobId }, 'workbench_get_result']]) {
      const summary = await mcp('workbench_get_result', identity);
      assert.equal(summary.presentation.reviewProgress.phase, 'observe');
      assert.deepEqual(summary.result.nextActions, [pollTool]);
      assert.ok(JSON.stringify(summary).length < 5000);
    }
  } finally {
    await writeFile(path.join(root, `${fixtureScope}.released`), '');
  }
}
try {
  for (let n=0; n<100; n++) { try { await request('/health'); break; } catch { if (child.exitCode !== null || n===99) throw new Error(log || 'Test API startup failed'); await delay(100); } }
  process.env.SPRITE_PIPELINE_API_URL = base;
  const manifest = await loadManifest(), capability = findCapability(manifest, 'sprite-generator');
  const motionSpec = { character_id:'test_hero', description:'角色低头检查手套，最后保持低头', provider:'fixture', review_protocol:'experts_v1', candidate_count:2, budget:{max_planning_calls:8,max_generation_calls:5,max_review_calls:35} };
  const planningModels = { strategy: { model: 'kimi-k3.1-pro', provider: 'tokenhub' } };
  const input = { operation:'plan-motion', motionSpec, planningAuthorized:true, planningModels };
  assert.deepEqual(validateInput(capability,input),[]);
  const revisionInput = { operation: 'revise-motion', motionSpec, planningAuthorized: true, openWorkId: 'a'.repeat(32), expectedRevision: 1 };
  assert.deepEqual(validateInput(capability, { ...input, autoExecute: true }), []);
  assert.deepEqual(validateInput(capability, revisionInput), []);
  assert.deepEqual(validateInput(capability, { ...revisionInput, autoExecute: false }), []);
  assert.match(validateInput(capability, { ...revisionInput, autoExecute: true }).join(' '), /generate-motion/);
  const { character_id: legacyCharacterId, ...commonSpec } = motionSpec;
  const modernSpec = { ...commonSpec, object_id: legacyCharacterId, object_type: 'character' };
  assert.deepEqual(validateInput(capability, { ...input, motionSpec: modernSpec }), []);
  const modernDefaultSpec = { ...modernSpec }; delete modernDefaultSpec.object_type;
  assert.deepEqual(validateInput(capability, { ...input, motionSpec: modernDefaultSpec }), []);
  assert.ok(validateInput(capability, { ...input, motionSpec: commonSpec }).length);
  assert.ok(validateInput(capability, { ...input, motionSpec: { ...modernSpec, character_id: 'another_object' } }).length);
  assert.ok(validateInput(capability, { ...input, motionSpec: { ...modernSpec, object_type: 'prop' } }).length);
  const references = await request('/v1/open-motion/references');
  const door = references.objects.find(item => item.id === 'fixture_door');
  assert.equal(door.object_type, 'interactable');
  assert.equal(door.facing, undefined);
  assert.ok(references.characters.some(item => item.id === 'test_hero'));
  const presets = await listPresets(manifest, { query: 'fixture_door' });
  assert.equal(presets.objects[0].object_type, 'interactable');
  assert.equal(presets.characters.length, 0);

  assert.ok(validateInput(capability,{...input,planningAuthorized:false}).length);
  assert.ok(validateInput(capability,{...input,motionSpec:{...motionSpec,apiKey:'must-not-be-stored'}}).length);
  assert.ok(validateInput(capability,{...input,motionSpec:{...motionSpec,budget:{max_generation_calls:99}}}).length);
  assert.ok(validateInput(capability,{...input,motionSpec:{...motionSpec,review_protocol:'invented'}}).length);
  assert.ok(validateInput(capability,{...input,motionSpec:{...motionSpec,visual_structure:{analysis_id:'not-an-id',token:'0'.repeat(64)}}}).length);
  assert.ok(validateInput(capability,{...input,motionSpec:{...motionSpec,visual_structure:{analysis_id:'0'.repeat(32),token:'0'.repeat(64),sourcePath:'unexpected'}}}).length);
  assert.ok(validateInput(capability, { ...input, planningModels: { reviewer: planningModels.strategy } }).length);
  assert.ok(validateInput(capability, { ...input, planningModels: { strategy: { ...planningModels.strategy, apiKey: 'must-not-be-stored' } } }).length);
  assert.ok(validateInput(capability, { ...input, planningModels: { strategy: { timeout_seconds: 30 } } }).length);
  let outcome = await runConnector(manifest,capability,input);
  const taskId = outcome.task.id;
  for (let n=0;n<100 && outcome.task.status==='running';n++) { await delay(100); outcome=await refreshTask(manifest,taskId); }
  assert.equal(outcome.task.status,'attention_required');
  const workId=outcome.task.adapter.openWorkId;
  assert.equal(taskViewPath(manifest,outcome.task),`/tools/sprite-generator?work=${workId}&version=1`);
  const work=await request(`/v1/open-motion/${workId}`);
  assert.equal(work.status,'ready'); assert.equal(work.planning_calls.length,4);
  assert.equal(work.planning_config.roles.strategy.model, planningModels.strategy.model);
  assert.ok(validateInput(capability, { ...input, operation: 'revise-motion', openWorkId: workId, expectedRevision: 1 }).length);
  const presentation = taskPresentation(manifest,outcome.task,{result:{work}});
  assert.equal(presentation.state,'saved'); assert.match(presentation.summary,/方案已保存/);
  assert.ok(validateInput(capability,{operation:'generate-motion',openWorkId:workId}).length);
  assert.ok(validateInput(capability,{operation:'target-motion-stage',openWorkId:workId,expectedRevision:1,stageIndex:0,reviewNote:'已检查目标'}).length);
  const targetPng=await readFile(path.join(root,'target-fixture','frame_002.png'));
  await runConnector(manifest,capability,{operation:'target-motion-stage',openWorkId:workId,expectedRevision:1,stageIndex:0,targetSetSha256:work.target_set_sha256,targetImageBase64:targetPng.toString('base64'),reviewNote:'真实诊断 PNG 用于末图传输检查，不代表美术效果'});
  const withTarget=await request(`/v1/open-motion/${workId}`);assert.equal(withTarget.end_targets.length,1);
  assert.notEqual(withTarget.target_set_sha256,work.target_set_sha256);
  await assert.rejects(runConnector(manifest,capability,{operation:'generate-motion',openWorkId:workId,expectedRevision:1,planSha256:work.plan_sha256,targetSetSha256:work.target_set_sha256}),/409/);
  const generated=await runConnector(manifest,capability,{operation:'generate-motion',openWorkId:workId,expectedRevision:1,planSha256:work.plan_sha256,targetSetSha256:withTarget.target_set_sha256});
  assert.ok(generated.task.id);
  client = new Client({ name: 'open-motion-review-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['scripts/workbench-mcp.mjs'],
    env: { WORKBENCH_TEST_RUN: process.env.WORKBENCH_TEST_RUN, SPRITE_PIPELINE_API_URL: base }, stderr: 'pipe' }));
  await observeHeldReview(generated.task.id, 'stage', 'open_motion_checkpoint');
  for (let candidateIndex=1;candidateIndex<=2;candidateIndex++) for(let stageIndex=0;stageIndex<2;stageIndex++) {
    for(let n=0;n<150;n++) {
      const current=await request(`/v1/open-motion/${workId}`);
      const checkpoint=current.job.candidates[candidateIndex-1].plan_execution.stages[stageIndex];
      if(checkpoint.state==='awaiting_review'&&checkpoint.review?.expert_review?.simulated)break;
      assert.ok(n<149,'checkpoint did not become ready');await delay(100);
    }
    const inspected=await runConnector(manifest,capability,{operation:'get-motion-stage',openWorkId:workId,candidateIndex,stageIndex});
    const evidence=JSON.parse(await readFile(inspected.task.outputs.find(p=>p.endsWith('/result.json')),'utf8'));
    assert.equal(evidence.orderedFrames.length,4);assert.equal(evidence.stage.state,'awaiting_review');
    const polled = await mcp('workbench_get_task', { taskId: generated.task.id });
    assert.equal(polled.presentation.state, 'attention_required');
    assert.equal(polled.presentation.reviewProgress.readyForDecision, true);
    const result = await mcp('workbench_get_result', { taskId: generated.task.id, candidateIndex });
    assert.deepEqual(result.result.nextActions, ['get-motion-stage', 'review-motion-stage']);
    const checkpoint = result.result.pendingCheckpoints.find(item => item.stageIndex === stageIndex);
    assert.equal(checkpoint.stageToken, evidence.stage.token);
    assert.equal(checkpoint.readyForDecision, true);
    assert.equal(result.result.workRevision, 1);
    const stageResult = await mcp('workbench_get_result', { taskId: inspected.task.id, candidateIndex });
    assert.equal(stageResult.result.stage.token, checkpoint.stageToken);
    assert.equal(stageResult.result.workRevision, 1);
    assert.equal(evidence.stage.review.protocol,'experts_v1');
    assert.equal(evidence.stage.review.expert_review.calls_used,5);
    assert.equal(evidence.stage.review.expert_review.simulated,true);
    assert.ok(evidence.stage.review.requires_human_adjudication.length);
    assert.equal((await readFile(evidence.orderedFrames[0])).subarray(1,4).toString(),'PNG');
    await assert.rejects(()=>request(`/v1/open-motion/${workId}/resume`,{expected_revision:1}));
    if(candidateIndex===1&&stageIndex===0){
      const repairInput={operation:'repair-motion-stage',openWorkId:workId,expectedRevision:1,candidateIndex,stageIndex,stageToken:evidence.stage.token,repairStart:1,repairEnd:2,repairMode:'appearance',reviewNote:'只修中间两帧物品轮廓；其余真实诊断帧保持原样。',generationAuthorized:true};
      assert.deepEqual(validateInput(capability,repairInput),[]);
      assert.ok(validateInput(capability,{...repairInput,generationAuthorized:false}).length);
      await runConnector(manifest,capability,repairInput);
      for(let n=0;n<100;n++){const v=await request(`/v1/open-motion/${workId}`);if(v.job.candidates[0].plan_execution.stages[0].repairs[0]?.state==='awaiting_review')break;assert.ok(n<99);await delay(100);}
      const preview=await runConnector(manifest,capability,{operation:'get-motion-stage',openWorkId:workId,candidateIndex,stageIndex});
      const before=JSON.parse(await readFile(preview.task.outputs.find(p=>p.endsWith('/result.json')),'utf8'));
      assert.equal(before.repairPreviews[0].frames.length,4);
      assert.equal((await readFile(before.repairPreviews[0].frames[1])).subarray(1,4).toString(),'PNG');
      await runConnector(manifest,capability,{operation:'review-motion-repair',openWorkId:workId,expectedRevision:1,candidateIndex,stageIndex,repairAttempt:0,stageToken:before.repairPreviews[0].token,stageDecision:'accept',reviewNote:'已核对全部诊断预览与两侧接缝，仅验证修复链路。'});
      for(let n=0;n<100;n++){const v=await request(`/v1/open-motion/${workId}`);if(v.job.candidates[0].plan_execution.stages[0].state==='awaiting_review')break;assert.ok(n<99);await delay(100);}
      evidence.stage=await request(`/v1/open-motion/${workId}/candidates/1/stages/0`);
    }
    await runConnector(manifest,capability,{operation:'review-motion-stage',openWorkId:workId,expectedRevision:1,candidateIndex,stageIndex,
      stageToken:evidence.stage.token,stageDecision:'accept',reviewNote:'已查看诊断片段与末姿势，仅验收工具流程',acknowledgeWarnings:true,
      ...(candidateIndex===1&&stageIndex===0?{anchorFrame:2,acknowledgeTrim:true}:{})});
    if (candidateIndex === 1 && stageIndex === 1) await observeHeldReview(generated.task.id, 'clip', 'open_motion_quality');
  }
  // The offline service restores diagnostic flags after publishing the review.
  // Wait for its final receipt before checking provenance, rather than racing it.
  for (let n=0;n<150;n++) { const c=await request(`/v1/open-motion/${workId}`);if(c.job.candidates.every((c,i)=>c.frames.length===(i===0?7:8)&&c.quality_review?.state==='complete'&&c.quality_review.expert_review?.simulated))break;await delay(100); }
  const complete=await request(`/v1/open-motion/${workId}`);
  assert.deepEqual(complete.job.candidates.map(c=>c.frames.length),[7,8]);
  assert.ok(complete.job.candidates.every(c=>c.diagnostic_only));
  assert.ok(complete.job.candidates.every(c=>c.quality_review.protocol==='experts_v1'&&c.quality_review.expert_review.calls_used===5));
  const reviewCalls=complete.job.candidates.reduce((sum,c)=>sum+c.quality_review.requests.length+c.plan_execution.stages.reduce((n,s)=>n+s.review.requests.length+s.review_history.reduce((n,r)=>n+r.requests.length,0),0),0);
  assert.equal(reviewCalls,35);
  const clip = await mcp('workbench_get_task', { taskId: generated.task.id });
  assert.ok(!clip.refreshError, clip.refreshError);
  assert.equal(clip.presentation.reviewProgress.scope, 'clip');
  assert.equal(clip.presentation.reviewProgress.readyForApproval, true);
  assert.equal(clip.presentation.reviewProgress.callsUsed, 5);
  assert.match(clip.presentation.summary, /检查完整播放后可以提交采用/);
  const compact = await mcp('workbench_get_result', { taskId: generated.task.id });
  const stored = JSON.parse(await readFile(clip.task.outputs.find(item => item.endsWith('/result.json')), 'utf8'));
  assert.ok(JSON.stringify(stored).length > 100000);
  assert.ok(JSON.stringify(compact).length < 5000);
  assert.ok(compact.result.nextActions.includes('approve'));
  console.log(`MCP animation result: ${JSON.stringify(stored).length} saved JSON characters, ${JSON.stringify(compact).length} summary characters.`);
  const approved = await runConnector(manifest, capability, { operation: 'approve', jobId: complete.job.job_id,
    candidateIndex: clip.presentation.reviewProgress.candidateIndex, acknowledgeWarnings: true, reviewNote: '已播放诊断用完整动画，测试一次提交采用。' });
  assert.equal(approved.task.status, 'completed', approved.refreshError);
  // Local image workspace -> bounded animation alternative -> new version; keep the other tests on candidate 1.
  const editReq=(op,input)=>imageEditRequest(process.cwd(),manifest,op,input);
  const frameRef={kind:'motion-frame',workId,workRevision:1,candidateIndex:2,frameIndex:1};
  const fi=(await editReq('image-inspect',{target:frameRef})).target;
  const guards={targetId:fi.targetId,expectedRevision:1,expectedSha256:fi.sha256};
  const locked=(await editReq('image-inspect',{target:{...frameRef,frameIndex:0}})).target;
  assert.equal(locked.locked,true);assert.equal(fi.aiEdit.supported,false);
  const {edit:ses}=await editReq('image-session-create',{...guards,commandId:'local-frame-session'});
  const reg=await editReq('image-resolve',{...guards,region:{type:'rectangle',x:16,y:16,width:16,height:16}});
  assert.equal(reg.frameEditRegion.spans.length,16);
  const made=await editReq('image-edit',{...guards,editId:ses.editId,expectedEditRevision:ses.revision,baseCandidateVersion:'source',regionRef:reg.regionRef,operation:{type:'erase'},commandId:'local-frame-erase'});
  assert.equal(made.status,'completed');
  const receipt=await editReq('image-apply',{editId:ses.editId,candidateVersion:made.candidateVersion,expectedRevision:1,expectedSha256:fi.sha256,commandId:'local-frame-adoption'});
  const local=(await request('/v1/open-motion/'+workId+'/adjustments/'+receipt.adoption.adjustmentId)).adjustment;
  assert.equal(local.repair_level,'deterministic');assert.equal(local.generation_calls.length,0);assert.equal(local.spatial_protection.frames[0].protected_changed_pixels,0);
  assert.equal(local.proposed_frames[0].sha256,local.source_frames[0].sha256);
  await request('/v1/open-motion/'+workId+'/adjustments/'+local.id+'/decision',{token:local.preview_token,decision:'reject',note:'验证保留原版的路径'});
  const attempts=complete.job.candidates.map(c=>c.submission_attempts);
  await request(`/v1/open-motion/${workId}/generate`,{expected_revision:1,plan_sha256:work.plan_sha256});
  assert.deepEqual((await request(`/v1/open-motion/${workId}`)).job.candidates.map(c=>c.submission_attempts),attempts);
  const objectInput = { ...input, motionSpec: { ...commonSpec, object_id: 'fixture_door', object_type: 'interactable', description: 'The fixture door opens and holds position.' } };
  let objectOutcome = await runConnector(manifest, capability, objectInput);
  for (let n = 0; n < 100 && objectOutcome.task.status === 'running'; n++) { await delay(100); objectOutcome = await refreshTask(manifest, objectOutcome.task.id); }
  assert.equal(objectOutcome.task.status, 'attention_required');
  const objectWork = await request(`/v1/open-motion/${objectOutcome.task.adapter.openWorkId}`);
  assert.equal(objectWork.spec.object_id, 'fixture_door');
  assert.equal(objectWork.spec.object_type, 'interactable');
  assert.equal(objectWork.spec.character_id, undefined);
  assert.equal(objectWork.status, 'needs_input');
  assert.match(objectWork.message, /结构/);
  assert.equal(objectWork.job, null);
  assert.ok(objectWork.plan.quality.interactable.reference_check);
  assert.equal(objectWork.character.object_type, 'interactable');
  assert.equal(objectWork.character.facing, undefined);
  assert.equal(objectWork.character.weapon_hand, undefined);

  // Real frontend proxy implementation, including refusal of arbitrary paths/origins.
  vite=await createTestViteServer({configFile:false,appType:'custom',logLevel:'error',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true}});
  const motionModel = await vite.ssrLoadModule('/components/sprite-generator/open-motion-model.ts');
  const { motionPlanningProgress, motionPlanningRequestKey } = motionModel;
  verifyMotionObjects(motionModel);
  verifyPlanningProgress(motionPlanningProgress, motionPlanningRequestKey);
  const {adjustmentRangeError,adjustmentAttemptBudget}=await vite.ssrLoadModule('/components/sprite-generator/motion-adjustment-range.ts');
  assert.equal(adjustmentRangeError(14,15,16,[0],2,false),'','15–16 is a valid two-frame tail');
  assert.equal(adjustmentRangeError(14,15,16,[0],2,true),'');
  assert.match(adjustmentRangeError(15,15,16,[0],2,false),/只选了 1 帧/);
  assert.match(adjustmentRangeError(15,14,16,[0],2,false),/开始帧不能大于/);
  assert.match(adjustmentRangeError(12,14,16,[0],2,false),/要求偶数帧/);
  assert.match(adjustmentRangeError(0,1,16,[0],2,false),/受保护/);
  assert.match(adjustmentRangeError(12,15,16,[0],2,true),/选中数量，不是帧号/);
  const attemptContext={attempt_scope:'selected_frames',attempt_limit:2,legacy_frame_attempts:Array(16).fill(0),tasks:[
    {start:12,end:13,generation_calls:[]},{start:12,end:13,generation_calls:[{state:'submitted'}]},
  ]};
  assert.equal(adjustmentAttemptBudget(attemptContext,14,15).remaining,2);
  assert.equal(adjustmentAttemptBudget(attemptContext,12,13).remaining,1);
  attemptContext.tasks.push({start:12,end:13,generation_calls:[{state:'unknown'}]});
  assert.deepEqual(adjustmentAttemptBudget(attemptContext,13,14).blocked,[14]);
  assert.equal(adjustmentAttemptBudget(attemptContext,14,15).remaining,2);
  const proxy=await vite.ssrLoadModule('/app/api/workbench/open-motion/route.ts');
  assert.equal((await proxy.GET(new Request('http://localhost:3000/api/workbench/open-motion?path=../secrets'))).status,400);
  assert.equal((await proxy.POST(new Request('http://localhost:3000/api/workbench/open-motion',{method:'POST',headers:{origin:'https://foreign.example'},body:'{}'}))).status,403);
  const proxied=await proxy.GET(new Request(`http://localhost:3000/api/workbench/open-motion?path=open-motion/${workId}`));
  assert.equal(proxied.status,200); assert.equal((await proxied.json()).id,workId);
  const checkpointImage=await proxy.GET(new Request(`http://localhost:3000/api/workbench/open-motion?path=open-motion/${workId}/candidates/1/stages/0/frames/3`));
  assert.equal(checkpointImage.status,200);assert.match(checkpointImage.headers.get('content-type'),/image\/png/);
  // Independent preference alternative: read context, submit once, poll same receipt,
  // compare exact files and adopt a derived version without touching source bytes.
  const contextRun=await runConnector(manifest,capability,{operation:'get-motion-adjustment',openWorkId:workId,expectedRevision:1,candidateIndex:2});
  const selection=JSON.parse(await readFile(contextRun.task.outputs.find(p=>p.endsWith('/result.json')),'utf8'));
  assert.equal(selection.orderedFrames.length,8);
  // Interactable panel routes stay inside the bounded proxy: exact token-bound frame sources and derived assets.
  const context=selection.adjustmentContext;
  const source=await proxy.GET(new Request(`http://localhost:3000/api/workbench/open-motion?path=open-motion/${workId}/edit-source/1&revision=1&candidate=2&token=${context.token}`));
  assert.equal(source.status,200);
  assert.equal(createHash('sha256').update(Buffer.from(await source.arrayBuffer())).digest('hex'),context.frames[1].sha256);
  assert.equal((await proxy.GET(new Request(`http://localhost:3000/api/workbench/open-motion?path=open-motion/${workId}/edit-source/1&revision=1&candidate=2&token=bad`))).status,400);
  const derivedList=await proxy.GET(new Request(`http://localhost:3000/api/workbench/open-motion?path=open-motion/${workId}/derived&revision=1`));
  assert.equal(derivedList.status,200);assert.deepEqual((await derivedList.json()).derived,[]);
  const characterDerivation=await proxy.POST(new Request(`http://localhost:3000/api/workbench/open-motion?path=open-motion/${workId}/derived`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({expected_revision:1,candidate_index:2,request_key:'character-derive-1',method:'reverse',stage_index:0})}));
  assert.equal(characterDerivation.status,409,'routed to the service, which refuses derivations for characters');
  const altInput={operation:'create-motion-adjustment',openWorkId:workId,expectedRevision:1,candidateIndex:2,
    adjustmentStart:1,adjustmentEnd:2,adjustmentToken:selection.adjustmentContext.token,
    adjustmentRequest:'我希望涂选处颜色略亮，这是个人偏好，并非原版有错',adjustmentPreserveMotion:true,
    adjustmentRegions:[1,2].map(frame=>({frame,source_sha256:selection.adjustmentContext.frames[frame].sha256,spans:[{start:1950,length:4}]})),
    generationAuthorized:true,requestKey:'isolated-adjustment-test'};
  assert.deepEqual(validateInput(capability,altInput),[]);
  assert.ok(validateInput(capability,{...altInput,generationAuthorized:false}).length);
  let alt=await runConnector(manifest,capability,altInput);
  for(let n=0;alt.task.status==='running'&&n<100;n++){await delay(100);alt=await refreshTask(manifest,alt.task.id);}
  assert.equal(alt.task.status,'attention_required');
  const alternative=JSON.parse(await readFile(alt.task.outputs.find(p=>p.endsWith('/result.json')),'utf8'));
  assert.equal(alternative.adjustment.state,'ready',alt.refreshError);
  assert.equal(alternative.adjustment.preserve_motion,true);
  assert.deepEqual(alternative.adjustment.edit_regions,altInput.adjustmentRegions);
  assert.ok(alternative.adjustment.spatial_protection.frames.every(f=>f.protected_changed_pixels===0));
  assert.equal(alternative.adjustment.review.comparison.state,'complete');
  assert.equal(alternative.adjustment.planning_calls.length,1);assert.equal(alternative.adjustment.review_calls.length,5);
  assert.equal(alternative.originalFrames.length,8);assert.equal(alternative.alternativeFrames.length,8);
  for(const i of [0,3,4,5,6,7])assert.deepEqual(await readFile(alternative.originalFrames[i]),await readFile(alternative.alternativeFrames[i]));
  const imageProxy=await proxy.GET(new Request(`http://localhost:3000/api/workbench/open-motion?path=open-motion/${workId}/adjustments/${alternative.adjustmentId}/proposed/1`));
  assert.equal(imageProxy.status,200);
  const before=await request(`/v1/open-motion/${workId}`);
  const adopted=await runConnector(manifest,capability,{operation:'review-motion-adjustment',openWorkId:workId,expectedRevision:1,
    adjustmentId:alternative.adjustmentId,adjustmentToken:alternative.adjustment.preview_token,stageDecision:'accept',
    reviewNote:'完整播放隔离诊断图后确认保留原帧与连续性，仅验收工程',acknowledgeWarnings:true});
  assert.equal(adopted.task.status,'completed');
  const after=await request(`/v1/open-motion/${workId}`);assert.equal(after.revision,2);assert.notEqual(after.job.job_id,before.job.job_id);
  assert.equal(after.job.candidates[0].status,'approved');
  const ctx=await request('/v1/open-motion/'+workId+'/adjustments?revision=2&candidate=1');
  const selected=ctx.frames.map((_,i)=>i).filter(i=>!ctx.locked_frames.includes(i));
  assert.ok(selected.length>=2);
  const localBody={expected_revision:2,candidate_index:1,token:ctx.token,request_key:'cross-stage-palette',description:'Exercise archive preservation across two segments',
    palette:[{source:'#808080',target:'#808081'}],frames:selected.map(frame=>({region:{frame,source_sha256:ctx.frames[frame].sha256,spans:[{start:0,length:ctx.width*ctx.height}]}}))};
  const localInput={operation:'edit-motion-frames',openWorkId:workId,expectedRevision:2,candidateIndex:1,
    adjustmentToken:ctx.token,requestKey:localBody.request_key,adjustmentRequest:localBody.description,
    adjustmentRegions:localBody.frames.map(f=>f.region),motionPalette:[{from:'#808080',to:'#808081'}]};
  assert.deepEqual(validateInput(capability,localInput),[]);
  assert.ok(validateInput(capability,{...localInput,adjustmentRegions:[]}).length);
  const localRun=await runConnector(manifest,capability,localInput);
  const pal=JSON.parse(await readFile(localRun.task.outputs.find(p=>p.endsWith('/result.json')),'utf8')).adjustment;
  const rev3=(await request('/v1/open-motion/'+workId+'/adjustments/'+pal.id+'/decision',{token:pal.preview_token,decision:'accept',acknowledge_warnings:true,note:'Full simulated playback for version preservation test'})).work;
  assert.equal(rev3.revision,3);assert.equal(rev3.job.candidates[0].submission_attempts,0);
  assert.ok(rev3.job.candidates[0].plan_execution.stages.every(r=>r.adjustment_history.at(-1).id===pal.id));
  const old=await request(`/v1/open-motion/${workId}?revision=1`);assert.equal(old.job.job_id,before.job.job_id);
  console.log('Open motion: nested input rejection, real Python API + shared adapter planning/generation, exact preview, candidate completion, idempotency and bounded frontend proxy passed; paid calls=0.');
} finally {
  if (client) await client.close();
  if (vite) await vite.close();
  child.kill();
  if (previous === undefined) delete process.env.SPRITE_PIPELINE_API_URL; else process.env.SPRITE_PIPELINE_API_URL=previous;
}
