"""Developer-only shadow evaluation; not a production capability or approval API."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
from types import SimpleNamespace

from ..errors import ValidationHarnessError, NotFoundError
from ..jsonio import read_json
from ..settings import HarnessSettings
from ..store import JobStore
from .model_config import ModelRegistry, ModelConfiguration
from .review_evaluation import ReviewEvidence, ReviewExperiment, risk_coverage_curve, score_reviews
from .independent_review import attach_opinions
from .review_sources import snapshot_review


def main(argv=None):
    parser=argparse.ArgumentParser(description='只读动画旁路评估；不会生成、采用、修复或导出素材')
    parser.add_argument('--data-root',type=Path,help='SpritePipeline 的现有数据目录')
    commands=parser.add_subparsers(dest='command',required=True)
    snapshot=commands.add_parser('snapshot',help='复制实际帧与验收合同，不调用模型')
    snapshot.add_argument('--job',required=True)
    snapshot.add_argument('--candidate',type=int,required=True)
    snapshot.add_argument('--stage',type=int)
    snapshot.add_argument('--token',required=True)
    snapshot.add_argument('--output',type=Path,required=True)
    inspect=commands.add_parser('inspect',help='只读验证已有证据')
    inspect.add_argument('--evidence',type=Path,required=True)
    for command in ('baseline','independent','resolve','self-consistency','experts-no-guard'):
        run=commands.add_parser(command,help='需要明确授权的旁路视觉调用')
        run.add_argument('--evidence',type=Path,required=True)
        run.add_argument('--output',type=Path,required=True)
        run.add_argument('--model-snapshot',type=Path)
        run.add_argument('--authorize-review',action='store_true')
        if command=='resolve':run.add_argument('--parent',type=Path,required=True)
        if command=='self-consistency':run.add_argument('--calls',type=int,default=5)
    combine=commands.add_parser('combine',help='保留基线，补充独立意见；不调用模型')
    combine.add_argument('--baseline',type=Path,required=True)
    combine.add_argument('--independent',type=Path,required=True)
    combine.add_argument('--output',type=Path,required=True)
    score=commands.add_parser('score',help='本地计算误报、漏报与未决项；标签不会发送给模型')
    score.add_argument('--labels',type=Path,required=True)
    score.add_argument('--reports',type=Path,required=True,help='JSON mapping of case IDs to report files')
    score.add_argument('--risk-coverage',action='store_true',help='另输出置信度阈值扫描下的 Risk-Coverage 曲线')
    args=parser.parse_args(argv)
    if args.command=='inspect':
        evidence=ReviewEvidence(args.evidence)
        return {'token':evidence.token,'frames':len(evidence.paths),'scope':evidence.manifest['scope'],'provider_called':False}
    if args.command=='score':
        labels=read_json(args.labels)
        label_map=labels.get('labels',labels)
        loaded={k:read_json(Path(p)) for k,p in read_json(args.reports).items()}
        scored=score_reviews(label_map,loaded)
        if args.risk_coverage:
            scored['risk_coverage']=risk_coverage_curve(label_map,loaded)
        return scored
    if args.command=='combine':
        result=attach_opinions(read_json(args.baseline),read_json(args.independent))
        # A new report only; never overwrite historical evidence.
        args.output.parent.mkdir(parents=True,exist_ok=True)
        with args.output.open('x',encoding='utf-8') as stream:
            json.dump(result,stream,ensure_ascii=False,indent=2)
        return {'state':'complete','advisory_only':True,'output':str(args.output),'provider_called':False}
    if args.command!='snapshot' and not args.authorize_review:
        raise ValidationHarnessError('缺少 --authorize-review；未调用模型')
    if args.data_root:
        os.environ['SPRITE_PIPELINE_DATA_DIR']=str(args.data_root.resolve())
    # Read credentials only; do not run service initialization or migrations.
    os.environ['SPRITE_PIPELINE_IMPORT_USER_CREDENTIALS']='0'
    settings=HarnessSettings.load()
    destination=args.output.resolve()
    if any(destination.is_relative_to(p.resolve()) for p in (settings.jobs_dir,settings.config_dir,settings.user_characters_dir,settings.exports_dir)):
        raise ValidationHarnessError('评估输出必须放在正式作业、配置、角色和导出目录之外')
    if args.command=='snapshot':
        def candidate(job,index):
            found=next((c for c in job.candidates if c.candidate_index==index),None)
            if found is None:raise NotFoundError('candidate not found')
            return found
        source=SimpleNamespace(settings=settings,store=JobStore(settings),_candidate=candidate)
        evidence=snapshot_review(source,args.job,args.candidate,destination,expected_token=args.token,stage=args.stage)
        return {'token':evidence.token,'frames':len(evidence.paths),'provider_called':False}
    evidence=ReviewEvidence(args.evidence)
    if destination.is_relative_to(evidence.folder.resolve()):
        raise ValidationHarnessError('报告目录必须与证据快照分开')
    registry=ModelRegistry(settings)
    if args.model_snapshot:
        models=ModelConfiguration.model_validate(read_json(args.model_snapshot)).model_dump(mode='json')
    elif args.command=='resolve':
        models=read_json(args.parent)['model_snapshot']
    elif (destination/'review.json').exists():
        models=read_json(destination/'review.json')['model_snapshot']
    else:
        models=registry.load().model_dump(mode='json')
    max_calls = 1 if args.command == 'resolve' else (args.calls if args.command == 'self-consistency' else (5 if args.command == 'experts-no-guard' else 2))
    run=ReviewExperiment(registry,evidence,destination,snapshot=models,max_calls=max_calls)
    mode_map={'self-consistency':'self_consistency','experts-no-guard':'experts_no_guard'}
    result=(run.resolve(read_json(args.parent),authorized=True) if args.command=='resolve' else run.run(mode=mode_map.get(args.command,args.command),authorized=True))
    return {'state':result['state'],'advisory_only':True,'verdict':result.get('verdict'),
        'recorded_calls':len(result['requests']),'output':str(destination/'review.json')}


if __name__=='__main__':
    try:
        print(json.dumps(main(),ensure_ascii=False,indent=2))
    except (ValidationHarnessError,NotFoundError) as exc:
        raise SystemExit(str(exc)) from None
