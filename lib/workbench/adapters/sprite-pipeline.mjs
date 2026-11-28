import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { replaceAtomicPath, writeAtomicSnapshot } from '../atomic-snapshot.mjs';
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
    const requestBody = nativeJobCreation(input, task.id);
    await context.beginSubmission({ id: 'sprite-pipeline', nativeLookupPending: true, nativeRequestKind: 'job', nativeRequestKey: requestBody.request_key });
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
      if (createdJob.request && !matchesJobCreation(createdJob, input, task.id))
        throw new Error('Native job receipt does not match the original creation request.');
      return submitNativeGeneration(context, baseUrl, token, createdJob);
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
    const current = await requestJson(endpointUrl(baseUrl, `/v1/jobs/${encodeURIComponent(input.jobId)}`), { headers, timeoutMs: 15_000 });
    const baseline = readJob(current);
    if (baseline.job_id !== input.jobId) throw new Error('Native job does not match the requested generation.');
    return submitNativeGeneration(context, baseUrl, token, baseline);
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
    if (input.operation === 'recover')
      await context.beginSubmission({ id: 'sprite-pipeline', nativeSubmissionPending: 'recover', remoteJobId: input.jobId });
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
      return buildSpriteExecution(context, job, { baseUrl, token, status: remoteTaskStatus(job.status), safety });
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
  const connector = capability.connector;
  const baseUrl = process.env[connector.urlEnv] || connector.defaultUrl;
  if (!baseUrl) {
    return {
      status: 'awaiting_configuration', requiredEnvironment: connector.urlEnv, result: null, adapter: task.adapter,
    };
  }
  const token = connector.tokenEnv ? process.env[connector.tokenEnv] : undefined;
  if (task.adapter?.materializationPending) {
    const receipt = await readSpriteReceipt(context);
    if (receipt.generation) return generationReceipt(context, baseUrl, token, receipt.generation);
    if (receipt.adjustment) return buildAdjustmentExecution(context, receipt.adjustment, baseUrl, token);
    if (receipt.work) return buildOpenExecution(context, receipt.work, baseUrl, token);
    return buildSpriteExecution(context, receipt.job, { ...receipt, baseUrl, token });
  }
  if (task.adapter?.nativeLookupPending || task.adapter?.nativeSubmissionPending || context.legacyNativeSubmission)
    return recoverNativeSubmission(context, baseUrl, token);
  if (task.adapter?.openWorkId) {
    if(task.adapter.adjustmentId) {
      const body=await requestJson(endpointUrl(baseUrl,`/v1/open-motion/${task.adapter.openWorkId}/adjustments/${task.adapter.adjustmentId}`),{headers:bearerHeaders(token),timeoutMs:15_000});
      return buildAdjustmentExecution(context,body,baseUrl,token);
    }
    const target = new URL(endpointUrl(baseUrl, `/v1/open-motion/${task.adapter.openWorkId}`));
    if (task.adapter.openWorkRevision) target.searchParams.set('revision', String(task.adapter.openWorkRevision));
    const work = await requestJson(target, { headers: bearerHeaders(token), timeoutMs: 15_000 });
    return buildOpenExecution(context, work, baseUrl, token);
  }
  const remoteJobId = task.adapter?.remoteJobId;
  if (typeof remoteJobId !== 'string' || !remoteJobId) return null;

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
    const evidence = (frames, segment, folder, frameToken) => frames.map((frame, index) => ({
      route: `${route}${segment}/frames/${index}`, revision, frameToken, sha256: frame.sha256, contentType: 'image/png',
      name: `checkpoint/${folder}frame-${String(index).padStart(3, '0')}.png`,
    }));
    const savedFrames = evidence(stage.frames, '', '', stage.token);
    const repairs = (stage.repairs || []).filter(repair => repair.proposed_frames).map(repair => ({
      attempt: repair.number, token: repair.token,
      frames: evidence(repair.proposed_frames, `/repairs/${repair.number}`, `repair-${repair.number}/`, repair.token),
    }));
    const { generatedOutputNames, outputPath } = await materializeBundle(context,
      [...savedFrames, ...repairs.flatMap(repair => repair.frames)], baseUrl, token);
    const orderedFrames = savedFrames.map(outputPath);
    const repairPreviews = repairs.map(repair => ({ ...repair, frames: repair.frames.map(outputPath) }));
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
  if (['plan-motion', 'revise-motion'].includes(input.operation)) {
    // A workbench-allocated native key is unique to this body. Explicit keys
    // can predate this task and only the original native POST can validate them.
    await context.beginSubmission({ id: 'sprite-pipeline', nativeRequestKey: payload.request_key,
      ...(input.requestKey === undefined ? { nativeLookupPending: true, nativeRequestKind: input.operation === 'revise-motion' ? 'revision' : 'plan' } : {}),
      ...(input.openWorkId ? { openWorkId: input.openWorkId } : {}) });
  } else if (input.operation === 'repair-motion-stage') {
    await context.beginSubmission(motionEditCheckpoint(input, task.id));
  } else if (input.operation === 'resume-motion') {
    await context.beginSubmission({ id: 'sprite-pipeline', nativeSubmissionPending: 'resume-motion', openWorkId: input.openWorkId, openWorkRevision: input.expectedRevision });
  } else if (input.operation === 'generate-motion') {
    await context.beginSubmission({ id: 'sprite-pipeline', nativeSubmissionPending: 'open-motion', openWorkId: input.openWorkId, openWorkRevision: input.expectedRevision });
  }
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
  } else if(input.operation==='create-motion-adjustment') {
    payload = adjustmentPayload(input, task.id);
    await context.beginSubmission(motionEditCheckpoint(input, task.id));
  }
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
    const fullClip = input.stageIndex === undefined;
    const job = fullClip ? (await requestJson(endpointUrl(baseUrl,
      `/v1/open-motion/${input.openWorkId}?revision=${input.expectedRevision}`), { headers, timeoutMs: 15_000 })).job : null;
    const files = selection.frames.map((frame, index) => ({
      route: fullClip ? `/v1/jobs/${encodeURIComponent(job.job_id)}/candidates/${input.candidateIndex}/frames/${frame.raw_index ?? index}/image` :
        `/v1/open-motion/${input.openWorkId}/candidates/${input.candidateIndex}/stages/${input.stageIndex}/frames/${index}`,
      revision: fullClip ? selection.job_revision ?? job.revision : input.expectedRevision,
      name: `adjustment/source-${index}.png`, sha256: frame.sha256, contentType: 'image/png',
    }));
    const { generatedOutputNames, outputPath } = await materializeBundle(context, files, baseUrl, token);
    return {status:'completed',result:{openWorkId:input.openWorkId,adjustmentContext:selection,orderedFrames:files.map(outputPath),
      nextActions:['edit-motion-frames','create-motion-adjustment'],viewPath:`/tools/sprite-generator?work=${input.openWorkId}&candidate=${input.candidateIndex}`},generatedOutputNames};
  }
  const body=await requestJson(endpointUrl(baseUrl,route),{method:payload?'POST':'GET',headers,...(payload?{body:JSON.stringify(payload)}:{}),timeoutMs:30_000});
  return buildAdjustmentExecution(context,body,baseUrl,token);
}

