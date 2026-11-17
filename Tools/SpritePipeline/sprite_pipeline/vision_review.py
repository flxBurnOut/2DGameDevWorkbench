"""Bounded, structured visual review. Never retries a potentially billed request."""
from __future__ import annotations
import base64
import hashlib
import io
import json
import os
import re
from pathlib import Path
from typing import Literal
import httpx
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from .motion_constraints import Phase
from .credential_store import CredentialStore
from .errors import InvalidPlanningResponse, ValidationHarnessError
from .jsonio import atomic_write_json, read_json

MAX_REVIEW_FRAMES = 64
MODEL = "gpt-5.4-2026-03-05"
HUNYUAN_MODEL = "hy-vision-2.0-instruct"
PROVIDERS = {
    "hunyuan": {"label":"混元 HY Vision 2.0", "model":HUNYUAN_MODEL,
                "endpoint":"https://tokenhub.tencentmaas.com/v1/chat/completions",
                "key_env":"TOKENHUB_API_KEY", "key_name":"motion_hunyuan_api_key"},
    "openai": {"label":"OpenAI GPT-5.4", "model":MODEL,
               "endpoint":"https://api.openai.com/v1/responses",
               "key_env":"OPENAI_API_KEY", "key_name":"motion_vision_api_key"},
}


def planning_validation_fields(error):
    fields = []
    for issue in error.errors(include_input=False, include_context=False, include_url=False)[:12]:
        location = issue['loc']
        if issue['type'] == 'extra_forbidden':
            location = (*location[:-1], '<extra field>')
        path = '.'.join(str(part) for part in location) or 'turn'
        fields.append(f"{path}: {issue['msg'][:200]}")
    return fields


class MotionIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: Literal["early_swing", "weapon_flip", "second_windup", "extra_strike", "body_discontinuity", "identity_drift", "weapon_deformation", "hand_swap", "incomplete_action", "other"]
    frames: list[int] = Field(min_length=1, max_length=MAX_REVIEW_FRAMES)
    description: str = Field(max_length=500)
    correction: str = Field(max_length=500)
    evidence_status: Literal["unverified", "confirmed"] = "unverified"
    evidence_confidence: float = Field(default=0, ge=0, le=1)
    phase: Phase = "unknown"
    phase_confidence: float = Field(default=0, ge=0, le=1)

class MotionReview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    verdict: Literal["pass", "fail", "uncertain"]
    confidence: float = Field(ge=0, le=1)
    summary: str = Field(max_length=800)
    issues: list[MotionIssue] = Field(max_length=MAX_REVIEW_FRAMES)

    @model_validator(mode="after")
    def consistent(self):
        if self.verdict == "pass" and self.issues:
            raise ValueError("passing review cannot contain unresolved issues")
        if self.verdict == "fail" and not self.issues:
            raise ValueError("failing review needs localized evidence")
        return self

from .vision_sequence import FramePose

from .vision_grip import ReferenceGrip, GRIP_REVIEW_INSTRUCTION, assess_grip

class ObservedReview(MotionReview):
    reference_grip: ReferenceGrip = "occluded"
    observations: list[FramePose] = Field(min_length=1, max_length=MAX_REVIEW_FRAMES)


def contract(action_id: str, frame_count: int = 16) -> str:
    phases = ("prepare, one airborne swing, extend, follow through, recover; no extra attack cycle."
              if action_id == "attack_in_air" else
              "prepare, raise blade behind shoulder, charge, one forward high-to-low strike, follow through, recover. Holds are allowed.")
    return (f"Inspect all {frame_count} actual frames in order, without forcing fixed phase boundaries. "
            "Blade orientation and apparent length naturally change with motion and perspective. "
            "Judge physical continuity relative to the grip, not identical screen-space direction. "
            "Only clear contradictions count as defects. Phase order: " + phases
            + (" A single frame cannot establish temporal continuity; verdict must be uncertain." if frame_count==1 else ""))

