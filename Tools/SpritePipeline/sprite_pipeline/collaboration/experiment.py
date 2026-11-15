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
import hashlib
import io
import json
import secrets
import uuid
from pathlib import Path

from PIL import Image

from ..errors import ConflictError, ValidationHarnessError
from ..jsonio import atomic_write_json, inside
from ..models import JobRecord
from ..providers.base import PollStatus, ProviderRequest
from ..providers.fixture import FixtureProvider
from .checkpoints import review_call_count
from .execution import stage_seed
from .experiment_policy import REPAIR_POLICIES
from .repairs import REPAIR_LEVELS, generation_calls
from .visual_review import audit_verdict

# Control strategies replayed outside the checkpoint pipeline.
ARMS = ('single', 'blind', 'keyframe_first', 'model_only')
# Checkpointed strategies, run in the real pipeline on a copy of the work.
PIPELINE_ARMS = ('model_only', 'human_verified')
MODEL_ONLY_REVIEWER = 'experiment-model-only'


def sha(data):
    return hashlib.sha256(data).hexdigest()


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


def freeze_protocol(service, work_id, revision, out):
    """Write the frozen inputs of one work so every control arm shares them."""
    ws, work, seed, fps, prompts, targets = _frozen_plan(service, work_id, revision)
    reference = ws.reference(work)
    out.mkdir(parents=True, exist_ok=False)
    (out / 'reference.png').write_bytes(reference)
    stages = []
    for i, definition in enumerate(work.plan.stages):
        # Same end condition the pipeline submits: a bound target image, the
        # original reference when the plan returns to it, otherwise none.
        last = 'target' if i in targets else 'original' if definition.last_frame == 'original' else None
        stage = {'prompt': prompts[i], 'frames': definition.frame_count, 'last': last}
        if last == 'target':
            (out / f'target-{i}.png').write_bytes(targets[i])
            stage['last_sha256'] = sha(targets[i])
        stages.append(stage)
    protocol = {'protocol': 2, 'seed': seed, 'fps': fps, 'stages': stages, 'reference_sha256': sha(reference),
                'source': {'work_id': work.id, 'revision': work.revision, 'plan_sha256': work.plan_sha256,
                           'job_id': work.job_id}}
    atomic_write_json(out / 'protocol.json', protocol)
    return protocol


def load_protocol(folder):
    """Read a frozen protocol directory, verifying every image it names."""
    protocol = json.loads((folder / 'protocol.json').read_bytes())
    reference = (folder / 'reference.png').read_bytes()
    if protocol.get('protocol') != 2 or sha(reference) != protocol['reference_sha256']:
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


# ------------------------------------------------------- replayed controls