function adjustmentPayload(input, taskId) {
  return {
    expected_revision: input.expectedRevision, candidate_index: input.candidateIndex, stage_index: input.stageIndex ?? null,
    token: input.adjustmentToken, start: input.adjustmentStart, end: input.adjustmentEnd,
    requested_method: input.adjustmentMethod, user_request: input.adjustmentRequest || '',
    request_key: input.requestKey || taskId, authorized: input.generationAuthorized === true,
    preserve_motion: input.adjustmentPreserveMotion, edit_regions: input.adjustmentRegions,
    max_planning_calls: input.adjustmentBudget?.planning ?? 1,
    max_generation_calls: input.adjustmentBudget?.generation ?? 1,
    max_review_calls: input.adjustmentBudget?.review ?? 5,
  };
}

function motionEditCheckpoint(input, taskId) {
  return { id: 'sprite-pipeline', nativeSubmissionPending: input.operation,
    openWorkId: input.openWorkId, openWorkRevision: input.expectedRevision, nativeRequestKey: input.requestKey || taskId };
}

// These native identities are Python's sorted, compact JSON over validated
// strings, booleans, integers and lists. Undefined options are omitted.
function nativeDigest(value) {
  const json = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return createHash('sha256').update(json).digest('hex');
}

async function buildAdjustmentExecution(context,body,baseUrl,token) {
  const a=body.adjustment;
  if(!/^[0-9a-f]{32}$/.test(a?.id||''))throw new Error('Invalid adjustment response.');
  const running=['queued','planning','submitting','pending','reviewing','adopting'].includes(a.state);
  const adapter = await saveSpriteReceipt(context, { adjustment: body }, {
    id: 'sprite-pipeline', openWorkId: a.work_id, adjustmentId: a.id, remoteStatus: a.state,
  });
  if (receiptUnchanged(context, adapter)) return null;
  const files=[],originalFrames=[],alternativeFrames=[];
  if(a.proposed_frames)for(let i=0;i<a.proposed_frames.length;i++){
    for(const [kind,frames,sha] of [['source',originalFrames,a.source_frames[i].sha256],['proposed',alternativeFrames,a.proposed_frames[i].sha256]]) {
      const file = { route: `/v1/open-motion/${a.work_id}/adjustments/${a.id}/${kind}/${i}`,
        name: `adjustment/${a.id}/${kind}-${i}.png`, sha256: sha, contentType: 'image/png' };
      files.push(file);
      frames.push(file);
    }
  }
  const { generatedOutputNames, outputPath } = await materializeBundle(context, files, baseUrl, token);
  return {status:running?'running':['adopted','rejected'].includes(a.state)?'completed':a.state==='failed'?'failed':'attention_required',
    result:{openWorkId:a.work_id,adjustmentId:a.id,adjustment:a,work:body.work,
      originalFrames:originalFrames.map(outputPath),alternativeFrames:alternativeFrames.map(outputPath),
      nextActions:running?['get-motion-adjustment']:a.state==='ready'?['review-motion-adjustment']:['get-motion'],
      viewPath:`/tools/sprite-generator?work=${a.work_id}&candidate=${a.state==='adopted'&&a.stage===null?1:a.candidate}`},
    adapter,generatedOutputNames};
}

