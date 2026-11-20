import { createHash } from 'node:crypto';
import { activeSpriteReview, spriteReview } from './sprite-review.mjs';

const DETAIL_PAGE_SIZE = 3200;

export function spriteResultJob(result) {
  return result?.jobRecord || result?.work?.job || (result?.job_id ? result : null);
}

export function spriteNextActions(job, review, pollTool = 'workbench_get_task') {
  if (job?.status === 'not_submitted') return [];
  if (job?.status === 'queued') return [pollTool];
  if (activeSpriteReview(review.reviewProgress)) return [pollTool];
  if (review.pendingCheckpoints.length) return ['get-motion-stage',
    ...(review.pendingCheckpoints.some(checkpoint => checkpoint.readyForDecision) ? ['review-motion-stage'] : [])];
  if (review.reviewProgress?.readyForApproval) return ['read-artifact', 'approve', 'reject'];
  if (['waiting', 'checking', 'repairing'].includes(job?.motion_control?.state)) return [pollTool];
  if (['approved', 'exported'].includes(job?.status)) return ['export'];
  if (job?.status === 'review_required') return ['read-artifact', 'safety', 'check', 'review-frame',
    ...(!review.reviewProgress ? ['approve'] : []), 'reject'];
  if (job?.status === 'attention_required') return ['safety', 'recover'];
  return job?.status === 'created' && !job.plan_control?.enabled ? ['get'] : [pollTool];
}

function compactIssue(issues = []) {
  const issue = issues[0];
  return issue ? [{ code: issue.code?.slice(0, 48), message: issue.message?.slice(0, 120),
    ...(Number.isInteger(issue.frame_index) ? { frameIndex: issue.frame_index } : {}) }] : [];
}

export function summarizeSpriteResult(result, candidateIndex, { native = false, taskInput } = {}) {
  if (!result) return null;
  const job = spriteResultJob(result);
  const candidates = (job?.candidates ?? result.candidates)?.map(candidate => {
    const failures = candidate.hard_failures ?? candidate.hardFailures ?? [];
    const warnings = candidate.warnings ?? [];
    return {
      candidateIndex: candidate.candidate_index ?? candidate.candidateIndex,
      status: candidate.status,
      frameCount: candidate.frames?.length ?? 0,
      hardFailureCount: failures.length,
      warningCount: warnings.length,
      hardFailures: compactIssue(failures),
      warnings: compactIssue(warnings),
    };
  });
  const { work, stage, adjustment, adjustmentContext, safety } = result;
  const openWorkId = result.openWorkId || job?.request?.open_plan?.work_id;
  const workRevision = work?.revision ?? job?.request?.open_plan?.revision ?? result.workRevision ?? stage?.work_revision ??
    adjustment?.revision ?? taskInput?.expectedRevision;
  const review = spriteReview(job, { candidateIndex: candidateIndex ?? (taskInput?.jobId ? taskInput.candidateIndex : undefined), work });

  if (candidateIndex !== undefined && !(candidates?.some(candidate => candidate.candidateIndex === candidateIndex) ||
      (stage?.candidate_index ?? adjustment?.candidate ?? (adjustmentContext ? taskInput?.candidateIndex : undefined)) === candidateIndex)) {
    throw new Error('所选动画候选不存在；请先刷新原任务。');
  }

  return {
    jobId: job?.job_id ?? result.jobId,
    status: job?.status ?? result.status,
    openWorkId,
    workRevision,
    ...(candidates ? { candidates: candidates.filter(candidate => candidateIndex === undefined || candidate.candidateIndex === candidateIndex) } : {}),
    ...(review.pendingCheckpoints.length ? { pendingCheckpoints: review.pendingCheckpoints } : {}),
    nextActions: job && !adjustment ? spriteNextActions(job, review,
      native ? 'workbench_get_result' : 'workbench_get_task') : result.nextActions,
    ...(work ? { work: { revision: workRevision, latest_revision: work.latest_revision, status: work.status, plan_sha256: work.plan_sha256,
      target_set_sha256: work.target_set_sha256, diagnostic_only: work.diagnostic_only } } : {}),
    ...(stage ? { stage: { candidate_index: stage.candidate_index, stage_index: stage.stage_index,
      state: stage.state, token: stage.token, fps: stage.fps, frameCount: stage.frames?.length ?? 0,
      review: { state: stage.review?.state, verdict: stage.review?.verdict } } } : {}),
    ...(result.repairPreviews?.length ? { repairPreviews: result.repairPreviews.map(item => ({
      attempt: item.attempt, token: item.token, frameCount: item.frames?.length ?? 0,
    })) } : {}),
    ...(adjustmentContext ? { adjustmentContext: { token: adjustmentContext.token, fps: adjustmentContext.fps,
      frameCount: adjustmentContext.frames?.length ?? 0, locked_frames: adjustmentContext.locked_frames } } : {}),
    ...(adjustment ? { adjustmentId: result.adjustmentId, adjustment: { state: adjustment.state,
      candidate: adjustment.candidate, stage: adjustment.stage, preview_token: adjustment.preview_token } } : {}),
    ...(safety ? { safety: { stage: safety.stage, provider_job_id: safety.provider_job_id,
      submission_attempts: safety.submission_attempts, result_integrity: safety.result_integrity } } : {}),
    ...(result.spriteSheet ? { spriteSheet: result.spriteSheet } : {}),
    ...(result.preview ? { preview: result.preview } : {}),
    ...(result.godotPackage ? { godotPackage: result.godotPackage } : {}),
  };
}

function atSection(value, section) {
  if (!/^(?:\/(?:[^~]|~[01])*)?$/.test(section)) throw new Error('Invalid detail section JSON Pointer.');
  if (!section) return value;
  for (const part of section.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
      throw new Error('Unknown detail section in this result.');
    value = value[key];
  }
  return value;
}

export function spriteDetailPage(payload, { taskId, jobId, candidateIndex, section = '', offset = 0, snapshot }) {
  const json = JSON.stringify(atSection(payload, section));
  const fingerprint = createHash('sha256').update(JSON.stringify([taskId ?? jobId, candidateIndex, section, json])).digest('hex');
  if ((offset && !snapshot) || (snapshot && snapshot !== fingerprint))
    throw new Error('结果详情快照缺失或已变化，请重新读取该分区的第一页。');
  const splitsCharacter = position => /[\uDC00-\uDFFF]/.test(json.charAt(position));
  if (offset >= json.length || splitsCharacter(offset)) throw new Error('Invalid detail page offset.');
  let end = Math.min(offset + DETAIL_PAGE_SIZE, json.length);
  if (splitsCharacter(end)) end--;
  return {
    section, snapshot: fingerprint, offset, totalCharacters: json.length,
    nextOffset: end < json.length ? end : null,
    json: json.slice(offset, end),
  };
}
