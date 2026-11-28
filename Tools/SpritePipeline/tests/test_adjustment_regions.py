"""Spatial preservation, explicit scope and differential verdict regressions."""
import copy
import hashlib
import io
import pytest
from dataclasses import replace
from PIL import Image
from test_open_motion import setup
from test_motion_adjustments import stage_work,request,IntentRegistry
from sprite_pipeline.collaboration.adjustments import Adjustments
from sprite_pipeline.collaboration.adjustment_regions import composite_region,verify_protection
from sprite_pipeline.collaboration.adjustment_comparison import AdjustmentAudit,AdjustmentResolution,ComparisonFinding,summarize,bind_report
from sprite_pipeline.errors import ConflictError,ValidationHarnessError


def png(color):
    out=io.BytesIO();Image.new('RGBA',(64,64),color).save(out,format='PNG');return out.getvalue()


def region(index,sha):
    return {'frame':index,'source_sha256':sha,'spans':[{'start':30*64+30,'length':4},{'start':31*64+30,'length':4}]}


def test_composite_preserves_every_rgba_channel_outside_exact_mask_including_holes():
    before=png((20,30,40,90));raw=png((90,80,70,0));r=region(0,hashlib.sha256(before).hexdigest())
    result,stats=composite_region(before,raw,r)
    image=Image.open(io.BytesIO(result));assert image.getpixel((30,30))==(90,80,70,0)
    assert image.getpixel((29,30))==(20,30,40,90) and image.getpixel((34,30))==(20,30,40,90)
    assert stats=={'frame':1,'editable_pixels':8,'protected_pixels':4088,'protected_changed_pixels':0,
                  'discarded_outside_changes':4088,'changed_inside_pixels':8}
    verify_protection(before,result,r)
    with pytest.raises(ConflictError,match='受保护像素'):verify_protection(before,raw,r)


@pytest.mark.parametrize('defect',['missing','duplicate','reordered','outside','overlap','full','stale','motion'])
def test_invalid_spatial_scope_stops_before_task_or_model(setup,defect):
    s,ws,p,w=stage_work(setup);m=Adjustments(s);context=m.context(w.id,1,1,0)
    values=[region(i,context['frames'][i]['sha256']) for i in (1,2)]
    if defect=='missing':values.pop()
    if defect=='duplicate':values[1]=copy.deepcopy(values[0])
    if defect=='reordered':values.reverse()
    if defect=='outside':values[0]['spans']=[{'start':4095,'length':2}]
    if defect=='overlap':values[0]['spans']=[{'start':10,'length':4},{'start':12,'length':2}]
    if defect=='full':values[0]['spans']=[{'start':0,'length':4096}]
    if defect=='stale':values[0]['source_sha256']='0'*64
    with pytest.raises((ConflictError,ValidationHarnessError)):
        m.create(w.id,request(m,w,preserve_motion=defect!='motion',edit_regions=values))
    assert m.listing(w.id)==[] and len(p.requests)==1


def test_spatial_task_delivers_composite_reviews_it_and_keeps_raw_and_original(setup):
    s,ws,p,w=stage_work(setup,True);s.adjustment_test_reviews=True
    registry=IntentRegistry();s.open_motion_review_registry=registry;m=Adjustments(s)
    context=m.context(w.id,1,1,0);before=(s.store.job_dir(w.job_id)/'job.json').read_bytes()
    regions=[region(i,context['frames'][i]['sha256']) for i in (1,2)]
    body=request(m,w,preserve_motion=True,edit_regions=regions,user='只调整涂选处颜色与轮廓')
    original_poll=p.poll
    def bad_outside(job_id):
        result=original_poll(job_id);images=list(result.images)
        for i in range(1,len(images)-1):
            im=Image.open(io.BytesIO(images[i])).convert('RGBA')
            im.putpixel((0,0),(255,255,0,255));im.putpixel((31,30),(255,255,0,255))
            out=io.BytesIO();im.save(out,format='PNG');images[i]=out.getvalue()
        return replace(result,images=images)
    p.poll=bad_outside
    t=m.create(w.id,body);assert m.create(w.id,body)['id']==t['id']
    t=m.advance(w.id,t['id'],p);assert t['state']=='ready',t
    assert len(t['planning_calls'])==1 and len(t['generation_calls'])==1 and len(t['review_calls'])==5
    assert t['spatial_policy']=='source_pixels_v1' and t['comparison_protocol']==1
    assert t['review']['comparison']['findings']['preservation']['status']=='pass'
    assert all(x['protected_changed_pixels']==0 for x in t['spatial_protection']['frames'])
    assert any(x['discarded_outside_changes']>0 for x in t['spatial_protection']['frames'])
    folder=m.folder(t)
    for i in (0,3):assert (folder/'source'/f'{i:03d}.png').read_bytes()==(folder/'proposed'/f'{i:03d}.png').read_bytes()
    for r in regions:
        verify_protection((folder/'source'/f'{r["frame"]:03d}.png').read_bytes(),(folder/'proposed'/f'{r["frame"]:03d}.png').read_bytes(),r)
    assert len(list((folder/'raw').glob('*.png')))==4
    assert (s.store.job_dir(w.job_id)/'job.json').read_bytes()==before
    assert 'Editable xyxy' in p.requests[-1].prompt
    assert any('AUTHORIZED REGION OVERLAY' in c.get('text','') for _,content in registry.inputs for c in content)
    assert any('ADJUSTMENT COMPARISON CONTRACT' in c.get('text','') for _,content in registry.inputs for c in content)
    m.decide(w.id,t['id'],token=t['preview_token'],decision='reject',note='仅验收工程，不采用诊断图片')
    assert (s.store.job_dir(w.job_id)/'job.json').read_bytes()==before