async function buildOpenExecution(context, work, baseUrl, token) {
  if (!/^[0-9a-f]{32}$/.test(work?.id || '')) throw new Error('Invalid open-motion response.');
  const intent = work.execution_intent;
  const activating = intent?.phase === 'authorized' && !intent.activation_error && (!work.job || work.job.status === 'created');
  const status = activating ? 'running' : work.job ? remoteTaskStatus(work.job.status) : work.status === 'planning' ? 'running' : 'attention_required';
  const execution = work.job ? await buildSpriteExecution(context, work.job, { baseUrl, token, status, work }) : {
    status, result: {}, generatedOutputNames: [],
    adapter: await saveSpriteReceipt(context, { work }, { id: 'sprite-pipeline', openWorkId: work.id, openWorkRevision: work.revision, remoteStatus: work.status }),
  };
  if (!execution || receiptUnchanged(context, execution.adapter)) return null;
  const nextActions = activating || (!work.job && intent) ? ['get-motion'] : work.job ? execution.result.nextActions :
    work.status === 'ready' ? ['generate-motion', 'revise-motion'] : work.status === 'planning' ? ['get-motion'] : ['revise-motion'];
  execution.result = { ...execution.result, openWorkId: work.id, work, nextActions,
    ...(execution.adapter.commandReceipt ? { commandReceipt: execution.adapter.commandReceipt } : {}) };
  return execution;
}

function readJob(body) {
  const job = body?.data?.job ?? body?.job;
  if (!job || typeof job !== 'object' || typeof job.job_id !== 'string') {
    throw new Error('SpritePipeline response did not contain data.job.');
  }
  return job;
}

function nativeJobCreation(input, taskId) {
  return compact({ schema_version: 1, character_id: input.characterId, action_id: input.actionId,
    provider: input.provider ?? 'pixellab', candidate_count: input.candidateCount ?? 1,
    seed: input.seed, frame_count: input.frameCount, action_description: input.actionDescription, loop: input.loop,
    request_key: input.requestKey ?? taskId });
}

function generationCheckpoint(job, taskId) {
  return { id: 'sprite-pipeline', remoteJobId: job.job_id, remoteStatus: job.status,
    nativeSubmissionPending: 'job-generation', nativeGenerationKey: taskId };
}

