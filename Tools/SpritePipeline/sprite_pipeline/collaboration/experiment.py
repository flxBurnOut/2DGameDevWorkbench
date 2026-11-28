"""Paper experiment support. Nothing here alters an existing job or work.

Every arm of a comparison starts from one frozen plan:

* ``freeze_protocol`` copies the compiled prompts, frame counts, seed, FPS,
  reference and end conditions the real pipeline uses for a work.
* ``run_arm`` replays that protocol for the control strategies that skip the
  pipeline's checkpoints (single request, blind chaining, keyframes first).
* ``clone_for_arm`` copies the work so the checkpointed strategies run in the
  real pipeline: ``human_verified`` is decided by a person as usual, and
  ``drive_model_only`` decides a ``model_only`` copy from the reviewer verdict.
* ``retrospective`` exports a finished job for labelling, ``blind_pack``
  anonymises clips, ``inventory`` lists which stored jobs can be exported.
"""
import io
import json
import secrets
import uuid
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageChops

from ..errors import ConflictError, HarnessError, ValidationHarnessError
from ..jsonio import atomic_write_json, inside, read_json
from ..models import JobRecord
from ..processing.frame_checks import run_frame_qa
from ..providers.fixture import FixtureProvider
from .checkpoints import review_call_count
from .contracts import digest
from .drawing_receipts import read_poll_receipt, response_usage
from .experiment_cost import drawing_cost, priced_amounts
from .experiment_policy import REPAIR_POLICIES
from .experiment_replay import ARMS, run_arm
from .experiment_requests import PROTOCOL, freeze_drawing, pipeline_prompts, sha, verify_protocol
from .repairs import REPAIR_LEVELS, generation_calls
from .visual_review import audit_verdict

# Checkpointed strategies, run in the real pipeline on a copy of the work.
PIPELINE_ARMS = ('model_only', 'human_verified')
MODEL_ONLY_REVIEWER = 'experiment-model-only'


# ---------------------------------------------------------------- protocol

def _frozen_plan(service, work_id, revision):
    """The plan inputs the pipeline would send for this work, without drawing."""
    from .quality import compiled_prompt
    from .targets import verified_target
    from .workspace import OpenMotionWorkspace
    ws = OpenMotionWorkspace(service)
    work = ws.load(work_id, revision)
    if work.plan is None or work.status not in ('ready', 'executing'):
        raise ConflictError('作品还没有可执行的方案，不能冻结实验协议')
    job = service.store.load(work.job_id) if work.job_id else None
    if job:
        binding = job.request.open_plan
        seed, fps, prompts = job.candidates[0].seed, job.action.fps, binding.compiled_prompts
    else:
        seed, prompts = work.spec.seed, None
        fps = work.plan.quality.playback_fps if work.plan.quality else work.spec.fps
    if not prompts:
        character = service.presets.load_object(work.spec.object_id, object_type=work.spec.object_type)[0]
        prompts = [compiled_prompt(work.plan, character, i, policy_version=work.generation_policy_version)
                   for i in range(len(work.plan.stages))]
    if seed is None:
        raise ValidationHarnessError('实验各组须使用同一个种子；请先为作品指定种子')
    targets = {t.stage: verified_target(ws.directory(work.id) / t.filename, t.sha256) for t in work.end_targets}
    return ws, work, seed, fps, prompts, targets


def _protocol_data(work, seed, fps, prompts, reference, targets):
    stages, end_hashes = [], []
    reference_sha256 = sha(reference)
    for i, definition in enumerate(work.plan.stages):
        # Same end condition the pipeline submits: a bound target image, the
        # original reference when the plan returns to it, otherwise none.
        last = 'target' if i in targets else 'original' if definition.last_frame == 'original' else None
        stage = {'prompt': prompts[i], 'frames': definition.frame_count, 'last': last}
        if last == 'target':
            stage['last_sha256'] = sha(targets[i])
        end_hashes.append(reference_sha256 if last == 'original' else stage.get('last_sha256'))
        stages.append(stage)
    with Image.open(io.BytesIO(reference)) as image:
        size = image.size
    budget = work.spec.budget.model_dump(mode='json')
    if work.frame_budget:
        for key in ('max_frames_per_request', 'max_total_frames', 'remaining_units'):
            if key in work.frame_budget:
                budget[key] = work.frame_budget[key]
    protocol = {'protocol': PROTOCOL, 'seed': seed, 'fps': fps, 'stages': stages,
                'reference_sha256': reference_sha256,
                'source': {'work_id': work.id, 'revision': work.revision, 'plan_sha256': work.plan_sha256,
                           'job_id': work.job_id, 'provider': work.spec.provider,
                           'review_protocol': work.spec.review_protocol},
                'drawing': freeze_drawing(stages, seed, reference_sha256, size, end_hashes, budget=budget)}
    return {**protocol, 'protocol_sha256': digest(protocol)}


def freeze_protocol(service, work_id, revision, out):
    """Write the original inputs and the exact provider-facing requests for each arm."""
    ws, work, seed, fps, prompts, targets = _frozen_plan(service, work_id, revision)
    reference = ws.reference(work)
    protocol = _protocol_data(work, seed, fps, prompts, reference, targets)
    out.mkdir(parents=True, exist_ok=False)
    (out / 'reference.png').write_bytes(reference)
    for i, data in targets.items():
        (out / f'target-{i}.png').write_bytes(data)
    atomic_write_json(out / 'protocol.json', protocol)
    return protocol


def load_protocol(folder):
    """Read a frozen protocol directory, verifying every image it names."""
    protocol = json.loads((folder / 'protocol.json').read_bytes())
    reference = (folder / 'reference.png').read_bytes()
    verify_protocol(protocol)
    if sha(reference) != protocol['reference_sha256']:
        raise ValueError('protocol directory is not a frozen plan or its reference changed')
    last_frames = []
    for i, stage in enumerate(protocol['stages']):
        data = None
        if stage.get('last') == 'original':
            data = reference
        elif stage.get('last') == 'target':
            data = (folder / f'target-{i}.png').read_bytes()
            if sha(data) != stage['last_sha256']:
                raise ValueError('protocol target image changed')
        last_frames.append(data)
    return protocol, reference, last_frames


# ------------------------------------------------- checkpointed pipeline arms

def clone_for_arm(service, work_id, revision, arm, request_key, *, repair_policy='toolset'):
    """Copy a planned work so another arm runs the same frozen plan and seed.

    The copy is an ordinary work marked with ``experiment``. It has no job yet;
    starting it spends drawing calls like any other work.
    """
    from .contracts import OpenWork
    from .workspace import now
    if arm not in PIPELINE_ARMS or repair_policy not in REPAIR_POLICIES:
        raise ValidationHarnessError('未知的实验组或修复策略')
    ws, source, seed, fps, prompts, targets = _frozen_plan(service, work_id, revision)
    if source.spec.candidate_count != 1:
        raise ValidationHarnessError('实验副本只支持单候选作品')
    reference = ws.reference(source)
    protocol = _protocol_data(source, seed, fps, prompts, reference, targets)
    drawing = protocol['drawing']
    identity = {'arm': arm, 'repair_policy': repair_policy, 'source_work': source.id,
                'source_revision': source.revision, 'plan_sha256': source.plan_sha256}
    frozen = {**drawing['arms'][arm], 'limits': drawing['limits'], 'frame_normalization': drawing['frame_normalization'],
              'seed': seed, 'fps': fps}
    marker = {**identity, 'protocol': PROTOCOL, 'protocol_sha256': protocol['protocol_sha256'],
              'frozen_drawing': frozen, 'frozen_drawing_sha256': digest(frozen)}
    fingerprint = digest({**identity, 'frozen_drawing_sha256': marker['frozen_drawing_sha256']})
    receipt = ws.root / 'requests' / (sha(request_key.encode()) + '.json')
    with service.store.global_lock('open-work-creation'):
        if receipt.exists():
            previous = json.loads(receipt.read_bytes())
            if previous['fingerprint'] not in (fingerprint, digest(identity)):
                raise ConflictError('同一请求标识已用于其他需求')
            return ws.load(previous['id'])
        data = source.model_dump(mode='json')
        data.pop('execution_intent', None)
        data.update(id=uuid.uuid4().hex, revision=1, request_key=request_key, request_sha256=fingerprint,
                    job_id=None, status='ready', history=[], created_at=now(), updated_at=now(),
                    auto_execute=False, experiment=marker, message=f'实验副本（{arm}），与来源作品使用同一方案和种子')
        data['spec']['seed'] = seed
        work = OpenWork.model_validate(data)
        directory = ws.directory(work.id)
        directory.mkdir(parents=True)
        service._atomic_write_bytes(directory / 'reference-1.png', reference)
        for target in source.end_targets:
            service._atomic_write_bytes(directory / target.filename, targets[target.stage])
        ws.save(work)
        atomic_write_json(receipt, {'id': work.id, 'fingerprint': fingerprint})
        return work


