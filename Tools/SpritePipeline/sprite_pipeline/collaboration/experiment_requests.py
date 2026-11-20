"""Freeze the provider-facing portions of every paper experiment arm."""
import hashlib

from ..errors import ConflictError, ValidationHarnessError
from ..providers.pixellab import PIXELLAB_ACTION_MAX_CHARACTERS, PIXELLAB_TOTAL_PIXEL_BUDGET
from .contracts import digest
from .drawing_frames import FRAME_NORMALIZATION
from .execution import stage_seed


PROTOCOL = 3


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify_protocol(protocol):
    version = protocol.get('protocol')
    if version == 2:
        return
    contents = {k: v for k, v in protocol.items() if k != 'protocol_sha256'}
    if (version != PROTOCOL or protocol.get('protocol_sha256') != digest(contents) or
            contents['drawing']['frame_normalization'] != FRAME_NORMALIZATION):
        raise ValueError('frozen protocol or its drawing requests changed')


def pipeline_prompts(work):
    """Validate the frozen baseline of a checkpointed copy before authorizing drawing."""
    experiment = work.experiment or {}
    if experiment.get('protocol') != PROTOCOL:
        return None
    frozen = experiment['frozen_drawing']
    requests = frozen['requests']
    targets = {target.stage: target.sha256 for target in work.end_targets}
    last_hashes = [targets.get(i, work.reference_sha256 if stage.last_frame == 'original' else None)
                   for i, stage in enumerate(work.plan.stages)]
    fps = work.plan.quality.playback_fps if work.plan.quality else work.spec.fps
    if (work.revision != 1 or work.plan_sha256 != experiment['plan_sha256']
            or digest(frozen) != experiment['frozen_drawing_sha256']
            or frozen['frame_normalization'] != FRAME_NORMALIZATION
            or requests[0]['first']['sha256'] != work.reference_sha256
            or work.spec.seed != frozen['seed'] or fps != frozen['fps']
            or [stage.frame_count for stage in work.plan.stages] != [call['count'] for call in requests]
            or last_hashes != [(call['last'] or {}).get('sha256') for call in requests]):
        raise ConflictError('实验副本的方案、原图或目标已脱离冻结协议，请重新建立副本')
    if frozen['preflight']:
        raise ValidationHarnessError('实验组的绘图请求超过冻结上限，尚未提交',
                                     details={'reason': 'local_preflight', 'problems': frozen['preflight']})
    return [call['prompt'] for call in requests]


def freeze_drawing(stages, seed, reference_sha256, size, last_sha256, *, budget=None):
    """Record static payloads and how dynamic inputs will be selected."""
    def request(kind, stage, count, prompt, first, last):
        return {'kind': kind, 'stage': stage, 'count': count, 'prompt': prompt.strip(),
                'seed': stage_seed(seed, stage), 'first': first, 'last': last,
                'transparent_background': True}

    reference = {'kind': 'reference', 'sha256': reference_sha256}
    targets = [{'kind': 'frozen', 'stage': i, 'sha256': value} if value else None
               for i, value in enumerate(last_sha256)]

    def segments(end_conditions, input_kind):
        return [request('segment', i, stage['frames'], stage['prompt'],
                        {'kind': input_kind, 'stage': i - 1} if i else reference, end_conditions[i])
                for i, stage in enumerate(stages)]

    poses = [request('pose', i, 4, 'Hold ending pose: ' + stage['prompt'], reference, None)
             for i, stage in enumerate(stages) if targets[i] is None]
    pose_targets = [target or {'kind': 'pose_endpoint', 'stage': i} for i, target in enumerate(targets)]
    blind = segments(targets, 'playback_endpoint')
    diagnostic = [call for initial in blind
                  for call in [initial, {**initial, 'kind': 'repair', 'conditional': 'review_non_pass'}]]
    checked = segments(targets, 'accepted_endpoint')
    schedules = {
        'single': [request('clip', 0, sum(s['frames'] for s in stages),
                           ' '.join(s['prompt'] for s in stages), reference, targets[-1])],
        'blind': blind,
        'keyframe_first': [*poses, *segments(pose_targets, 'playback_endpoint')],
        'model_only': checked,
        'human_verified': checked,
        'model_only_diagnostic': diagnostic,
    }
    budget = budget or {}
    per_request = budget.get('max_frames_per_request')
    limits = {
        'max_prompt_characters': PIXELLAB_ACTION_MAX_CHARACTERS,
        'max_pixels_per_request': PIXELLAB_TOTAL_PIXEL_BUDGET,
        'max_frames_per_request': per_request if per_request is not None else 16,
        'max_total_frames': budget.get('max_total_frames'),
        'max_generation_calls': budget.get('max_generation_calls'),
        'max_review_calls': budget.get('max_review_calls'),
        'max_generation_units': budget.get('remaining_units'),
    }
    arms = {}
    for arm, requests in schedules.items():
        required = [call for call in requests if not call.get('conditional')]
        arms[arm] = {
            'requests': requests,
            'minimum_draws': len(required),
            'minimum_frames': sum(call['count'] for call in required),
            'preflight': preflight(required, limits, size),
        }
    return {'frame_normalization': FRAME_NORMALIZATION, 'reference_size': list(size),
            'limits': limits, 'arms': arms, 'availability_denominator': 'all_registered_runs',
            'usage_accounting': 'native_units_per_provider_call'}


