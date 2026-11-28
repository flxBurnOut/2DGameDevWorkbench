"""One complete, bounded drawing brief, separate from detailed planning.

The coordinator writes the actual provider text, with flexible space allocation
across named conditions. Nothing is concatenated, shortened or rewritten after
validation. The sections provide coverage evidence, not proof of image quality.
"""
from __future__ import annotations
import re
from ..errors import ValidationHarnessError

VERSION=3
SECTIONS={
    'appearance':('Appearance',['quality.appearance_contract','motion.appearance']),
    'action':('Action',['stage.goal','stage.acceptance']),
    'camera':('Camera',['motion.camera']),
    'facing':('Facing',['motion.orientation']),
    'drive':('Drive',['motion.drive']),
    'support':('Support',['motion.support']),
    'path':('Path',['motion.trajectory']),
    'timing':('Timing',['checkpoint.rhythm','motion.holds']),
    'poses':('Poses',['quality.key_poses']),
    'relations':('Relations',['motion.generation_hint','structure_usage']),
    'end':('End',['checkpoint.endpoint','quality.ending_contract']),
    'boundary':('Boundary',['motion.boundary','motion.entry','motion.exit']),
}
PATTERN=re.compile(r'^(Appearance|Action|Camera|Facing|Drive|Support|Path|Timing|Poses|Relations|End|Boundary):[ \t]*',re.I|re.M)


def rows(plan,stage_index):
    text=plan.stages[stage_index].prompt
    matches=list(PATTERN.finditer(text))
    names=[m.group(1).lower() for m in matches]
    missing=set(SECTIONS)-set(names)
    if missing or len(names)!=len(set(names)) or not matches or text[:matches[0].start()].strip():
        raise ValidationHarnessError('绘图说明须包含且仅包含一组完整条件段：'+', '.join(v[0] for v in SECTIONS.values())+'；不改写原响应')
    result=[]
    for i,m in enumerate(matches):
        label,sources=SECTIONS[m.group(1).lower()]
        stop=matches[i+1].start() if i+1<len(matches) else len(text)
        content=text[m.end():stop].strip()
        if not content:raise ValidationHarnessError('绘图说明的 '+label+' 为空；尚未提交绘图')
        result.append({'label':label,'text':content,'sources':sources})
    return result


def compile_brief(plan,stage_index):
    text=plan.stages[stage_index].prompt
    if len(text)>1000:raise ValidationHarnessError('完整绘图说明超过1000字符；不截断、不自动重试')
    rows(plan,stage_index)
    return text


INSTRUCTIONS='''
EXECUTABLE DRAWING BRIEF policy 3. This overrides earlier guidance that treats
stage.prompt as only a short transition. Keep quality.version=4, the original
MotionConstraints/KeyPose limits and the full reasoning, requirements and criteria.
Do NOT use the experimental 26-character pose limit or other micro field budgets.

Each stage.prompt is the COMPLETE text sent to PixelLab, unchanged. Write it once,
preferably 650-850 characters, absolute maximum 1000 including headings/newlines.
No application suffix, global narrative, duplicate appearance or extra key poses
will be appended. Spend space on this task's important relations rather than
equal-sized slots. Detailed planning fields remain available for review.

Use each following heading once on its own line, with a nonempty value. Flexible
length per section; there is only the overall 1000-character drawing-text limit:
Appearance: reference identity and local object/material/ownership invariants.
Action: ONLY this segment's transition/event, continuing its actual input.
Camera: intended camera/framing.
Facing: body orientation separately from the held object's projection.
Drive: which parts lead, which follow, and how force or momentum is conveyed.
Support: visible/task-appropriate support and weight transfer, including airborne.
Path: relevant body/limb/object path, without inventing hidden joints.
Timing: local timing in the actual frame count; retain explicitly intended holds.
Poses: concrete local-frame waypoints; the full detailed key poses remain in quality.
Relations: task-relevant observed relations/remaining continuity constraints. Use
  checked structure when supplied; unknown anchors never become control facts.
End: the local visible endpoint; include the intended finish only in the last stage.
Boundary: how motion continues through the join or settles; no unsolicited hold.

Headings and required dimensions are generic, not an attack template. Never
force a ground contact, fixed facing, return pose or motion phase without a task
reason. A reference mask does not constrain future joint positions. Actual target
PNGs remain separately checked inputs; a text endpoint is not an image already
available. Do not generate/select target images or raise any budget.
Strategy proposes this same complete brief; coordinator checks coherence against
the detailed plan and original request. Use compact English phrases and avoid
repetition; never satisfy brevity by omitting a user requirement or changing the
event, selected scope or frame count. No paid rewriting request or automatic retry.
'''