def run_arm(arm, source, stages, seed, provider, judge, output, fps=8, *, last_frames=None, origin=None):
    """Run one control strategy against ``provider``.

    ``stages`` and ``last_frames`` come from ``load_protocol`` in a real
    comparison, so prompts, frame counts and end conditions equal the
    pipeline's. Segment ``i`` always draws with ``stage_seed(seed, i)``.

    ``model_only`` here takes an injected ``judge(first, stage, frames)`` and
    redraws a refused segment once. It exists for offline dry runs; a real
    model-verified arm uses ``drive_model_only`` and the pipeline reviewer.
    """
    if arm not in ARMS or not 1 <= fps <= 60 or not 1 <= len(stages) <= 4:
        raise ValueError('invalid protocol')
    counts = [s['frames'] for s in stages]
    if any(type(n) is not int or n not in range(4, 17, 2) for n in counts) or (arm == 'single' and sum(counts) > 16):
        raise ValueError('requested arm exceeds drawing call limit')
    last_frames = list(last_frames or [None] * len(stages))
    if len(last_frames) != len(stages):
        raise ValueError('one end condition per stage is required')
    output.mkdir(parents=True, exist_ok=False)
    ledger = {'protocol': 2, 'arm': arm, 'source_sha256': sha(source), 'seed': seed, 'fps': fps, 'stages': stages,
              'origin': origin or {'kind': 'manual'}, 'calls': [], 'reviews': [], 'frames': [],
              'diagnostic_only': bool(provider.diagnostic_only), 'human_seconds': None, 'status': 'running'}

    def save():
        atomic_write_json(output / 'run.json', ledger)

    def draw(first, last, count, prompt, stage, kind):
        call = {'kind': kind, 'stage': stage, 'seed': stage_seed(seed, stage), 'first': sha(first),
                'last': sha(last) if last else None, 'count': count, 'state': 'submitting'}
        ledger['calls'].append(call)
        save()
        request = provider.submit(ProviderRequest(reference_image=first, last_frame=last, prompt=prompt,
                                                  frame_count=count, seed=call['seed']))
        call.update(state='submitted', id=request.provider_job_id)
        save()
        result = provider.wait(request.provider_job_id)
        if result.status != PollStatus.completed or len(result.images) != count:
            raise ValueError('unexpected provider result; no retry')
        saved = []
        for i, png in enumerate(result.images):
            name = f"calls/{len(ledger['calls']) - 1:02}/{i:03}.png"
            (output / name).parent.mkdir(parents=True, exist_ok=True)
            (output / name).write_bytes(png)
            saved.append({'file': name, 'sha256': sha(png)})
        call.update(state='complete', usage=result.usage, frames=saved)
        save()
        return result.images

    def publish(frames):
        for frame in frames:
            name = f"{len(ledger['frames']):03}.png"
            (output / name).write_bytes(frame)
            ledger['frames'].append({'file': name, 'sha256': sha(frame)})
        save()

    try:
        if arm == 'single':
            prompt = ' '.join(s['prompt'] for s in stages)
            publish(draw(source, last_frames[-1], sum(counts), prompt, 0, 'clip'))
        else:
            targets = list(last_frames)
            if arm == 'keyframe_first':
                # The provider only draws animations. Freeze the real last frame
                # of one separate pose call per segment before any transition.
                for i, stage in enumerate(stages):
                    if targets[i] is None:
                        targets[i] = draw(source, None, 4, 'Hold ending pose: ' + stage['prompt'], i, 'pose')[-1]
                        (output / f'pose-{i}.png').write_bytes(targets[i])
            first = source
            for i, stage in enumerate(stages):
                for attempt in range(2):
                    frames = draw(first, targets[i], stage['frames'], stage['prompt'], i, 'repair' if attempt else 'segment')
                    if arm != 'model_only':
                        break
                    finding = judge(first, stage, frames)
                    if finding not in ('pass', 'fail', 'uncertain'):
                        raise ValueError('review verdict missing')
                    ledger['reviews'].append({'stage': i, 'attempt': attempt, 'verdict': finding,
                                              'frame_hashes': [sha(f) for f in frames]})
                    save()
                    if finding == 'pass':
                        break
                else:
                    ledger['status'] = 'stopped_by_review'
                    save()
                    return ledger
                publish(frames)
                first = frames[-1]
        ledger['status'] = 'complete'
        save()
        return ledger
    except Exception:
        ledger['status'] = 'interrupted'
        save()
        raise


# ------------------------------------------------- checkpointed pipeline arms

