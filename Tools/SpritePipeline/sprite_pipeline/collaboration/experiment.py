"""Offline experimental arms and retrospective materials; never alter a native job."""
import hashlib
import io
import json
import secrets
from pathlib import Path
from PIL import Image
from ..providers.base import ProviderRequest, PollStatus
from ..providers.fixture import FixtureProvider
from ..jsonio import atomic_write_json, inside
from ..models import JobRecord
from .checkpoints import review_call_count
from .repairs import generation_calls

ARMS=('single','blind','keyframe_first','model_only')

def sha(data):return hashlib.sha256(data).hexdigest()

def run_arm(arm,source,stages,seed,provider,judge,output,fps=8):
    """judge receives only the reference, segment brief and actual returned frames.
    A non-pass permits one segment redraw; a second non-pass stops the run.
    """
    if arm not in ARMS or not 1<=fps<=60 or not 1<=len(stages)<=4:raise ValueError('invalid protocol')
    counts=[s['frames'] for s in stages]
    if any(type(n) is not int or n not in range(4,17,2) for n in counts) or (arm=='single' and sum(counts)>16):
        raise ValueError('requested arm exceeds drawing call limit')
    output.mkdir(parents=True,exist_ok=False)
    ledger={'protocol':1,'arm':arm,'source_sha256':sha(source),'seed':seed,'fps':fps,'stages':stages,'calls':[],'reviews':[],'frames':[],
            'diagnostic_only':bool(provider.diagnostic_only),'human_seconds':None,'status':'running'}
    def save():atomic_write_json(output/'run.json',ledger)
    def draw(a,b,n,prompt,stage,kind):
        call={'kind':kind,'stage':stage,'first':sha(a),'last':sha(b) if b else None,'count':n,'state':'submitting'}
        ledger['calls'].append(call);save()
        req=provider.submit(ProviderRequest(reference_image=a,last_frame=b,prompt=prompt,frame_count=n,seed=seed))
        call.update(state='submitted',id=req.provider_job_id);save()
        result=provider.wait(req.provider_job_id)
        if result.status!=PollStatus.completed or len(result.images)!=n:raise ValueError('unexpected provider result; no retry')
        saved=[]
        for i,png in enumerate(result.images):
            name=f"calls/{len(ledger['calls'])-1:02}/{i:03}.png";file=output/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(png)
            saved.append({'file':name,'sha256':sha(png)})
        call.update(state='complete',usage=result.usage,frames=saved);save()
        return result.images
    def publish(frames):
        for frame in frames:
            i=len(ledger['frames']);f=f'{i:03}.png';(output/f).write_bytes(frame);ledger['frames'].append({'file':f,'sha256':sha(frame)})
        save()
    try:
        if arm=='single':publish(draw(source,None,sum(counts),' '.join(s['prompt'] for s in stages),0,'clip'))
        else:
            targets=[]
            if arm=='keyframe_first':
                # Fixture provider has an animation-shaped interface. Freeze one endpoint
                # from each separate pose call before any transition is generated.
                for i,s in enumerate(stages):
                    target=draw(source,None,4,'Hold ending pose: '+s['prompt'],i,'pose')[-1]
                    (output/f'pose-{i}.png').write_bytes(target);targets.append(target)
            first=source
            for i,s in enumerate(stages):
                for attempt in range(2):
                    frames=draw(first,targets[i] if targets else None,s['frames'],s['prompt'],i,'segment' if not attempt else 'repair')
                    if arm!='model_only':break
                    finding=judge(first,s,frames)
                    if finding not in ('pass','fail','uncertain'):raise ValueError('review verdict missing')
                    ledger['reviews'].append({'stage':i,'attempt':attempt,'verdict':finding,'frame_hashes':[sha(f) for f in frames]});save()
                    if finding=='pass':break
                else:
                    ledger['status']='stopped_by_review';save();return ledger
                publish(frames);first=frames[-1]
        ledger['status']='complete';save();return ledger
    except Exception:
        ledger['status']='interrupted';save();raise

