import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { persistTask } from '../runtime.mjs';
import { activeSpriteReview, spriteReview } from '../sprite-review.mjs';
import { spriteNextActions } from '../sprite-result.mjs';

import {
  bearerHeaders,
  endpointUrl,
  requestBinary,
  requestJson,
} from './http.mjs';

const CREATE_OPERATIONS = new Set(['create', 'create-and-generate']);
const CANDIDATE_OPERATIONS = new Set([
  'export',
  'check',
  'review-frame',
  'approve',
  'reject',
  'recover',
  'attach-provider-job',
  'safety',
]);
const JOB_OPERATIONS = new Set([
  'generate-existing',
  'get',
  ...CANDIDATE_OPERATIONS,
]);
const SAFE_PRESET_ID = /^[a-z0-9][a-z0-9_]*$/;
const ADJUSTMENT_OPERATIONS = new Set(['edit-motion-frames','get-motion-adjustment','create-motion-adjustment','review-motion-adjustment']);
const MOTION_OPERATIONS = new Set(['plan-motion', 'revise-motion', 'get-motion', 'generate-motion', 'pause-motion', 'resume-motion', 'get-motion-stage', 'review-motion-stage', 'target-motion-stage', 'repair-motion-stage', 'review-motion-repair',...ADJUSTMENT_OPERATIONS]);