def test_compared_regression_uses_existing_dispute_call_even_when_old_dimensions_pass(setup):
    s,ws,p,w=stage_work(setup,True);s.adjustment_test_reviews=True
    class Registry(IntentRegistry):
        def send(self,role,content,schema,count,**kwargs):
            value,meta=super().send(role,content,schema,count,**kwargs)
            if isinstance(value,AdjustmentAudit):
                for c in value.checks:c.status='pass'
                if any('primary expertise is visual identity' in c.get('text','') for c in content):
                    value.preservation=ComparisonFinding(status='fail',confidence=.95,frames=[2],evidence='目标细节改善，但实际头部轮廓出现未要求变化')
            if isinstance(value,AdjustmentResolution):
                value.preservation=ComparisonFinding(status='fail',confidence=.95,frames=[2],evidence='实际前后帧对比确认头部新增不应存在的轮廓')
            return value,meta
    s.open_motion_review_registry=Registry();m=Adjustments(s)
    t=m.create(w.id,request(m,w));t=m.advance(w.id,t['id'],p)
    assert t['state']=='ready' and len(t['review_calls'])==5
    assert t['review']['expert_review']['comparison_disputes']
    assert t['review']['comparison']['findings']['change']['status']=='pass'
    assert t['review']['comparison']['findings']['preservation']['status']=='fail'
    assert t['review']['verdict']=='fail'
    with pytest.raises(ValidationHarnessError,match='尚未解决'):
        m.decide(w.id,t['id'],token=t['preview_token'],decision='accept',note='不能忽略新增退化')
    assert len(p.requests)==2


def test_clearing_comparison_concern_needs_human_and_missing_opinion_never_passes():
    finding=lambda status:{'status':status,'confidence':.95,'frames':[2],'evidence':'实际帧可见的对比依据'}
    t={'protocol':'experts_v1','source_token':'source','preview_token':'preview','comparison_opinions':{
        'audit':{'change':finding('pass'),'preservation':finding('fail')},
        'expert_appearance':{'change':finding('pass'),'preservation':finding('pass')},
        'expert_motion':{'change':finding('pass'),'preservation':finding('pass')},
        'dispute':{'change':finding('pass'),'preservation':finding('pass')}}}
    r=summarize(t);assert r['findings']['preservation']['status']=='uncertain'
    assert r['findings']['preservation']['requires_human_adjudication']
    t['comparison_opinions'].pop('expert_motion');r=summarize(t)
    assert r['state']=='incomplete' and r['verdict']!='pass'
    t['spatial_protection']={'frames':[{'frame':2,'changed_inside_pixels':0}]}
    r=summarize(t);assert r['no_pixel_change'] and r['findings']['change']['status']=='fail'


def test_incomplete_review_never_displays_a_green_comparison():
    comparison={'state':'complete','verdict':'pass','findings':{key:{'status':'pass','evidence':'先前模型意见'} for key in ('change','preservation')}}
    result=bind_report({'state':'failed','verdict':'uncertain','summary':'请求未完成'},comparison)
    assert result['comparison']['state']=='incomplete'
    assert all(v['status']=='uncertain' for v in result['comparison']['findings'].values())
    assert comparison['findings']['change']['status']=='pass'  # source opinion retained


def test_regions_and_comparison_evidence_cannot_be_changed_after_freezing(setup):
    s,ws,p,w=stage_work(setup);m=Adjustments(s);context=m.context(w.id,1,1,0)
    t=m.create(w.id,request(m,w,preserve_motion=True,edit_regions=[region(i,context['frames'][i]['sha256']) for i in (1,2)]))
    tampered=copy.deepcopy(t);tampered['edit_regions'][0]['spans'][0]['start']+=1
    with pytest.raises(ConflictError,match='冻结要求'):m.verify(tampered)
    t=m.advance(w.id,t['id'],p);assert t['state']=='ready'
    t['review']['comparison']['findings']['change']['evidence']='不同版本的检查结论'
    with pytest.raises(ConflictError,match='对比报告'):m.verify(t)