def retrospective(job_dir,work,adjustments,out):
    """Explicit paths supplied by operator. Only read and copy verified source media."""
    job=JobRecord.model_validate_json((job_dir/'job.json').read_bytes())
    if work.get('job_id')!=job.job_id or not job.request.open_plan or work['id']!=job.request.open_plan.work_id or work['revision']!=job.request.open_plan.revision:
        raise ValueError('work, job and revision do not match')
    out.mkdir(parents=True,exist_ok=False)
    def copy_png(item,name):
        data=inside(job_dir,job_dir/item['path']).read_bytes()
        if sha(data)!=item['sha256']:raise ValueError('archive frame hash mismatch')
        dest=out/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data)
        return {'file':name,'sha256':sha(data)}
    rows=[];timings=[];usage=[];clip_manifests=[];review_usages=[]
    def record_review(report):
        review_usages.extend(q.get('usage') or (q.get('receipt') or {}).get('usage') or {} for q in (report or {}).get('requests',[]))
    for c in job.candidates:
        record_review(c.plan_execution.quality_review)
        if c.frames:
            playable=[copy_png({'path':f.active_path,'sha256':f.sha256},f'candidate-{c.candidate_index}/playback/{n:03}.png') for n,f in enumerate(c.frames)]
            clip_manifests.append({'candidate':c.candidate_index,'frames':playable,'fps':job.action.fps})
        for i,r in enumerate(c.plan_execution.stages):
            folder=f'candidate-{c.candidate_index}/stage-{i}'
            def images(items,kind):return [copy_png(f,f'{folder}/{kind}/{j:03}.png') for j,f in enumerate(items)]
            raw=[]
            manifest=job_dir/'provider'/f'candidate_{c.candidate_index:02}.plan'/str(i)/'frames.json'
            if manifest.exists():
                for f in json.loads(manifest.read_bytes())['frames']:
                    raw.append({'path':(manifest.parent/f['filename']).relative_to(job_dir).as_posix(),'sha256':f['sha256']})
            reports=[*r.review_history,r.review or {}]
            for report in reports:record_review(report)
            decisions=[x['human_decision'] for x in reports if x.get('human_decision')]
            if r.state_checkpoint:decisions.append({'decision':'accept_state',**r.state_checkpoint})
            timings.extend(d.get('human_seconds') for d in decisions)
            repairs=[]
            for n,a in enumerate(r.repairs):
                repairs.append({**a,'images':images(a.get('proposed_frames',[]),f'repair-{n}')})
            if r.submission_attempts:usage.append(r.usage)
            usage.extend(a.get('usage',{}) for a in r.repairs)
            rows.append({'candidate':c.candidate_index,'stage':i,'state':r.state,'raw':images(raw,'raw'),
                         'accepted':images((r.accepted or {}).get('frames',[]),'accepted'),'review_history':reports,
                         'human_decisions':decisions,'repairs':repairs,'adjustment_history':r.adjustment_history})
    timings.extend(e.get('human_seconds') for e in job.events if e.get('event')=='candidate_approved' and e.get('reviewer')=='open-motion-user')
    saved=[]
    for folder in sorted(adjustments.glob('*/task.json')):
        task=json.loads(folder.read_bytes())
        if task['source_job']!=job.job_id:continue
        media=[]
        for i,f in enumerate(task.get('proposed_frames',[])):
            data=inside(folder.parent,folder.parent/f['file']).read_bytes()
            if sha(data)!=f['sha256']:raise ValueError('adjustment frame hash mismatch')
            name=f'alternatives/{len(saved)}/{i:03}.png';dest=out/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data);media.append({'file':name,'sha256':sha(data)})
        saved.append({**task,'exported_frames':media})
        if task.get('decision_note'):timings.append(task.get('human_seconds'))
        usage.extend([task.get('usage',{})] * len(task['generation_calls']))
    totals={kind:sum(len(t[kind+'_calls']) for t in saved) for kind in ('planning','generation','review')}
    totals['planning']+=len(work.get('planning_calls',[]));totals['generation']+=generation_calls(job);totals['review']+=review_call_count(job)
    # Preserve every native unit. Never treat missing prices, tokens or credits as dollars.
    cost={'calls':totals,'drawing_usage':usage,'known_human_seconds':sum(t for t in timings if t is not None),
          'unmeasured_decisions':sum(t is None for t in timings),'human_seconds':sum(timings) if timings and None not in timings else None}
    def receipt_usage(call):return call.get('usage') or (call.get('receipt') or {}).get('usage') or {}
    metered=[*usage,*review_usages,*[receipt_usage(x) for x in work.get('planning_calls',[])],
             *[receipt_usage(x) for t in saved for k in ('planning_calls','review_calls') for x in t[k]]]
    cost['known_drawing_units']=sum(u['units'] for u in usage if isinstance(u.get('units'),(int,float)))
    cost['unpriced_calls']=sum(totals.values())-sum(isinstance(u.get('cost_usd'),(int,float)) for u in metered)
    cost['visual_usage']=[*review_usages,*[receipt_usage(x) for x in work.get('planning_calls',[])],*[receipt_usage(x) for t in saved for k in ('planning_calls','review_calls') for x in t[k]]]
    cost['known_total_usd']=sum(u['cost_usd'] for u in metered if isinstance(u.get('cost_usd'),(int,float)))
    cost['known_drawing_usd']=sum(u['cost_usd'] for u in usage if isinstance(u.get('cost_usd'),(float,int)))
    cost['total_usd']=None if cost['unpriced_calls'] else sum(x['cost_usd'] for x in metered)
    atomic_write_json(out/'retrospective.json',{'job':job.job_id,'revision':work['revision'],'clips':clip_manifests,
         'stages':rows,'alternatives':saved,'cost':cost})
    return cost