async function submitNativeGeneration(context, baseUrl, token, job) {
  const { task, input } = context;
  const adapter = generationCheckpoint(job, task.id);
  await context.beginSubmission(adapter);
  let body;
  try {
    body = await requestJson(endpointUrl(baseUrl, `/v1/jobs/${encodeURIComponent(job.job_id)}/generate`), {
      method: 'POST', headers: bearerHeaders(token),
      body: JSON.stringify({ request_key: task.id, wait: input.wait ?? false, candidate_index: input.candidateIndex }),
      timeoutMs: input.wait ? 360_000 : 30_000,
    });
  } catch (error) {
    // Older native services could report 422 after a paid result failed local validation.
    if (!error.status || error.status >= 500) throw error;
    if (!error.body?.data?.generation_receipt)
      return { status: 'attention_required', adapter, submissionUnknown: true, error: '生成调用返回错误，请按原命令核对提交与用量。' };
    body = error.body;
  }
  return generationReceipt(context, baseUrl, token, body);
}

function matchesProgress(receipt, job) {
  const observed = new Map();
  let exactRevision = false;
  for (const event of job.events || []) {
    if (event.event !== 'generation_command_progress' || event.request_key !== receipt.request_key ||
        event.candidate_index !== receipt.candidate_index || event.wait !== receipt.wait) continue;
    if (event.result_revision === job.revision) exactRevision = true;
    for (const row of event.evidence || []) {
      if ((receipt.candidate_index !== null && row.candidate_index !== receipt.candidate_index) ||
          !job.candidates?.some(candidate => candidate.candidate_index === row.candidate_index)) return false;
      observed.set(`${row.candidate_index}:${row.stage_index}`, row);
    }
  }
  return exactRevision && Array.isArray(receipt.evidence) && observed.size > 0 && receipt.evidence.length === observed.size &&
    nativeDigest(receipt.evidence) === nativeDigest([...observed.values()]);
}

async function generationReceipt(context, baseUrl, token, body) {
  const { task, input } = context;
  const adapter = task.adapter;
  const receipt = body?.data?.generation_receipt;
  const uncertain = error => ({ status: 'attention_required', adapter, error, submissionUnknown: true });
  if (!receipt || receipt.request_key !== task.id || receipt.job_id !== adapter.remoteJobId ||
      receipt.candidate_index !== (input.candidateIndex ?? null) || receipt.wait !== (input.wait ?? false))
    return uncertain('原生生成回执与本次命令或候选不符。');
  if (receipt.state === 'rejected' && receipt.submission_created === false) {
    const { nativeSubmissionPending: _pending, ...identity } = adapter;
    const rejected = { status: 'not_submitted', adapter: { ...identity, generationReceipt: receipt },
      error: receipt.error || '原生服务已拒绝此生成请求。' };
    if (receipt.revision === undefined) return rejected;
    const job = readJob(body);
    if (job.job_id !== receipt.job_id || job.revision !== receipt.revision ||
        !job.events?.some(event => event.event === 'generation_command_preflight' && event.request_key === task.id &&
          event.candidate_index === receipt.candidate_index && event.wait === receipt.wait && event.result_revision === receipt.revision))
      return uncertain('提交前拒绝的回执与原命令的作业版本不符。');
    rejected.adapter = await saveSpriteReceipt(context, { generation: body }, { ...rejected.adapter, jobRevision: job.revision });
    return { ...rejected, result: { jobId: job.job_id, jobRecord: job, generationReceipt: receipt } };
  }
  if (!['returned', 'progress', 'interrupted'].includes(receipt.state))
    return { ...uncertain(receipt.error || '原生服务已收到本次命令，尚未确认生成结果。'), adapter: { ...adapter, generationReceipt: receipt } };
  const job = readJob(body);
  if (job.job_id !== receipt.job_id || !Number.isSafeInteger(receipt.revision) || job.revision !== receipt.revision)
    return uncertain('生成结果与原命令回执绑定的作业版本不符。');
  if (receipt.state !== 'returned') {
    if (!matchesProgress(receipt, job))
      return uncertain('生成异常回执缺少原候选的执行证据。');
    const saved = await saveSpriteReceipt(context, { generation: body }, { ...generationCheckpoint(job, task.id),
      jobRevision: job.revision, generationReceipt: receipt });
    if (receiptUnchanged(context, saved)) return null;
    return { ...uncertain(receipt.error || '原生生成已开始，尚未确认有效的生成结果。'), adapter: saved,
      result: { jobId: job.job_id, jobRecord: job, generationReceipt: receipt, nextActions: ['get'] } };
  }
  return buildSpriteExecution(context, job, { baseUrl, token, status: operationStatus(input.operation, job.status), generationReceipt: receipt });
}

