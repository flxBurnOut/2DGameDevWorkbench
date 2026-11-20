"""Archive provider usage and validated outputs before interpreting a paid drawing."""
import hashlib
from collections.abc import Mapping

from ..errors import ConflictError, ProviderError, ValidationHarnessError
from ..jsonio import atomic_write_json, inside, read_json
from ..providers.base import PollStatus, redact_provider_payload
from .drawing_frames import playback_indices
from .targets import checked_png


def response_usage(response):
    usage = response.get('usage') if isinstance(response, Mapping) else None
    return redact_provider_payload(usage) if isinstance(usage, Mapping) else {}


def poll_error_usage(exc):
    return (response_usage(exc.details.get('response')) or
            response_usage({'usage': exc.details.get('last_poll_usage')}))


def read_poll_receipt(path, provider_job_id):
    try:
        receipt = read_json(path)
    except FileNotFoundError:
        return None
    except ValueError as exc:
        raise ConflictError('已保存的绘图回执无效') from exc
    if not isinstance(receipt, dict) or receipt.get('version') != 1 or receipt.get('provider_job_id') != provider_job_id:
        raise ConflictError('已保存的绘图回执与远端请求不匹配')
    return receipt


def poll_drawing(folder, provider, provider_job_id, size, frame_name, write_bytes, *, usage=None):
    """Reopen a committed result or poll the same ID and archive it exactly once."""
    result_path = folder / 'provider-result.json'
    saved = read_poll_receipt(result_path, provider_job_id)
    if saved is not None:
        return saved
    receipt_path = folder / 'poll-receipt.json'
    previous = read_poll_receipt(receipt_path, provider_job_id) or {}
    known = response_usage(previous) or usage or {}
    identity = {'version': 1, 'provider_job_id': provider_job_id}
    try:
        result = provider.poll(provider_job_id)
    except ProviderError as exc:
        observed_id = exc.details.get('provider_job_id')
        if not observed_id or observed_id == provider_job_id:
            atomic_write_json(receipt_path, {**identity, 'status': 'poll_error',
                'usage': poll_error_usage(exc) or known, 'error': redact_provider_payload(exc.as_dict())})
        raise
    if result.provider_job_id != provider_job_id:
        raise ConflictError('远端返回的绘图请求编号与本次提交不符')
    receipt = {**identity, 'status': result.status.value, 'provider_status': result.provider_status,
               'usage': response_usage({'usage': result.usage}) or response_usage(result.raw_response) or known,
               'response': redact_provider_payload(result.raw_response), 'error': redact_provider_payload(result.error),
               'raw_count': len(result.images)}
    if result.status != PollStatus.pending or receipt['usage'] != response_usage(previous):
        atomic_write_json(receipt_path, receipt)
    if result.status == PollStatus.pending:
        return receipt

    frames, invalid = [], []
    for index, data in enumerate(result.images):
        try:
            sha256 = checked_png(data, *size)
        except ValidationHarnessError:
            invalid.append(index)
            continue
        name = frame_name(index)
        path = inside(folder, folder / name)
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_file():
            if path.read_bytes() != data:
                raise ConflictError('远端绘图帧发生变化，保留已有原始结果')
        else:
            write_bytes(path, data)
        frames.append({'file': name, 'sha256': sha256, 'raw_index': index})
    saved = {**receipt, 'frames': frames, 'invalid_frames': invalid}
    atomic_write_json(result_path, saved)
    return saved


def repair_playback(folder, result, frame_name, expected_count, mode, first):
    """Return verified bytes and the replacement indices in raw output order."""
    if result['invalid_frames']:
        raise ValidationHarnessError('绘图结果中存在格式、尺寸或透明通道无效的帧',
                                     details={'reason': 'invalid_drawing_frame', 'raw_indices': result['invalid_frames']})
    frames = []
    for index, item in enumerate(result['frames']):
        if item['file'] != frame_name(index) or item['raw_index'] != index:
            raise ConflictError('已保存的绘图帧清单顺序发生变化')
        data = inside(folder, folder / item['file']).read_bytes()
        if hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ConflictError('已保存的原始绘图帧发生变化')
        frames.append(data)
    if len(frames) != result['raw_count']:
        raise ConflictError('已保存的绘图帧数与回执不符')
    if mode == 'transition':
        return frames, playback_indices(frames, expected_count, first)
    if len(frames) != expected_count:
        raise ValidationHarnessError('绘图返回帧数不符，原始帧已保留',
                                     details={'reason': 'unexpected_frame_count', 'raw_count': len(frames),
                                              'requested_count': expected_count})
    return frames, range(1, expected_count - 1)
