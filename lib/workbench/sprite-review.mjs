const activeStates = new Set(['pending', 'running']);
const busyRepairStates = new Set(['submitting', 'pending', 'unknown', 'awaiting_review']);
const activeAdjustmentStates = new Set(['queued', 'planning', 'submitting', 'pending', 'reviewing', 'ready', 'adopting', 'unknown']);

function reviewReceipt(report = {}, protocol) {
  const state = report.state || 'pending';
  const requests = report.requests ?? [];
  const last = requests.at(-1);
  const expert = report.expert_review;
  const expertPhase = ['appearance', 'motion'].includes(expert?.phase)
    ? `expert_${expert.phase}` : expert?.phase;
  let phase = 'done';
  if (activeStates.has(state)) {
    phase = last?.state === 'submitting' ? last.phase
      : expert?.state === 'complete' ? 'finalizing'
      : expertPhase || last?.phase || 'prepare';
  }
  return {
    state,
    phase,
    callsUsed: requests.length,
    callsCompleted: requests.filter(request => request.state === 'complete').length,
    maxCalls: (report.protocol || protocol) === 'experts_v1' ? 5 : 2,
    ...(report.verdict ? { verdict: report.verdict } : {}),
  };
}

export function spriteReview(job, { candidateIndex, work } = {}) {
  const binding = job?.request?.open_plan;
  const quality = binding?.plan?.quality;
  if (!quality) return { reviewProgress: null, pendingCheckpoints: [] };

  const active = [], checkpoints = [], clips = [];
  const protocol = binding.spec?.review_protocol;
  const adjustments = work?.adjustment_usage?.tasks ?? [];
  for (const candidate of job.candidates ?? []) {
    if (!candidate.plan_execution) continue;
    const index = candidate.candidate_index;
    const runs = candidate.plan_execution.stages;
    for (const [stageIndex, run] of runs.entries()) {
      if (quality.version < 3) break;
      const stage = { candidateIndex: index, stageIndex };
      if (['complete', 'reviewing'].includes(run.state)) {
        active.push({ ...stage, scope: 'stage', ...reviewReceipt(run.review ?? {}, protocol) });
      } else if (run.state === 'awaiting_review') {
        const repairPending = run.repairs?.some(repair => busyRepairStates.has(repair.state));
        const adjustmentPending = adjustments.some(adjustment => adjustment.revision === work.revision &&
          adjustment.candidate === index && adjustment.stage === stageIndex && activeAdjustmentStates.has(adjustment.state));
        const token = /^[a-f0-9]{64}$/.test(run.review?.token ?? '') ? run.review.token : undefined;
        const decisionBlock = work?.latest_revision > work?.revision ? 'historical_revision'
          : repairPending || adjustmentPending ? 'pending_alternative' : !token ? 'missing_token' : undefined;
        const decision = {
          readyForDecision: !decisionBlock,
          needsWarningAcknowledgement: run.review?.verdict !== 'pass',
          ...(decisionBlock ? { decisionBlock } : {}),
        };
        checkpoints.push({ ...stage, ...(token ? { stageToken: token } : {}), ...decision,
          progress: { ...stage, scope: 'stage', ...reviewReceipt({ state: 'unknown', ...run.review }, protocol), ...decision } });
      }
    }

    const report = candidate.quality_review ?? candidate.plan_execution.quality_review;
    const assembling = job.plan_control?.enabled && runs.every(run => run.state === (quality.version >= 3 ? 'accepted' : 'complete'));
    if (!report || (!candidate.frames?.length && !assembling) || candidate.status === 'failed') continue;
    const clip = { candidateIndex: index, scope: 'clip', ...reviewReceipt(report, protocol) };
    if (activeStates.has(clip.state)) active.push(clip);
    else {
      const canApprove = candidate.status === 'review_ready' && candidate.frames?.length > 0 &&
        (quality.version < 3 || runs.every(run => run.state === 'accepted')) &&
        !candidate.hard_failures?.length && !candidate.frames.some(frame => frame.hard_failures?.length ||
          ['repair_requested', 'rejected'].includes(frame.review_status));
      clips.push({ ...clip, readyForApproval: Boolean(canApprove),
        needsWarningAcknowledgement: report.verdict !== 'pass' || Boolean(candidate.warnings?.length),
      });
    }
  }

  const selected = rows => candidateIndex === undefined ? rows : rows.filter(row => row.candidateIndex === candidateIndex);
  const pending = selected(checkpoints);
  // Checkpoint decisions share the operation lock with other candidates' reviews.
  const current = selected(active)[0] ?? (pending.length ? active[0] : undefined);
  const finished = selected(clips);
  return {
    reviewProgress: current ?? pending[0]?.progress ?? finished.find(clip => clip.readyForApproval) ?? finished[0] ?? null,
    pendingCheckpoints: pending.map(({ progress: _progress, ...checkpoint }) => current
      ? { ...checkpoint, readyForDecision: false, decisionBlock: 'active_review' }
      : checkpoint),
  };
}

export function activeSpriteReview(progress) {
  return activeStates.has(progress?.state);
}

const phases = {
  prepare: '准备复核所需画面', observe: '逐帧观察', audit: '核对动作与外观',
  expert_appearance: '独立检查外观', expert_motion: '独立检查运动',
  dispute: '复核有争议的画面', finalizing: '整理复核结论',
};

export function spriteReviewPresentation(review) {
  const { reviewProgress: progress, pendingCheckpoints } = review;
  if (!progress) return null;
  const scope = progress.scope === 'stage' ? `候选 ${progress.candidateIndex} 第 ${progress.stageIndex + 1} 段`
    : `候选 ${progress.candidateIndex} 完整动画`;
  const usage = `已用 ${progress.callsUsed}/${progress.maxCalls} 次视觉调用。`;
  if (activeSpriteReview(progress)) return {
    state: 'running', summary: `${scope}正在${phases[progress.phase] || '复核画面'}，${usage}`,
  };
  if (pendingCheckpoints.length) {
    const next = progress.readyForDecision ? '播放实际片段后可以确认姿势并继续。'
      : progress.decisionBlock === 'historical_revision' ? '请在当前作品版本继续检查。'
      : progress.decisionBlock === 'missing_token' ? '请读取片段详情核对版本。'
      : '请先处理当前修复或调整备选。';
    return { state: 'attention_required', summary: `${scope}的复核已结束，${usage}${next}` };
  }
  if (progress.readyForApproval) return {
    state: 'attention_required',
    summary: `${scope}的复核已结束，${usage}检查完整播放后可以提交采用${progress.needsWarningAcknowledgement ? '并确认提醒' : ''}。`,
  };
  return null;
}