function matchesJobCreation(job, input, taskId) {
  const request = job.request;
  if (!request || request.open_plan || request.attack_segment || request.motion_repair || (request.object_type ?? 'character') !== 'character') return false;
  const expected = nativeJobCreation(input, taskId);
  return (request.character_id ?? request.object_id) === expected.character_id &&
    ['request_key', 'action_id', 'provider', 'candidate_count', 'seed', 'frame_count', 'action_description', 'loop']
      .every(key => (request[key] ?? null) === (expected[key] ?? null));
}

async function recoverNativeSubmission(context, baseUrl, token) {
  const { task, input } = context;
  const edit = ['repair-motion-stage', 'create-motion-adjustment'].includes(input.operation);
  const adapter = context.legacyNativeSubmission && edit ? motionEditCheckpoint(input, task.id) : task.adapter || {};
  const read = route => requestJson(endpointUrl(baseUrl, route), { headers: bearerHeaders(token), timeoutMs: 15_000 });
  const uncertain = error => ({ status: 'attention_required', adapter, error, submissionUnknown: true });
  try {
    if (adapter.nativeLookupPending && adapter.nativeRequestKind !== 'job') {
      const prefix = adapter.nativeRequestKind === 'revision' ? `/v1/open-motion/${encodeURIComponent(input.openWorkId)}` : '/v1/open-motion';
      const key = adapter.nativeRequestKey;
      const work = await read(`${prefix}/requests/${encodeURIComponent(key)}`);
      if (work.request_key !== undefined && work.request_key !== key ||
        adapter.nativeRequestKind === 'revision' && (work.id !== input.openWorkId || work.revision !== input.expectedRevision + 1))
        return uncertain('原生规划回执与本次命令版本不符。');
      return buildOpenExecution(context, work, baseUrl, token);
    }
    if (adapter.nativeSubmissionPending === 'create-motion-adjustment') {
      const body = await read(`/v1/open-motion/${encodeURIComponent(input.openWorkId)}/adjustments/requests/${encodeURIComponent(adapter.nativeRequestKey)}`);
      const a = body.adjustment;
      if (a?.work_id !== input.openWorkId || a.revision !== input.expectedRevision || a.candidate !== input.candidateIndex ||
          a.stage !== (input.stageIndex ?? null) || a.request_key !== adapter.nativeRequestKey ||
          a.request_identity !== nativeDigest(adjustmentPayload(input, task.id)))
        return uncertain('备选回执与原修改请求不符。');
      return buildAdjustmentExecution(context, body, baseUrl, token);
    }
    if (adapter.nativeSubmissionPending === 'repair-motion-stage') {
      const work = await read(`/v1/open-motion/${encodeURIComponent(input.openWorkId)}?revision=${input.expectedRevision}`);
      const candidate = work.job?.candidates?.find(item => item.candidate_index === input.candidateIndex);
      const repair = candidate?.plan_execution?.stages?.[input.stageIndex]?.repairs?.find(item => item.request_key === adapter.nativeRequestKey);
      const identity = nativeDigest({ token: input.stageToken, start: input.repairStart, end: input.repairEnd, mode: input.repairMode, note: input.reviewNote });
      if (work.id !== input.openWorkId || work.revision !== input.expectedRevision || !work.job_id ||
          work.job?.job_id !== work.job_id || repair?.identity !== identity)
        return uncertain('尚未查到绑定原候选、片段和参数的修复回执。');
      return buildOpenExecution(context, work, baseUrl, token);
    }
    if (adapter.nativeSubmissionPending === 'resume-motion' || adapter.nativeSubmissionPending === 'recover')
      return uncertain('尚未收到原命令的回执。可查看原作品或候选的当前状态。');
    if (adapter.nativeSubmissionPending === 'open-motion') {
      const work = await read(`/v1/open-motion/${encodeURIComponent(input.openWorkId)}?revision=${input.expectedRevision}`);
      const binding = work.job?.request?.open_plan;
      const intent = work.execution_intent;
      const intentMatches = intent && intent.revision === work.revision && intent.plan_sha256 === work.plan_sha256 &&
        intent.targets_sha256 === work.target_set_sha256;
      if (work.id !== input.openWorkId || work.revision !== input.expectedRevision || work.plan_sha256 !== input.planSha256 ||
          (input.targetSetSha256 && work.target_set_sha256 !== input.targetSetSha256) || (intent && !intentMatches))
        return uncertain('已找到原作品，生产版本与原生成命令不符。');
      if (!work.job ? !intentMatches : work.job_id !== work.job.job_id || !binding || binding.work_id !== work.id ||
          binding.revision !== work.revision || binding.plan_sha256 !== work.plan_sha256)
        return uncertain('已找到原作品，当前证据无法确认这次生成已启用。');
      return buildOpenExecution(context, work, baseUrl, token);
    }
    if (adapter.nativeSubmissionPending === 'job-generation' && adapter.nativeGenerationKey === task.id) {
      const body = await read(`/v1/jobs/${encodeURIComponent(adapter.remoteJobId)}/generation-requests/${encodeURIComponent(task.id)}`);
      return generationReceipt(context, baseUrl, token, body);
    }
    const byKey = adapter.nativeLookupPending && adapter.nativeRequestKind === 'job';
    const route = byKey ? `/v1/jobs/requests/${encodeURIComponent(adapter.nativeRequestKey)}` : `/v1/jobs/${encodeURIComponent(adapter.remoteJobId)}`;
    const job = readJob(await read(route));
    if (!byKey && job.job_id !== adapter.remoteJobId ||
        (byKey || context.legacyNativeSubmission) && !matchesJobCreation(job, input, task.id))
      return uncertain('原生作业与本次命令的请求参数不符。');
    // Historical job or candidate transitions cannot distinguish two callers
    // asking to generate the very same candidate.
    if (input.operation !== 'create')
      return { ...uncertain('已保存原生作业，当前记录无法确认这次生成已提交。'), adapter: { ...adapter, remoteJobId: job.job_id, remoteStatus: job.status } };
    return buildSpriteExecution(context, job, { baseUrl, token, status: operationStatus(input.operation, job.status) });
  } catch (error) {
    if (error.status === 404) return uncertain('尚未查到原请求的上游回执。请按原任务标识核验。');
    throw error;
  }
}