export function validateSpritePipelineInput(input) {
  const errors = [];
  if (input.planningModels !== undefined && input.operation !== 'plan-motion') {
    errors.push('planningModels can only be set when creating a plan with plan-motion.');
  }
  if (MOTION_OPERATIONS.has(input.operation)) {
    if (input.operation !== 'plan-motion' && !/^[0-9a-f]{32}$/.test(input.openWorkId || '')) errors.push('openWorkId is required.');
    if (!['plan-motion', 'get-motion', 'get-motion-stage','get-motion-adjustment'].includes(input.operation) && !Number.isInteger(input.expectedRevision)) errors.push('expectedRevision is required.');
    if(ADJUSTMENT_OPERATIONS.has(input.operation)) {
      if(input.adjustmentId!==undefined&&!/^[0-9a-f]{32}$/.test(input.adjustmentId)) errors.push('Invalid adjustmentId.');
      if(input.stageIndex!==undefined&&(!Number.isInteger(input.stageIndex)||input.stageIndex<0||input.stageIndex>3)) errors.push('Invalid stageIndex.');
      if(input.operation==='get-motion-adjustment'&&!input.adjustmentId&&(!Number.isInteger(input.candidateIndex)||!Number.isInteger(input.expectedRevision))) errors.push('Context reads require candidateIndex and expectedRevision.');
      if(input.operation==='edit-motion-frames'&&(!Number.isInteger(input.candidateIndex)||!/^[0-9a-f]{64}$/.test(input.adjustmentToken||'')||!input.adjustmentRegions?.length||!input.motionPalette?.length))errors.push('Local frame editing requires exact source, explicit per-frame regions and palette.');
      if(input.operation==='create-motion-adjustment'&&(input.generationAuthorized!==true||!Number.isInteger(input.candidateIndex)||!Number.isInteger(input.adjustmentStart)||!Number.isInteger(input.adjustmentEnd)||!/^[0-9a-f]{64}$/.test(input.adjustmentToken||''))) errors.push('An explicit bounded alternative requires authorized scope, exact context token and frame range.');
      if(input.operation==='review-motion-adjustment'&&(!input.adjustmentId||!/^[0-9a-f]{64}$/.test(input.adjustmentToken||'')||!['accept','reject'].includes(input.stageDecision)||(input.stageDecision==='accept'&&(input.reviewNote?.trim().length||0)<4))) errors.push('Adoption requires exact alternative identity and actual playback reasoning.');
    }
    if (['get-motion-stage','review-motion-stage','repair-motion-stage','review-motion-repair'].includes(input.operation)) {
      if (!Number.isInteger(input.stageIndex) || input.stageIndex < 0 || input.stageIndex > 3 || !Number.isInteger(input.candidateIndex)) errors.push('A valid stageIndex and candidateIndex are required.');
      if (input.operation === 'review-motion-stage' && (!/^[0-9a-f]{64}$/.test(input.stageToken || '') || !['accept','reject','accept_state'].includes(input.stageDecision) || (input.reviewNote?.trim().length || 0) < 4)) errors.push('Exact stageToken, decision and actual visual reviewNote are required.');
    }
    if (['plan-motion', 'revise-motion'].includes(input.operation)) {
      const spec = input.motionSpec;
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) errors.push('motionSpec is required.');
      else {
        const id = spec.object_id ?? spec.character_id;
        if (typeof id !== 'string' || !SAFE_PRESET_ID.test(id) || id.length > 100)
          errors.push('motionSpec requires an existing object_id or legacy character_id.');
        if (spec.object_id !== undefined && spec.character_id !== undefined && spec.object_id !== spec.character_id)
          errors.push('motionSpec object_id and character_id must identify the same object.');
        if (spec.object_type !== undefined && !['character', 'interactable'].includes(spec.object_type))
          errors.push('motionSpec object_type must be character or interactable.');
      }
      if (input.planningAuthorized !== true) errors.push('Planning model calls require explicit user authorization.');
      if (input.operation === 'revise-motion' && input.autoExecute === true)
        errors.push('revise-motion 请省略 autoExecute 或设为 false。查看新方案后，用新的 expectedRevision 和 planSha256 调用 generate-motion。');
    }
    if (input.operation === 'generate-motion' && !/^[0-9a-f]{64}$/.test(input.planSha256 || '')) errors.push('planSha256 from the current proposal is required.');
    if (input.operation === 'target-motion-stage' && (!Number.isInteger(input.stageIndex) || input.stageIndex<0 || input.stageIndex>3 || (input.reviewNote?.trim().length||0)<4 || (!input.targetImageBase64 && input.clearTarget!==true))) errors.push('Target stage, inspected PNG (or explicit clearTarget), and reviewNote are required.');
    if (input.operation === 'repair-motion-stage' && (input.generationAuthorized!==true || !Number.isInteger(input.repairStart) || !Number.isInteger(input.repairEnd) || !['appearance','transition'].includes(input.repairMode) || !/^[0-9a-f]{64}$/.test(input.stageToken||'') || (input.reviewNote?.trim().length||0)<4)) errors.push('Authorized repair requires exact evidence token, window, mode and actual defect note.');
    if (input.operation === 'review-motion-repair' && (!Number.isInteger(input.repairAttempt)||!/^[0-9a-f]{64}$/.test(input.stageToken||'')||!['accept','reject'].includes(input.stageDecision)||(input.reviewNote?.trim().length||0)<4)) errors.push('Repair review requires attempt, preview token, decision and actual visual note.');
    return errors;
  }
  if (CREATE_OPERATIONS.has(input.operation)) {
    if (typeof input.characterId !== 'string' || !input.characterId) {
      errors.push('characterId is required for this operation.');
    } else if (!SAFE_PRESET_ID.test(input.characterId)) {
      errors.push(
        'characterId must contain only lowercase letters, digits, and underscores.',
      );
    }
    if (typeof input.actionId !== 'string' || !input.actionId) {
      errors.push('actionId is required for this operation.');
    } else if (!SAFE_PRESET_ID.test(input.actionId)) {
      errors.push(
        'actionId must contain only lowercase letters, digits, and underscores.',
      );
    }
  }
  if (
    JOB_OPERATIONS.has(input.operation) &&
    (typeof input.jobId !== 'string' || !input.jobId)
  ) {
    errors.push('jobId is required for this operation.');
  }
  if (
    CANDIDATE_OPERATIONS.has(input.operation) &&
    !Number.isInteger(input.candidateIndex)
  ) {
    errors.push('candidateIndex is required for this operation.');
  }
  if (
    input.operation === 'create-and-generate' &&
    input.provider === 'import'
  ) {
    errors.push('create-and-generate cannot use the import provider.');
  }
  if (input.operation === 'approve' && !input.reviewNote?.trim())
    errors.push(
      'reviewNote is required after visually inspecting the candidate.',
    );
  if (input.operation === 'attach-provider-job' && !input.providerJobId)
    errors.push('providerJobId is required.');
  if (input.operation === 'review-frame') {
    if (!Number.isInteger(input.frameIndex) || !input.reviewStatus)
      errors.push('frameIndex and reviewStatus are required.');
    if (input.reviewStatus === 'repair_requested' && !input.issueType)
      errors.push('issueType is required for repair_requested.');
  }
  return errors;
}

export function spritePipelineConfigured(connector) {
  return Boolean(process.env[connector.urlEnv] || connector.defaultUrl);
}