class VisionReviewer:
    def __init__(self, settings):
        self.settings = settings

    @property
    def provider(self):
        value=os.environ.get("SPRITE_PIPELINE_VISION_PROVIDER", "").strip()
        path=self.settings.config_dir/"motion_vision.json"
        if not value:
            value=read_json(path).get("provider") if path.exists() else "hunyuan"
        if value not in PROVIDERS:
            raise ValidationHarnessError("视觉检查服务配置无效，请在设置中重新选择")
        return value

    @property
    def info(self):
        return PROVIDERS[self.provider]

    def select(self, provider):
        if provider not in PROVIDERS:
            raise ValidationHarnessError("不支持的视觉检查服务")
        override=os.environ.get("SPRITE_PIPELINE_VISION_PROVIDER", "").strip()
        if override and override != provider:
            raise ValidationHarnessError("视觉检查服务由启动环境管理")
        atomic_write_json(self.settings.config_dir/"motion_vision.json", {"provider":provider})

    def key(self):
        info=self.info
        return os.environ.get(info["key_env"], "").strip() or CredentialStore(self.settings.config_dir).get(info["key_name"])

    def save_key(self, value):
        info=self.info
        if os.environ.get(info["key_env"], "").strip():
            raise ValidationHarnessError("当前视觉 Key 由启动环境管理")
        key=(value or "").strip()
        if key and (not 8 <= len(key) <= 4096 or any(not 33 <= ord(ch) <= 126 for ch in key)):
            raise ValidationHarnessError("视觉检查 Key 格式无效")
        CredentialStore(self.settings.config_dir).set(info["key_name"],key or None)

    @property
    def configured(self):
        return bool(self.key())

    @staticmethod
    def validate_inputs(paths: list[Path], reference: Path) -> None:
        if not 1 <= len(paths) <= MAX_REVIEW_FRAMES:
            raise ValidationHarnessError(f"视觉检查支持 1–{MAX_REVIEW_FRAMES} 帧；实际收到 {len(paths)} 帧，尚未发送请求")
        try:
            for path in [reference, *paths]:
                with Image.open(path) as source:
                    if not 1 <= source.width <= 512 or not 1 <= source.height <= 512:
                        raise ValueError("unsupported image size")
                    source.verify()
        except Exception:
            raise ValidationHarnessError("视觉检查参考图或动画帧无法读取；尚未发送请求") from None

    def _send(self, content, schema_type, provider, key, frame_count, on_request, *, schema_name="attack_motion_review", on_response=None, model_options=None, output_format=None):
        if output_format not in (None, 'json_object', 'json_schema'):
            raise ValidationHarnessError('未知的模型输出格式；未发送请求')
        if provider != 'hunyuan' and output_format == 'json_object':
            raise ValidationHarnessError('当前 Responses 适配使用既有严格 Schema；未发送请求')
        info = dict(PROVIDERS[provider])
        if model_options:
            info['model'] = model_options['model']
        schema = schema_type.model_json_schema()
        def strict(value):
            if isinstance(value, dict):
                value.pop("default", None)
                if value.get("type") == "object" and "properties" in value:
                    value["required"] = list(value["properties"])
                for child in value.values(): strict(child)
            elif isinstance(value, list):
                for child in value: strict(child)
        strict(schema)
        for definition in schema.get("$defs",{}).values():
            properties=definition.get("properties",{})
            if "frame" in properties: properties["frame"].update(minimum=1, maximum=frame_count)
            if "frames" in properties: properties["frames"]["items"].update(minimum=1, maximum=frame_count)
        body = {"model":info["model"], "store":False, "reasoning":{"effort":"high"}, "max_output_tokens":6000,
            "input":[{"role":"user", "content":content}],
            "text":{"format":{"type":"json_schema", "name":schema_name, "strict":True, "schema":schema}}}
        if provider == "hunyuan":
            chat_content=[]
            for part in content:
                if part["type"]=="input_text":
                    chat_content.append({"type":"text","text":part["text"]})
                else:
                    chat_content.append({"type":"image_url","image_url":{"url":part["image_url"],"detail":"high"}})
            chat_content.append({"type":"text","text":"Return exactly one JSON object matching this schema, without prose or Markdown. " + json.dumps(schema,ensure_ascii=False)})
            body={"model":info["model"],"stream":False,"temperature":0,"max_tokens":6000,
                  "messages":[{"role":"user","content":chat_content}],"response_format":{"type":"json_object"}}
            if output_format == 'json_schema':
                body['response_format']={'type':'json_schema','json_schema':{'name':schema_name,'strict':True,'schema':schema}}
        if model_options:
            limit = model_options['max_output_tokens']
            effort = model_options['reasoning_effort']
            if provider == 'hunyuan':
                body.pop('temperature', None)  # Sampling constraints vary across foundation models.
                body.pop('max_tokens', None)
                token_parameter = model_options['token_parameter']
                if token_parameter == 'auto':
                    token_parameter = 'max_completion_tokens' if info['model'].startswith('kimi-k3') else 'max_tokens'
                body[token_parameter] = limit
                if info['model'] == HUNYUAN_MODEL:
                    body['temperature'] = 0
                if effort != 'auto': body['reasoning_effort'] = effort
            else:
                body['max_output_tokens'] = limit
                if effort == 'auto': body.pop('reasoning', None)
                else: body['reasoning'] = {'effort': effort}
        output = None
        try:
            with httpx.Client(timeout=model_options.get('timeout_seconds',180) if model_options else 180, follow_redirects=False) as client:
                if on_request is not None: on_request()
                response=client.post(info["endpoint"], headers={"Authorization":"Bearer "+key}, json=body)
            if response.status_code != 200:
                failure={'http_status':response.status_code}
                # Keep bounded diagnostics, never raw provider bodies, echoed
                # prompts, images or credentials. Existing request transport stays unchanged.
                try:
                    if response.status_code != 400:
                        raise ValueError('Only malformed-request diagnostics are inspected')
                    payload=response.json()
                    error=payload.get('error') or payload.get('Response',{}).get('Error',{})
                    if isinstance(error,dict):
                        code=error.get('code') or error.get('Code') or error.get('type')
                        if isinstance(code,str) and re.fullmatch(r'[A-Za-z][A-Za-z_.]{2,79}',code):failure['provider_error_code']=code
                        message=str(error.get('message') or error.get('Message') or '').lower()
                        for parameter in ('max_completion_tokens','max_tokens','reasoning_effort','response_format','image_url','model'):
                            if parameter in message:failure['provider_error_parameter']=parameter;break
                    request_id=response.headers.get('x-request-id') or response.headers.get('x-tc-requestid')
                    if isinstance(request_id,str) and re.fullmatch(r'[A-Za-z0-9_-]{8,100}',request_id):failure['provider_request_id']=request_id
                except (ValueError,TypeError,AttributeError):pass
                if on_response is not None:on_response(failure)
                hint='；参数：'+failure['provider_error_parameter'] if failure.get('provider_error_parameter') else ''
                raise ValidationHarnessError(f"视觉检查请求失败（HTTP {response.status_code}{hint}）；未自动重试", details=failure)
            data=response.json()
            if provider == "hunyuan":
                choices=data.get("choices",[])
                if len(choices)!=1:
                    raise ValueError("incomplete visual review")
                message=choices[0].get("message",{})
                if message.get("refusal") or message.get("tool_calls"):
                    raise ValueError("visual review refused")
                output=message.get("content")
            else:
                if data.get("status") != "completed":
                    raise ValueError("incomplete visual review")
                output="".join(part.get("text", "") for item in data.get("output", []) if item.get("type")=="message" for part in item.get("content", []) if part.get("type")=="output_text")
            response_model=data.get("model")
            receipt={"requested_model":info["model"], "response_model":response_model,
                     "response_id":data.get("id"),"usage":data.get("usage",{})}
            if provider == 'hunyuan': receipt['finish_reason'] = choices[0].get('finish_reason')
            if on_response is not None:
                on_response({**receipt, "output_characters":len(output) if isinstance(output,str) else 0,
                             "output_sha256":hashlib.sha256(output.encode()).hexdigest() if isinstance(output,str) else None})
            if provider == 'hunyuan' and choices[0].get('finish_reason') != 'stop':
                raise ValidationHarnessError('视觉模型输出未完成（finish_reason='+str(choices[0].get('finish_reason'))+'）；已保留用量回执，未重试')
            if schema_name == "open_motion_plan" and isinstance(output,str):
                # Accept a complete JSON Markdown envelope, never repair partial
                # JSON or infer missing fields. The same strict model still validates.
                fenced=re.fullmatch(r"\s*```(?:json)?\s*\n?(.*?)\n?```\s*",output,re.DOTALL)
                if fenced: output=fenced.group(1)
            if response_model is not None and response_model != info["model"]:
                raise ValidationHarnessError("视觉服务回传的模型与请求不一致；未采纳结论")
            parsed=schema_type.model_validate_json(output)
            return parsed,receipt
        except ValidationHarnessError:
            raise
        except httpx.TimeoutException as exc:
            raise ValidationHarnessError('视觉模型请求超时；结果未知，未自动重试', details={'error_type':type(exc).__name__}) from None
        except ValidationError as exc:
            # Record schema error categories, never provider text, request bodies or secrets.
            errors=exc.errors(include_input=False)
            categories=sorted({item["type"] for item in errors})
            known={"phase","stage","code","status","verdict","grip_height","blade_tip","observations","frame","frames"}
            fields=sorted({part for item in errors for part in item["loc"] if part in known})
            if schema_name == "open_motion_plan":
                fields = planning_validation_fields(exc)
            if schema_name == 'motion_adjustment':
                fields=sorted({str(item['loc'][0]) for item in errors if item['loc'] and item['loc'][0] in {'goal','preserve','method','provider_prompt','conflict'}})
            message = "视觉检查未取得有效结论；结构化字段无效（"+", ".join(categories+fields)+"），未自动重试"
            complete_plan = schema_name == 'open_motion_plan' and isinstance(output, str) and bool(output.strip()) and 'json_invalid' not in categories
            if complete_plan:
                draft = None
                if len(output) <= 24_000:
                    try:
                        parsed_draft = json.loads(output)
                        if isinstance(parsed_draft, dict):
                            draft = parsed_draft
                    except (ValueError, RecursionError):
                        pass  # Validation feedback is still available without the draft.
                raise InvalidPlanningResponse(message, details={'validation_fields': fields}, draft=draft) from None
            raise ValidationHarnessError(message, details={'validation_fields': fields} if schema_name == 'motion_adjustment' else {}) from None
        except Exception:
            raise ValidationHarnessError("视觉检查未取得有效结论；请人工检查，不会自动重新生成") from None

    def review(self, paths: list[Path], action_id: str, reference: Path, *, on_request=None, weapon_hand="reference", handoff_frame=None, handoff_frames=None, facing="right") -> dict:
        from .vision_evidence import (REVIEW_PROTOCOL_VERSION, Verification, raster, image_part,
                                      verified_issues)
        from .vision_sequence import SequenceVerification, sequence_content, assess_sequence, facing_instruction
        self.validate_inputs(paths, reference)
        count=len(paths); provider=self.provider; key=self.key()
        if not key:
            raise ValidationHarnessError("请在设置中保存视觉检查 API Key；视觉检查已暂停")
        content=[{"type":"input_text","text":
            f"Review this ordered {count}-frame pixel-art attack. FIRST record the actually visible pose of EVERY frame in observations. "
            "grip_height is hand/grip relative to shoulder/head; blade_tip is relative to the character, front means facing direction. "
            "Describe concrete hand/blade/body positions in Chinese, not a predicted stage name. Occluded means not visible; never fill in a desired pose. "
            "A low sword idle is not a charge. Then compare every frame to Character reference: "
            "look for newly invented cape/scarf/costume parts, armor/body recoloring, changed helmet, body proportions or weapon design. "
            "Distinguish detached motion effects from persistent body/outfit changes. Then inspect adjacent transitions and whole-sequence timing. "
            "Frame labels are 1-based; the reference is NOT an animation frame. "
            "Do not invent a defect because the contract mentions it. Rotation, foreshortening, occlusion and a trailing cloth/effect "
            "do not alone establish weapon flipping or a second attack. Describe only clearly visible differences; uncertain when unclear. "
            "For each tentative issue use evidence_status=unverified and evidence_confidence=0; a separate pass must verify it. "
            "Identify intended phase with confidence, unknown if unsure; never infer phase from a fixed frame number. "
            "Give concise Chinese observations and English corrections. " + contract(action_id,count)}]
        content.append({"type":"input_text","text":facing_instruction(facing)})
        from .grip_contract import grip_rule
        content.append({"type":"input_text","text":GRIP_REVIEW_INSTRUCTION + grip_rule(weapon_hand)})
        for label,path in [("Character reference (not animation frame)",reference),*[(f"Frame {i+1}/{count}",p) for i,p in enumerate(paths)]]:
            content.extend([{"type":"input_text","text":label},image_part(raster(path,512))])
        initial,meta=self._send(content,ObservedReview,provider,key,count,on_request)
        if [p.frame for p in initial.observations] != list(range(1,count+1)):
            raise ValidationHarnessError("视觉检查未取得有效结论；逐帧姿势记录不完整或顺序错误")
        if any(i<1 or i>count for issue in initial.issues for i in issue.frames):
            raise ValidationHarnessError("视觉检查未取得有效结论；帧号超出实际范围")
        if count==1 and initial.verdict=='pass':
            raise ValidationHarnessError("视觉检查未取得有效结论；单帧不能证明动作连续性")
        report={**initial.model_dump(),"frame_count":count,"provider":provider,"model":meta['requested_model'],
                "review_protocol_version":REVIEW_PROTOCOL_VERSION, **meta,
                "request_count":1,"requests":[{"stage":"initial",**meta}],
                "input_sha256":{"reference":hashlib.sha256(reference.read_bytes()).hexdigest(),
                                "frames":[hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]}}
        # Every verdict, including a clean initial pass, requires a full action audit.
        hypotheses=[{**issue.model_dump(),'evidence_status':'unverified','evidence_confidence':0} for issue in initial.issues]
        report['initial_review']={**initial.model_dump(),'issues':hypotheses}
        # Missing phases are judged against the full sequence, never a local pair.
        local_hypotheses=[issue for issue in hypotheses if issue['code'] not in {'incomplete_action','hand_swap'}]
        report['local_hypotheses']=local_hypotheses
        report.update(verdict='uncertain',confidence=0,issues=[],summary='动作完整性尚未完成核验。')
        verification,included=sequence_content(paths,reference,local_hypotheses,action_id,handoff_frame=handoff_frame,handoff_frames=handoff_frames,facing=facing)
        verification.append({"type":"input_text","text":grip_rule(weapon_hand)})
        report["weapon_hand_expected"]=weapon_hand
        report["facing"]=facing
        report['request_count']=2
        try:
            decisions,check_meta=self._send(verification,SequenceVerification,provider,key,count,on_request)
            report['requests'].append({'stage':'verification',**check_meta})
            confirmed,audit=verified_issues(local_hypotheses,decisions,included,paths)
            hand_ok,hand_issues,hand_audit=assess_grip(decisions.hand_continuity,initial.observations,initial.reference_grip,count)
            report['hand_continuity']=hand_audit
            from .vision_appearance import assess_appearance
            appearance_ok,appearance_issues,appearance_audit=assess_appearance(decisions.appearance_continuity,paths,reference)
            report['appearance_continuity']=appearance_audit
            try:
                complete,missing,stages=assess_sequence(decisions,initial.observations,action_id,count)
            except ValueError:
                complete,missing,stages=False,[],[]
                report['action_evidence_error']='动作阶段证据无效；已保留独立验证的持刀手结论。'
            report['verification']=audit
            report['action_completeness']={'complete':complete,'stages':stages}
            report['recovery_evidence']=decisions.recovery_evidence.model_dump() if decisions.recovery_evidence else None
            confirmed.extend(missing)
            confirmed.extend(hand_issues)
            for issue in appearance_issues:
                if not any(i['code']==issue['code'] and sorted(i['frames'])==issue['frames'] for i in confirmed):
                    confirmed.append(issue)
            report['issues']=confirmed
            if confirmed:
                report['confidence']=min(i['evidence_confidence'] for i in confirmed)
                report['verdict']='fail'
                report['summary']=f'检测到 {len(confirmed)} 项有帧证据的问题，已定位到逐帧修补。'
            elif complete and hand_ok and appearance_ok and all(d.get('decision')=='dismissed' and d.get('confidence',0)>=.9 for d in audit):
                report['verdict']='pass'
                report['confidence']=min([s['confidence'] for s in stages]+[appearance_audit['confidence']])
                report['summary']='动作完整性、持刀手、人物外形与武器形状已分别核验，未检出有证据支持的异常。'
            else:
                pending=[s for s in stages if s['status']!='present']
                from .motion_constraints import PHASE_LABELS
                detail='；'.join(f"{PHASE_LABELS[s['stage']]}（第 {', '.join(map(str,s['frames']))} 帧）：{s.get('evidence_note') or s['reason']}" for s in pending)
                if not appearance_ok:
                    detail+=('；' if detail else '')+appearance_audit.get('reason','人物外形或武器形状的独立核验仍缺少充分证据')
                report['summary']=('尚未通过检查。'+detail if detail else '持刀手或局部疑点证据不足，尚未通过检查。')[:800]
        except Exception:
            report['verification_error']='完整性复核未完成或证据无效；未通过检查，不自动重试。'
            if report['requests'][-1].get('stage')=='verification':
                report['requests'][-1]['state']='invalid_evidence'
            else:
                report['requests'].append({'stage':'verification','requested_model':meta['requested_model'],'state':'failed_or_unknown'})
        usage={}
        for request in report['requests']:
            for name,value in request.get('usage',{}).items():
                if isinstance(value,(int,float)) and not isinstance(value,bool): usage[name]=usage.get(name,0)+value
        report['usage']=usage
        return report