function spriteReceiptPath(context, sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error('Invalid native receipt identity.');
  return path.join(context.outputDirectory, '.native-receipts', `${sha256}.json`);
}

async function readSpriteReceipt(context) {
  const sha256 = context.task.adapter.receiptSha256;
  const bytes = await readFile(spriteReceiptPath(context, sha256));
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Native receipt changed on disk.');
  return JSON.parse(bytes);
}

async function saveSpriteReceipt(context, receipt, identity) {
  const bytes = JSON.stringify(receipt);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const previous = context.task.adapter;
  const commandReceipt = previous?.commandReceipt ?? receipt.work?.command_receipt;
  const adapter = { ...identity, originalReceiptSha256: previous?.originalReceiptSha256 || sha256, receiptSha256: sha256,
    ...(commandReceipt ? { commandReceipt } : {}) };
  if (previous?.receiptSha256 !== sha256) {
    const file = spriteReceiptPath(context, sha256);
    await mkdir(path.dirname(file), { recursive: true });
    await writeAtomicSnapshot(file, bytes);
    await context.saveAdapter({ ...adapter, materializationPending: true });
  }
  return adapter;
}

function receiptUnchanged(context, adapter) {
  return context.task.adapter?.receiptSha256 === adapter.receiptSha256 &&
    !context.task.adapter.materializationPending && Boolean(context.task.resultDigest);
}