export async function executeSpritePipeline(context) {
  const { capability, input, task } = context;
  const connector = capability.connector;
  const baseUrl = process.env[connector.urlEnv] || connector.defaultUrl;
  if (!baseUrl) {
    return {
      status: 'awaiting_configuration',
      requiredEnvironment: connector.urlEnv,
      result: null,
    };
  }

  const token = connector.tokenEnv
    ? process.env[connector.tokenEnv]
    : undefined;
  const headers = bearerHeaders(token);
  if (MOTION_OPERATIONS.has(input.operation)) return executeOpenMotion(context, baseUrl, headers);
  let body;

  if (CREATE_OPERATIONS.has(input.operation)) {
    const requestBody = compact({
      schema_version: 1,
      character_id: input.characterId,
      action_id: input.actionId,
      provider: input.provider ?? 'pixellab',
      candidate_count: input.candidateCount ?? 1,
      seed: input.seed,
      frame_count: input.frameCount,
      action_description: input.actionDescription,
      loop: input.loop,
      request_key: input.requestKey ?? task.id,
    });
    body = await requestJson(endpointUrl(baseUrl, '/v1/jobs'), {
      method: 'POST',
      headers: {
        ...headers,
        'Idempotency-Key': requestBody.request_key,
      },
      body: JSON.stringify(requestBody),
      timeoutMs: 30_000,
    });

    if (input.operation === 'create-and-generate') {
      const createdJob = readJob(body);
      task.adapter = {
        id: 'sprite-pipeline',
        remoteJobId: createdJob.job_id,
        remoteStatus: createdJob.status,
      };
      await persistTask(context.manifest, task);
      body = await requestJson(
        endpointUrl(
          baseUrl,
          `/v1/jobs/${encodeURIComponent(createdJob.job_id)}/generate`,
        ),
        {
          method: 'POST',
          headers,
          body: JSON.stringify(
            compact({
              wait: input.wait ?? false,
              candidate_index: input.candidateIndex,
            }),
          ),
          timeoutMs: input.wait ? 360_000 : 30_000,
        },
      );
    }
  } else if (input.operation === 'get') {
    body = await requestJson(
      endpointUrl(baseUrl, `/v1/jobs/${encodeURIComponent(input.jobId)}`),
      {
        method: 'GET',
        headers,
        timeoutMs: 15_000,
      },
    );
  } else if (input.operation === 'generate-existing') {
    body = await requestJson(
      endpointUrl(
        baseUrl,
        `/v1/jobs/${encodeURIComponent(input.jobId)}/generate`,
      ),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(
          compact({
            wait: input.wait ?? false,
            candidate_index: input.candidateIndex,
          }),
        ),
        timeoutMs: input.wait ? 360_000 : 30_000,
      },
    );
  } else if (
    CANDIDATE_OPERATIONS.has(input.operation) &&
    input.operation !== 'export'
  ) {
    const operation =
      input.operation === 'review-frame' ? 'reviews/frame' : input.operation;
    const route = `/v1/jobs/${encodeURIComponent(input.jobId)}/candidates/${input.candidateIndex}/${operation}`;
    const payload =
      input.operation === 'approve'
        ? {
            reviewer: input.reviewer ?? 'agent',
            acknowledge_warnings: input.acknowledgeWarnings ?? false,
            review_note: input.reviewNote ?? '',
          }
        : input.operation === 'reject'
          ? {
              reviewer: input.reviewer ?? 'agent',
              note: input.reviewNote ?? '',
            }
          : input.operation === 'review-frame'
            ? compact({
                reviewer: input.reviewer ?? 'agent',
                note: input.reviewNote ?? '',
                frame_index: input.frameIndex,
                status: input.reviewStatus,
                issue_type: input.issueType,
              })
            : input.operation === 'attach-provider-job'
              ? { provider_job_id: input.providerJobId }
              : {};
    body = await requestJson(endpointUrl(baseUrl, route), {
      method: input.operation === 'safety' ? 'GET' : 'POST',
      headers,
      ...(input.operation === 'safety'
        ? {}
        : { body: JSON.stringify(payload) }),
      timeoutMs: 30_000,
    });
    if (input.operation === 'safety') {
      const safety = body.data?.safety;
      const jobResponse = await requestJson(
        endpointUrl(baseUrl, `/v1/jobs/${encodeURIComponent(input.jobId)}`),
        { headers, timeoutMs: 15_000 },
      );
      const job = readJob(jobResponse);
      const execution = await buildSpriteExecution(context, job, {
        baseUrl,
        token,
        status: remoteTaskStatus(job.status),
      });
      execution.result.safety = safety;
      return execution;
    }
  } else if (input.operation === 'export') {
    body = await requestJson(
      endpointUrl(
        baseUrl,
        `/v1/jobs/${encodeURIComponent(input.jobId)}/candidates/${input.candidateIndex}/export`,
      ),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(
          compact({
            columns: input.columns,
            filename: input.filename,
            overwrite: input.overwrite ?? false,
          }),
        ),
        timeoutMs: 30_000,
      },
    );
  } else {
    throw new Error(`Unsupported SpritePipeline operation: ${input.operation}`);
  }

  const job = readJob(body);
  return buildSpriteExecution(context, job, {
    baseUrl,
    token,
    status: operationStatus(input.operation, job.status),
  });
}