def repair_window(count):
    """Largest interior even window a segment redraw accepts, or None."""
    size = min(16, (count - 2) // 2 * 2)
    return (1, size) if size >= 4 else None


def _real_verdict(report):
    if report and report.get('state') == 'complete' and report.get('verdict') in ('pass', 'fail', 'uncertain'):
        return report['verdict']
    return None


def _repair_interruption(attempts, stage, reports):
    if not attempts:
        return None
    attempt = attempts[-1]
    state = attempt['state']
    error = attempt.get('error') or {}
    details = error.get('details') or {}
    if state == 'unknown':
        reason = 'repair_submission_unknown'
    elif state == 'failed':
        reason = details.get('reason') or details.get('code') or error.get('code') or 'repair_failed'
    elif state == 'rejected' or (state == 'accepted' and not _real_verdict(reports[-1])):
        reason = 'repair_review_unavailable'
    else:
        return None
    last_verdict = next((verdict for report in reversed(reports) if (verdict := _real_verdict(report))), None)
    return {'kind': 'provider_failure', 'reason': reason, 'stage': stage,
            'repair_state': state, 'repair_request_key': attempt['request_key'],
            'provider_job_id': attempt.get('provider_job_id'), 'last_review_verdict': last_verdict}


def _model_review_interruption(attempts, stage, reports):
    first = reports[0] or {}
    if not _real_verdict(first):
        return {'kind': 'provider_failure', 'reason': 'initial_review_unavailable', 'stage': stage,
                'review_state': first.get('state'), 'last_review_verdict': None}
    return _repair_interruption(attempts, stage, reports)


def _model_frame_budget(job, experiment):
    if experiment.get('arm') != 'model_only' or experiment.get('protocol') != PROTOCOL:
        return None
    frozen = experiment['frozen_drawing']
    if digest(frozen) != experiment['frozen_drawing_sha256']:
        raise ConflictError('实验副本的冻结绘图协议已改变')
    counts = [call['count'] for call in frozen['requests']]
    requested = reserved = 0
    for candidate in job.candidates:
        for count, run in zip(counts, candidate.plan_execution.stages, strict=True):
            requested += count * run.submission_attempts + sum(a['input_count'] for a in run.repairs)
            if not run.submission_attempts:
                reserved += count
    limit = frozen['limits']['max_total_frames']
    return {'max_total_frames': limit, 'requested_frames': requested, 'reserved_baseline_frames': reserved,
            'over_limit': limit is not None and requested + reserved > limit}


def _model_interruption(job, experiment, frame_budget):
    if experiment.get('arm') != 'model_only':
        return None
    for candidate in job.candidates:
        for stage, run in enumerate(candidate.plan_execution.stages):
            if run.state_checkpoint and run.state_checkpoint.get('reviewer') != MODEL_ONLY_REVIEWER:
                return {'kind': 'protocol_violation', 'reason': 'human_intervention_in_model_only', 'stage': stage}
            if run.accepted and run.accepted.get('reviewer') != MODEL_ONLY_REVIEWER:
                return {'kind': 'protocol_violation', 'reason': 'human_intervention_in_model_only', 'stage': stage}
            if run.adjustment_history:
                return {'kind': 'protocol_violation', 'reason': 'human_intervention_in_model_only', 'stage': stage}
            for rep in [*run.review_history, run.review or {}]:
                decision = rep.get('human_decision')
                if decision and decision.get('reviewer') != MODEL_ONLY_REVIEWER:
                    return {'kind': 'protocol_violation', 'reason': 'human_intervention_in_model_only', 'stage': stage}
            if run.state in ('awaiting_review', 'rejected', 'accepted', 'repairing'):
                if failure := _model_review_interruption(run.repairs, stage, [*run.review_history, run.review]):
                    return failure
    if frame_budget and frame_budget['over_limit']:
        return {'kind': 'protocol_violation', 'reason': 'max_total_frames', **frame_budget}
    return None


def drive_model_only(service, work_id, provider, *, authorized, allow_unsupported_motion=False, max_steps=40):
    """Decide a ``model_only`` copy from the pipeline reviewer alone.

    Fixed rule per segment: a ``pass`` verdict is accepted. Otherwise one
    interior redraw is requested with the reviewer's own findings as the
    instruction and the segment is reviewed again; a second non-pass, or a
    segment too short or too costly to redraw, rejects it and stops the run.
    Failed or uncertain drawing requests interrupt the run at the last real review.
    No person looks at any frame.
    """
    from .checkpoints import Checkpoints
    from .execution import PlanGeneration
    from .repairs import LocalRepairs
    from .workspace import OpenMotionWorkspace
    if not authorized:
        raise ValidationHarnessError('自动执行会调用绘图与视觉模型，须明确授权')
    ws = OpenMotionWorkspace(service)
    work = ws.load(work_id)
    if (work.experiment or {}).get('arm') != 'model_only':
        raise ValidationHarnessError('只能自动裁决 model_only 实验副本，不会替用户裁决普通作品')
    if not work.job_id:
        try:
            pipeline_prompts(work)
        except ValidationHarnessError as exc:
            summary = {'work_id': work.id, 'job_id': None, 'arm': 'model_only', 'protocol': PROTOCOL,
                       'status': 'blocked_preflight', 'outcome': {'kind': 'local_preflight', **exc.details},
                       'decisions': []}
            atomic_write_json(ws.directory(work.id) / 'experiment-run.json', summary)
            return summary
        work = ws.start(work.id, work.revision, work.plan_sha256, allow_unsupported_motion=allow_unsupported_motion)
    job_id, engine, checkpoints, repairs = work.job_id, PlanGeneration(service), Checkpoints(service), LocalRepairs(service)
    decisions, status = [], 'stalled'
    outcome = {'kind': 'not_submitted', 'reason': 'no_provider_submission'}
    job = service.store.load(job_id)
    failure = _model_interruption(job, work.experiment, _model_frame_budget(job, work.experiment))
    for _ in range(max_steps):
        if failure:
            status, outcome = 'interrupted', failure
            break
        try:
            job = engine.advance(job_id, provider, wait=True)
        except HarnessError:
            job = service.store.load(job_id)
            if job.candidates[0].status.value not in ('failed', 'submission_unknown'):
                raise
        candidate = job.candidates[0]
        runs = candidate.plan_execution.stages
        failure = _model_interruption(job, work.experiment, _model_frame_budget(job, work.experiment))
        if failure:
            status, outcome = 'interrupted', failure
            break
        stage = next((i for i, r in enumerate(runs) if r.state == 'awaiting_review'), None)
        if stage is None:
            if candidate.frames:
                status = 'complete'
                outcome = {'kind': 'complete', 'reason': 'playable'}
            elif any(r.state == 'rejected' for r in runs):
                status = 'stopped_by_review'
                outcome = {'kind': 'review_stopped', 'reason': 'segment_rejected'}
            elif candidate.status.value in ('failed', 'submission_unknown'):
                status = 'interrupted'
                error = candidate.error or {}
                reason = (error.get('details') or {}).get('reason') or error.get('code') or candidate.status.value
                stage_failed = next((i for i, r in enumerate(runs) if r.error), None)
                submitted = runs[stage_failed].submission_attempts if stage_failed is not None else candidate.submission_attempts
                outcome = {'kind': 'provider_failure' if submitted else 'local_preflight', 'reason': reason,
                           **({'stage': stage_failed} if stage_failed is not None else {})}
            else:
                continue
            break
        run = runs[stage]
        preview = next((a for a in run.repairs if a['state'] == 'awaiting_review'), None)
        if preview:
            repairs.decide(job_id, 1, stage, preview['number'], preview['token'],
                           'Fixed policy: adopt the single redraw and review it again', 'accept')
            decisions.append({'stage': stage, 'action': 'adopt_repair'})
            continue
        view = checkpoints.view(job_id, 1, stage)
        verdict = _real_verdict(run.review)
        if verdict == 'pass':
            checkpoints.decide(job_id, 1, stage, token=view['token'], decision='accept', reviewer=MODEL_ONLY_REVIEWER,
                               note='Fixed policy: reviewer verdict pass, no human inspection')
            decisions.append({'stage': stage, 'action': 'accept', 'verdict': verdict})
            continue
        window = repair_window(len(view['frames']))
        refusal = 'second non-pass verdict' if run.repairs else 'segment too short to redraw' if not window else None
        if refusal is None:
            findings = [c['evidence'] for c in (run.review or {}).get('checks', []) if c.get('status') != 'pass']
            note = ('Fix: ' + (' '.join(findings) or 'the defects reported by the reviewer'))[:700]
            redraw = {'stage': stage, 'action': 'redraw', 'verdict': verdict, 'window': list(window)}
            try:
                repairs.create(job_id, 1, stage, token=view['token'], start=window[0], end=window[1], note=note,
                               mode='transition', request_key=f'model-only-s{stage}', authorized=True, provider=provider)
                decisions.append(redraw)
                continue
            except Exception as exc:
                current = checkpoints.run_record(service.store.load(job_id), 1, stage)
                if failure := _repair_interruption(current.repairs, stage, [*current.review_history, current.review]):
                    decisions.append(redraw)
                    status, outcome = 'interrupted', failure
                    break
                if not isinstance(exc, ValidationHarnessError):
                    raise
                refusal = str(exc)  # Budget or tool limits; never widen them here.
        checkpoints.decide(job_id, 1, stage, token=view['token'], decision='reject', reviewer=MODEL_ONLY_REVIEWER,
                           note='Fixed policy: reviewer did not pass; ' + refusal)
        decisions.append({'stage': stage, 'action': 'reject', 'verdict': verdict, 'reason': refusal})
    if status == 'stalled' and service.store.load(job_id).candidates[0].submission_attempts:
        outcome = {'kind': 'provider_failure', 'reason': 'unfinished_provider_result'}
    summary = {'work_id': work.id, 'job_id': job_id, 'arm': 'model_only', 'status': status,
               'protocol': work.experiment.get('protocol', 2), 'outcome': outcome, 'decisions': decisions}
    atomic_write_json(ws.directory(work.id) / 'experiment-run.json', summary)
    return summary


# --------------------------------------------------------------- exports

def _is_probe_override(item):
    return (isinstance(item, dict)
            and (item.get('source') == 'deterministic_probe'
                 or ('proposal' not in item and 'prior' in item and 'frames' in item)))


def _adjudication_items(report, expert):
    combined = []
    seen = set()
    for source in (expert.get('requires_human_adjudication') or [], report.get('requires_human_adjudication') or []):
        for item in source:
            if not isinstance(item, dict):
                continue
            frames_key = tuple(sorted(set(item.get('frames') or [])))
            key = (item.get('dimension'), _is_probe_override(item), item.get('reason'), frames_key)
            if key not in seen:
                seen.add(key)
                combined.append(item)
    return combined


def _combine_verdicts(*verdicts):
    present = [v for v in verdicts if v is not None]
    if not present:
        return None
    if 'fail' in present:
        return 'fail'
    if 'uncertain' in present:
        return 'uncertain'
    return 'pass'


def _ground_check(check, frame_count):
    """Apply the same distinct-frame evidence floor as ``grounded_audit``."""
    item = dict(check)
    dim = item.get('dimension')
    frames = item.get('frames') or []
    if dim in {'rhythm', 'transition', 'fixed_parts'}:
        minimum = 2
    elif dim == 'completeness':
        minimum = min(frame_count, 3) if frame_count else min(max(frames, default=0), 3)
    else:
        minimum = 1
    if len(set(frames)) < minimum:
        item.update(status='uncertain', confidence=0)
    return item


def _infer_frame_count(report, checks, frame_count):
    if frame_count is not None:
        return frame_count
    obs = (report.get('observations') or {}).get('frames') or []
    if obs:
        return len(obs)
    motion_ev = report.get('motion_evidence') or {}
    probe_frames = (motion_ev.get('tracked_parts') or {}).get('frames') or (motion_ev.get('character_probes') or {}).get('frames') or []
    if probe_frames:
        return len(probe_frames)
    return max((f for c in checks for f in (c.get('frames') or [])), default=0)


def counterfactual_verdicts(report, *, frame_count=None):
    """Verdicts the same recorded opinions give with parts of the review removed.

    Produces the full 2x2 ablation matrix over contradiction retention and
    deterministic probe overrides (plus ``baseline_only``):

    * ``full``: retention ON, probes ON (stored verdict).
    * ``without_probes``: retention ON, probes OFF.
    * ``without_retention``: retention OFF, probes ON (when expert review ran).
    * ``final_review_wins``: retention OFF, probes OFF (when expert review ran).
    * ``baseline_only``: independent experts, dispute review, and probes dropped.

    Preserves orthogonal gates (such as adjustment ``comparison.verdict``) and
    re-applies ``grounded_audit`` frame-evidence floors to dispute proposals.
    Computed from the stored report; no model is called.
    """
    expert = (report or {}).get('expert_review') or {}
    if not report or report.get('verdict') is None or ('state' in report and not _real_verdict(report)):
        return None
    items = _adjudication_items(report, expert)
    probe_items = [item for item in items if _is_probe_override(item)]
    review_items = [item for item in items if not _is_probe_override(item) and 'proposal' in item]
    checks = report.get('checks') or []
    comparison_verdict = (report.get('comparison') or {}).get('verdict')
    eff_count = _infer_frame_count(report, checks, frame_count)

    review_dims = {item['dimension'] for item in review_items if item.get('dimension')}
    probe_priors = {}
    probe_by_dim = {}
    for item in probe_items:
        dim = item.get('dimension')
        if not dim:
            continue
        probe_by_dim.setdefault(dim, item)
        if dim not in review_dims and dim not in probe_priors and isinstance(item.get('prior'), dict):
            probe_priors[dim] = item['prior']

    pre_probe_checks = [probe_priors.get(c['dimension'], c) for c in checks]
    if not checks:
        without_probes_verdict = None
        without_probes_checks = None
    elif not probe_items:
        without_probes_verdict = report['verdict']
        without_probes_checks = [dict(c) for c in checks]
    else:
        without_probes_verdict = _combine_verdicts(audit_verdict(pre_probe_checks), comparison_verdict)
        without_probes_checks = [dict(c) for c in pre_probe_checks]

    without_retention_verdict = None
    without_retention_checks = None
    final_review_wins_verdict = None
    final_review_wins_checks = None
    if checks and expert.get('state') == 'complete':
        proposals = {item['dimension']: item['proposal'] for item in review_items if item.get('dimension')}
        final_review_wins_checks = [
            _ground_check(proposals[c['dimension']], eff_count) if c['dimension'] in proposals else dict(c)
            for c in pre_probe_checks
        ]
        if not probe_items and not proposals:
            final_review_wins_verdict = report['verdict']
        else:
            final_review_wins_verdict = _combine_verdicts(audit_verdict(final_review_wins_checks), comparison_verdict)

        # Retention OFF, probes ON: start from unretained proposals, then re-apply probe overrides.
        ret_off_checks = []
        for c in final_review_wins_checks:
            dim = c['dimension']
            if dim in probe_by_dim and c.get('status') == 'pass':
                ret_off_checks.append({**c, 'status': 'uncertain', 'confidence': 0})
            else:
                ret_off_checks.append(dict(c))
        motion_ev = report.get('motion_evidence') or {}
        probe_cues = motion_ev.get('tracked_parts') or motion_ev.get('character_probes')
        if probe_cues:
            from .prop_measurements import guard_measurements
            guarded = guard_measurements({'checks': ret_off_checks, 'verdict': audit_verdict(ret_off_checks)}, probe_cues)
            ret_off_checks = [dict(c) for c in guarded['checks']]
        without_retention_checks = ret_off_checks
        if not proposals:
            without_retention_verdict = report['verdict']
        else:
            without_retention_verdict = _combine_verdicts(audit_verdict(without_retention_checks), comparison_verdict)

    baseline_checks = (expert.get('baseline') or {}).get('checks')
    return {
        'full': report['verdict'],
        'baseline_only': (expert.get('baseline') or {}).get('verdict'),
        'without_probes': without_probes_verdict,
        'without_retention': without_retention_verdict,
        'final_review_wins': final_review_wins_verdict,
        'retained_contradictions': len(review_items),
        'probe_overrides': len(probe_items),
        'probe_override_details': [
            {'dimension': item['dimension'], 'frames': list(item.get('frames') or []), 'reason': item.get('reason', '')}
            for item in probe_items
        ],
        'checks_by_condition': {
            'full': [dict(c) for c in checks] if checks else None,
            'baseline_only': [dict(c) for c in baseline_checks] if baseline_checks else None,
            'without_probes': without_probes_checks,
            'without_retention': without_retention_checks,
            'final_review_wins': final_review_wins_checks,
        },
    }


def sequence_drift_metrics(frame_paths, reference_path, *, job=None):
    """Deterministic per-frame geometry & palette drift relative to ``reference_path``."""
    paths = [Path(p) for p in frame_paths]
    ref_path = Path(reference_path) if reference_path is not None else None
    if not paths or ref_path is None or not ref_path.is_file():
        return None
    alpha_threshold = max(0, job.character.qa.alpha_visible_threshold - 1) if job is not None else 0
    palette_distance = float(job.character.qa.palette_distance) if job is not None else 48.0
    palette_candidates = sorted(ref_path.parent.glob('palette.*'))
    palette_path = palette_candidates[0] if palette_candidates else ref_path
    qa = run_frame_qa(
        paths,
        reference_frame=ref_path,
        palette=palette_path,
        grounded=True,
        thresholds={'alpha_threshold': alpha_threshold, 'palette_color_distance': palette_distance},
    )
    with Image.open(ref_path) as ref_im:
        ref_rgba = ref_im.convert('RGBA')
        ref_size = ref_rgba.size
        ref_mask = ref_rgba.getchannel('A').point(lambda a: 255 if a > alpha_threshold else 0, mode='1')

    rows = []
    for idx, path in enumerate(paths):
        iou = None
        try:
            with Image.open(path) as frame_im:
                frame_rgba = frame_im.convert('RGBA')
                if frame_rgba.size == ref_size:
                    frame_mask = frame_rgba.getchannel('A').point(lambda a: 255 if a > alpha_threshold else 0, mode='1')
                    inter = ImageChops.logical_and(ref_mask, frame_mask).histogram()[255]
                    union = ImageChops.logical_or(ref_mask, frame_mask).histogram()[255]
                    iou = round(inter / union, 6) if union else None
        except (OSError, ValueError, SyntaxError):
            iou = None
        metrics = qa['frames'][idx]['metrics'] if idx < len(qa.get('frames', [])) else {}
        rows.append({
            'frame': idx + 1,
            'ground_y_delta_px': metrics.get('ground_delta'),
            'area_change_ratio': metrics.get('area_change_ratio'),
            'silhouette_iou': iou,
            'palette_deviation_ratio': metrics.get('palette_deviation_ratio'),
        })

    abs_ground = [abs(r['ground_y_delta_px']) for r in rows if r['ground_y_delta_px'] is not None]
    areas = [r['area_change_ratio'] for r in rows if r['area_change_ratio'] is not None]
    ious = [r['silhouette_iou'] for r in rows if r['silhouette_iou'] is not None]
    palettes = [r['palette_deviation_ratio'] for r in rows if r['palette_deviation_ratio'] is not None]
    end = rows[-1]
    return {
        'reference_sha256': sha(ref_path.read_bytes()),
        'frame_count': len(paths),
        'frames': rows,
        'summary': {
            'max_abs_ground_y_delta_px': max(abs_ground) if abs_ground else None,
            'mean_abs_ground_y_delta_px': round(sum(abs_ground) / len(abs_ground), 6) if abs_ground else None,
            'max_area_change_ratio': max(areas) if areas else None,
            'mean_area_change_ratio': round(sum(areas) / len(areas), 6) if areas else None,
            'min_silhouette_iou': min(ious) if ious else None,
            'mean_silhouette_iou': round(sum(ious) / len(ious), 6) if ious else None,
            'max_palette_deviation_ratio': max(palettes) if palettes else None,
            'mean_palette_deviation_ratio': round(sum(palettes) / len(palettes), 6) if palettes else None,
            'end_ground_y_delta_px': end['ground_y_delta_px'],
            'end_area_change_ratio': end['area_change_ratio'],
            'end_silhouette_iou': end['silhouette_iou'],
            'end_palette_deviation_ratio': end['palette_deviation_ratio'],
        },
    }


def _playback(job, job_dir, out):
    ref_path = job_dir / 'input' / 'reference.png'
    def copy(frame, name):
        data = inside(job_dir, job_dir / frame.active_path).read_bytes()
        if sha(data) != frame.sha256:
            raise ValueError('archive frame hash mismatch')
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        (out / name).write_bytes(data)
        return {'file': name, 'sha256': frame.sha256}
    clips = []
    for c in job.candidates:
        if not c.frames:
            continue
        frames = [copy(f, f'candidate-{c.candidate_index}/playback/{n:03}.png') for n, f in enumerate(c.frames)]
        clips.append({
            'candidate': c.candidate_index, 'fps': job.action.fps, 'loop': job.action.loop, 'status': c.status.value,
            'frames': frames, 'drift': sequence_drift_metrics([out / f['file'] for f in frames], ref_path, job=job),
        })
    return clips


def legacy_export(job_dir, out):
    """Playback frames and events of a job made before open plans existed.

    Such jobs have no segments, checkpoints or review ledger, so they support
    failure labelling of whole clips only.
    """
    job = JobRecord.model_validate_json((job_dir / 'job.json').read_bytes())
    if job.request.open_plan:
        raise ValueError('this job has an open plan; use the full export')
    out.mkdir(parents=True, exist_ok=False)
    result = {'job': job.job_id, 'kind': 'legacy', 'clips': _playback(job, job_dir, out), 'events': job.events}
    atomic_write_json(out / 'retrospective.json', result)
    return result


def inventory(jobs_dir):
    """Which stored jobs each export accepts. Reads ``job.json`` files only."""
    rows = []
    for path in sorted(jobs_dir.glob('*/job.json')):
        try:
            job = JobRecord.model_validate_json(path.read_bytes())
        except ValueError as exc:
            rows.append({'job': path.parent.name, 'export': 'unreadable', 'error': str(exc)[:200]})
            continue
        plan = job.request.open_plan
        stages = [r for c in job.candidates if c.plan_execution for r in c.plan_execution.stages]
        rows.append({'job': job.job_id, 'export': 'full' if plan else 'legacy', 'status': job.status.value,
                     'work_id': plan.work_id if plan else None, 'revision': plan.revision if plan else None,
                     'object_type': getattr(job.request, 'object_type', None), 'candidates': len(job.candidates),
                     'playable_candidates': sum(bool(c.frames) for c in job.candidates), 'stages': len(stages),
                     'reviewed_stages': sum(bool(r.review or r.review_history) for r in stages),
                     'human_decisions': sum(bool((r.review or {}).get('human_decision')) for r in stages),
                     'repairs': sum(len(r.repairs) for r in stages)})
    return rows


def _parse_iso_dt(value):
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


def _escalation_summary(job, rows, alternatives, *, current_protocol):
    """Objective checkpoint escalation counts and backend wall-clock latency."""
    ready_events = {}
    for event in job.events:
        if event.get('event') == 'open_motion_checkpoint_ready':
            key = (event.get('candidate_index'), event.get('stage'))
            dt = _parse_iso_dt(event.get('at'))
            if dt is not None:
                ready_events.setdefault(key, []).append(dt)

    all_reports = []
    wall_deltas = []
    human_checkpoint_decisions = 0
    for row in rows:
        reports = [rep for rep in row['review_history'] if rep]
        all_reports.extend(reports)
        human_checkpoint_decisions += sum(
            1 for d in row['human_decisions']
            if not current_protocol or d.get('reviewer') != MODEL_ONLY_REVIEWER
        )
        candidate = next((c for c in job.candidates if c.candidate_index == row['candidate']), None)
        stage_run = candidate.plan_execution.stages[row['stage']] if (candidate and candidate.plan_execution) else None
        for idx, rep in enumerate(reports):
            decision = rep.get('human_decision')
            if not decision or (current_protocol and decision.get('reviewer') == MODEL_ONLY_REVIEWER):
                continue
            end_dt = _parse_iso_dt(decision.get('decided_at'))
            if end_dt is None and idx == len(reports) - 1 and stage_run and stage_run.accepted:
                end_dt = _parse_iso_dt(stage_run.accepted.get('accepted_at'))
            start_dt = _parse_iso_dt(rep.get('reviewed_at'))
            if start_dt is None:
                stage_ready = ready_events.get((row['candidate'], row['stage']), [])
                if idx < len(stage_ready):
                    start_dt = stage_ready[idx]
            if start_dt is not None and end_dt is not None:
                wall_deltas.append(max(0.0, round((end_dt - start_dt).total_seconds(), 3)))

    def is_auto_pass(rep):
        expert = rep.get('expert_review') or {}
        return (
            rep.get('state') == 'complete'
            and rep.get('verdict') == 'pass'
            and not _adjudication_items(rep, expert)
        )

    total = len(all_reports)
    auto_pass = sum(1 for rep in all_reports if is_auto_pass(rep))
    escalated = total - auto_pass
    probe_escalated = sum(
        1 for rep in all_reports
        if any(_is_probe_override(item) for item in _adjudication_items(rep, rep.get('expert_review') or {}))
    )
    contradiction_escalated = sum(
        1 for rep in all_reports
        if any(not _is_probe_override(item) and 'proposal' in item
               for item in _adjudication_items(rep, rep.get('expert_review') or {}))
    )
    human_adjustment_decisions = sum(
        1 for t in alternatives
        if t.get('state') in ('adopted', 'rejected') or t.get('decision_note') or t.get('human_seconds') is not None
    )
    return {
        'total_checkpoint_reviews': total,
        'auto_pass_reviews': auto_pass,
        'escalated_reviews': escalated,
        'escalation_rate': round(escalated / total, 6) if total else None,
        'probe_escalated_reviews': probe_escalated,
        'contradiction_escalated_reviews': contradiction_escalated,
        'human_checkpoint_decisions': human_checkpoint_decisions,
        'human_adjustment_decisions': human_adjustment_decisions,
        'human_interventions': human_checkpoint_decisions + human_adjustment_decisions,
        'measured_wall_decisions': len(wall_deltas),
        'known_wall_seconds': round(sum(wall_deltas), 3),
    }


def retrospective(job_dir, work, adjustments, out):
    """Export one open-plan job for labelling. Paths are supplied by the operator;
    every copied PNG is verified against its recorded hash."""
    job = JobRecord.model_validate_json((job_dir / 'job.json').read_bytes())
    plan = job.request.open_plan
    if not plan:
        raise ValueError('job has no open plan (made by the earlier attack flow); use the legacy export')
    if work.get('job_id') != job.job_id or work['id'] != plan.work_id or work['revision'] != plan.revision:
        raise ValueError('work, job and revision do not match')
    current_protocol = (work.get('experiment') or {}).get('protocol') == PROTOCOL
    out.mkdir(parents=True, exist_ok=False)

    def copy_png(item, name, *, root=job_dir):
        relative = item['path'] if 'path' in item else item['file']
        data = inside(root, root / relative).read_bytes()
        if sha(data) != item['sha256']:
            raise ValueError('archive frame hash mismatch')
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        (out / name).write_bytes(data)
        return {'file': name, 'sha256': item['sha256']}

    def receipt_usage(call):
        usage = response_usage(call) or response_usage(call.get('receipt'))
        error = call.get('error')
        if usage or not isinstance(error, dict):
            return usage
        return response_usage((error.get('details') or {}).get('response'))

    def optional_record(path):
        try:
            return read_json(path)
        except FileNotFoundError:
            return {}

    def drawing_record(record, folder, submit_name):
        identity = record.get('provider_job_id')
        returned, observed = None, None
        if identity and folder is not None:
            returned = read_poll_receipt(folder / 'provider-result.json', identity)
            observed = read_poll_receipt(folder / 'poll-receipt.json', identity)
        # One call has several observations. Use the latest bound usage and
        # fall back to the accepted submission when a poll omits usage.
        known = response_usage(returned) or response_usage(observed) or receipt_usage(record)
        if not known and folder is not None:
            known = response_usage(optional_record(folder / submit_name))
        return known, returned

    rows, timings, drawing_usage, review_usage, tools = [], [], [], [], {}

    def note_review(report):
        review_usage.extend(receipt_usage(q) for q in (report or {}).get('requests', []))

    def note_tool(level):
        tools[level] = tools.get(level, 0) + 1

    for c in job.candidates:
        note_review(c.plan_execution.quality_review)
        for i, run in enumerate(c.plan_execution.stages):
            folder = f'candidate-{c.candidate_index}/stage-{i}'
            manifest = job_dir / 'provider' / f'candidate_{c.candidate_index:02}.plan' / str(i) / 'frames.json'
            saved_stage = optional_record(manifest)
            reports = [*run.review_history, run.review or {}]
            for report in reports:
                note_review(report)
            decisions = [r['human_decision'] for r in reports if r.get('human_decision')]
            if run.state_checkpoint:
                decisions.append({'decision': 'accept_state', **run.state_checkpoint})
            timings.extend(d.get('human_seconds') for d in decisions
                           if not current_protocol or d.get('reviewer') != MODEL_ONLY_REVIEWER)
            repairs = []
            for n, attempt in enumerate(run.repairs):
                level = attempt.get('repair_level') or REPAIR_LEVELS[attempt['mode']]
                note_tool(level)
                repair_root = inside(job_dir, job_dir / attempt['folder']) if attempt.get('folder') else None
                inherited = job.request.request_key.startswith('adjustment-') and repair_root is not None and not repair_root.is_dir()
                proposed_entries = attempt.get('proposed_frames', [])
                proposed_unavailable = inherited and any(
                    not inside(job_dir, job_dir / (f['path'] if 'path' in f else f['file'])).is_file()
                    for f in proposed_entries
                )
                frames = [] if proposed_unavailable else [
                    copy_png(f, f'{folder}/repair-{n}/{j:03}.png') for j, f in enumerate(proposed_entries)
                ]
                usage, returned = drawing_record(attempt, repair_root, 'response.json')
                raw_entries = [] if inherited else attempt.get('raw_frames', [])
                raw_frames = [
                    copy_png(f, f'{folder}/repair-{n}/raw/{f["raw_index"]:03}.png', root=repair_root)
                    for f in (returned or {}).get('frames', [])
                ] if returned else [
                    copy_png(f, f'{folder}/repair-{n}/raw/{j:03}.png') for j, f in enumerate(raw_entries)
                ]
                repairs.append({**attempt, 'repair_level': level, 'images': frames, 'usage': usage, 'original_images': raw_frames,
                                **({'proposed_archive_unavailable': True} if proposed_unavailable else {}),
                                **({'original_archive_unavailable': True} if inherited and attempt.get('raw_frames') else {})})
                drawing_usage.append(usage)
            stage_usage = (response_usage(saved_stage) or run.usage)
            returned = None
            if run.submission_attempts:
                stage_usage, returned = drawing_record({'provider_job_id': run.provider_job_id, 'usage': stage_usage,
                                                        'error': run.error}, manifest.parent, 'submit.response.json')
                drawing_usage.append(stage_usage)
            if saved_stage:
                if run.frames_manifest_sha256 and digest(saved_stage) != run.frames_manifest_sha256:
                    raise ValueError('archive stage manifest hash mismatch')
                originals = [{'file': f['filename'], 'sha256': f['sha256'], 'raw_index': j}
                             for j, f in enumerate(saved_stage.get('frames', []))]
            else:
                originals = (returned or {}).get('frames', [])
            raw = [{**copy_png(f, f'{folder}/raw/{f["raw_index"]:03}.png', root=manifest.parent),
                    'raw_index': f['raw_index']} for f in originals]
            accepted_frames = [{**copy_png(f, f'{folder}/accepted/{j:03}.png'), 'raw_index': f.get('raw_index')}
                               for j, f in enumerate((run.accepted or {}).get('frames', []))]
            invalid_raw = set((returned or {}).get('invalid_frames') or [])
            valid_raw = [f for f in raw if f.get('raw_index') not in invalid_raw]
            drift_frames = accepted_frames or valid_raw
            ref_path = job_dir / 'input' / 'reference.png'
            rows.append({'candidate': c.candidate_index, 'stage': i, 'state': run.state,
                         'raw': raw,
                         **({'raw_count': returned['raw_count'], 'invalid_raw_indices': returned['invalid_frames']}
                            if returned else {}),
                         'provider_job_id': run.provider_job_id, 'usage': stage_usage, 'drawing_error': run.error,
                         'submitted_attempts': run.submission_attempts,
                         'frame_normalization': (run.accepted or {}).get('frame_normalization'),
                         'accepted': accepted_frames,
                         'drift_source': 'accepted' if accepted_frames else ('raw' if valid_raw else None),
                         'drift': sequence_drift_metrics([out / f['file'] for f in drift_frames], ref_path, job=job) if drift_frames else None,
                         'review_history': reports,
                         'review_ablation': [counterfactual_verdicts(r, frame_count=plan.plan.stages[i].frame_count) for r in reports],
                         'human_decisions': decisions, 'repairs': repairs, 'adjustment_history': run.adjustment_history})
    timings.extend(e.get('human_seconds') for e in job.events
                   if e.get('event') == 'candidate_approved' and e.get('reviewer') == 'open-motion-user')

    alternatives = []
    for path in sorted(adjustments.glob('*/task.json')):
        task = json.loads(path.read_bytes())
        if job.job_id not in (task['source_job'], task.get('target_job')):
            continue
        media = []
        for i, frame in enumerate(task.get('proposed_frames', [])):
            data = inside(path.parent, path.parent / frame['file']).read_bytes()
            if sha(data) != frame['sha256']:
                raise ValueError('adjustment frame hash mismatch')
            name = f'alternatives/{len(alternatives)}/{i:03}.png'
            (out / name).parent.mkdir(parents=True, exist_ok=True)
            (out / name).write_bytes(data)
            media.append({'file': name, 'sha256': frame['sha256']})
        attempts = task['generation_calls']
        alternative_usage = []
        returned = None
        for i, call in enumerate(attempts):
            if i == len(attempts) - 1:
                latest = {**call, 'provider_job_id': call.get('provider_job_id') or task.get('provider_job_id')}
                latest['usage'] = receipt_usage(call) or receipt_usage(task)
                known, returned = drawing_record(latest, path.parent, 'provider-response.json')
            else:
                known = receipt_usage(call)
            alternative_usage.append(known)
        raw = [copy_png(f, f'alternatives/{len(alternatives)}/raw/{f["raw_index"]:03}.png', root=path.parent)
               for f in (returned or {}).get('frames', task.get('raw_frames', []))]
        alternatives.append({**task, 'exported_frames': media, 'original_images': raw,
                             **({'usage': alternative_usage[-1]} if alternative_usage else {})})
        if task.get('repair_level'):
            note_tool(task['repair_level'])
        if task.get('state') in ('adopted', 'rejected') or task.get('decision_note') or task.get('human_seconds') is not None:
            timings.append(task.get('human_seconds'))
        drawing_usage.extend(alternative_usage)

    calls = {kind: sum(len(t[kind + '_calls']) for t in alternatives) for kind in ('planning', 'generation', 'review')}
    calls['planning'] += len(work.get('planning_calls', []))
    calls['generation'] += generation_calls(job)
    calls['review'] += review_call_count(job)
    visual_usage = [*review_usage, *(receipt_usage(x) for x in work.get('planning_calls', [])),
                    *(receipt_usage(x) for t in alternatives for k in ('planning_calls', 'review_calls') for x in t[k])]

    # Keep every native unit. A missing price is unknown, never zero dollars.
    draws = drawing_cost(drawing_usage)
    visual_prices = list(priced_amounts(visual_usage))
    known_total = draws['known_usd'] + sum(visual_prices)
    unpriced = sum(calls.values()) - draws['priced_calls'] - len(visual_prices)
    cost = {'calls': calls, 'drawing_usage': drawing_usage, 'visual_usage': visual_usage,
            'known_human_seconds': sum(t for t in timings if t is not None),
            'unmeasured_decisions': sum(t is None for t in timings),
            'human_seconds': sum(timings) if timings and None not in timings else None,
            'known_drawing_units': draws['known_units'], 'unpriced_calls': unpriced,
            'priced_drawing_calls': draws['priced_calls'],
            'known_drawing_usd': draws['known_usd'], 'known_total_usd': known_total,
            'total_usd': None if unpriced else known_total}
    result = {
        'job': job.job_id, 'kind': 'open_plan', 'revision': work['revision'], 'experiment': work.get('experiment'),
        'clips': _playback(job, job_dir, out), 'stages': rows, 'alternatives': alternatives,
        'tool_usage': tools, 'cost': cost,
        'escalation': _escalation_summary(job, rows, alternatives, current_protocol=current_protocol)}
    if current_protocol:
        frame_budget = _model_frame_budget(job, work['experiment'])
        if frame_budget:
            result['drawing_frame_budget'] = frame_budget
        interruption = _model_interruption(job, work['experiment'], frame_budget)
        if interruption:
            result['outcome'] = interruption
        elif result['clips']:
            result['outcome'] = {'kind': 'complete', 'reason': 'playable'}
        elif any(row['state'] == 'rejected' for row in rows):
            result['outcome'] = {'kind': 'review_stopped', 'reason': 'segment_rejected'}
        elif failed := next((row for row in rows if row['drawing_error']), None):
            error = failed['drawing_error']
            result['outcome'] = {
                'kind': 'provider_failure' if failed['submitted_attempts'] else 'local_preflight',
                'reason': (error.get('details') or {}).get('reason') or error['code'],
                'stage': failed['stage'],
            }
        elif any(row['submitted_attempts'] for row in rows):
            result['outcome'] = {'kind': 'no_playable_clip', 'reason': 'unfinished_or_unaccepted'}
        else:
            result['outcome'] = {'kind': 'not_submitted', 'reason': 'no_provider_submission'}
    atomic_write_json(out / 'retrospective.json', result)
    return cost


def blind_pack(clips, out, *, excluded=()):
    """Re-encode RGBA frames to drop metadata and paths.

    The answer key stays outside the package. ``excluded`` lists runs that
    produced no playable clip (stopped by review, interrupted); they are named
    in the key so usable-rate denominators include them.
    """
    if not clips and not excluded:
        raise ValueError('no clips')
    key = out.with_name(out.name + '-private-key.json')
    if key.exists():
        raise FileExistsError(key)
    seen_clips = set()
    order = []
    for entry in clips:
        root, frames, fps, *details = entry
        if not frames or not 1 <= fps <= 60:
            raise ValueError('clip requires frames and valid FPS')
        clip_key = (str(Path(root).resolve()), frames[0]['file'])
        if clip_key in seen_clips:
            raise ValueError(f'duplicate clip source: {root}')
        seen_clips.add(clip_key)
        order.append((root, frames, fps, details[0] if details else {}))
    out.mkdir(parents=True, exist_ok=False)
    secrets.SystemRandom().shuffle(order)
    answers, items = {}, []
    for root, frames, fps, meta in order:
        label = secrets.token_hex(8)
        answers[label] = {'source': str(root), 'first_frame': frames[0]['file'], **meta}
        (out / label).mkdir()
        size = None
        for i, frame in enumerate(frames):
            data = inside(root, root / frame['file']).read_bytes()
            if sha(data) != frame['sha256']:
                raise ValueError('clip frame hash mismatch')
            with Image.open(io.BytesIO(data)) as image:
                rgba = image.convert('RGBA')
                if size is None:
                    size = rgba.size
                elif rgba.size != size:
                    raise ValueError(f'clip frame size mismatch: expected {size}, got {rgba.size}')
                Image.frombytes('RGBA', rgba.size, rgba.tobytes()).save(out / label / f'{i:03}.png')
        items.append({'id': label, 'frames': len(frames), 'fps': fps, 'width': size[0], 'height': size[1],
                      'loop': bool(meta.get('loop', False))})
    atomic_write_json(out / 'clips.json', items)
    atomic_write_json(key, {'clips': answers, 'excluded': list(excluded), 'runs': len(order) + len(excluded)})
    (out / 'index.html').write_text(PLAYER.replace('__CLIPS__', json.dumps(items)), encoding='utf8')


PLAYER = '''<!doctype html><meta charset=utf-8><title>匿名动画评审</title><style>
body{font-family:system-ui,sans-serif;margin:16px;background:#181c24;color:#eef2f7}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap}
.grid{display:grid;gap:16px}
.card{border:1px solid #334155;border-radius:8px;padding:12px;background:#0f172a;max-width:100%;box-sizing:border-box}
.views{display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap;margin:10px 0}
.pane{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#94a3b8;max-width:100%}
.stage{display:inline-flex;align-items:center;justify-content:center;padding:8px;border:1px solid #334155;border-radius:4px;max-width:100%;overflow:auto;box-sizing:border-box}
.stage img{display:block;image-rendering:pixelated;image-rendering:crisp-edges}
body[data-bg=checker] .stage{background:repeating-conic-gradient(#cbd5e1 0 25%,#94a3b8 0 50%) 50%/16px 16px}
body[data-bg=light] .stage{background:#d4d8df}
body[data-bg=dark] .stage{background:#1e2430}
.ctrls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px}
button{padding:4px 10px;border-radius:4px;border:1px solid #475569;background:#1e293b;color:#f8fafc;cursor:pointer}
button[aria-pressed=true]{background:#334155;border-color:#94a3b8}
</style><body data-bg=checker><div class=bar><strong>匿名动画评审</strong><span>背景：</span>
<button data-set-bg=checker aria-pressed=true>棋盘格</button>
<button data-set-bg=light aria-pressed=false>浅灰</button>
<button data-set-bg=dark aria-pressed=false>深灰</button>
</div><main class=grid></main><script>
const clips=__CLIPS__;
const scaleFor=(w,h,avail)=>{
  const target=Math.max(2,Math.min(4,Math.floor(256/Math.max(w||128,h||128))*2||4));
  const fit=Math.max(1,Math.floor(Math.max(w||1,avail||512)/Math.max(1,w||1)));
  return Math.min(target,fit);
};
document.querySelectorAll('[data-set-bg]').forEach(btn=>{
  btn.onclick=()=>{
    document.body.dataset.bg=btn.dataset.setBg;
    document.querySelectorAll('[data-set-bg]').forEach(x=>x.setAttribute('aria-pressed',String(x===btn)));
  };
});
const resizers=[];
for(const c of clips){
  const p=document.createElement('section');p.className='card';
  const h=document.createElement('h2');h.textContent=c.id;
  const views=document.createElement('div');views.className='views';
  const mkPane=(title,w,hpx)=>{
    const d=document.createElement('div');d.className='pane';
    const cap=document.createElement('span');cap.textContent=title;
    const box=document.createElement('div');box.className='stage';
    const im=new Image();im.width=w;im.height=hpx;im.style.width=w+'px';im.style.height=hpx+'px';
    box.append(im);d.append(cap,box);views.append(d);return {im,cap};
  };
  const pane1=mkPane('1x 原尺寸 ('+c.width+'x'+c.height+')',c.width,c.height);
  const paneZ=mkPane('',c.width,c.height);
  const ctrls=document.createElement('div');ctrls.className='ctrls';
  const play=document.createElement('button');play.textContent='播放 / 暂停';
  const prev=document.createElement('button');prev.textContent='上一帧';
  const next=document.createElement('button');next.textContent='下一帧';
  let loopOn=Boolean(c.loop);
  const loopBtn=document.createElement('button');
  const syncLoop=()=>{loopBtn.setAttribute('aria-pressed',String(loopOn));loopBtn.textContent=loopOn?'循环：开':'循环：关（播完即停）';};
  syncLoop();
  const info=document.createElement('span');
  ctrls.append(play,prev,next,loopBtn,info);p.append(h,views,ctrls);document.querySelector('main').append(p);
  const applyZoom=()=>{
    const avail=(p.clientWidth||window.innerWidth||960)-48;
    const z=scaleFor(c.width,c.height,avail);
    const zw=c.width*z,zh=c.height*z;
    paneZ.im.width=zw;paneZ.im.height=zh;paneZ.im.style.width=zw+'px';paneZ.im.style.height=zh+'px';
    paneZ.cap.textContent=z+'x 最近邻放大 ('+zw+'x'+zh+')';
  };
  applyZoom();resizers.push(applyZoom);
  let i=0,t=0;
  function stop(){if(t){clearInterval(t);t=0;}}
  function render(idx){
    i=Math.max(0,Math.min(c.frames-1,idx));
    const src=c.id+'/'+String(i).padStart(3,'0')+'.png';
    pane1.im.src=src;paneZ.im.src=src;
    info.textContent='帧 '+(i+1)+' / '+c.frames+' · '+c.fps+' FPS';
  }
  render(0);
  const step=()=>{
    if(i+1<c.frames){render(i+1);}
    else if(loopOn){render(0);}
    else{stop();}
  };
  play.onclick=()=>{if(t){stop();}else{if(!loopOn&&i>=c.frames-1){render(0);}else{step();}if(loopOn||i<c.frames-1){t=setInterval(step,1000/c.fps);}}};
  prev.onclick=()=>{stop();render(loopOn?(i-1+c.frames)%c.frames:i-1);};
  next.onclick=()=>{stop();render(loopOn?(i+1)%c.frames:i+1);};
  loopBtn.onclick=()=>{loopOn=!loopOn;syncLoop();};
}
window.addEventListener('resize',()=>resizers.forEach(fn=>fn()));
</script></body>'''


def collect_clips(roots):
    """Clips and unusable runs from simulation or export directories."""
    clips, excluded, seen = [], [], set()
    for root in roots:
        resolved = Path(root).resolve()
        if resolved in seen:
            raise ValueError(f'duplicate run directory: {root}')
        seen.add(resolved)
        if (root / 'retrospective.json').exists():
            export = json.loads((root / 'retrospective.json').read_bytes())
            arm = (export.get('experiment') or {}).get('arm')
            outcome = export.get('outcome') or {}
            if not export['clips'] or (outcome and outcome['kind'] != 'complete'):
                exclusion = {'source': str(root), 'arm': arm, 'status': 'no_playable_clip'}
                if export.get('outcome'):
                    status = {'provider_failure': 'interrupted', 'protocol_violation': 'interrupted',
                              'review_stopped': 'stopped_by_review', 'local_preflight': 'blocked_preflight'}
                    exclusion.update(protocol=PROTOCOL, outcome=outcome, status=status.get(outcome['kind'], 'no_playable_clip'))
                excluded.append(exclusion)
                continue
            for clip in export['clips']:
                clips.append((root, clip['frames'], clip['fps'],
                              {'arm': arm, 'candidate': clip['candidate'], 'loop': bool(clip.get('loop', False))}))
            continue
        if (root / 'experiment-run.json').exists() and not (root / 'run.json').exists():
            summary = json.loads((root / 'experiment-run.json').read_bytes())
            if summary.get('job_id'):
                raise ValueError(f'export job via retrospective before collecting: {root}')
            if summary.get('status') == 'running':
                raise ValueError(f'run is still in progress: {root}')
            exclusion = {'source': str(root), 'arm': summary.get('arm'), 'status': summary.get('status', 'no_playable_clip')}
            if summary.get('protocol') == PROTOCOL and summary.get('outcome'):
                exclusion.update(protocol=PROTOCOL, outcome=summary['outcome'])
            excluded.append(exclusion)
            continue
        run = json.loads((root / 'run.json').read_bytes())
        if run['status'] == 'running':
            raise ValueError(f'run is still in progress: {root}')
        if run['status'] != 'complete':
            exclusion = {'source': str(root), 'arm': run['arm'], 'status': run['status']}
            if run.get('protocol') == PROTOCOL and run.get('outcome'):
                exclusion.update(protocol=PROTOCOL, outcome=run['outcome'])
            excluded.append(exclusion)
        else:
            stages = run.get('stages') or []
            details = {'arm': run['arm'], 'loop': bool(stages and stages[-1].get('last') == 'original')}
            if run.get('protocol') == PROTOCOL:
                details['protocol'] = PROTOCOL
            clips.append((root, run['frames'], run['fps'], details))
    return clips, excluded


# ------------------------------------------------------------------- CLI

def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description='Free simulations and local exports for paper experiments.')
    sub = parser.add_subparsers(dest='op', required=True)
    p = sub.add_parser('freeze', help='copy the frozen plan inputs of a work')
    p.add_argument('root', type=Path, help='SpritePipeline data root')
    p.add_argument('work_id')
    p.add_argument('output', type=Path)
    p.add_argument('--revision', type=int)
    p = sub.add_parser('simulate', help='run one control arm with the offline fixture provider')
    p.add_argument('arm', choices=ARMS)
    p.add_argument('protocol', type=Path, help='frozen protocol directory, or a hand-written protocol JSON')
    p.add_argument('output', type=Path)
    p.add_argument('--reference', type=Path, help='reference PNG for a hand-written protocol')
    p = sub.add_parser('clone', help='copy a planned work for a checkpointed arm')
    p.add_argument('root', type=Path)
    p.add_argument('work_id')
    p.add_argument('arm', choices=PIPELINE_ARMS)
    p.add_argument('request_key')
    p.add_argument('--revision', type=int)
    p.add_argument('--repair-policy', choices=REPAIR_POLICIES, default='toolset')
    p = sub.add_parser('model-only', help='decide a model_only copy from the reviewer verdict; spends real calls')
    p.add_argument('root', type=Path)
    p.add_argument('work_id')
    p.add_argument('--authorize-paid-calls', action='store_true',
                   help='required: this draws and reviews with the work\'s configured services')
    p.add_argument('--allow-unsupported-motion', action='store_true')
    p = sub.add_parser('inventory', help='list which stored jobs can be exported')
    p.add_argument('jobs_dir', type=Path)
    p = sub.add_parser('export')
    p.add_argument('job_dir', type=Path)
    p.add_argument('work_json', type=Path)
    p.add_argument('output', type=Path)
    p = sub.add_parser('export-legacy')
    p.add_argument('job_dir', type=Path)
    p.add_argument('output', type=Path)
    p = sub.add_parser('blind')
    p.add_argument('output', type=Path)
    p.add_argument('runs', type=Path, nargs='+')
    args = parser.parse_args(argv)

    if args.op in ('freeze', 'clone', 'model-only'):
        from ..service import SpritePipelineService
        service = SpritePipelineService(args.root)
        if args.op == 'freeze':
            freeze_protocol(service, args.work_id, args.revision, args.output)
        elif args.op == 'model-only':
            from ..providers import get_provider
            from .workspace import OpenMotionWorkspace
            provider = get_provider(OpenMotionWorkspace(service).load(args.work_id).spec.provider, service.settings)
            summary = drive_model_only(service, args.work_id, provider, authorized=args.authorize_paid_calls,
                                       allow_unsupported_motion=args.allow_unsupported_motion)
            print(json.dumps(summary, ensure_ascii=False, indent=2))
        else:
            print(clone_for_arm(service, args.work_id, args.revision, args.arm, args.request_key,
                                repair_policy=args.repair_policy).id)
    elif args.op == 'simulate':
        if args.protocol.is_dir():
            protocol, reference, last_frames = load_protocol(args.protocol)
            frozen = protocol
        else:
            if not args.reference:
                parser.error('a hand-written protocol needs --reference')
            protocol, reference, last_frames = json.loads(args.protocol.read_bytes()), args.reference.read_bytes(), None
            frozen = None
        verdicts = iter(protocol.get('mock_verdicts', []))
        run_arm(args.arm, reference, protocol['stages'], protocol['seed'], FixtureProvider(),
                lambda *_: next(verdicts, None), args.output, protocol['fps'], last_frames=last_frames, protocol=frozen)
    elif args.op == 'inventory':
        print(json.dumps(inventory(args.jobs_dir), ensure_ascii=False, indent=2))
    elif args.op == 'export':
        retrospective(args.job_dir, json.loads(args.work_json.read_bytes()), args.work_json.parent / 'adjustments', args.output)
    elif args.op == 'export-legacy':
        legacy_export(args.job_dir, args.output)
    else:
        clips, excluded = collect_clips(args.runs)
        blind_pack(clips, args.output, excluded=excluded)


if __name__ == '__main__':
    main()
