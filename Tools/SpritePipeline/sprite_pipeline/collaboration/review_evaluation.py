"""Read-only review experiments over hash-checked copies of existing frames.

No generation, checkpoint decision, candidate adoption or production budget is
reachable here. A recorded submission is never automatically retried.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

from PIL import Image

from ..errors import ConflictError, ValidationHarnessError
from ..jsonio import atomic_write_json, read_json, inside
from ..store import JobStore
from ..vision_evidence import image_part, raster
from .contracts import CHARACTER_DIMENSIONS, PROP_DIMENSIONS, digest
from .motion_evidence import measurements
from .review_inputs import review_dimensions, observation_content, audit_content
from .visual_review import Observations, Audit, evidence_panels, grounded_audit

DIMENSIONS = CHARACTER_DIMENSIONS
CONTEXT_KEYS = {'interactable', 'user_request', 'quality_contract', 'segment_motion_constraints',
                'actual_stage_boundaries', 'timing_note', 'segment', 'appearance',
                'seconds_per_frame', 'pixel_cues_not_verdict'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


class ReviewEvidence:
    def __init__(self, folder):
        self.folder = Path(folder)
        self.manifest = read_json(self.folder / 'evidence.json')
        self.token = self.manifest['token']
        self.verify()

    @classmethod
    def create(cls, folder, *, paths, reference, fps, context, source, input_pose=None,
               target=None, target_note='', segment=False):
        if not 1 <= len(paths) <= 64 or not 1 <= fps <= 60:
            raise ValidationHarnessError('评估需要 1–64 张实际帧和有效 FPS')
        if set(context) - CONTEXT_KEYS:
            raise ValidationHarnessError('评估输入不允许包含人工标签或其他额外字段')
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=False)
        def save(path, filename):
            data = Path(path).read_bytes()
            with Image.open(Path(path)) as im:
                if im.format != 'PNG' or max(im.size) > 1024:
                    raise ValidationHarnessError('评估只接受已有 PNG 帧')
            (folder / filename).write_bytes(data)
            return {'file': filename, 'sha256': sha(data)}
        manifest = {'version': 1, 'scope': 'segment' if segment else 'clip', 'fps': fps,
                    'context': copy.deepcopy(context), 'source': copy.deepcopy(source),
                    'frames': [save(p, f'frame-{i:03d}.png') for i, p in enumerate(paths)],
                    'reference': save(reference, 'reference.png'), 'target_note': target_note}
        for key, path in [('input_pose', input_pose), ('target', target)]:
            if path is not None:
                manifest[key] = save(path, key + '.png')
        manifest['token'] = digest(manifest)
        atomic_write_json(folder / 'evidence.json', manifest)
        return cls(folder)

    @property
    def paths(self):
        return [inside(self.folder, self.folder / f['file']) for f in self.manifest['frames']]

    def verify(self):
        saved = read_json(self.folder / 'evidence.json')
        token = saved.pop('token')
        if token != self.token or digest(saved) != token or digest({k:v for k,v in self.manifest.items() if k!='token'}) != token:
            raise ConflictError('评估输入记录已改变')
        for item in [*saved['frames'], saved['reference'], *[saved[k] for k in ('input_pose', 'target') if k in saved]]:
            if sha(inside(self.folder, self.folder / item['file']).read_bytes()) != item['sha256']:
                raise ConflictError('评估图片已改变；旧意见不得用于当前图片')

    def pictures(self):
        self.verify()
        m = self.manifest
        result = evidence_panels(self.paths, self.folder / m['reference']['file'], m['fps'])
        for key, label in [
            ('input_pose', 'INPUT POSE, before frame 1; not a generated frame. Compare continuity to this accepted image.'),
            ('target', 'TARGET POSE GUIDE, NOT a generated frame. Verify whether actual frames approach it; do not claim exact pixel equality. Human target note: ' + m['target_note'])]:
            if key in m:
                result += [{'type': 'input_text', 'text': label}, image_part(raster(self.folder / m[key]['file'], 256))]
        return result

    def context(self):
        value = copy.deepcopy(self.manifest['context'])
        value['pixel_cues_not_verdict'] = measurements([p.read_bytes() for p in self.paths], self.manifest['fps'],
            value.get('interactable'), self.folder / self.manifest['reference']['file'])
        return value


def validated_audit(result, count, dimensions=DIMENSIONS):
    if {c.dimension for c in result.checks} != set(dimensions) or any(f < 1 or f > count for c in result.checks for f in c.frames):
        raise ValidationHarnessError('视觉验收维度或帧证据无效')
    verdict, checks, summary = grounded_audit(result, count)
    return {'verdict': verdict, 'checks': checks, 'summary': summary, 'model_audit': result.model_dump(mode='json')}


def raw_audit_verdict(checks):
    statuses = [c.get('status') for c in checks]
    if 'fail' in statuses:
        return 'fail'
    return 'pass' if statuses and all(s == 'pass' for s in statuses) else 'uncertain'


def unguarded_audit(result, count, dimensions=DIMENSIONS):
    """Validate structure and 1-based frame bounds without confidence or frame-floor guards."""
    if {c.dimension for c in result.checks} != set(dimensions) or any(f < 1 or f > count for c in result.checks for f in c.frames):
        raise ValidationHarnessError('视觉验收维度或帧证据无效')
    checks = [item.model_dump(mode='json') for item in result.checks]
    return {
        'verdict': raw_audit_verdict(checks),
        'checks': checks,
        'summary': result.summary,
        'model_audit': result.model_dump(mode='json'),
        'unguarded': True,
    }


def criterion_status(check):
    """Report abstentions explicitly; confidence alone is never accuracy evidence."""
    threshold = .8 if check['status'] == 'fail' else .85
    return check['status'] if check['status'] != 'uncertain' and check['confidence'] >= threshold else 'uncertain'


class ReviewExperiment:
    def __init__(self, registry, evidence, directory, *, snapshot, max_calls=2, charge=None):
        self.registry, self.evidence, self.directory = registry, evidence, Path(directory)
        self.snapshot, self.max_calls, self.charge = snapshot, max_calls, charge
        self.record = None

    def save(self):
        atomic_write_json(self.directory / 'review.json', self.record)

    def call(self, phase, content, schema, *, role='reviewer'):
        self.evidence.verify()
        if len(self.record['requests']) >= self.max_calls:
            raise ValidationHarnessError('旁路检查已达独立预算上限')
        if any(c['phase'] == phase for c in self.record['requests']):
            raise ConflictError('已提交的视觉请求不能重发')
        if self.charge:
            self.charge(phase)
        request = {'phase': phase, 'role': role, 'state': 'submitting',
                   'input_sha256': digest(content),
                   'profile': self.registry.profile(role, self.snapshot).model_dump(mode='json')}
        self.record['requests'].append(request)
        self.save()  # Persist before the external call, including unknown outcomes.
        receipt = {}
        try:
            result, metadata = self.registry.send(role, content, schema, len(self.evidence.paths),
                snapshot=self.snapshot, schema_name='open_motion_quality', on_response=receipt.update,
                **({'interactable': True} if self.evidence.manifest['context'].get('interactable') else {}))
            request.update(state='complete', **metadata)
            request['response'] = result.model_dump(mode='json')
            self.evidence.verify()
            return result
        finally:
            if request['state'] == 'submitting':
                request.update(state='failed_or_unknown', **receipt)
            self.save()

    def resolve(self, augmented, *, authorized=False):
        """Only one extra request. Parent evidence, models and opinions are frozen."""
        if not authorized or self.max_calls != 1:
            raise ValidationHarnessError('争议复核需要独立授权和一次调用上限')
        if augmented.get('evidence_token')!=self.evidence.token or augmented.get('mode')!='augmented' or augmented.get('state')!='complete':
            raise ConflictError('争议来源与当前证据不一致')
        if digest(augmented['model_snapshot']) != digest(self.snapshot):
            raise ConflictError('本轮复核模型配置必须与比较快照一致')
        binding=getattr(self.evidence,'structure_binding',None)
        if augmented.get('structure_binding')!=binding:
            raise ConflictError('争议所依据的结构版本与当前观察不一致')
        self.evidence.verify()
        self.directory.mkdir(parents=True,exist_ok=True)
        with JobStore._file_lock(None,self.directory/'.lock',timeout_seconds=.1,operation='dispute review'):
            path=self.directory/'review.json';parent=digest(augmented)
            if path.exists():
                self.record=read_json(path)
                if self.record.get('parent_digest')!=parent:
                    raise ConflictError('复核请求身份已用于不同的专家意见')
                if self.record['state']=='running':
                    self.record.update(state='unknown',summary='复核曾中断；未自动重发');self.save()
                self.evidence.verify()
                return self.record
            self.record={'version':1,'mode':'dispute','state':'running','advisory_only':True,
                'evidence_token':self.evidence.token,'model_snapshot':self.snapshot,'parent_digest':parent,
                'max_calls':1,'requests':[],'prior_requests':copy.deepcopy(augmented['requests'])}
            if binding:self.record['structure_binding']=copy.deepcopy(binding)
            self.save()
            try:
                from .dispute_review import Resolution,resolution_content,apply_resolution
                if not augmented['disputes']:
                    self.record.update(state='complete',checks=copy.deepcopy(augmented['checks']),verdict=augmented['verdict'],summary='没有需要追加观察的争议；未调用模型')
                else:
                    content,selection=resolution_content(self.evidence,augmented)
                    self.record['focus']=selection
                    if binding:
                        from .structure_judgment import StructureResolution,apply_structure_resolution
                        result=self.call('resolve',content,StructureResolution)
                        applied=apply_structure_resolution(augmented,result,self.evidence)
                    else:
                        result=self.call('resolve',content,Resolution)
                        applied=apply_resolution(augmented,result,len(self.evidence.paths))
                    self.record.update(state='complete',**applied)
            except Exception as exc:
                self.record.update(state='failed',verdict='uncertain',summary=str(exc) if isinstance(exc,(ValidationHarnessError,ConflictError)) else '争议复核未完成；旧结论仍保留，未重试')
            self.save()
            return self.record

    def run(self, *, mode='baseline', authorized=False):
        if not authorized:
            raise ValidationHarnessError('旁路视觉检查需要明确授权；未调用模型')
        if mode in ('baseline', 'independent'):
            if self.max_calls != 2:
                raise ValidationHarnessError('不支持的旁路检查配置')
        elif mode == 'self_consistency':
            if self.max_calls < 2:
                raise ValidationHarnessError('多数投票采样次数至少为 2')
        elif mode == 'experts_no_guard':
            if self.max_calls != 5:
                raise ValidationHarnessError('无守卫多视角对照需要 5 次调用上限')
        else:
            raise ValidationHarnessError('不支持的旁路检查配置')
        binding=getattr(self.evidence,'structure_binding',None)
        if mode in ('baseline', 'self_consistency', 'experts_no_guard') and binding:
            raise ValidationHarnessError('结构补充不得改变冻结的基础或等成本基线检查')
        self.directory.mkdir(parents=True, exist_ok=True)
        # The existing crash-safe OS lock is reused, but lives outside every job.
        with JobStore._file_lock(None, self.directory / '.lock', timeout_seconds=.1, operation='shadow review'):
            saved = self.directory / 'review.json'
            if saved.exists():
                self.record = read_json(saved)
                if self.record['evidence_token'] != self.evidence.token or self.record['mode'] != mode:
                    raise ConflictError('请求身份已用于另一组评估输入')
                if mode == 'self_consistency' and self.record.get('max_calls') != self.max_calls:
                    raise ConflictError('请求身份已用于不同的采样次数')
                if self.record.get('structure_binding')!=binding:
                    raise ConflictError('复核所依据的结构版本已改变')
                if self.record['state'] == 'running':
                    self.record.update(state='unknown', summary='上次检查被中断；不会自动重发')
                    self.save()
                self.evidence.verify()
                return self.record
            self.record = {'version': 1, 'mode': mode, 'state': 'running', 'advisory_only': True,
                           'evidence_token': self.evidence.token, 'model_snapshot': self.snapshot,
                           'max_calls': self.max_calls, 'requests': []}
            if binding:self.record['structure_binding']=copy.deepcopy(binding)
            self.save()
            try:
                pictures = self.evidence.pictures()
                segment = self.evidence.manifest['scope'] == 'segment'
                dims = review_dimensions(self.evidence.manifest['context'])
                count = len(self.evidence.paths)
                if mode == 'baseline':
                    observations = self.call('observe', observation_content(pictures, segment=segment, interactable=bool(self.evidence.manifest['context'].get('interactable'))), Observations)
                    if [o.frame for o in observations.frames] != list(range(1, count + 1)):
                        raise ValidationHarnessError('逐帧观察不完整或顺序错误')
                    self.record['observations'] = observations.model_dump(mode='json')
                    context = self.evidence.context()
                    context['observations'] = self.record['observations']
                    result = self.call('audit', audit_content(pictures, context, self.evidence.manifest['fps'], segment=segment), Audit)
                    self.record.update(state='complete', **validated_audit(result, count, dims))
                elif mode == 'independent':
                    from .independent_review import EXPERTS, PROMPT_VERSION, expert_content, consensus
                    self.record.update(experts={}, prompt_version=PROMPT_VERSION)
                    for expert in EXPERTS:
                        # No previous opinion or observation is passed to the next expert.
                        result = self.call(expert, expert_content(self.evidence, expert), Audit)
                        self.record['experts'][expert] = validated_audit(result, count, dims)
                        self.save()
                    self.record.update(state='complete', **consensus(self.record['experts'], count))
                elif mode == 'self_consistency':
                    self.record['samples'] = []
                    context = self.evidence.context()
                    content = audit_content(pictures, context, self.evidence.manifest['fps'], segment=segment)
                    for idx in range(1, self.max_calls + 1):
                        result = self.call(f'sample_{idx}', content, Audit)
                        self.record['samples'].append(unguarded_audit(result, count, dims))
                        self.save()
                    checks = []
                    for dim in dims:
                        dim_checks = [next(c for c in s['checks'] if c['dimension'] == dim) for s in self.record['samples']]
                        counts = {s: sum(1 for c in dim_checks if c['status'] == s) for s in ('pass', 'fail', 'uncertain')}
                        ordered = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
                        if ordered[0][1] > ordered[1][1]:
                            winner = ordered[0][0]
                            voters = [c for c in dim_checks if c['status'] == winner]
                            confidence = round(sum(float(c['confidence']) for c in voters) / len(voters), 4)
                            frames = list(voters[0]['frames'])
                            evidence = voters[0]['evidence']
                        else:
                            winner = 'uncertain'
                            confidence = 0.0
                            frames = sorted({f for c in dim_checks for f in c['frames']})
                            evidence = dim_checks[0]['evidence']
                        checks.append({
                            'dimension': dim, 'status': winner, 'confidence': confidence,
                            'frames': frames, 'evidence': evidence,
                            'vote_counts': counts, 'vote_share': round(counts[winner] / self.max_calls, 4),
                        })
                    self.record.update(
                        state='complete', unguarded=True, checks=checks, verdict=raw_audit_verdict(checks),
                        summary=f'同模型 {self.max_calls} 次独立采样多数投票（无守卫）',
                    )
                else:
                    from .independent_review import EXPERTS, PROMPT_VERSION, expert_content
                    from .dispute_review import Resolution, resolution_content
                    observations = self.call('observe', observation_content(pictures, segment=segment, interactable=bool(self.evidence.manifest['context'].get('interactable'))), Observations)
                    if [o.frame for o in observations.frames] != list(range(1, count + 1)):
                        raise ValidationHarnessError('逐帧观察不完整或顺序错误')
                    self.record['observations'] = observations.model_dump(mode='json')
                    context = self.evidence.context()
                    context['observations'] = self.record['observations']
                    baseline_res = self.call('audit', audit_content(pictures, context, self.evidence.manifest['fps'], segment=segment), Audit)
                    baseline_raw = unguarded_audit(baseline_res, count, dims)
                    self.record.update(baseline=baseline_raw, experts={}, prompt_version=PROMPT_VERSION)
                    self.save()
                    for expert in EXPERTS:
                        exp_res = self.call(expert, expert_content(self.evidence, expert), Audit)
                        self.record['experts'][expert] = unguarded_audit(exp_res, count, dims)
                        self.save()
                    disputes = []
                    for dim in dims:
                        prior = next(c for c in baseline_raw['checks'] if c['dimension'] == dim)
                        peers = {exp: next(c for c in self.record['experts'][exp]['checks'] if c['dimension'] == dim) for exp in EXPERTS}
                        states = [prior['status'], *(p['status'] for p in peers.values())]
                        if len(set(states)) != 1 or states[0] == 'uncertain':
                            disputes.append({
                                'dimension': dim,
                                'frames': sorted({f for c in (prior, *peers.values()) for f in c['frames']}),
                                'baseline': copy.deepcopy(prior), 'opinions': copy.deepcopy(peers),
                                'reason': 'evidence_or_opinion_disagreement',
                            })
                    self.record['disputes'] = disputes
                    if not disputes:
                        checks = copy.deepcopy(baseline_raw['checks'])
                        self.record.update(
                            state='complete', unguarded=True, checks=checks, verdict=raw_audit_verdict(checks),
                            summary='多视角意见一致（无守卫）；未调用争议复核',
                        )
                    else:
                        content, selection = resolution_content(self.evidence, {'disputes': disputes, 'checks': baseline_raw['checks']})
                        self.record['focus'] = selection
                        resolved = self.call('resolve', content, Resolution)
                        if {c.dimension for c in resolved.checks} != set(dims) or any(f < 1 or f > count for c in resolved.checks for f in c.frames):
                            raise ValidationHarnessError('争议复核维度或帧证据无效')
                        status_map = {'satisfied': 'pass', 'material_defect': 'fail', 'preference': 'uncertain', 'insufficient_evidence': 'uncertain'}
                        disputed_dims = {d['dimension'] for d in disputes}
                        checks = copy.deepcopy(baseline_raw['checks'])
                        for item in resolved.checks:
                            if item.dimension in disputed_dims:
                                idx = next(i for i, c in enumerate(checks) if c['dimension'] == item.dimension)
                                checks[idx] = {
                                    'dimension': item.dimension,
                                    'status': status_map[item.classification],
                                    'confidence': float(item.confidence),
                                    'frames': list(item.frames),
                                    'evidence': item.evidence,
                                    'classification': item.classification,
                                }
                        self.record.update(
                            state='complete', unguarded=True, checks=checks, verdict=raw_audit_verdict(checks),
                            summary=resolved.summary, resolution=resolved.model_dump(mode='json'),
                        )
            except Exception as exc:
                self.record.update(state='failed', verdict='uncertain',
                    summary=str(exc) if isinstance(exc, (ValidationHarnessError, ConflictError)) else '旁路检查未完成；未重试，也未改变生产结果')
            self.save()
            return self.record


def _case_dimensions(expected, dimensions=None):
    if dimensions is not None:
        return tuple(dimensions)
    if set(expected) == set(PROP_DIMENSIONS):
        return PROP_DIMENSIONS
    return DIMENSIONS


def _review_rates(totals, confusion):
    criteria = totals['criteria']
    decided = criteria - totals['abstentions']
    fail_truth = sum(confusion['fail'].values())
    pass_truth = sum(confusion['pass'].values())
    return {
        'coverage': round(decided / criteria, 6) if criteria else 0.0,
        'abstention_rate': round(totals['abstentions'] / criteria, 6) if criteria else 0.0,
        'false_accept_rate_overall': round(totals['false_negative'] / fail_truth, 6) if fail_truth else None,
        'false_accept_rate_selective': round(totals['false_negative'] / decided, 6) if decided else None,
        'false_reject_rate_overall': round(totals['false_positive'] / pass_truth, 6) if pass_truth else None,
        'selective_error_rate': (
            round((totals['false_positive'] + totals['false_negative'] + totals['disputed_overconfidence']) / decided, 6)
            if decided else None
        ),
    }


def score_reviews(labels, reports, *, dimensions=None):
    """Labels are local-only and never part of model inputs. No cherry-picking.

    Supports both character (``CHARACTER_DIMENSIONS``) and interactable
    (``PROP_DIMENSIONS``) review rubrics. Note metric polarity:
    ``false_positive`` counts false rejects (truth=pass, pred=fail), while
    ``false_negative`` counts false accepts (truth=fail, pred=pass).
    """
    totals = {k: 0 for k in ('criteria', 'correct', 'false_positive', 'false_negative',
        'abstentions', 'missed_defects', 'unnecessary_blocks', 'disputed_overconfidence', 'failed_reports')}
    confusion = {t: {p: 0 for p in ('pass', 'fail', 'uncertain')} for t in ('pass', 'fail', 'uncertain')}
    rows = []
    for case, expected in labels.items():
        report = reports.get(case, {})
        if report.get('state') != 'complete':
            totals['failed_reports'] += 1
        checks = {c['dimension']: c for c in report.get('checks', [])} if report.get('state') == 'complete' else {}
        unguarded = bool(report.get('unguarded'))
        for dimension in _case_dimensions(expected, dimensions):
            truth = expected[dimension]['status']
            if dimension in checks:
                check = checks[dimension]
                prediction = check['status'] if (unguarded and check.get('status') in ('pass', 'fail', 'uncertain')) else criterion_status(check)
            else:
                prediction = 'uncertain'
            totals['criteria'] += 1
            totals['correct'] += truth == prediction
            totals['abstentions'] += prediction == 'uncertain'
            totals['false_positive'] += truth == 'pass' and prediction == 'fail'
            totals['false_negative'] += truth == 'fail' and prediction == 'pass'
            totals['missed_defects'] += truth == 'fail' and prediction != 'fail'
            totals['unnecessary_blocks'] += truth == 'pass' and prediction != 'pass'
            totals['disputed_overconfidence'] += truth == 'uncertain' and prediction != 'uncertain'
            confusion[truth][prediction] += 1
            rows.append({'case': case, 'dimension': dimension, 'expected': truth, 'actual': prediction})
    return {'totals': totals, 'rows': rows, 'label_digest': digest(labels),
            'confusion_matrix': confusion, 'rates': _review_rates(totals, confusion)}


def _raw_check_signal(report, dimension):
    if report.get('state') != 'complete':
        return 'uncertain', 0.0, True
    adjudicated = {
        item.get('dimension')
        for item in (report.get('requires_human_adjudication') or [])
        if isinstance(item, dict)
    }
    if dimension in adjudicated:
        return 'uncertain', 0.0, True
    checks = {c['dimension']: c for c in report.get('checks', [])}
    check = checks.get(dimension)
    if check is None:
        return 'uncertain', 0.0, True
    status = check.get('status', 'uncertain')
    confidence = float(check.get('confidence', 0.0))
    return status, confidence, status == 'uncertain'


def risk_coverage_curve(labels, reports, *, thresholds=None, dimensions=None):
    """Sweep confidence thresholds over saved checks to measure risk vs coverage."""
    sweep = (0.0, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95) if thresholds is None else tuple(thresholds)
    points = []
    for tau in sweep:
        tau = float(tau)
        totals = {k: 0 for k in ('criteria', 'correct', 'false_positive', 'false_negative',
            'abstentions', 'missed_defects', 'unnecessary_blocks', 'disputed_overconfidence')}
        confusion = {t: {p: 0 for p in ('pass', 'fail', 'uncertain')} for t in ('pass', 'fail', 'uncertain')}
        for case, expected in labels.items():
            report = reports.get(case, {})
            for dimension in _case_dimensions(expected, dimensions):
                truth = expected[dimension]['status']
                raw_status, raw_conf, forced_abstain = _raw_check_signal(report, dimension)
                prediction = raw_status if (not forced_abstain and raw_status in ('pass', 'fail') and raw_conf >= tau) else 'uncertain'
                totals['criteria'] += 1
                totals['correct'] += truth == prediction
                totals['abstentions'] += prediction == 'uncertain'
                totals['false_positive'] += truth == 'pass' and prediction == 'fail'
                totals['false_negative'] += truth == 'fail' and prediction == 'pass'
                totals['missed_defects'] += truth == 'fail' and prediction != 'fail'
                totals['unnecessary_blocks'] += truth == 'pass' and prediction != 'pass'
                totals['disputed_overconfidence'] += truth == 'uncertain' and prediction != 'uncertain'
                confusion[truth][prediction] += 1
        rates = _review_rates(totals, confusion)
        decided = totals['criteria'] - totals['abstentions']
        points.append({
            'threshold': tau,
            **rates,
            'counts': {
                'criteria': totals['criteria'],
                'decided': decided,
                'abstentions': totals['abstentions'],
                'false_negative': totals['false_negative'],
                'false_positive': totals['false_positive'],
                'missed_defects': totals['missed_defects'],
                'unnecessary_blocks': totals['unnecessary_blocks'],
            },
        })
    return points


def comparison_gate(baseline, proposed, *, sources_unchanged):
    metrics = ('false_positive', 'false_negative', 'missed_defects', 'unnecessary_blocks',
               'disputed_overconfidence', 'failed_reports')
    regressions = [k for k in metrics if proposed['totals'][k] > baseline['totals'][k]]
    if baseline.get('label_digest') != proposed.get('label_digest'):
        regressions.append('changed_labels')
    if {(r['case'],r['dimension']) for r in baseline['rows']} != {(r['case'],r['dimension']) for r in proposed['rows']}:
        regressions.append('changed_coverage')
    if not sources_unchanged:
        regressions.append('source_mutation')
    # Also prevent an improvement elsewhere from concealing a newly broken case.
    old = {(r['case'], r['dimension']): r for r in baseline['rows']}
    for row in proposed['rows']:
        before = old.get((row['case'], row['dimension']))
        if before is None:
            continue
        if before['actual'] == before['expected'] and row['actual'] != row['expected']:
            regressions.append(f"case_regression:{row['case']}:{row['dimension']}")
    return {'can_advance': not regressions, 'regressions': regressions,
            'improved': [k for k in metrics if proposed['totals'][k] < baseline['totals'][k]],
            'scope': 'This frozen corpus only; no claim of generalization or production activation.'}