def preflight(requests, limits, size):
    """All mandatory draws must fit before an arm can submit its first call."""
    problems = []
    for call in requests:
        count = call['count']
        scope = {key: call[key] for key in ('kind', 'stage')}
        if not call['prompt'] or len(call['prompt']) > limits['max_prompt_characters']:
            problems.append({**scope, 'reason': 'prompt_length', 'observed': len(call['prompt']),
                             'maximum': limits['max_prompt_characters']})
        if count not in range(4, 17, 2) or count > limits['max_frames_per_request']:
            problems.append({**scope, 'reason': 'per_request_frame_limit', 'observed': count,
                             'maximum': limits['max_frames_per_request']})
        pixels = size[0] * size[1] * count
        if pixels > limits['max_pixels_per_request']:
            problems.append({**scope, 'reason': 'per_request_pixel_limit', 'observed': pixels,
                             'maximum': limits['max_pixels_per_request']})
    for key, observed in [('max_generation_calls', len(requests)),
                          ('max_total_frames', sum(call['count'] for call in requests))]:
        maximum = limits[key]
        if maximum is not None and observed > maximum:
            problems.append({'reason': key, 'maximum': maximum, 'observed': observed})
    maximum = limits.get('max_generation_units')
    if maximum is not None and size[0] > 0 and size[1] > 0:
        from ..service import SpritePipelineService
        units = sum(SpritePipelineService._pixellab_generation_units(*size, call['count']) for call in requests)
        if units > maximum:
            problems.append({'reason': 'max_generation_units', 'maximum': maximum, 'observed': units})
    return problems


def check_model_redraw_budget(experiment, job, stage, request):
    """Reserve all baseline draws and account for every extra submitted redraw."""
    if experiment.get('arm') != 'model_only' or experiment.get('protocol') != PROTOCOL:
        return
    frozen = experiment['frozen_drawing']
    if digest(frozen) != experiment['frozen_drawing_sha256']:
        raise ConflictError('实验副本的冻结绘图协议已改变')
    previous = [{'kind': 'repair', 'stage': i, 'count': attempt['input_count'], 'prompt': attempt['note']}
                for candidate in job.candidates for i, run in enumerate(candidate.plan_execution.stages)
                for attempt in run.repairs]
    proposed = {'kind': 'repair', 'stage': stage, 'count': request.frame_count, 'prompt': request.prompt}
    issues = preflight([*frozen['requests'], *previous, proposed], frozen['limits'],
                       (job.character.cell_width, job.character.cell_height))
    if issues:
        raise ValidationHarnessError('重画超过冻结绘图上限：' + issues[0]['reason'],
                                     details={'reason': issues[0]['reason'], 'problems': issues})