export async function refreshSpritePipeline(context) {
  const { capability, task } = context;
  if (task.adapter?.openWorkId) {
    const connector = capability.connector;
    const base = process.env[connector.urlEnv] || connector.defaultUrl;
    const token = connector.tokenEnv ? process.env[connector.tokenEnv] : undefined;
    if(task.adapter.adjustmentId) {
      const body=await requestJson(endpointUrl(base,`/v1/open-motion/${task.adapter.openWorkId}/adjustments/${task.adapter.adjustmentId}`),{headers:bearerHeaders(token),timeoutMs:15_000});
      return buildAdjustmentExecution(context,body,base,token);
    }
    const target = new URL(endpointUrl(base, `/v1/open-motion/${task.adapter.openWorkId}`));
    if (task.adapter.openWorkRevision) target.searchParams.set('revision', String(task.adapter.openWorkRevision));
    const work = await requestJson(target, { headers: bearerHeaders(token), timeoutMs: 15_000 });
    return buildOpenExecution(context, work, base, token);
  }
  const remoteJobId = task.adapter?.remoteJobId;
  if (typeof remoteJobId !== 'string' || !remoteJobId) return null;

  const connector = capability.connector;
  const baseUrl = process.env[connector.urlEnv] || connector.defaultUrl;
  if (!baseUrl) {
    return {
      status: 'awaiting_configuration',
      requiredEnvironment: connector.urlEnv,
      result: null,
      adapter: task.adapter,
    };
  }
  const token = connector.tokenEnv
    ? process.env[connector.tokenEnv]
    : undefined;
  const body = await requestJson(
    endpointUrl(baseUrl, `/v1/jobs/${encodeURIComponent(remoteJobId)}`),
    {
      method: 'GET',
      headers: bearerHeaders(token),
      timeoutMs: 15_000,
    },
  );
  const job = readJob(body);
  return buildSpriteExecution(context, job, {
    baseUrl,
    token,
    status: remoteTaskStatus(job.status),
  });
}

