"""Reserve the scheduled experts before optional paid consultations (policy 5)."""
from ..errors import ValidationHarnessError


DEFERRED_REQUEST = (
    'A peer request was deferred to preserve the scheduled budget. Inspect deferred_request and the unchanged raw expert '
    'response. Resolve from existing evidence, keep unknown geometry unknown, or ask the user in plan.questions. '
    'Do not claim the consultation occurred.'
)
FINAL_RESPONSE = (
    'This is the final coordinator turn. Return finalize with a complete plan. '
    'Put any unresolved decision that blocks generation in plan.questions; no further expert calls can be requested.'
)


def final_response_only(work, role):
    return (work.generation_policy_version in (5, 6) and role == 'coordinator'
            and len(work.planning_calls) >= work.spec.budget.max_planning_calls)


def context(work,role):
    unseen=[r for r in ('appearance','motion','strategy','coordinator') if r!=role and not any(m['role']==r for m in work.messages)]
    remaining=max(0,work.spec.budget.max_planning_calls-len(work.planning_calls))
    return {'remaining_after_current':remaining,'roles_not_yet_heard':unseen,
            'rule':'Reserve scheduled strategy and coordinator turns. If there is no spare call, submit the required observation or strategy draft now. Put noncritical uncertainty in findings; the coordinator can resolve it from peer observations. Do not repeat a consultation merely to name an invisible anatomical detail. Critical unresolved user choices belong in final plan.questions, never an invented assumption.'}


def defer(work,role,turn,queue):
    if turn.action not in ('consult','inspect_reference'):return False
    if turn.action=='consult' and turn.target==role:raise ValidationHarnessError('专家不能向自己发起重复质询')
    if turn.action=='inspect_reference' and turn.crop:
        left,top,right,bottom=turn.crop
        if not 0<=left<right<=work.character['cell_width'] or not 0<=top<bottom<=work.character['cell_height']:
            raise ValidationHarnessError('专家请求的观察区域超出原图范围')
    extra=2 if turn.action=='consult' else 1
    remaining=work.spec.budget.max_planning_calls-len(work.planning_calls)
    if remaining>=len(queue)+extra:return False
    note={'action':turn.action,'from':role,'target':turn.target,'question':turn.question,
          'crop':turn.crop,'reason':'reserve_remaining_scheduled_experts','resolved':False}
    work.messages[-1]['deferred_request']=note
    for i,(next_role,question,crop) in enumerate(queue):
        if next_role=='coordinator':
            queue[i]=(next_role, (question+'\n'+DEFERRED_REQUEST).strip(),
                      crop or (turn.crop if turn.action=='inspect_reference' else None))
            return True
    if role == 'coordinator' and remaining > len(queue):
        queue.append(('coordinator', DEFERRED_REQUEST + '\n' + FINAL_RESPONSE, None))
    return True
