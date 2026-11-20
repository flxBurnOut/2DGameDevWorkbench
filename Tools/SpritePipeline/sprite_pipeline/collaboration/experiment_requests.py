"""Freeze the provider-facing portions of every paper experiment arm."""
import hashlib
import re

from ..errors import ConflictError, ValidationHarnessError
from ..providers.pixellab import PIXELLAB_ACTION_MAX_CHARACTERS, PIXELLAB_TOTAL_PIXEL_BUDGET
from .contracts import digest
from .drawing_frames import FRAME_NORMALIZATION
from .executable_brief import PATTERN as BRIEF_PATTERN, SECTIONS as BRIEF_SECTIONS
from .execution import stage_seed


PROTOCOL = 3
_POSE_FRAME = re.compile(r'(^|;\s*)f(\d+):')
_BRIEF_ORDER = ('appearance', 'action', 'camera', 'facing', 'drive', 'support',
                'path', 'timing', 'poses', 'relations', 'end', 'boundary')
_FINAL_LABELS = {'end', 'boundary'}


def _parse_structured_brief(text):
    matches = list(BRIEF_PATTERN.finditer(text))
    names = [m.group(1).lower() for m in matches]
    if set(names) != set(BRIEF_SECTIONS) or len(names) != len(BRIEF_SECTIONS) or text[:matches[0].start()].strip():
        return None
    parsed = {}
    for i, match in enumerate(matches):
        key = match.group(1).lower()
        stop = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        value = match.group(0) and text[match.end():stop].strip()
        if not value:
            return None
        parsed[key] = value
    return parsed


def _dedup_join(values):
    seen, ordered = set(), []
    for item in values:
        norm = item.strip()
        if norm and norm.lower() not in seen:
            seen.add(norm.lower())
            ordered.append(norm)
    return '; '.join(ordered)


def _single_arm_prompt(stages):
    """Build the single-shot prompt without duplicating 12-line structured headers.

    Plain prompts and short briefs keep verbatim space-joined text for backward
    compatibility; only structured 12-line briefs that exceed the provider cap
    when naively joined are deterministically deduplicated across shared lines.
    Never truncates; over-cap prompts still fail local preflight transparently.
    """
    joined = ' '.join(stage['prompt'].strip() for stage in stages).strip()
    if len(stages) <= 1 or len(joined) <= PIXELLAB_ACTION_MAX_CHARACTERS:
        return joined
    parsed = [_parse_structured_brief(stage['prompt']) for stage in stages]
    if not all(parsed):
        return joined
    merged = {}
    offset = 0
    pose_parts = []
    for stage, fields in zip(stages, parsed):
        shifted = _POSE_FRAME.sub(lambda m, base=offset: f'{m.group(1)}f{int(m.group(2)) + base}:', fields['poses'])
        pose_parts.append(shifted)
        offset += stage['frames']
    for key in _BRIEF_ORDER:
        if key in _FINAL_LABELS:
            merged[key] = parsed[-1][key]
        elif key == 'poses':
            merged[key] = _dedup_join(pose_parts)
        else:
            merged[key] = _dedup_join([fields[key] for fields in parsed])
    candidate = '\n'.join(f'{BRIEF_SECTIONS[key][0]}: {merged[key]}' for key in _BRIEF_ORDER)
    return candidate if len(candidate) < len(joined) else joined


def _pose_arm_prompt(prompt):
    """Build the 4-frame endpoint proposal prompt for keyframe_first.

    Short prompts keep the verbatim ``Hold ending pose: `` prefix. When adding
    the prefix pushes a structured 12-line brief past the provider cap, extract
    its endpoint-defining lines deterministically without silent truncation.
    """
    cleaned = prompt.strip()
    raw = 'Hold ending pose: ' + cleaned
    if len(raw) <= PIXELLAB_ACTION_MAX_CHARACTERS:
        return raw
    fields = _parse_structured_brief(cleaned)
    if not fields:
        return raw
    lines = [
        f"Appearance: {fields['appearance']}",
        'Action: Hold ending pose',
        f"Camera: {fields['camera']}",
        f"Facing: {fields['facing']}",
        f"Relations: {fields['relations']}",
        f"End: {fields['end']}",
    ]
    compact = '\n'.join(lines)
    return compact if len(compact) < len(raw) else raw


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


def freeze_drawing(stages, seed, reference_sha256, size, last_sha256, *, budget=None, legacy_prompts=False):
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

    pose_prompt = (lambda p: 'Hold ending pose: ' + p) if legacy_prompts else _pose_arm_prompt
    single_prompt = (lambda st: ' '.join(s['prompt'] for s in st)) if legacy_prompts else _single_arm_prompt
    poses = [request('pose', i, 4, pose_prompt(stage['prompt']), reference, None)
             for i, stage in enumerate(stages) if targets[i] is None]
    pose_targets = [target or {'kind': 'pose_endpoint', 'stage': i} for i, target in enumerate(targets)]
    blind = segments(targets, 'playback_endpoint')
    diagnostic = [call for initial in blind
                  for call in [initial, {**initial, 'kind': 'repair', 'conditional': 'review_non_pass'}]]
    checked = segments(targets, 'accepted_endpoint')
    schedules = {
        'single': [request('clip', 0, sum(s['frames'] for s in stages),
                           single_prompt(stages), reference, targets[-1])],
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
