"""Run the paper control arms using pre-registered requests and private receipts."""
from ..errors import HarnessError, ProviderConfigurationError, ProviderError, ValidationHarnessError
from ..jsonio import atomic_write_json
from ..providers.account import AccountSlotBusy
from ..providers.base import (ImagePayloadError, PollStatus, ProviderRequest,
                              normalize_image_bytes, redact_provider_payload)
from .drawing_frames import FRAME_NORMALIZATION, playback_indices, validate_drawing_frame
from .experiment_requests import PROTOCOL, freeze_drawing, preflight, sha, verify_protocol


ARMS = ('single', 'blind', 'keyframe_first', 'model_only')


def run_arm(arm, source, stages, seed, provider, judge, output, fps=8, *,
            last_frames=None, origin=None, protocol=None):
    """Replay a frozen comparison (or, without a protocol, run a manual diagnostic)."""
    if arm not in ARMS or not 1 <= fps <= 60 or not 1 <= len(stages) <= 4:
        raise ValueError('invalid protocol')
    if any(type(stage['frames']) is not int or stage['frames'] not in range(4, 17, 2) for stage in stages):
        raise ValueError('invalid stage frame count')
    last_frames = [None] * len(stages) if last_frames is None else list(last_frames)
    if len(last_frames) != len(stages):
        raise ValueError('one end condition per stage is required')
    replay = Replay(arm, source, stages, seed, provider, output, fps, last_frames, origin, protocol)
    return replay.run(judge)