async function executeOpenMotion(context, baseUrl, headers) {
  const { input, task } = context;
  if(ADJUSTMENT_OPERATIONS.has(input.operation))return executeAdjustment(context,baseUrl,headers);
  if (input.operation === 'get-motion-stage') {
    const route = `/v1/open-motion/${input.openWorkId}/candidates/${input.candidateIndex}/stages/${input.stageIndex}`;
    const stageUrl = segment => {
      const target = new URL(endpointUrl(baseUrl, `${route}${segment}`));
      if (revision) target.searchParams.set('revision', String(revision));
      return target;
    };
    let revision = input.expectedRevision;
    const stage = await requestJson(stageUrl(''),{headers,timeoutMs:15_000});
    revision = stage.work_revision ?? revision;
    const token = context.capability.connector.tokenEnv ? process.env[context.capability.connector.tokenEnv] : undefined;
    const generatedOutputNames=[], orderedFrames=[];
    for (let i=0;i<stage.frames.length;i++) {
      const name=`checkpoint/frame-${String(i).padStart(3,'0')}.png`;
      await downloadSpriteArtifact(stageUrl(`/frames/${i}`),path.join(context.outputDirectory,name),token,'image/png',stage.frames[i].sha256);
      generatedOutputNames.push(name);orderedFrames.push(projectPath(context.repositoryRoot,context.outputDirectory,name));
    }
    const repairPreviews=[];
    for(const repair of stage.repairs||[]) if(repair.proposed_frames){
      const frames=[];
      for(let i=0;i<repair.proposed_frames.length;i++){
        const name=`checkpoint/repair-${repair.number}/frame-${String(i).padStart(3,'0')}.png`;
        await downloadSpriteArtifact(stageUrl(`/repairs/${repair.number}/frames/${i}`),path.join(context.outputDirectory,name),token,'image/png',repair.proposed_frames[i].sha256);
        generatedOutputNames.push(name);frames.push(projectPath(context.repositoryRoot,context.outputDirectory,name));
      }
      repairPreviews.push({attempt:repair.number,token:repair.token,frames});
    }
    return {status:'completed',result:{openWorkId:input.openWorkId,workRevision:revision,stage,orderedFrames,repairPreviews,
      nextActions:stage.state==='awaiting_review'?['review-motion-stage','repair-motion-stage','review-motion-repair']:[],
      viewPath:`/tools/sprite-generator?work=${input.openWorkId}&candidate=${input.candidateIndex}`},generatedOutputNames};
  }
  let route = '/v1/open-motion';
  if (input.operation !== 'plan-motion') route += `/${input.openWorkId}`;
  const suffix = { 'revise-motion': 'revise', 'generate-motion': 'generate', 'pause-motion': 'pause', 'resume-motion': 'resume', 'review-motion-stage':'review-stage', 'target-motion-stage':'target', 'repair-motion-stage':'repair-stage', 'review-motion-repair':'review-repair' }[input.operation];
  if (suffix) route += `/${suffix}`;
  const payload = input.operation === 'get-motion' ? null :
    ['plan-motion', 'revise-motion'].includes(input.operation) ? compact({
      spec: input.motionSpec, request_key: input.requestKey || task.id,
      planning_authorized: input.planningAuthorized === true, auto_execute: input.autoExecute ?? false,
      planning_models: input.planningModels,
      expected_revision: input.operation === 'revise-motion' ? input.expectedRevision : undefined,
    }) : input.operation === 'repair-motion-stage' ? {
      expected_revision:input.expectedRevision,candidate_index:input.candidateIndex,stage_index:input.stageIndex,token:input.stageToken,
      start:input.repairStart,end:input.repairEnd,mode:input.repairMode,note:input.reviewNote,request_key:input.requestKey||task.id,generation_authorized:input.generationAuthorized===true,
    } : input.operation === 'review-motion-repair' ? {
      expected_revision:input.expectedRevision,candidate_index:input.candidateIndex,stage_index:input.stageIndex,attempt:input.repairAttempt,token:input.stageToken,note:input.reviewNote,decision:input.stageDecision,
    } : input.operation === 'target-motion-stage' ? {
      expected_revision:input.expectedRevision,expected_targets:input.targetSetSha256,stage_index:input.stageIndex,png_base64:input.clearTarget?null:input.targetImageBase64,note:input.reviewNote,
    } : input.operation === 'review-motion-stage' ? {
      expected_revision:input.expectedRevision,candidate_index:input.candidateIndex,stage_index:input.stageIndex,
      token:input.stageToken,decision:input.stageDecision,note:input.reviewNote,human_seconds:input.humanSeconds,acknowledge_warnings:input.acknowledgeWarnings ?? false,
      anchor_frame:input.anchorFrame ?? null,acknowledge_trim:input.acknowledgeTrim ?? false,
    } : compact({ expected_revision: input.expectedRevision, expected_targets: input.operation === 'generate-motion' ? input.targetSetSha256 : undefined, plan_sha256: input.operation === 'generate-motion' ? input.planSha256 : undefined, allow_unsupported_motion: input.operation === 'generate-motion' ? input.allowUnsupportedMotion : undefined });
  const work = await requestJson(endpointUrl(baseUrl, route), {
    method: payload ? 'POST' : 'GET', headers, ...(payload ? { body: JSON.stringify(payload) } : {}), timeoutMs: 30_000,
  });
  const token = context.capability.connector.tokenEnv ? process.env[context.capability.connector.tokenEnv] : undefined;
  return buildOpenExecution(context, work, baseUrl, token);
}