def clone_for_arm(service, work_id, revision, arm, request_key, *, repair_policy='toolset'):
    """Copy a planned work so another arm runs the same frozen plan and seed.

    The copy is an ordinary work marked with ``experiment``. It has no job yet;
    starting it spends drawing calls like any other work.
    """
    from .contracts import OpenWork, digest
    from .workspace import now
    if arm not in PIPELINE_ARMS or repair_policy not in REPAIR_POLICIES:
        raise ValidationHarnessError('未知的实验组或修复策略')
    ws, source, seed, _fps, _prompts, targets = _frozen_plan(service, work_id, revision)
    if source.spec.candidate_count != 1:
        raise ValidationHarnessError('实验副本只支持单候选作品')
    marker = {'arm': arm, 'repair_policy': repair_policy, 'source_work': source.id,
              'source_revision': source.revision, 'plan_sha256': source.plan_sha256}
    fingerprint = digest(marker)
    receipt = ws.root / 'requests' / (sha(request_key.encode()) + '.json')
    with service.store.global_lock('open-work-creation'):
        if receipt.exists():
            previous = json.loads(receipt.read_bytes())
            if previous['fingerprint'] != fingerprint:
                raise ConflictError('同一请求标识已用于其他需求')
            return ws.load(previous['id'])
        data = source.model_dump(mode='json')
        data.update(id=uuid.uuid4().hex, revision=1, request_key=request_key, request_sha256=fingerprint,
                    job_id=None, status='ready', history=[], created_at=now(), updated_at=now(),
                    experiment=marker, message=f'实验副本（{arm}），与来源作品使用同一方案和种子')
        data['spec']['seed'] = seed
        work = OpenWork.model_validate(data)
        directory = ws.directory(work.id)
        directory.mkdir(parents=True)
        service._atomic_write_bytes(directory / 'reference-1.png', ws.reference(source))
        for target in source.end_targets:
            service._atomic_write_bytes(directory / target.filename, targets[target.stage])
        ws.save(work)
        atomic_write_json(receipt, {'id': work.id, 'fingerprint': fingerprint})
        return work


