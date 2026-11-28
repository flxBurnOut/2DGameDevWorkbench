"""Per-selected-frame drawing limits, without erasing paid failure history."""
import copy
import pytest
from test_open_motion import setup
from test_motion_adjustments import long_stage_work, request, IntentRegistry
from sprite_pipeline.collaboration.adjustments import Adjustments, AdjustmentIntent
from sprite_pipeline.collaboration.adjustment_attempts import frame_attempts, require_drawing_slot
from sprite_pipeline.collaboration.checkpoints import Checkpoints
from sprite_pipeline.errors import ValidationHarnessError, ConflictError


def test_interpretation_failure_and_adopted_13_14_do_not_block_15_16(setup):
    s,ws,p,w=long_stage_work(setup);s.adjustment_test_reviews=True
    class RejectIntent(IntentRegistry):
        def send(self,*args,**kw):
            result,meta=super().send(*args,**kw)
            if isinstance(result,AdjustmentIntent):result.conflict='仅验证一次未进入绘图的历史失败'
            return result,meta
    s.open_motion_review_registry=RejectIntent();m=Adjustments(s)
    failed=m.create(w.id,request(m,w,start=12,end=13));failed=m.advance(w.id,failed['id'],p)
    assert failed['state']=='needs_input' and len(failed['planning_calls'])==1 and not failed['generation_calls']
    failed_bytes=(m.folder(failed)/'task.json').read_bytes()
    s.open_motion_review_registry=IntentRegistry();m=Adjustments(s)
    first=m.create(w.id,request(m,w,start=12,end=13));first=m.advance(w.id,first['id'],p)
    m.decide(w.id,first['id'],token=first['preview_token'],decision='accept',note='模拟验证原帧和连接，采用前一选区',acknowledge=True)
    before=Checkpoints(s).view(w.job_id,1,0)
    context=m.context(w.id,1,1,0)
    assert context['frame_attempts'][12:16]==[1,1,0,0]
    assert context['attempt_scope']=='selected_frames' and len(context['tasks'])==2
    second_body=request(m,w,start=14,end=15)
    second=m.create(w.id,second_body)
    assert m.create(w.id,second_body)['id']==second['id']
    second=m.advance(w.id,second['id'],p)
    assert second['state']=='ready'
    assert second['source_frames'][12:14]==before['frames'][12:14]
    assert all(second['proposed_frames'][i]['sha256']==before['frames'][i]['sha256'] for i in range(14))
    assert m.context(w.id,1,1,0)['frame_attempts'][12:16]==[1,1,1,1]
    assert (m.folder(failed)/'task.json').read_bytes()==failed_bytes
    assert len(m.load(w.id,failed['id'])['planning_calls'])==1
    # The pending alternative still blocks a parallel submission in any range.
    with pytest.raises(ConflictError):m.create(w.id,request(m,w,start=6,end=7))


def test_overlap_cannot_bypass_two_submitted_drawings_and_new_window_is_free(setup):
    s,ws,p,w=long_stage_work(setup);m=Adjustments(s)
    for _ in range(2):
        t=m.create(w.id,request(m,w,start=12,end=13));t=m.advance(w.id,t['id'],p)
        m.decide(w.id,t['id'],token=t['preview_token'],decision='reject',note='保留原版，试做仍计数')
    before=len(p.requests)
    for start,end in [(12,13),(13,14),(11,12)]:
        with pytest.raises(ValidationHarnessError,match='绘图试做上限'):
            m.create(w.id,request(m,w,start=start,end=end))
    assert len(p.requests)==before and len(m.listing(w.id))==2
    assert m.create(w.id,request(m,w,start=14,end=15))['state']=='queued'


def test_unknown_drawings_count_even_after_explicit_rejection(setup):
    s,ws,p,w=long_stage_work(setup);m=Adjustments(s);p.unknown=True
    for _ in range(2):
        t=m.create(w.id,request(m,w,start=12,end=13));t=m.advance(w.id,t['id'],p)
        assert t['state']=='unknown'
        calls=len(p.requests);m.advance(w.id,t['id'],p);assert len(p.requests)==calls
        m.decide(w.id,t['id'],token=t['source_token'],decision='reject',note='结束本次尝试，未知提交保留')
    assert m.context(w.id,1,1,0)['frame_attempts'][12:16]==[2,2,0,0]
    with pytest.raises(ValidationHarnessError):m.create(w.id,request(m,w,start=12,end=13))
    assert m.create(w.id,request(m,w,start=14,end=15))['state']=='queued'


def test_legacy_repairs_use_their_real_range_without_rewriting_them(setup):
    s,ws,p,w=long_stage_work(setup);m=Adjustments(s)
    old=[{'start':12,'end':13,'state':'rejected','requests':1},{'start':12,'end':13,'state':'failed','requests':1}]
    with s.store.locked_job(w.job_id) as job:job.candidates[0].plan_execution.stages[0].repairs=copy.deepcopy(old)
    context=m.context(w.id,1,1,0)
    assert context['legacy_frame_attempts'][12:16]==[2,2,0,0]
    with pytest.raises(ValidationHarnessError):require_drawing_slot(context,12,13)
    require_drawing_slot(context,14,15)
    assert s.store.load(w.job_id).candidates[0].plan_execution.stages[0].repairs==old


def test_count_comes_from_submission_ledger_not_success_or_record_count():
    rows=[{'start':0,'end':1,'state':'failed','generation_calls':[]},
          {'start':0,'end':1,'state':'failed','generation_calls':[{'state':'failed'}]},
          {'start':1,'end':2,'state':'rejected','generation_calls':[{'state':'unknown'}]}]
    assert frame_attempts(4,rows)==[1,2,1,0]
    with pytest.raises(ConflictError):frame_attempts(4,[{'start':None,'end':2,'generation_calls':[{}]}])