async function executeAdjustment(context,baseUrl,headers) {
  const {input,task}=context;
  const token=context.capability.connector.tokenEnv?process.env[context.capability.connector.tokenEnv]:undefined;
  let route=`/v1/open-motion/${input.openWorkId}/adjustments`,payload;
  if(input.operation==='edit-motion-frames'){
    route=`/v1/open-motion/${input.openWorkId}/local-frame-edits`;
    payload={expected_revision:input.expectedRevision,candidate_index:input.candidateIndex,stage_index:input.stageIndex,
      token:input.adjustmentToken,request_key:input.requestKey||task.id,description:input.adjustmentRequest||'对明确授权的帧和区域执行精确替色',
      palette:input.motionPalette.map(p=>({source:p.from,target:p.to})),frames:input.adjustmentRegions.map(region=>({region}))};
  } else if(input.operation==='create-motion-adjustment') payload={expected_revision:input.expectedRevision,candidate_index:input.candidateIndex,
    stage_index:input.stageIndex??null,token:input.adjustmentToken,start:input.adjustmentStart,end:input.adjustmentEnd,
    requested_method:input.adjustmentMethod,user_request:input.adjustmentRequest||'',request_key:input.requestKey||task.id,authorized:input.generationAuthorized===true,
    ...(typeof input.adjustmentPreserveMotion==='boolean'?{preserve_motion:input.adjustmentPreserveMotion}:{}),
    ...(input.adjustmentRegions!==undefined?{edit_regions:input.adjustmentRegions}:{}),
    max_planning_calls:input.adjustmentBudget?.planning??1,max_generation_calls:input.adjustmentBudget?.generation??1,max_review_calls:input.adjustmentBudget?.review??5};
  else if(input.adjustmentId) {
    route+=`/${input.adjustmentId}`;
    if(input.operation==='review-motion-adjustment') {
      const saved=await requestJson(endpointUrl(baseUrl,route),{headers,timeoutMs:15_000});
      if(saved.adjustment.revision!==input.expectedRevision)throw new Error('Adjustment revision does not match the selected source.');
      route+='/decision';payload={token:input.adjustmentToken,decision:input.stageDecision,note:input.reviewNote||'',human_seconds:input.humanSeconds,acknowledge_warnings:input.acknowledgeWarnings??false};
    }
  } else {
    const target=new URL(endpointUrl(baseUrl,route));target.searchParams.set('revision',String(input.expectedRevision));target.searchParams.set('candidate',String(input.candidateIndex));
    if(input.stageIndex!==undefined)target.searchParams.set('stage',String(input.stageIndex));
    const selection=await requestJson(target,{headers,timeoutMs:15_000});
    const work=await requestJson(endpointUrl(baseUrl,`/v1/open-motion/${input.openWorkId}`),{headers,timeoutMs:15_000});
    const frames=[],names=[];
    for(let i=0;i<selection.frames.length;i++){
      const remote=input.stageIndex===undefined?`/v1/jobs/${work.job.job_id}/candidates/${input.candidateIndex}/frames/${i}/image`:
        `/v1/open-motion/${input.openWorkId}/candidates/${input.candidateIndex}/stages/${input.stageIndex}/frames/${i}`;
      frames.push(await checkedAdjustmentDownload(context,baseUrl,token,remote,`adjustment/source-${i}.png`,selection.frames[i].sha256,names));
    }
    return {status:'completed',result:{openWorkId:input.openWorkId,adjustmentContext:selection,orderedFrames:frames,
      nextActions:['edit-motion-frames','create-motion-adjustment'],viewPath:`/tools/sprite-generator?work=${input.openWorkId}&candidate=${input.candidateIndex}`},generatedOutputNames:names};
  }
  const body=await requestJson(endpointUrl(baseUrl,route),{method:payload?'POST':'GET',headers,...(payload?{body:JSON.stringify(payload)}:{}),timeoutMs:30_000});
  return buildAdjustmentExecution(context,body,baseUrl,token);
}

async function checkedAdjustmentDownload(context,baseUrl,token,route,name,sha,names) {
  const file=path.join(context.outputDirectory,name);
  await downloadSpriteArtifact(endpointUrl(baseUrl,route),file,token,'image/png');
  if(createHash('sha256').update(await readFile(file)).digest('hex')!==sha)throw new Error('Adjustment evidence changed while reading.');
  names.push(name);return projectPath(context.repositoryRoot,context.outputDirectory,name);
}

async function buildAdjustmentExecution(context,body,baseUrl,token) {
  const a=body.adjustment;
  if(!/^[0-9a-f]{32}$/.test(a?.id||''))throw new Error('Invalid adjustment response.');
  const running=['queued','planning','submitting','pending','reviewing','adopting'].includes(a.state);
  const names=[],originalFrames=[],alternativeFrames=[];
  if(a.proposed_frames)for(let i=0;i<a.proposed_frames.length;i++){
    for(const [kind,frames,sha] of [['source',originalFrames,a.source_frames[i].sha256],['proposed',alternativeFrames,a.proposed_frames[i].sha256]])
      frames.push(await checkedAdjustmentDownload(context,baseUrl,token,`/v1/open-motion/${a.work_id}/adjustments/${a.id}/${kind}/${i}`,`adjustment/${a.id}/${kind}-${i}.png`,sha,names));
  }
  return {status:running?'running':['adopted','rejected'].includes(a.state)?'completed':a.state==='failed'?'failed':'attention_required',
    result:{openWorkId:a.work_id,adjustmentId:a.id,adjustment:a,work:body.work,originalFrames,alternativeFrames,
      nextActions:running?['get-motion-adjustment']:a.state==='ready'?['review-motion-adjustment']:['get-motion'],
      viewPath:`/tools/sprite-generator?work=${a.work_id}&candidate=${a.state==='adopted'&&a.stage===null?1:a.candidate}`},
    adapter:{id:'sprite-pipeline',openWorkId:a.work_id,adjustmentId:a.id,remoteStatus:a.state},generatedOutputNames:names};
}