class Replay:
    def __init__(self, arm, source, stages, seed, provider, output, fps, last_frames, origin, protocol):
        self.arm, self.source, self.provider, self.output = arm, source, provider, output
        self.last_frames = last_frames
        self.version = protocol['protocol'] if protocol is not None else PROTOCOL
        self.ledger = {'protocol': self.version, 'arm': arm, 'source_sha256': sha(source), 'seed': seed,
                       'fps': fps, 'stages': stages, 'origin': origin or {'kind': 'manual'}, 'calls': [],
                       'reviews': [], 'frames': [], 'diagnostic_only': bool(provider.diagnostic_only or arm == 'model_only'),
                       'human_seconds': None, 'status': 'running'}
        last_hashes = [sha(frame) if frame is not None else None for frame in last_frames]
        if protocol is not None:
            verify_protocol(protocol)
            expected = [protocol['reference_sha256'] if s.get('last') == 'original' else s.get('last_sha256')
                        for s in protocol['stages']]
            if ((seed, fps, stages, sha(source), last_hashes) !=
                    (protocol['seed'], protocol['fps'], protocol['stages'], protocol['reference_sha256'], expected)):
                raise ValueError('replay inputs differ from the frozen protocol')
            self.ledger['origin'] = {'kind': 'frozen_plan', **protocol['source']}
            if self.version == PROTOCOL:
                self.ledger['protocol_sha256'] = protocol['protocol_sha256']
        if self.version == 2 and arm == 'single' and sum(stage['frames'] for stage in stages) > 16:
            raise ValueError('requested arm exceeds drawing call limit')

        self.input_problems = []
        try:
            image = normalize_image_bytes(source)
            self.size = (image.width, image.height)
        except ImagePayloadError:
            self.size = (0, 0)
            self.input_problems.append({'reason': 'invalid_reference'})
        for i, frame in enumerate(last_frames):
            if frame is None:
                continue
            try:
                image = normalize_image_bytes(frame)
                if (image.width, image.height) == self.size:
                    continue
            except ImagePayloadError:
                pass
            self.input_problems.append({'reason': 'invalid_last_frame', 'stage': i})
        drawing = (protocol['drawing'] if protocol and self.version == PROTOCOL else
                   freeze_drawing(stages, seed, sha(source), self.size, last_hashes))
        if drawing['reference_size'] != list(self.size):
            self.input_problems.append({'reason': 'reference_size_mismatch'})
        key = 'model_only_diagnostic' if arm == 'model_only' else arm
        self.schedule = drawing['arms'][key]
        self.limits = drawing['limits']
        if self.version == PROTOCOL:
            self.ledger.update(frame_normalization=FRAME_NORMALIZATION, limits=self.limits,
                               requests=self.schedule['requests'], preflight=[*self.input_problems, *self.schedule['preflight']],
                               availability_denominator=drawing['availability_denominator'],
                               usage_accounting=drawing['usage_accounting'])

    def save(self):
        atomic_write_json(self.output / 'run.json', self.ledger)

    def stop(self, status, kind, reason, **details):
        self.ledger.update(status=status, outcome={'kind': kind, 'reason': reason, **details})
        self.save()
        return self.ledger

    def draw(self, spec, first, last):
        call = {**spec, 'first': sha(first), 'last': sha(last) if last else None,
                'state': 'not_submitted'}
        calls = self.ledger['calls']
        directory = self.output / f'calls/{len(calls):02}'
        calls.append(call)
        if self.version == PROTOCOL and spec.get('conditional'):
            required = [item for item in self.schedule['requests'] if not item.get('conditional')]
            optional = [item for item in calls if item.get('conditional')]
            issues = preflight([*required, *optional], self.limits, self.size)
            if issues:
                call['preflight'] = issues
                self.stop('blocked_preflight', 'local_preflight', issues[0]['reason'], stage=spec['stage'])
                return None
        self.save()
        request = ProviderRequest(reference_image=first, last_frame=last, prompt=spec['prompt'],
                                  frame_count=spec['count'], seed=spec['seed'],
                                  transparent_background=spec['transparent_background'])
        call['state'] = 'submitting'
        self.save()
        try:
            accepted = self.provider.submit(request)
        except Exception as exc:
            details = exc.details if isinstance(exc, ProviderError) else {}
            upstream_id = details.get('provider_job_id')
            # A provider configuration or account gate proves that no POST was sent.
            if isinstance(exc, (ProviderConfigurationError, AccountSlotBusy)):
                outcome, reason = 'not_submitted', exc.code
            elif details.get('submission_rejected'):
                outcome, reason = 'provider_failure', 'submission_rejected'
            else:
                outcome, reason = 'provider_failure', 'submission_unknown'
            call.update(state=reason, id=upstream_id, error=error_record(exc))
            if upstream_id:
                call['usage'] = redact_provider_payload((details.get('response') or {}).get('usage') or {})
            self.stop('interrupted', outcome, reason, stage=spec['stage'])
            raise
        call.update(state='submitted', id=accepted.provider_job_id, started=True,
                    diagnostic_only=accepted.diagnostic_only,
                    submission_receipt=redact_provider_payload(accepted.raw_response),
                    provider_request=redact_provider_payload(accepted.request_record),
                    usage=redact_provider_payload(accepted.raw_response.get('usage') or {}))
        self.ledger['diagnostic_only'] |= accepted.diagnostic_only
        self.save()
        try:
            result = self.provider.wait(accepted.provider_job_id)
        except Exception as exc:
            call.update(state='provider_outcome_unknown', error=error_record(exc))
            self.stop('interrupted', 'provider_failure', 'poll_interrupted', stage=spec['stage'])
            raise
        call.update(provider_status=result.provider_status, poll_receipt=redact_provider_payload(result.raw_response),
                    usage=redact_provider_payload(result.usage) or call['usage'])
        self.ledger['diagnostic_only'] |= result.diagnostic_only
        if result.status != PollStatus.completed:
            call.update(state='provider_failed', error=redact_provider_payload(result.error))
            reason = (result.error or {}).get('code', 'unexpected_provider_status')
            self.stop('interrupted', 'provider_failure', reason, stage=spec['stage'])
            raise ValueError('unexpected provider result; no retry')
        if result.provider_job_id != accepted.provider_job_id:
            call.update(state='provider_failed', response_id=result.provider_job_id)
            self.stop('interrupted', 'provider_failure', 'provider_job_mismatch', stage=spec['stage'])
            raise ValueError('provider result belongs to another request')

        call.update(state='provider_completed', raw_count=len(result.images), frames=[])
        self.save()
        if self.version == 2 and len(result.images) != spec['count']:
            call['state'] = 'provider_failed'
            self.stop('interrupted', 'provider_failure', 'unexpected_frame_count', stage=spec['stage'])
            raise ValueError('unexpected provider result; no retry')
        directory.mkdir(parents=True, exist_ok=True)
        invalid = []
        for i, data in enumerate(result.images):
            try:
                if self.version == PROTOCOL:
                    validate_drawing_frame(data, self.size, i)
            except ValidationHarnessError:
                invalid.append(i)
                continue
            file = directory / f'{i:03}.png'
            file.write_bytes(data)
            call['frames'].append({'file': file.relative_to(self.output).as_posix(), 'sha256': sha(data), 'raw_index': i})
        self.save()
        try:
            if invalid:
                raise ValidationHarnessError('provider output has invalid PNG frames',
                                             details={'reason': 'invalid_drawing_frame', 'raw_indices': invalid})
            indices = (playback_indices(result.images, spec['count'], first) if self.version == PROTOCOL else
                       tuple(range(len(result.images))))
        except ValidationHarnessError as exc:
            call.update(state='provider_failed', error=exc.as_dict())
            self.stop('interrupted', 'provider_failure', exc.details['reason'], stage=spec['stage'])
            raise
        call.update(state='complete', playback_raw_indices=list(indices), context_removed=indices[0] != 0)
        self.save()
        return [result.images[index] for index in indices]

    def publish(self, frames):
        for frame in frames:
            name = f"{len(self.ledger['frames']):03}.png"
            (self.output / name).write_bytes(frame)
            self.ledger['frames'].append({'file': name, 'sha256': sha(frame)})
        self.save()

    def run(self, judge):
        self.output.mkdir(parents=True, exist_ok=False)
        self.save()
        if self.version == PROTOCOL and self.ledger['preflight']:
            return self.stop('blocked_preflight', 'local_preflight', self.ledger['preflight'][0]['reason'])
        try:
            first = self.source
            targets = list(self.last_frames)
            finding = None
            for spec in self.schedule['requests']:
                i, kind = spec['stage'], spec['kind']
                if kind == 'clip':
                    self.publish(self.draw(spec, first, targets[-1]))
                elif kind == 'pose':
                    targets[i] = self.draw(spec, self.source, None)[-1]
                    (self.output / f'pose-{i}.png').write_bytes(targets[i])
                elif kind == 'repair' and finding == 'pass':
                    continue
                else:
                    frames = self.draw(spec, first, targets[i])
                    if frames is None:  # conditional request blocked by its frozen budget
                        return self.ledger
                    if self.arm == 'model_only':
                        finding = judge(first, self.ledger['stages'][i], frames)
                        if finding not in ('pass', 'fail', 'uncertain'):
                            raise ValueError('review verdict missing')
                        self.ledger['reviews'].append({'stage': i, 'attempt': int(kind == 'repair'), 'verdict': finding,
                                                       'frame_hashes': [sha(frame) for frame in frames]})
                        self.save()
                        if finding != 'pass':
                            if kind == 'repair':
                                return self.stop('stopped_by_review', 'review_stopped', 'second_non_pass', stage=i)
                            continue
                    self.publish(frames)
                    first = frames[-1]
            return self.stop('complete', 'complete', 'playable')
        except Exception as exc:
            if self.ledger['status'] == 'running':
                kind = 'local_failure' if any(c.get('started') for c in self.ledger['calls']) else 'not_submitted'
                self.stop('interrupted', kind, 'local_interruption', error=error_record(exc))
            raise


def error_record(exc):
    if isinstance(exc, HarnessError):
        return redact_provider_payload(exc.as_dict())
    return {'code': type(exc).__name__}
