"""Validate drawing outputs and interpret extra context without changing raw frames."""
import hashlib
import io

from PIL import Image

from ..attack_timeline import is_context_frame
from ..errors import ValidationHarnessError


FRAME_NORMALIZATION = 'input_pose_v1'


def validate_drawing_frame(data, expected_size, index):
    """Require the same transparent PNG canvas for production and experiment draws."""
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            if image.format == 'PNG' and image.size == expected_size and 'A' in image.getbands():
                return hashlib.sha256(data).hexdigest()
    except (OSError, TypeError, ValueError, Image.DecompressionBombError):
        pass
    raise ValidationHarnessError(
        '片段格式、尺寸或透明通道无效，不会用它继续生成',
        details={'reason': 'invalid_drawing_frame', 'raw_index': index},
    )


def playback_indices(frames, requested, first):
    """Map playback indices to provider indices using the production pose test."""
    count = len(frames)
    if count == requested:
        return tuple(range(count))
    if count == requested + 1:
        if is_context_frame(frames[0], first):
            return tuple(range(1, count))
        reason, message = 'unexpected_extra_frame', '多出的帧不是可确认的输入参考帧，停止衔接'
    else:
        reason, message = 'unexpected_frame_count', '片段帧数不符合方案；不补帧、不丢弃实际姿势'
    raise ValidationHarnessError(
        message, details={'reason': reason, 'raw_count': count, 'requested_count': requested,
                          'normalization': FRAME_NORMALIZATION},
    )