async function buildOpenExecution(context, work, baseUrl, token) {
  if (!/^[0-9a-f]{32}$/.test(work?.id || '')) throw new Error('Invalid open-motion response.');
  const status = work.job ? remoteTaskStatus(work.job.status) : work.status === 'planning' ? 'running' : 'attention_required';
  const execution = work.job ? await buildSpriteExecution(context, work.job, { baseUrl, token, status, work }) : { status, result: {}, generatedOutputNames: [] };
  execution.result = { ...execution.result, openWorkId: work.id, work, nextActions: work.job ? execution.result.nextActions : work.status === 'ready' ? ['generate-motion', 'revise-motion'] : work.status === 'planning' ? ['get-motion'] : ['revise-motion'] };
  execution.adapter = { ...execution.adapter, id: 'sprite-pipeline', openWorkId: work.id, openWorkRevision: work.revision, remoteStatus: work.job?.status || work.status };
  return execution;
}

function readJob(body) {
  const job = body?.data?.job ?? body?.job;
  if (!job || typeof job !== 'object' || typeof job.job_id !== 'string') {
    throw new Error('SpritePipeline response did not contain data.job.');
  }
  return job;
}

async function buildSpriteExecution(context, job, { baseUrl, token, status, work }) {
  const review = spriteReview(job, { candidateIndex: context.input.jobId ? context.input.candidateIndex : undefined, work });
  if (['queued', 'not_submitted'].includes(job.status)) {
    status = remoteTaskStatus(job.status);
  } else {
    if (job.request?.open_plan && job.candidates?.some(c => !c.frames?.length &&
        (['submitting','provider_pending','saving'].includes(c.status) || (job.plan_control?.enabled && c.status === 'created')))) status = 'running';
    if (context.input.operation !== 'create' && ['waiting', 'checking', 'repairing'].includes(job.motion_control?.state)) status = 'running';
    if (activeSpriteReview(review.reviewProgress)) status = 'running';
    else if (review.pendingCheckpoints.length || (review.reviewProgress?.readyForApproval &&
        !['approved', 'exported'].includes(job.status))) status = 'attention_required';
  }
  const artifacts = await materializeSpriteArtifacts(
    context,
    job,
    baseUrl,
    token,
  );
  return {
    status,
    result: normalizeSpriteResult(job, artifacts, review),
    generatedOutputNames: artifacts.generatedOutputNames,
    adapter: {
      id: 'sprite-pipeline',
      remoteJobId: job.job_id,
      remoteStatus: job.status,
      endpoint: context.capability.connector.urlEnv,
    },
    ...(['failed', 'not_submitted'].includes(status) ? { error: remoteJobError(job) } : {}),
  };
}

function normalizeSpriteResult(job, artifacts, review) {
  const candidates = Array.isArray(job.candidates) ? job.candidates : [];
  return {
    jobRecord: job,
    jobId: job.job_id,
    candidates: candidates.map((candidate) => ({
      candidateIndex: candidate.candidate_index,
      status: candidate.status,
      hardFailures: candidate.hard_failures ?? [],
      warnings: candidate.warnings ?? [],
      frames:
        candidate.frames?.map((frame) => ({
          index: frame.index,
          reviewStatus: frame.review_status,
          hardFailures: frame.hard_failures ?? [],
          warnings: frame.warnings ?? [],
        })) ?? [],
    })),
    motionControl: job.motion_control ?? null,
    ...(review.pendingCheckpoints.length ? { pendingCheckpoints: review.pendingCheckpoints } : {}),
    nextActions: spriteNextActions(job, review),
    orderedFrames: artifacts.orderedFrames,
    spriteSheet: artifacts.spriteSheet,
    preview: artifacts.preview,
    godotPackage: artifacts.godotPackage,
    metadata: {
      jobId: job.job_id,
      status: job.status,
      revision: job.revision,
      candidateCount: candidates.length,
    },
  };
}

function operationStatus(operation, remoteStatus) {
  if (operation === 'create') return 'completed';
  return remoteTaskStatus(remoteStatus);
}

function remoteTaskStatus(remoteStatus) {
  if (remoteStatus === 'not_submitted') return 'not_submitted';
  if (remoteStatus === 'failed') return 'failed';
  if (
    remoteStatus === 'attention_required' ||
    remoteStatus === 'review_required'
  )
    return 'attention_required';
  if (remoteStatus === 'approved' || remoteStatus === 'exported')
    return 'completed';
  if (remoteStatus === 'created') return 'attention_required';
  return 'running';
}