async function buildSpriteExecution(context, job, { baseUrl, token, status, work, safety, generationReceipt }) {
  const snapshot = work ? { work } : { job, status, safety, ...(generationReceipt ? { generationReceipt } : {}) };
  const command = generationReceipt ?? context.task.adapter?.generationReceipt;
  const adapter = await saveSpriteReceipt(context, snapshot, {
    ...(command ? { generationReceipt: command } : {}),
    id: 'sprite-pipeline', remoteJobId: job.job_id, remoteStatus: job.status, jobRevision: job.revision,
    endpoint: context.capability.connector.urlEnv,
    ...(work ? { openWorkId: work.id, openWorkRevision: work.revision } : {}),
  });
  if (receiptUnchanged(context, adapter)) return null;
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
    result: { ...normalizeSpriteResult(job, artifacts, review), ...(safety ? { safety } : {}) },
    generatedOutputNames: artifacts.generatedOutputNames,
    adapter,
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
  const files = [];
  const jobRoute = `/v1/jobs/${encodeURIComponent(job.job_id)}`;
  const candidates = Array.isArray(job.candidates) ? job.candidates : [];
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate.candidate_index) || !Array.isArray(candidate.frames)) continue;
    for (const frame of candidate.frames.slice().sort((left, right) => left.index - right.index)) {
      if (!Number.isInteger(frame.index)) continue;
      if (!/^[0-9a-f]{64}$/.test(frame.sha256 ?? '')) throw new Error('The native frame has no valid source hash.');
      files.push({
        name: `frames/candidate-${String(candidate.candidate_index).padStart(2, '0')}/frame-${String(frame.index).padStart(3, '0')}.png`,
        route: `${jobRoute}/candidates/${candidate.candidate_index}/frames/${frame.index}/image`,
        sha256: frame.sha256,
        revision: job.revision,
        contentType: 'image/png',
      });
    }
  }
  const frameFiles = files.slice();
  const exportFile = (suffix, name, contentType, sha256) => {
    const file = { name, route: `${jobRoute}/exports/${suffix}`, contentType, sha256, revision: job.revision };
    files.push(file);
    return file;
  };
  let sheet, preview, godotPackage;
  if (job.export) {
    sheet = exportFile('sheet', 'sprite-sheet.png', 'image/png', job.export.sha256);
    preview = exportFile('preview', 'preview.gif', 'image/gif', job.export.preview_sha256);
    if (job.export.godot_package_path)
      godotPackage = exportFile('godot', 'sprite-frames.godot.zip', 'application/zip', job.export.godot_sha256);
  }
  const { generatedOutputNames, outputPath } = await materializeBundle(context, files, baseUrl, token);
  return {
    generatedOutputNames, orderedFrames: frameFiles.map(outputPath),
    spriteSheet: outputPath(sheet), preview: outputPath(preview), godotPackage: outputPath(godotPackage),
  };
}

async function materializeBundle(context, files, baseUrl, token) {
  if (!files.length) return { generatedOutputNames: [], outputPath: () => null };
  const digest = createHash('sha256').update(JSON.stringify(files.map(file =>
    [file.name, file.route, file.sha256 || ['legacy', file.revision]],
  ))).digest('hex');
  const relative = path.join('artifacts', digest.slice(0, 32));
  const directory = path.join(context.outputDirectory, relative);
  const generatedOutputNames = files.map(file => path.join(relative, file.name));
  const outputPath = file => file ? projectPath(context.repositoryRoot, context.outputDirectory, path.join(relative, file.name)) : null;
  const published = await readFile(path.join(directory, '.sha256'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (published && published !== digest) throw new Error('Saved sprite artifact digest collision or modification.');
  if (!published) {
    await mkdir(path.dirname(directory), { recursive: true });
    const staging = await mkdtemp(path.join(path.dirname(directory), '.staging-'));
    try {
      for (const file of files) {
        const url = new URL(endpointUrl(baseUrl, file.route));
        if (Number.isInteger(file.revision)) url.searchParams.set('revision', String(file.revision));
        if (file.sha256) url.searchParams.set('expected_sha256', file.sha256);
        if (file.frameToken) url.searchParams.set('token', file.frameToken);
        await downloadSpriteArtifact(url, path.join(staging, file.name), token, file.contentType, file.sha256);
      }
      await writeFile(path.join(staging, '.sha256'), digest, { flag: 'wx' });
      await replaceAtomicPath(staging, directory);
    } finally { await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  }
  return { generatedOutputNames, outputPath };
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
