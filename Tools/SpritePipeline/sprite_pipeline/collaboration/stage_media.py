"""Versioned, hash-bound stage previews. Adoption keeps the full evidence gate."""
from __future__ import annotations

import hashlib
from contextlib import ExitStack

from ..errors import ConflictError, NotFoundError, ValidationHarnessError
from ..jsonio import atomic_write_json, read_json
from .checkpoints import Checkpoints
from .contracts import adjustment_source_token, digest
from .execution import PlanGeneration
from .drawing_frames import FRAME_NORMALIZATION

class StageMedia:
    VERSION = 1

    def __init__(self, service):
        self.store = service.store
        self.checkpoints = Checkpoints(service)
        self.engine = PlanGeneration(service)

    def manifest(self, work, job, candidate, stage):
        binding = job.request.open_plan
        if (not binding or binding.work_id != work.id or binding.revision != work.revision
                or binding.plan_sha256 != work.plan_sha256 or job.job_id != work.job_id):
            raise ConflictError('作品和片段来源版本不匹配')
        run = self.checkpoints.run_record(job, candidate, stage)
        if run.state in {'created', 'submitting', 'pending', 'unknown', 'failed'}:
            raise ConflictError('片段尚未完整保存，暂时不能检查')

        folder = self.engine.directory(job.job_id, candidate, stage)
        try:
            raw = read_json(folder / 'frames.json')
            raw_sha256 = digest(raw)
            if (not isinstance(raw, dict) or raw.get('provider_job_id') != run.provider_job_id
                    or run.frames_manifest_sha256 and run.frames_manifest_sha256 != raw_sha256):
                raise ConflictError('片段原始帧清单已改变')
            offset = len(raw['frames']) - binding.plan.stages[stage].frame_count
            if offset not in {0, 1}:
                raise ConflictError('片段帧数与冻结方案不一致')
            directory = folder.relative_to(self.store.job_dir(job.job_id)).as_posix()
            frames = []
            for index, entry in enumerate(raw['frames']):
                filename = f'frame_{index:03d}.png'
                if entry['filename'] != filename:
                    raise ConflictError('片段原始帧路径无效')
                if index >= offset:
                    frames.append({'raw_index': index, 'sha256': entry['sha256'], 'path': f'{directory}/{filename}'})
            if run.active_frames is not None:
                if len(run.active_frames) != len(frames):
                    raise ConflictError('修复版本帧数与原片段不同')
                frames = run.active_frames
            if stage:
                previous = self.checkpoints.run_record(job, candidate, stage - 1)
                if previous.state != 'accepted' or not previous.accepted:
                    raise ConflictError('前一片段尚未确认，不能绑定输入姿势')
                input_sha256 = previous.accepted['anchor_sha256']
            else:
                input_sha256 = job.reference_sha256
        except FileNotFoundError as exc:
            raise NotFoundError('片段原始帧清单缺失') from exc
        except (KeyError, TypeError, ValueError) as exc:
            raise ConflictError('片段原始帧清单无效') from exc
        except OSError as exc:
            raise ConflictError('无法读取片段原始帧清单') from exc

        target = next((item for item in binding.end_targets if item.stage == stage), None)
        hashes = {'input_sha256': input_sha256, **({'target_sha256': target.sha256} if target else {})}
        token = digest({'job': job.job_id, 'candidate': candidate, 'stage': stage,
                        'plan': binding.plan_sha256, 'frames': frames, **hashes})
        recorded_token = (run.accepted or run.review or {}).get('token')
        if recorded_token and recorded_token != token:
            raise ConflictError('片段帧清单与已经记录的检查版本不一致')

        evidence = {**hashes, 'token': token, 'frames': frames,
                    'context_removed': bool(offset), 'raw_count': len(raw['frames']),
                    'frame_normalization': FRAME_NORMALIZATION}
        record = {'version': self.VERSION, 'job_id': job.job_id, 'work_revision': work.revision,
                  'candidate': candidate, 'stage': stage, 'raw_manifest_sha256': raw_sha256, 'evidence': evidence}
        # The filename changes with an adopted edit, while repeat reads of the
        # same source can reuse the prior full verification.
        path = folder / 'media' / f'{digest(record)}.json'
        if not self.check_cached(path, record):
            lock_name = f'stage_media_{candidate}_{stage}'
            with ExitStack() as cache_lock:
                try:
                    cache_lock.enter_context(self.store.operation_lock(job.job_id, lock_name, timeout_seconds=5))
                except OSError:
                    pass  # A read-only workspace may still provide source evidence.
                if not self.check_cached(path, record):
                    try:
                        verified = self.checkpoints.evidence(job, candidate, stage)
                    except FileNotFoundError as exc:
                        raise NotFoundError('片段证据缺失，无法重新验证媒体清单') from exc
                    except OSError as exc:
                        raise ConflictError('无法读取片段证据，媒体清单未更新') from exc
                    if verified != evidence:
                        raise ConflictError('片段文件发生变化，请刷新后重新读取')
                    try:
                        atomic_write_json(path, record)
                    except OSError:
                        pass  # The verified frame remains readable if the derived cache cannot be saved.
        return evidence

    @staticmethod
    def check_cached(path, record):
        try:
            return read_json(path) == record
        except (OSError, TypeError, ValueError):
            return False

    def view(self, work, job, candidate, stage):
        evidence = self.manifest(work, job, candidate, stage)
        return {**self.checkpoints.view(job.job_id, candidate, stage, job=job, preview=evidence),
                'work_revision': work.revision, 'job_revision': job.revision, 'media_manifest_version': self.VERSION}

    def image(self, work, job, candidate, stage, frame, *, token=None, legacy_token=None, expected_sha256=None):
        evidence = self.manifest(work, job, candidate, stage)
        if token is not None and token != evidence['token']:
            raise ConflictError('片段媒体版本已改变')
        if legacy_token is not None and legacy_token not in {
                evidence['token'], adjustment_source_token(job, work.revision, evidence['token'])}:
            raise ConflictError('片段媒体版本已改变')
        if not 0 <= frame < len(evidence['frames']):
            raise ValidationHarnessError('帧索引无效')
        item = evidence['frames'][frame]
        if expected_sha256 is not None and expected_sha256 != item['sha256']:
            raise ConflictError('帧哈希与所选片段版本不一致')
        try:
            data = self.store.resolve_job_path(job.job_id, item['path']).read_bytes()
        except FileNotFoundError as exc:
            raise NotFoundError('所选片段帧文件缺失') from exc
        except OSError as exc:
            raise ConflictError('无法读取所选片段帧') from exc
        if hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ConflictError('所选片段帧内容已改变')
        return data