async function materializeSpriteArtifacts(context, job, baseUrl, token) {
  const generatedOutputNames = [];
  const orderedFrames = [];
  const candidates = Array.isArray(job.candidates) ? job.candidates : [];
  for (const candidate of candidates) {
    if (
      !Number.isInteger(candidate.candidate_index) ||
      !Array.isArray(candidate.frames)
    )
      continue;
    const frames = candidate.frames
      .filter((frame) => Number.isInteger(frame.index))
      .slice()
      .sort((left, right) => left.index - right.index);
    for (const frame of frames) {
      const relativeName =
        `frames/candidate-${String(candidate.candidate_index).padStart(2, '0')}/` +
        `frame-${String(frame.index).padStart(3, '0')}.png`;
      await downloadSpriteArtifact(
        endpointUrl(
          baseUrl,
          `/v1/jobs/${encodeURIComponent(job.job_id)}/candidates/` +
            `${candidate.candidate_index}/frames/${frame.index}/image`,
        ),
        path.join(context.outputDirectory, relativeName),
        token,
        'image/png',
      );
      generatedOutputNames.push(relativeName);
      orderedFrames.push(
        projectPath(
          context.repositoryRoot,
          context.outputDirectory,
          relativeName,
        ),
      );
    }
  }

  let spriteSheet = null;
  let preview = null;
  let godotPackage = null;
  if (job.export && typeof job.export === 'object') {
    await downloadSpriteArtifact(
      endpointUrl(
        baseUrl,
        `/v1/jobs/${encodeURIComponent(job.job_id)}/exports/sheet`,
      ),
      path.join(context.outputDirectory, 'sprite-sheet.png'),
      token,
      'image/png',
    );
    await downloadSpriteArtifact(
      endpointUrl(
        baseUrl,
        `/v1/jobs/${encodeURIComponent(job.job_id)}/exports/preview`,
      ),
      path.join(context.outputDirectory, 'preview.gif'),
      token,
      'image/gif',
    );
    generatedOutputNames.push('sprite-sheet.png', 'preview.gif');
    if (job.export.godot_package_path) {
      await downloadSpriteArtifact(
        endpointUrl(baseUrl, `/v1/jobs/${encodeURIComponent(job.job_id)}/exports/godot`),
        path.join(context.outputDirectory, 'sprite-frames.godot.zip'),
        token,
        'application/zip',
      );
      generatedOutputNames.push('sprite-frames.godot.zip');
      godotPackage = projectPath(context.repositoryRoot, context.outputDirectory, 'sprite-frames.godot.zip');
    }
    spriteSheet = projectPath(
      context.repositoryRoot,
      context.outputDirectory,
      'sprite-sheet.png',
    );
    preview = projectPath(
      context.repositoryRoot,
      context.outputDirectory,
      'preview.gif',
    );
  }

  return { generatedOutputNames, orderedFrames, spriteSheet, preview, godotPackage };
}

async function downloadSpriteArtifact(
  url,
  destination,
  token,
  expectedContentType,
  expectedSha256,
) {
  const { buffer, contentType } = await requestBinary(url, {
    method: 'GET',
    headers: {
      accept: expectedContentType,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    timeoutMs: 30_000,
    maxBytes: 40 * 1024 * 1024,
  });
  if (
    contentType &&
    !contentType.toLowerCase().startsWith(expectedContentType)
  ) {
    throw new Error(
      `SpritePipeline artifact returned ${contentType}; expected ${expectedContentType}.`,
    );
  }
  if (
    expectedContentType === 'image/png' &&
    !hasPrefix(buffer, [137, 80, 78, 71, 13, 10, 26, 10])
  ) {
    throw new Error('SpritePipeline artifact was not a valid PNG.');
  }
  if (
    expectedContentType === 'image/gif' &&
    buffer.subarray(0, 6).toString('ascii') !== 'GIF87a' &&
    buffer.subarray(0, 6).toString('ascii') !== 'GIF89a'
  ) {
    throw new Error('SpritePipeline preview was not a valid GIF.');
  }
  if (expectedContentType === 'application/zip' && !hasPrefix(buffer, [80, 75, 3, 4])) {
    throw new Error('SpritePipeline Godot package was not a ZIP.');
  }
  if (expectedSha256 && createHash('sha256').update(buffer).digest('hex') !== expectedSha256) {
    throw new Error('片段画面在读取期间发生变化，请重新读取当前片段与 token。');
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, buffer);
}

function projectPath(repositoryRoot, outputDirectory, relativeName) {
  return path
    .relative(repositoryRoot, path.join(outputDirectory, relativeName))
    .replaceAll('\\', '/');
}

function hasPrefix(buffer, values) {
  return values.every((value, index) => buffer[index] === value);
}

function remoteJobError(job) {
  const candidate = Array.isArray(job.candidates)
    ? job.candidates.find((item) => item?.error)
    : null;
  const error = job.error ?? candidate?.error;
  if (typeof error === 'string') return error;
  if (error?.message) return String(error.message);
  return job.status === 'not_submitted' ? '本次动画生成未提交。' : 'SpritePipeline reported a failed job.';
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
