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
        if mode not in ('baseline', 'independent') or self.max_calls != 2:
            raise ValidationHarnessError('不支持的旁路检查配置')
        binding=getattr(self.evidence,'structure_binding',None)
        if mode=='baseline' and binding:
            raise ValidationHarnessError('结构补充不得改变冻结的两次基础检查')
        self.directory.mkdir(parents=True, exist_ok=True)
        # The existing crash-safe OS lock is reused, but lives outside every job.
        with JobStore._file_lock(None, self.directory / '.lock', timeout_seconds=.1, operation='shadow review'):
            saved = self.directory / 'review.json'
            if saved.exists():
                self.record = read_json(saved)
                if self.record['evidence_token'] != self.evidence.token or self.record['mode'] != mode:
                    raise ConflictError('请求身份已用于另一组评估输入')
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
                if mode == 'baseline':
                    pictures = self.evidence.pictures()
                    segment = self.evidence.manifest['scope'] == 'segment'
                    observations = self.call('observe', observation_content(pictures, segment=segment, interactable=bool(self.evidence.manifest['context'].get('interactable'))), Observations)
                    if [o.frame for o in observations.frames] != list(range(1, len(self.evidence.paths)+1)):
                        raise ValidationHarnessError('逐帧观察不完整或顺序错误')
                    self.record['observations'] = observations.model_dump(mode='json')
                    context = self.evidence.context()
                    context['observations'] = self.record['observations']
                    result = self.call('audit', audit_content(pictures, context, self.evidence.manifest['fps'], segment=segment), Audit)
                    self.record.update(state='complete', **validated_audit(result, len(self.evidence.paths), review_dimensions(self.evidence.manifest['context'])))
                else:
                    from .independent_review import EXPERTS, PROMPT_VERSION, expert_content, consensus
                    self.record.update(experts={}, prompt_version=PROMPT_VERSION)
                    for expert in EXPERTS:
                        # No previous opinion or observation is passed to the next expert.
                        result = self.call(expert, expert_content(self.evidence, expert), Audit)
                        self.record['experts'][expert] = validated_audit(result, len(self.evidence.paths), review_dimensions(self.evidence.manifest['context']))
                        self.save()
                    self.record.update(state='complete', **consensus(self.record['experts'], len(self.evidence.paths)))
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


def score_reviews(labels, reports, *, dimensions=None):
    """Labels are local-only and never part of model inputs. No cherry-picking.

    Supports both character (``CHARACTER_DIMENSIONS``) and interactable
    (``PROP_DIMENSIONS``) review rubrics. Note metric polarity:
    ``false_positive`` counts false rejects (truth=pass, pred=fail), while
    ``false_negative`` counts false accepts (truth=fail, pred=pass).
    """
    totals = {k: 0 for k in ('criteria', 'correct', 'false_positive', 'false_negative',
        'abstentions', 'missed_defects', 'unnecessary_blocks', 'disputed_overconfidence', 'failed_reports')}
    rows = []
    for case, expected in labels.items():
        report = reports.get(case, {})
        if report.get('state') != 'complete':
            totals['failed_reports'] += 1
        checks = {c['dimension']: c for c in report.get('checks', [])} if report.get('state') == 'complete' else {}
        for dimension in _case_dimensions(expected, dimensions):
            truth = expected[dimension]['status']
            prediction = criterion_status(checks[dimension]) if dimension in checks else 'uncertain'
            totals['criteria'] += 1
            totals['correct'] += truth == prediction
            totals['abstentions'] += prediction == 'uncertain'
            totals['false_positive'] += truth == 'pass' and prediction == 'fail'
            totals['false_negative'] += truth == 'fail' and prediction == 'pass'
            totals['missed_defects'] += truth == 'fail' and prediction != 'fail'
            totals['unnecessary_blocks'] += truth == 'pass' and prediction != 'pass'
            totals['disputed_overconfidence'] += truth == 'uncertain' and prediction != 'uncertain'
            rows.append({'case': case, 'dimension': dimension, 'expected': truth, 'actual': prediction})
    return {'totals': totals, 'rows': rows, 'label_digest': digest(labels)}


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
