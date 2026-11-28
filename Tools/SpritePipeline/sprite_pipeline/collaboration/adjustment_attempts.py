"""Admission for a new explicitly authorized edit, separate from cost history."""
from ..errors import ConflictError, ValidationHarnessError

ATTEMPT_LIMIT = 2


def frame_attempts(frame_count, records, *, legacy=False):
    counts = [0] * frame_count
    for record in records:
        # A legacy repair is persisted immediately before its one submission.
        # New adjustments also persist interpretation-only attempts: those do not
        # consume a drawing slot, but their planning cost remains in the ledger.
        used = record.get('requests', 1) if legacy else len(record.get('generation_calls', []))
        if not used:
            continue
        start, end = record.get('start'), record.get('end')
        if type(used) is not int or used < 0 or type(start) is not int or type(end) is not int or start < 0 or start > end:
            raise ConflictError('历史修改范围记录无效，不能确定剩余绘图次数')
        for i in range(start, min(end + 1, frame_count)):
            counts[i] += used
    return counts


def require_drawing_slot(context, start, end, *, additional=1):
    counts = context['frame_attempts']
    if type(start) is not int or type(end) is not int or not 0 <= start <= end < len(counts):
        raise ValidationHarnessError('请选择实际存在的连续帧')
    blocked = [str(i + 1) for i in range(start, end + 1) if counts[i] + additional > context['attempt_limit']]
    if blocked:
        raise ValidationHarnessError(f"第 {'、'.join(blocked)} 帧已达到 {context['attempt_limit']} 次绘图试做上限；其他未用完次数的帧仍可单独选择。历史费用与记录保留。")