def blind_pack(clips,out):
    """Re-encode RGBA frames to remove metadata and paths; keep key outside the package."""
    if not clips:raise ValueError('no clips')
    key=out.with_name(out.name+'-private-key.json')
    if key.exists():raise FileExistsError(key)
    out.mkdir(parents=True,exist_ok=False);order=list(clips);secrets.SystemRandom().shuffle(order)
    answers={};items=[]
    for entry in order:
        root,frames,fps=entry
        if not frames or not 1<=fps<=60:raise ValueError('clip requires frames and valid FPS')
        label=secrets.token_hex(8);answers[label]={'source':str(root),'first_frame':frames[0]['file']};folder=out/label;folder.mkdir()
        for i,f in enumerate(frames):
            data=inside(root,root/f['file']).read_bytes()
            if sha(data)!=f['sha256']:raise ValueError('clip frame hash mismatch')
            with Image.open(io.BytesIO(data)) as src:
                rgba=src.convert('RGBA');Image.frombytes('RGBA',rgba.size,rgba.tobytes()).save(folder/f'{i:03}.png')
        items.append({'id':label,'frames':len(frames),'fps':fps})
    atomic_write_json(out/'clips.json',items);atomic_write_json(key,answers)
    (out/'index.html').write_text('''<!doctype html><meta charset=utf-8><title>匿名动画评审</title><main></main><script>const clips='''+json.dumps(items)+''';for(const c of clips){const p=document.createElement('section'),h=document.createElement('h2'),im=new Image(),b=document.createElement('button');h.textContent=c.id;b.textContent='播放 / 暂停';p.append(h,im,b);document.querySelector('main').append(p);let i=0,t;function draw(){im.src=c.id+'/'+String(i).padStart(3,'0')+'.png';i=(i+1)%c.frames}draw();b.onclick=()=>{if(t){clearInterval(t);t=0}else{draw();t=setInterval(draw,1000/c.fps)}}}</script>''',encoding='utf8')

def main():
    import argparse
    parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='op',required=True)
    p=sub.add_parser('simulate');p.add_argument('arm',choices=ARMS);p.add_argument('reference',type=Path);p.add_argument('protocol',type=Path);p.add_argument('output',type=Path)
    p=sub.add_parser('export');p.add_argument('job_dir',type=Path);p.add_argument('work_json',type=Path);p.add_argument('output',type=Path)
    p=sub.add_parser('blind');p.add_argument('output',type=Path);p.add_argument('runs',type=Path,nargs='+')
    args=parser.parse_args()
    if args.op=='simulate':
        config=json.loads(args.protocol.read_bytes());verdicts=iter(config.get('mock_verdicts',[]))
        run_arm(args.arm,args.reference.read_bytes(),config['stages'],config['seed'],FixtureProvider(),lambda *_:next(verdicts),args.output,config['fps'])
    elif args.op=='export':retrospective(args.job_dir,json.loads(args.work_json.read_bytes()),args.work_json.parent/'adjustments',args.output)
    else:
        clips=[]
        for root in args.runs:
            if (root/'retrospective.json').exists():
                for clip in json.loads((root/'retrospective.json').read_bytes())['clips']:
                    clips.append((root,clip['frames'],clip['fps']))
                continue
            manifest=json.loads((root/'run.json').read_bytes())
            if manifest['status']!='complete':raise ValueError('incomplete clip')
            clips.append((root,manifest['frames'],manifest['fps']))
        blind_pack(clips,args.output)

if __name__=='__main__':main()