def repair_window(count):
    """Largest interior even window a segment redraw accepts, or None."""
    size = min(16, (count - 2) // 2 * 2)
    return (1, size) if size >= 4 else None


def drive_model_only(service, work_id, provider, *, authorized, allow_unsupported_motion=False, max_steps=40):
    """Decide a ``model_only`` copy from the pipeline reviewer alone.

    Fixed rule per segment: a ``pass`` verdict is accepted. Otherwise one
    interior redraw is requested with the reviewer's own findings as the
    instruction and the segment is reviewed again; a second non-pass, or a
    segment too short or too costly to redraw, rejects it and stops the run.
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
        work = ws.start(work.id, work.revision, work.plan_sha256, allow_unsupported_motion=allow_unsupported_motion)
    job_id, engine, checkpoints, repairs = work.job_id, PlanGeneration(service), Checkpoints(service), LocalRepairs(service)
    decisions, status = [], 'stalled'
    for _ in range(max_steps):
        job = engine.advance(job_id, provider, wait=True)
        candidate = job.candidates[0]
        runs = candidate.plan_execution.stages
        stage = next((i for i, r in enumerate(runs) if r.state == 'awaiting_review'), None)
        if stage is None:
            if candidate.frames:
                status = 'complete'
            elif any(r.state == 'rejected' for r in runs):
                status = 'stopped_by_review'
            elif candidate.status.value in ('failed', 'submission_unknown'):
                status = 'interrupted'
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
        verdict = (run.review or {}).get('verdict')
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
            try:
                repairs.create(job_id, 1, stage, token=view['token'], start=window[0], end=window[1], note=note,
                               mode='transition', request_key=f'model-only-s{stage}', authorized=True, provider=provider)
                decisions.append({'stage': stage, 'action': 'redraw', 'verdict': verdict, 'window': list(window)})
                continue
            except ValidationHarnessError as exc:
                refusal = str(exc)  # Budget or tool limits; never widen them here.
        checkpoints.decide(job_id, 1, stage, token=view['token'], decision='reject', reviewer=MODEL_ONLY_REVIEWER,
                           note='Fixed policy: reviewer did not pass; ' + refusal)
        decisions.append({'stage': stage, 'action': 'reject', 'verdict': verdict, 'reason': refusal})
    summary = {'work_id': work.id, 'job_id': job_id, 'arm': 'model_only', 'status': status, 'decisions': decisions}
    atomic_write_json(ws.directory(work.id) / 'experiment-run.json', summary)
    return summary


# --------------------------------------------------------------- exports

def counterfactual_verdicts(report):
    """Verdicts the same recorded opinions give with parts of the review removed.

    ``baseline_only`` drops the independent experts. ``final_review_wins``
    drops the retained-contradiction rule: where the dispute review proposed
    clearing an earlier concern, its proposal is taken as is. Computed from the
    stored report; no model is called.
    """
    expert = (report or {}).get('expert_review') or {}
    if not report or report.get('verdict') is None:
        return None
    result = {'full': report['verdict'], 'baseline_only': (expert.get('baseline') or {}).get('verdict'),
              'final_review_wins': None, 'retained_contradictions': len(expert.get('requires_human_adjudication') or [])}
    if report.get('checks') and expert.get('state') == 'complete':
        proposals = {item['dimension']: item['proposal'] for item in expert.get('requires_human_adjudication') or []}
        result['final_review_wins'] = audit_verdict([proposals.get(c['dimension'], c) for c in report['checks']])
    return result


def _playback(job, job_dir, out):
    def copy(frame, name):
        data = inside(job_dir, job_dir / frame.active_path).read_bytes()
        if sha(data) != frame.sha256:
            raise ValueError('archive frame hash mismatch')
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        (out / name).write_bytes(data)
        return {'file': name, 'sha256': frame.sha256}
    return [{'candidate': c.candidate_index, 'fps': job.action.fps, 'status': c.status.value,
             'frames': [copy(f, f'candidate-{c.candidate_index}/playback/{n:03}.png') for n, f in enumerate(c.frames)]}
            for c in job.candidates if c.frames]


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


def retrospective(job_dir, work, adjustments, out):
    """Export one open-plan job for labelling. Paths are supplied by the operator;
    every copied PNG is verified against its recorded hash."""
    job = JobRecord.model_validate_json((job_dir / 'job.json').read_bytes())
    plan = job.request.open_plan
    if not plan:
        raise ValueError('job has no open plan (made by the earlier attack flow); use the legacy export')
    if work.get('job_id') != job.job_id or work['id'] != plan.work_id or work['revision'] != plan.revision:
        raise ValueError('work, job and revision do not match')
    out.mkdir(parents=True, exist_ok=False)

    def copy_png(item, name):
        data = inside(job_dir, job_dir / item['path']).read_bytes()
        if sha(data) != item['sha256']:
            raise ValueError('archive frame hash mismatch')
        (out / name).parent.mkdir(parents=True, exist_ok=True)
        (out / name).write_bytes(data)
        return {'file': name, 'sha256': item['sha256']}

    def receipt_usage(call):
        return call.get('usage') or (call.get('receipt') or {}).get('usage') or {}

    rows, timings, drawing_usage, review_usage, tools = [], [], [], [], {}

    def note_review(report):
        review_usage.extend(receipt_usage(q) for q in (report or {}).get('requests', []))

    def note_tool(level):
        tools[level] = tools.get(level, 0) + 1

    for c in job.candidates:
        note_review(c.plan_execution.quality_review)
        for i, run in enumerate(c.plan_execution.stages):
            folder = f'candidate-{c.candidate_index}/stage-{i}'
            raw = []
            manifest = job_dir / 'provider' / f'candidate_{c.candidate_index:02}.plan' / str(i) / 'frames.json'
            if manifest.exists():
                raw = [{'path': (manifest.parent / f['filename']).relative_to(job_dir).as_posix(), 'sha256': f['sha256']}
                       for f in json.loads(manifest.read_bytes())['frames']]
            reports = [*run.review_history, run.review or {}]
            for report in reports:
                note_review(report)
            decisions = [r['human_decision'] for r in reports if r.get('human_decision')]
            if run.state_checkpoint:
                decisions.append({'decision': 'accept_state', **run.state_checkpoint})
            timings.extend(d.get('human_seconds') for d in decisions)
            repairs = []
            for n, attempt in enumerate(run.repairs):
                level = attempt.get('repair_level') or REPAIR_LEVELS[attempt['mode']]
                note_tool(level)
                frames = [copy_png(f, f'{folder}/repair-{n}/{j:03}.png') for j, f in enumerate(attempt.get('proposed_frames', []))]
                repairs.append({**attempt, 'repair_level': level, 'images': frames})
                drawing_usage.append(attempt.get('usage', {}))
            if run.submission_attempts:
                drawing_usage.append(run.usage)
            rows.append({'candidate': c.candidate_index, 'stage': i, 'state': run.state,
                         'raw': [copy_png(f, f'{folder}/raw/{j:03}.png') for j, f in enumerate(raw)],
                         'accepted': [copy_png(f, f'{folder}/accepted/{j:03}.png')
                                      for j, f in enumerate((run.accepted or {}).get('frames', []))],
                         'review_history': reports, 'review_ablation': [counterfactual_verdicts(r) for r in reports],
                         'human_decisions': decisions, 'repairs': repairs, 'adjustment_history': run.adjustment_history})
    timings.extend(e.get('human_seconds') for e in job.events
                   if e.get('event') == 'candidate_approved' and e.get('reviewer') == 'open-motion-user')

    alternatives = []
    for path in sorted(adjustments.glob('*/task.json')):
        task = json.loads(path.read_bytes())
        if task['source_job'] != job.job_id:
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
        alternatives.append({**task, 'exported_frames': media})
        if task.get('repair_level'):
            note_tool(task['repair_level'])
        if task.get('decision_note'):
            timings.append(task.get('human_seconds'))
        drawing_usage.extend([task.get('usage', {})] * len(task['generation_calls']))

    calls = {kind: sum(len(t[kind + '_calls']) for t in alternatives) for kind in ('planning', 'generation', 'review')}
    calls['planning'] += len(work.get('planning_calls', []))
    calls['generation'] += generation_calls(job)
    calls['review'] += review_call_count(job)
    visual_usage = [*review_usage, *(receipt_usage(x) for x in work.get('planning_calls', [])),
                    *(receipt_usage(x) for t in alternatives for k in ('planning_calls', 'review_calls') for x in t[k])]

    def priced(usages):
        return [u['cost_usd'] for u in usages if isinstance(u.get('cost_usd'), (int, float))]

    def units(usages):
        return sum(u['units'] for u in usages if isinstance(u.get('units'), (int, float)))

    # Keep every native unit. A missing price is unknown, never zero dollars.
    unpriced = max(0, sum(calls.values()) - len(priced(drawing_usage)) - len(priced(visual_usage)))
    cost = {'calls': calls, 'drawing_usage': drawing_usage, 'visual_usage': visual_usage,
            'known_human_seconds': sum(t for t in timings if t is not None),
            'unmeasured_decisions': sum(t is None for t in timings),
            'human_seconds': sum(timings) if timings and None not in timings else None,
            'known_drawing_units': units(drawing_usage), 'unpriced_calls': unpriced,
            'known_drawing_usd': sum(priced(drawing_usage)),
            'known_total_usd': sum(priced(drawing_usage)) + sum(priced(visual_usage)),
            'total_usd': None if unpriced else sum(priced(drawing_usage)) + sum(priced(visual_usage))}
    atomic_write_json(out / 'retrospective.json', {
        'job': job.job_id, 'kind': 'open_plan', 'revision': work['revision'], 'experiment': work.get('experiment'),
        'clips': _playback(job, job_dir, out), 'stages': rows, 'alternatives': alternatives,
        'tool_usage': tools, 'cost': cost})
    return cost


def blind_pack(clips, out, *, excluded=()):
    """Re-encode RGBA frames to drop metadata and paths.

    The answer key stays outside the package. ``excluded`` lists runs that
    produced no playable clip (stopped by review, interrupted); they are named
    in the key so usable-rate denominators include them.
    """
    if not clips:
        raise ValueError('no clips')
    key = out.with_name(out.name + '-private-key.json')
    if key.exists():
        raise FileExistsError(key)
    out.mkdir(parents=True, exist_ok=False)
    order = list(clips)
    secrets.SystemRandom().shuffle(order)
    answers, items = {}, []
    for root, frames, fps, *details in order:
        if not frames or not 1 <= fps <= 60:
            raise ValueError('clip requires frames and valid FPS')
        label = secrets.token_hex(8)
        answers[label] = {'source': str(root), 'first_frame': frames[0]['file'], **(details[0] if details else {})}
        (out / label).mkdir()
        for i, frame in enumerate(frames):
            data = inside(root, root / frame['file']).read_bytes()
            if sha(data) != frame['sha256']:
                raise ValueError('clip frame hash mismatch')
            with Image.open(io.BytesIO(data)) as image:
                rgba = image.convert('RGBA')
                Image.frombytes('RGBA', rgba.size, rgba.tobytes()).save(out / label / f'{i:03}.png')
        items.append({'id': label, 'frames': len(frames), 'fps': fps})
    atomic_write_json(out / 'clips.json', items)
    atomic_write_json(key, {'clips': answers, 'excluded': list(excluded), 'runs': len(order) + len(excluded)})
    (out / 'index.html').write_text(PLAYER.replace('__CLIPS__', json.dumps(items)), encoding='utf8')


PLAYER = '''<!doctype html><meta charset=utf-8><title>匿名动画评审</title><main></main><script>
const clips=__CLIPS__;
for(const c of clips){
  const p=document.createElement('section'),h=document.createElement('h2'),im=new Image(),b=document.createElement('button');
  h.textContent=c.id;b.textContent='播放 / 暂停';p.append(h,im,b);document.querySelector('main').append(p);
  let i=0,t;
  function draw(){im.src=c.id+'/'+String(i).padStart(3,'0')+'.png';i=(i+1)%c.frames}
  draw();
  b.onclick=()=>{if(t){clearInterval(t);t=0}else{draw();t=setInterval(draw,1000/c.fps)}};
}
</script>'''


def collect_clips(roots):
    """Clips and unusable runs from simulation or export directories."""
    clips, excluded = [], []
    for root in roots:
        if (root / 'retrospective.json').exists():
            export = json.loads((root / 'retrospective.json').read_bytes())
            arm = (export.get('experiment') or {}).get('arm')
            if not export['clips']:
                excluded.append({'source': str(root), 'arm': arm, 'status': 'no_playable_clip'})
            for clip in export['clips']:
                clips.append((root, clip['frames'], clip['fps'], {'arm': arm, 'candidate': clip['candidate']}))
            continue
        run = json.loads((root / 'run.json').read_bytes())
        if run['status'] == 'running':
            raise ValueError(f'run is still in progress: {root}')
        if run['status'] != 'complete':
            excluded.append({'source': str(root), 'arm': run['arm'], 'status': run['status']})
        else:
            clips.append((root, run['frames'], run['fps'], {'arm': run['arm']}))
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
            origin = {'kind': 'frozen_plan', **protocol['source']}
        else:
            if not args.reference:
                parser.error('a hand-written protocol needs --reference')
            protocol, reference, last_frames = json.loads(args.protocol.read_bytes()), args.reference.read_bytes(), None
            origin = {'kind': 'manual'}
        verdicts = iter(protocol.get('mock_verdicts', []))
        run_arm(args.arm, reference, protocol['stages'], protocol['seed'], FixtureProvider(),
                lambda *_: next(verdicts, None), args.output, protocol['fps'], last_frames=last_frames, origin=origin)
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
