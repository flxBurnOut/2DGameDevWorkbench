import html
import hashlib
import math
import re
import uuid
from functools import partial
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from PIL import Image

from .workbench_export import REQUEST_GODOT_EXPORT_JS, EXPORTED_GODOT_JS
from .errors import HarnessError, ProviderConfigurationError, ValidationHarnessError
from .artwork_library import ArtworkLibrary, ACTION_LABELS, KIND_LABELS, animation_title
from .models import Anchor, CharacterPreset, ExportOptions, FrameReviewRequest, GenerationRequest
from .reference_canvas import ReferenceCanvas
from .project_profile import DREAMWEAVER_PROFILE, ProjectAction, project_action_choices
from .service import QA_ALGORITHM_VERSION, SpritePipelineService
from .sheet_inspection import build_grid_overlay, extract_character_reference_frame, inspect_sprite_sheet


BASE_UI_CSS = r"""
:root{--muted:light-dark(var(--theme-light-muted), #aaa6b8);--panel:light-dark(var(--theme-light-panel), rgba(27,25,38,.88));--border:light-dark(var(--theme-light-border), rgba(170,157,255,.24));--accent:light-dark(var(--theme-light-accent), #9f83ff);--mint:light-dark(var(--theme-light-success), #63dfc9);--warn:light-dark(var(--theme-light-warning), #ffc76b)}
.gradio-container{max-width:1220px!important;margin:0 auto!important;padding-bottom:60px!important}
#sprite-hero{padding:25px 28px;margin:8px 0 14px;border:1px solid var(--border);border-radius:22px;background:radial-gradient(circle at 86% 8%,light-dark(var(--theme-light-surface), rgba(159,131,255,.23)),transparent 35%),linear-gradient(145deg,light-dark(var(--theme-light-panel), rgba(31,28,46,.98)),light-dark(var(--theme-light-panel), rgba(19,18,28,.98)));box-shadow:0 18px 60px light-dark(var(--theme-light-shadow), rgba(0,0,0,.2))}
#sprite-hero h1{margin:0 0 7px;font-size:clamp(28px,4vw,44px);letter-spacing:-.035em}#sprite-hero p{margin:0;color:var(--muted);line-height:1.65;max-width:920px}
.flow-map{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;align-items:stretch;margin-top:18px}.flow-box{padding:9px 8px;border:1px solid var(--border);border-radius:11px;background:light-dark(var(--theme-light-surface), rgba(255,255,255,.04));color:light-dark(var(--theme-light-text), #e9e4f6);text-align:center}.flow-box small{display:block;color:var(--mint);font-weight:800;margin-bottom:3px}
.status-bar{display:flex;gap:9px;flex-wrap:wrap;margin:0 0 16px;padding:12px 15px;border:1px solid var(--border);border-radius:14px;background:var(--panel)}.status-bar span{color:var(--muted)}.status-bar b{color:light-dark(var(--theme-light-text), #f0ecfa)}
.section-intro{padding:18px 20px;border:1px solid var(--border);border-radius:16px;background:var(--panel);margin:4px 0 15px}.section-intro h2,.section-intro h3{margin:0 0 7px}.section-intro p{margin:0;color:var(--muted);line-height:1.65}
.notice{padding:14px 17px;border-radius:13px;margin:7px 0 13px;line-height:1.6}.notice strong{display:block;margin-bottom:2px}.notice.info{border:1px solid var(--border);background:light-dark(var(--theme-light-warning-soft), rgba(159,131,255,.08))}.notice.ok{border:1px solid light-dark(var(--theme-light-warning), rgba(99,223,201,.36));background:light-dark(var(--theme-light-warning-soft), rgba(99,223,201,.08))}.notice.warn{border:1px solid light-dark(var(--theme-light-warning), rgba(255,199,107,.38));background:light-dark(var(--theme-light-warning-soft), rgba(255,199,107,.08))}.notice.error{border:1px solid light-dark(var(--theme-light-danger), rgba(255,140,164,.42));background:light-dark(var(--theme-light-danger-soft), rgba(255,140,164,.09))}
.safety-card{padding:15px 16px;margin:9px 0;border:1px solid var(--border);border-radius:14px;background:light-dark(var(--theme-light-surface), rgba(255,255,255,.03))}.safety-card h4{margin:0 0 8px}.safety-card p{margin:4px 0;color:var(--muted);line-height:1.55}.safety-track{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:10px}.safety-step{padding:8px 7px;border-radius:9px;background:light-dark(var(--theme-light-surface), rgba(255,255,255,.04));text-align:center;color:var(--muted);font-size:12px}.safety-step.done{background:light-dark(var(--theme-light-cyan-soft), rgba(99,223,201,.12));color:var(--mint)}.safety-step.current{background:light-dark(var(--theme-light-surface), rgba(159,131,255,.16));color:light-dark(var(--theme-light-text), #e7defe)}.safety-step.problem{background:light-dark(var(--theme-light-danger-soft), rgba(255,140,164,.12));color:light-dark(var(--theme-light-danger), #ff9caf)}.path-list code{user-select:text!important;cursor:text!important;caret-color:auto!important}
.contract-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}.contract-card{padding:12px 14px;border-radius:12px;background:light-dark(var(--theme-light-surface), rgba(255,255,255,.035))}.contract-card small{display:block;color:var(--muted);margin-bottom:4px}.contract-card b{color:light-dark(var(--theme-light-text), #f2eefb)}
.qa-counts{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.qa-count{padding:6px 10px;border-radius:999px;background:light-dark(var(--theme-light-surface), rgba(255,255,255,.05))}.qa-count.hard{color:light-dark(var(--theme-light-danger), #ff9caf)}.qa-count.warn{color:light-dark(var(--theme-light-warning), #ffd486)}.diagnostic-badge{display:inline-block;margin-top:8px;padding:4px 9px;border-radius:999px;color:light-dark(var(--theme-light-muted), #2a210f);background:var(--warn);font-size:12px;font-weight:800}
.qa-change{padding:13px 16px;margin:9px 0 14px;border:1px solid var(--border);border-radius:13px;background:light-dark(var(--theme-light-surface), rgba(255,255,255,.025))}.qa-change h4{margin:0 0 8px}.qa-change p{margin:5px 0;color:var(--muted)}.qa-change .resolved{color:var(--mint)}.qa-change .new{color:light-dark(var(--theme-light-danger), #ff9caf)}.qa-change .persisting{color:light-dark(var(--theme-light-warning), #ffd486)}.qa-change details{margin-top:7px}.qa-change li{margin:4px 0;color:var(--muted)}
.project-table{width:100%;border-collapse:collapse;margin-top:12px}.project-table th,.project-table td{padding:9px 10px;border-bottom:1px solid var(--border);text-align:left}.project-table th{color:light-dark(var(--theme-light-text), #dcd5ef)}.project-table td{color:var(--muted)}
.choice-cards,.static-choice,.workflow-tabs{caret-color:transparent!important}.choice-cards label,.choice-cards label *,.static-choice label,.static-choice label *,.workflow-tabs button,.workflow-tabs button *{cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;caret-color:transparent!important}.static-choice input[role="combobox"],.static-choice input[readonly]{cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;caret-color:transparent!important}.choice-cards>div>div{gap:9px!important}.choice-cards label{padding:11px 13px!important;border:1px solid var(--border)!important;border-radius:13px!important;background:light-dark(var(--theme-light-surface), rgba(255,255,255,.025))!important}.choice-cards label:hover{border-color:light-dark(var(--theme-light-accent), rgba(159,131,255,.72))!important;background:light-dark(var(--theme-light-surface), rgba(159,131,255,.09))!important}.choice-cards label:has(input:checked){border-color:var(--accent)!important;background:light-dark(var(--theme-light-accent-soft), rgba(159,131,255,.14))!important}
.primary-action button{min-height:48px;font-weight:750;border-radius:13px!important}.pixel-preview img,.frame-gallery img,.sheet-preview img{image-rendering:pixelated!important}
.step-actions{padding:13px 15px;margin-top:14px;border:1px solid var(--border);border-radius:14px;background:light-dark(var(--theme-light-surface), rgba(159,131,255,.06))}.step-actions button{min-height:46px;font-weight:750}.replay-action button{min-height:42px}
.pixel-editor-frame{display:block;width:100%;height:1160px;border:1px solid var(--border);border-radius:16px;background:light-dark(var(--theme-light-panel), #15131d)}
.internal-bridge{display:none!important}
.animation-player-frame{display:block;width:100%;height:480px;border:0;border-radius:12px;background:light-dark(var(--theme-light-panel), #10192b)}
@media(max-width:760px){.flow-map{grid-template-columns:repeat(2,minmax(0,1fr))}.contract-grid,.safety-track{grid-template-columns:1fr}#sprite-hero{padding:21px 19px}}
"""

UI_CSS = BASE_UI_CSS + "\n" + (
    Path(__file__).resolve().parent / "static" / "workbench.css"
).read_text(encoding="utf-8")
THEME_CSS = (Path(__file__).resolve().parent / "static" / "theme-tokens.css").read_text(encoding="utf-8")
THEME_JS = (Path(__file__).resolve().parent / "static" / "theme.js").read_text(encoding="utf-8")
UI_CSS = THEME_CSS + "\n" + UI_CSS



PIXEL_EDITOR_BRIDGE_JS = r"""
() => {
  if (window.__spritePixelEditorBridgeInstalled) return [];
  const clickButton = (id) => {
    const root = document.getElementById(id);
    const button = root?.matches("button") ? root : root?.querySelector("button");
    if (button && !button.disabled) button.click();
  };
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === "sprite-pixel-editor-layout") {
      const editorFrame = Array.from(document.querySelectorAll(".pixel-editor-frame"))
        .find((frame) => frame.contentWindow === event.source);
      const height = event.data.height;
      if (!editorFrame || typeof height !== "number" || !Number.isFinite(height) || height < 400 || height > 6000) return;
      editorFrame.style.height = `${Math.ceil(height)}px`;
      return;
    }
    if (event.data?.type === "sprite-reference-transferred") {
      const trusted = Array.from(document.querySelectorAll(".reference-editor-frame"))
        .some((frame) => frame.contentWindow === event.source);
      if (!trusted || !/^edited_[0-9a-f]{32}_v[0-9]+$/.test(event.data.characterId || "")) return;
      const field = document.querySelector("#reference-transfer-character textarea, #reference-transfer-character input");
      if (!field) return;
      const prototype = field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, event.data.characterId);
      field.dispatchEvent(new Event("input", {bubbles: true}));
      const sourceFrame = event.source;
      window.setTimeout(() => {
        if (Array.from(document.querySelectorAll(".reference-editor-frame")).some((frame) => frame.contentWindow === sourceFrame)) {
          clickButton("reference-transfer-apply");
        }
      }, 80);
      return;
    }
    if (event.data?.type !== "sprite-pixel-editor-saved") return;
    const sourceFrame = event.source;
    const trustedFrame = Array.from(document.querySelectorAll(".pixel-editor-frame"))
      .some((frame) => frame.contentWindow === event.source);
    if (!trustedFrame) return;
    window.setTimeout(() => {
      const stillCurrent = Array.from(document.querySelectorAll(".pixel-editor-frame"))
        .some((frame) => frame.contentWindow === sourceFrame);
      if (!stillCurrent) return;
      clickButton("refresh-repair-button");
      clickButton("refresh-review-button");
    }, 80);
  });
  window.__spritePixelEditorBridgeInstalled = true;
  return [];
}
"""


REFERENCE_CANVAS_SCROLL_JS = """() => {
  window.requestAnimationFrame(() => document.getElementById("reference-canvas-panel")?.scrollIntoView({behavior: "smooth", block: "start"}));
}"""


LIBRARY_DETAIL_SCROLL_JS = """() => {
  window.requestAnimationFrame(() => document.getElementById("artwork-detail")?.scrollIntoView({behavior: "smooth", block: "start"}));
}"""


JOB_STATUS_CN = {
    "created": "任务已保存",
    "queued": "等待 PixelLab 账户空位",
    "not_submitted": "未提交",
    "submitting": "正在提交",
    "provider_pending": "模型处理中",
    "saving": "正在安全保存",
    "attention_required": "需要人工恢复",
    "review_required": "结果已保存，等待检查",
    "approved": "已确认",
    "exported": "已导出",
    "failed": "处理失败",
}
CANDIDATE_STATUS_CN = {
    "created": "任务已保存，尚未提交",
    "submitting": "正在提交",
    "submission_unknown": "提交结果未知，已禁止重试",
    "provider_pending": "已提交，模型处理中",
    "saving": "模型已完成，正在安全保存",
    "received": "结果已保存",
    "check_failed": "结果已保存，检查未通过",
    "review_ready": "结果已保存，等待确认",
    "approved": "结果已保存并采用",
    "rejected": "结果已保存但已放弃",
    "failed": "生成失败",
}
REVIEW_STATUS_CN = {"pending": "未判断", "approved": "已通过", "repair_requested": "待修补", "rejected": "不采用"}
PROJECT_INTEGRATION_STATUS_CN = {
    "existing": "现有 16 帧合同",
    "frame_upgrade": "现有动作，Godot 需升级帧列表",
    "new": "新增动作，待 Godot 接线",
}
QA_CODE_CN = {
    "no_frames": "没有找到序列帧", "frame_count_mismatch": "画面数量与动作规格不一致", "frame_size_mismatch": "画面尺寸不一致",
    "missing_alpha": "缺少透明通道", "blank_frame": "画面完全透明", "corrupt_frame": "图片无法读取",
    "consecutive_duplicate_frames": "连续画面完全重复", "touches_canvas_edge": "角色碰到画布边缘", "safe_margin_violation": "角色离画布边缘过近",
    "area_change": "角色可见面积变化较大", "centroid_jump": "角色重心跳动较大", "palette_deviation": "颜色变化较大",
    "loop_endpoint_difference": "循环首尾差异较大", "ground_baseline_drift": "脚底位置发生跳动", "reference_unavailable": "参考图检查被跳过",
    "frame_position_jump": "整个人物在相邻帧之间发生突变式跳位",
    "centroid_velocity_jump": "相邻帧的位置运动趋势发生突变",
    "provider_frame_count_adjusted": "模型返回的帧数与预设不同；已保留全部有效帧并自动补透明空格",
    "palette_unavailable": "色板检查被跳过", "preview_generation_failed": "预览图生成失败",
}
ISSUE_TYPE_CHOICES = [
    ("角色长得不一致", "identity_drift"), ("衣服或配饰变化", "clothing_error"), ("武器不对", "weapon_error"),
    ("肢体异常", "limb_error"), ("动作姿势不对", "pose_error"), ("背景或透明度错误", "alpha_background_error"),
    ("大小或脚底位置跳动", "scale_baseline_error"), ("其他", "other"),
]

REPAIR_FRAME_STATES = {
    "blocked": ("⛔", "仍有阻止问题"),
    "repair": ("🛠", "待修补"),
    "modified": ("✎", "已修改"),
    "approved": ("✓", "已通过"),
    "pending": ("○", "未检查"),
}


def _repair_frame_state(candidate: Any, frame: Any) -> tuple[str, str, str]:
    qa_current = bool(
        candidate.qa_completed_at is not None
        and candidate.qa_input_sha256
        and candidate.qa_algorithm_version == QA_ALGORITHM_VERSION
        and candidate.error is None
    )
    if qa_current and frame.hard_failures:
        key = "blocked"
    elif frame.review_status.value == "repair_requested":
        key = "repair"
    elif frame.review_status.value == "approved":
        key = "approved"
    elif frame.manual_edit_versions > 0 or frame.repair_attempts > 0:
        key = "modified"
    else:
        key = "pending"
    icon, label = REPAIR_FRAME_STATES[key]
    return key, icon, label


def _adjacent_problem_frame_index(
    problem_indices: list[int],
    current_index: int | None,
    direction: int,
) -> int | None:
    if not problem_indices:
        return None
    ordered = list(dict.fromkeys(int(index) for index in problem_indices))
    current = int(current_index) if current_index is not None else None
    if current in ordered:
        position = ordered.index(current)
        return ordered[(position + (1 if direction >= 0 else -1)) % len(ordered)]
    if direction >= 0:
        return next((index for index in ordered if current is None or index > current), ordered[0])
    return next((index for index in reversed(ordered) if current is None or index < current), ordered[-1])


def _repair_qa_change_html(candidate: Any) -> str:
    summary = getattr(candidate, "qa_change_summary", None)
    if summary is None:
        return ""

    groups = (
        ("已解决", "resolved", summary.resolved),
        ("新出现", "new", summary.new),
        ("仍存在", "persisting", summary.persisting),
    )
    detail_rows: list[str] = []
    for title, css_name, issues in groups:
        for issue in issues:
            frame_numbers: set[int] = set()
            if issue.frame_index is not None:
                frame_numbers.add(int(issue.frame_index) + 1)
            raw_indices = issue.metrics.get("frame_indices")
            if isinstance(raw_indices, (list, tuple)):
                for value in raw_indices:
                    try:
                        frame_numbers.add(int(value) + 1)
                    except (TypeError, ValueError):
                        pass
            for key in ("from", "to"):
                try:
                    if issue.metrics.get(key) is not None:
                        frame_numbers.add(int(issue.metrics[key]) + 1)
                except (TypeError, ValueError):
                    pass
            scope = f"第 {'、'.join(str(value) for value in sorted(frame_numbers))} 帧 · " if frame_numbers else ""
            label = QA_CODE_CN.get(issue.code, issue.message or issue.code)
            detail_rows.append(
                f'<li><span class="{css_name}">{title}</span> · {_escape(scope + label)}</li>'
            )
    details = (
        "<details><summary>查看变化明细</summary><ul>" + "".join(detail_rows) + "</ul></details>"
        if detail_rows
        else ""
    )
    return (
        '<div class="qa-change"><h4>修补后复查变化</h4>'
        f'<p><b class="resolved">已解决 {len(summary.resolved)}</b>　'
        f'<b class="new">新出现 {len(summary.new)}</b>　'
        f'<b class="persisting">仍存在 {len(summary.persisting)}</b></p>'
        f"{details}</div>"
    )


def _escape(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _notice(kind: str, title: str, body: str) -> str:
    return f'<div class="notice {kind}"><strong>{_escape(title)}</strong>{_escape(body)}</div>'


def _stage_header(badge: str, title: str, body: str) -> str:
    return (
        '<div class="stage-header">'
        f'<span class="stage-badge">{_escape(badge)}</span>'
        f'<h2>{_escape(title)}</h2><p>{_escape(body)}</p></div>'
    )


def _card_heading(kicker: str, title: str, body: str = "") -> str:
    description = f"<p>{_escape(body)}</p>" if body else ""
    return (
        '<div class="card-heading">'
        f'<span>{_escape(kicker)}</span><h3>{_escape(title)}</h3>{description}</div>'
    )


def _error_payload(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, HarnessError):
        return {"ok": False, "error": exc.as_dict()}
    return {"ok": False, "error": {"code": "operation_error", "message": str(exc), "details": {"type": type(exc).__name__}}}


def _human_error(exc: Exception) -> str:
    message = str(exc)
    translations = (
        ("API key", "尚未配置 PixelLab API Key。请到“设置”保存后再生成。"),
        ("frame_count", "素材画面数量与所选动作不一致。请确认动作和网格预检结果。"),
        ("wrong size", "上传图片尺寸不正确。修补图必须与当前单帧画布完全一致。"),
        ("alpha channel", "图片必须保留透明通道。请上传透明背景 PNG。"),
        ("completely transparent", "图片完全透明，请换一张包含角色内容的 PNG。"),
        ("warnings; explicit acknowledgement", "这组动画有提醒项。请勾选已查看提醒后再采用。"),
        ("hard failures", "自动检查发现阻止问题，修正后才能采用。"),
        ("repair_requested", "请先在“播放检查”把这帧标记为待修补。"),
        ("export files already exist", "暂存区已有同名文件。确认后可允许覆盖。"),
        ("column count", "Sheet 的列数不符合当前项目固定网格。"),
        ("wrong number of columns", "这张 Sheet 不是当前项目要求的 4 列网格。"),
        ("must be a PNG", "角色原型必须是 PNG 图片。"),
        ("dimensions must be exact multiples", "角色原型既不是 128×128 单帧，也不是规则的 4 列 Sheet。"),
    )
    for needle, translated in translations:
        if needle.casefold() in message.casefold():
            return translated
    return message


def _uploaded_path(value: Any) -> Path:
    if isinstance(value, (str, Path)):
        return Path(value)
    if isinstance(value, dict) and value.get("path"):
        return Path(str(value["path"]))
    name = getattr(value, "name", None) or getattr(value, "path", None)
    if name:
        return Path(str(name))
    raise ValidationHarnessError("uploaded file path is unavailable")


def _candidate_letter(index: int) -> str:
    return chr(ord("A") + index - 1) if 1 <= index <= 26 else str(index)


def _pixel_editor_embed(
    job_id: str | None,
    candidate_index: int | None,
    frame_index: int | None,
) -> str:
    if not job_id or candidate_index is None or frame_index is None:
        return _notice("info", "像素画布尚未打开", "选择一帧待修补画面后，这里会载入精确像素编辑器。")
    query = urlencode(
        {
            "job_id": str(job_id),
            "candidate": int(candidate_index),
            "frame": int(frame_index),
        }
    )
    return (
        f'<iframe class="pixel-editor-frame" src="/pixel-editor?{_escape(query)}" '
        'title="精确像素修补画布" sandbox="allow-scripts allow-same-origin allow-downloads allow-modals"></iframe>'
    )


def _animation_player_embed(job_id: str, candidate: Any) -> str:
    revision = hashlib.sha256("|".join(frame.sha256 for frame in candidate.frames).encode("ascii")).hexdigest()[:16]
    query = urlencode({"job_id": job_id, "candidate": candidate.candidate_index, "revision": revision})
    return (f'<iframe class="animation-player-frame" src="/animation-player?{_escape(query)}" '
            'title="动画播放检查" sandbox="allow-scripts allow-same-origin"></iframe>')


def _export_download_files(service: SpritePipelineService, job_id: str | None, candidate_index: int | None = None) -> tuple[str | None, str | None, list[str]]:
    """Show saved exports again on selection/reload, without exporting or modifying a job."""
    if not job_id:
        return None, None, []
    try:
        job = service.get_job(str(job_id))
        record = job.export
        if record is None or (candidate_index is not None and record.candidate_index != int(candidate_index)):
            return None, None, []
        def existing(value: str | None) -> str | None:
            if not value:
                return None
            path = service.settings.resolve_record_path(value).resolve()
            path.relative_to(service.settings.exports_dir.resolve())
            return str(path) if path.is_file() else None
        return (
            existing(record.sheet_path),
            existing(record.godot_package_path),
            [path for value in (record.preview_path, record.recipe_path, record.qa_path) if (path := existing(value))],
        )
    except Exception:
        return None, None, []


def build_ui(
    root: str | Path | None = None,
    *,
    service: SpritePipelineService | None = None,
) -> Any:
    """Build a project-guided UI backed by the shared service used by API/CLI."""
    try:
        import gradio as gr
    except ImportError as exc:  # pragma: no cover
        raise ProviderConfigurationError("operator UI requires Gradio; install requirements.txt", details={"dependency": "gradio"}) from exc

    service = service or SpritePipelineService(root)
    profile = DREAMWEAVER_PROFILE
    library = ArtworkLibrary(service)
    # Diagnostic jobs stay out of the production history until this browser
    # session explicitly launches one from the Example page.
    visible_diagnostic_jobs: set[str] = set()

    def api_configured() -> bool:
        return bool(service.settings.pixellab_api_key)

    def header_status_html() -> str:
        frame_count = profile.actions[0].frame_count if profile.actions else 0
        return (
            '<div class="status-bar">'
            f'<span>项目 <b>{_escape(profile.display_name)}</b></span>'
            f'<span>输出 <b>{frame_count} 帧 · {profile.columns} 列 · {profile.cell_width}×{profile.cell_height}/格</b></span>'
            f'<span>PixelLab <b>{"已保存" if api_configured() else "未配置"}</b></span></div>'
        )

    def api_banner_html() -> str:
        if api_configured():
            return _notice("ok", "PixelLab API 已保存", "现在可以生成。首次真实调用成功前，页面不会把它误写成“已连接”。")
        return _notice("warn", "PixelLab API 尚未配置", "点击右侧“API 设置”填写 Key。已有 Sheet 检查、修补和导出不需要 API。")

    def api_settings_status() -> str:
        if api_configured():
            return _notice("ok", "已受保护保存，尚未调用验证", "Key 已由当前 Windows 用户加密保护，页面不会回显完整内容。")
        return _notice("info", "未配置", "只有“1 · 生成”需要 PixelLab API；其他功能仍可使用。")

    def quota_html(snapshot: dict[str, Any] | None = None) -> str:
        snapshot = snapshot if snapshot is not None else service.get_cached_balance()
        if not snapshot:
            return _notice("info", "额度尚未读取", "点击“刷新额度”后显示 PixelLab 当前剩余生成次数；刷新额度不会消耗生成次数。")
        balance = snapshot.get("balance", {}) if isinstance(snapshot, dict) else {}
        subscription = balance.get("subscription", {}) if isinstance(balance, dict) else {}
        credits = balance.get("credits", {}) if isinstance(balance, dict) else {}

        def first_number(mapping: Any, names: tuple[str, ...]) -> int | float | None:
            if not isinstance(mapping, dict):
                return None
            for name in names:
                value = mapping.get(name)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    return value
            return None

        remaining = first_number(
            subscription,
            ("generations", "remaining", "remaining_generations", "generations_remaining"),
        )
        total = first_number(
            subscription,
            ("total", "total_generations", "generations_total"),
        )
        usd = first_number(credits, ("usd",))
        pieces: list[str] = []
        if remaining is not None:
            pieces.append(f"剩余生成次数：{remaining:g}")
        if total is not None:
            pieces.append(f"套餐总次数：{total:g}")
        if usd is not None:
            pieces.append(f"额外余额：${usd:g}")
        checked_at = snapshot.get("checked_at")
        detail = "；".join(pieces) if pieces else "PixelLab 已返回账户信息，但字段格式暂时无法识别。"
        if checked_at:
            detail += f"；读取时间：{checked_at}"
        return _notice("ok", "当前 PixelLab 额度", detail)

    def refresh_quota() -> tuple[str, dict[str, Any]]:
        try:
            snapshot = service.refresh_pixellab_balance()
            return quota_html(snapshot), {"ok": True, "balance": snapshot}
        except Exception as exc:
            cached = service.get_cached_balance()
            body = _human_error(exc)
            if cached:
                body += " 已保留上一次成功读取的额度快照。"
            return _notice("error", "额度读取失败", body), _error_payload(exc)

    def generation_cost_html(count: float, action_id: str | None) -> str:
        resolved = max(1, int(count or 1))
        action = project_action(action_id)
        if action is None:
            return _notice(
                "info",
                "选择动作后显示额度",
                "额度按单帧尺寸和送给模型的帧数计算。",
            )
        per_candidate = service._pixellab_generation_units(
            profile.cell_width,
            profile.cell_height,
            action.provider_frame_count,
        )
        from .attack_sequence import segment_counts, phase_timing
        try:
            preset, _ = service.presets.load_action(action_id)
        except HarnessError:
            # A partial preset installation must still render the library/settings.
            counts = []
        else:
            counts = segment_counts(preset)
        if counts:
            per_candidate=sum(service._pixellab_generation_units(profile.cell_width,profile.cell_height,n) for n in counts)
        total = per_candidate * resolved
        if action_id in {"attack", "attack_in_air"}:
            from .vision_review import VisionReviewer
            configured = VisionReviewer(service.settings).configured
            timing=phase_timing(preset) if counts else {}
            rhythm=(f"节奏目标：{'空中准备' if action_id=='attack_in_air' else '起势/蓄力'} {timing['preparation']} 帧 → 出刀/随挥 {timing['attack']} 帧 → 收招 {timing['recovery']} 帧；出刀先快后慢。" if timing else "")
            anchor_note=("出刀与收招连续生成，原图同时作为收招终点和外形参考。一脚稳住，另一脚随劈砍小幅前弓步，收招时退回。" if counts and preset.generation_strategy=="reference_anchored_attack" else "")
            return (_notice("info" if configured else "warn", f"本次预计最多 {total} 个 PixelLab 额度 · {resolved} 个候选",
                f"已默认启用攻击检查与问题标记。视觉检查另行计费，每个候选最多两次，合计最多 {2*resolved} 次调用，不自动重试或补做。"
                + ("在逐帧修补中由你决定是否请求 AI 重新生成。" if configured else "请先在设置中配置 视觉检查 API Key。"))
                + '<details class="inline-details"><summary>查看攻击节奏与固定生成次数</summary><p>'
                + _escape(rhythm + anchor_note + (f"每个候选分 {len(counts)} 段生成，共 {len(counts)*resolved} 次固定提交；每段仅生成一次。" if counts else "每个候选提交一次。"))
                + '</p></details>')
        return _notice(
            "warn" if total > per_candidate else "info",
            f"本次最多消耗 {total} 个 generation 额度",
            f"当前动作每个候选约 {per_candidate} 个额度，共 {resolved} 个候选、{resolved} 次独立提交。系统会在每次提交前读取余额；刷新、查询和取回不消耗额度。",
        )

    def storage_status_html() -> str:
        status = service.storage_status()
        paths = status["paths"]
        migration = status["migration"]
        mode = "便携模式（你显式指定了 --root）" if paths["portable_mode"] else "用户数据隔离模式"
        migration_status = migration.get("status", "unknown")
        migration_label = {
            "complete": "已完成",
            "complete_with_conflicts": "已完成，但有同名内容待确认",
            "incomplete": "未完成",
            "not_required": "无需迁移",
            "portable_mode": "便携模式不迁移",
        }.get(migration_status, str(migration_status))
        legacy_note = (
            "旧任务、角色和导出文件仍完整保留；确认加密副本后，旧明文 Key 会被清除。"
            if migration.get("source_root")
            else "没有需要迁移的旧目录。"
        )
        return (
            '<div class="section-intro path-list"><h3>存储与恢复位置</h3>'
            f"<p><b>{_escape(mode)}</b>。程序代码与用户数据已经分离；{_escape(legacy_note)}</p>"
            f"<p>用户数据：<code>{_escape(paths['data_root'])}</code><br>"
            f"任务与原始结果：<code>{_escape(paths['jobs_dir'])}</code><br>"
            f"用户角色：<code>{_escape(paths['user_characters_dir'])}</code><br>"
            f"最终导出：<code>{_escape(paths['exports_dir'])}</code></p>"
            f"<p>迁移状态：{_escape(migration_label)}；已复制任务 {migration.get('copied_jobs', 0)} 个、"
            f"角色 {migration.get('copied_characters', 0)} 个、导出文件 {migration.get('copied_exports', 0)} 个；"
            f"已识别更新版本 {migration.get('skipped_destination_newer', 0)} 个；"
            f"冲突 {len(migration.get('conflicts', []))} 个，错误 {len(migration.get('errors', []))} 个。</p></div>"
        )

    def refresh_storage_status() -> tuple[str, dict[str, Any]]:
        return storage_status_html(), service.storage_status()

    def official_character_choices() -> list[tuple[str, str]]:
        choices = [
            (str(item["name"]), str(item["id"]))
            for item in service.list_presets()["characters"]
            if item.get("valid", True) and item["id"] != "diagnostic_dummy"
        ]
        choices.sort(key=lambda item: (0 if item[1] == profile.character_id else 1, item[0]))
        return choices

    def character_projection(character_id: str | None) -> tuple[str | None, str]:
        if not character_id:
            return None, _notice("warn", "还没有角色外观参考", "请到“1 · 生成”上传一张 128×128 透明 PNG，或使用已保存角色。")
        try:
            character, preset_path = service.presets.load_character(character_id)
            return str(preset_path.parent / character.reference_frame), _notice(
                "ok", f"角色：{character.display_name}", "模型只用这张单帧图保持脸、服装、颜色和武器一致；它不是一套动画。"
            )
        except Exception as exc:
            return None, _notice("error", "角色外观参考不可用", _human_error(exc))

    def project_action(action_id: str | None) -> ProjectAction | None:
        if not action_id:
            return None
        try:
            return profile.action(action_id)
        except KeyError:
            return None

    def action_projection(action_id: str | None) -> str:
        action = project_action(action_id)
        if action is None:
            return _notice("warn", "请选择动作", "动作会自动带入项目的帧数、FPS、循环方式和目标文件名。")
        width, height = action.sheet_size
        layout = (
            "按项目指定格位播放，未使用格保持透明"
            if action.is_sparse
            else "从左到右、从上到下"
        )
        body = (
            f"{action.frame_count} 帧 · {action.fps:g} FPS · {'循环播放' if action.loop else '播放一次'}。"
            f"预计导出 {width}×{height} PNG，{profile.cell_width}×{profile.cell_height}/格，"
            f"{action.columns} 列×{action.rows} 行；{layout}。"
        )
        if action.provider_frame_count != action.frame_count:
            body += f" 模型生成 {action.provider_frame_count} 个连续源帧，Harness 保留为项目需要的 {action.frame_count} 帧。"
        if action.note:
            body += f" {action.note}"
        return (
            '<details class="inline-details"><summary>动作规格与导出说明</summary>'
            + _notice("info", f"{action.display_name} → {action.filename}", body)
            + "</details>"
        )

    def save_api_key(value: str) -> tuple[str, str, str, Any, Any]:
        try:
            if not (value or "").strip():
                raise ValidationHarnessError("请先填写 API Key；如果要删除已保存的 Key，请使用“清除本机 Key”")
            service.configure_pixellab_api_key(value)
            return header_status_html(), api_settings_status(), api_banner_html(), gr.update(interactive=True), gr.update(value="")
        except Exception as exc:
            return header_status_html(), _notice("error", "API Key 没有保存", _human_error(exc)), api_banner_html(), gr.update(interactive=api_configured()), gr.update()

    def clear_api_key() -> tuple[str, str, str, Any, Any]:
        try:
            service.configure_pixellab_api_key(None)
            return header_status_html(), api_settings_status(), api_banner_html(), gr.update(interactive=False), gr.update(value="")
        except Exception as exc:
            return header_status_html(), _notice("error", "没有清除成功", _human_error(exc)), api_banner_html(), gr.update(interactive=api_configured()), gr.update()

    def inspect_generation_reference_source(source: Path) -> tuple[Image.Image, dict[str, Any]]:
        """Return the exact 128px frame that will be sent to the generator."""
        return extract_character_reference_frame(
            source,
            cell_width=profile.cell_width,
            cell_height=profile.cell_height,
            columns=profile.columns,
        )

    def prepare_generation_reference(uploaded: Any, saved_character_id: str | None) -> tuple[Any, str, dict[str, Any]]:
        if uploaded is None:
            reference, _summary = character_projection(saved_character_id)
            if reference:
                if saved_character_id and saved_character_id.startswith("edited_"):
                    return reference, _notice("ok", "修改版已作为新的生成原图", "下次生成将使用上方这张修改后的原图。"), {}
                return reference, _notice(
                    "info",
                    "当前使用已保存角色",
                    "上传新的角色原型 PNG 后，会改用上传图片；不会修改这个已保存角色。",
                ), {}
            return None, _notice("warn", "还没有角色原型", "请上传一张角色原型 PNG。"), {}
        try:
            source = _uploaded_path(uploaded)
            reference, state = inspect_generation_reference_source(source)
            if state["kind"] == "single":
                detail = f"将直接使用这张 {profile.cell_width}×{profile.cell_height} 透明 PNG。"
            else:
                detail = (
                    f"识别为 {state['sheet_width']}×{state['sheet_height']} Sheet；"
                    f"将自动取第 {state['reference_index'] + 1} 格作为角色第一帧。"
                )
            return reference, _notice("ok", "角色原型已准备好", detail), state
        except Exception as exc:
            return None, _notice("error", "这张角色原型暂时不能使用", _human_error(exc)), {}

    def resolve_generation_character(
        uploaded: Any,
        reference_state: dict[str, Any],
        name: str,
        identity_prompt: str,
        saved_character_id: str | None,
    ) -> tuple[str, dict[str, Any]]:
        if uploaded is None:
            if not saved_character_id:
                raise ValidationHarnessError("请上传角色原型图，或选择一个已保存角色")
            service.presets.load_character(saved_character_id)
            return saved_character_id, {}

        source = _uploaded_path(uploaded).resolve()
        _reference, inspected = inspect_generation_reference_source(source)
        if not reference_state.get("valid") or str(source) != str(Path(str(reference_state.get("path", ""))).resolve()):
            reference_state = inspected
        display_name = (name or "").strip() or "新角色"
        identity = (identity_prompt or "").strip()
        signature = "|".join(
            (str(source), display_name, identity, str(reference_state.get("reference_index", 0)))
        )
        reusable_id = reference_state.get("character_id") if reference_state.get("signature") == signature else None
        if reusable_id:
            try:
                service.presets.load_character(str(reusable_id))
                return str(reusable_id), reference_state
            except Exception:
                pass

        common = dict(
            display_name=display_name,
            facing=profile.facing,
            identity_description=identity,
            character_id=(
                "user_"
                + hashlib.sha256(
                    source.read_bytes()
                    + display_name.encode("utf-8")
                    + identity.encode("utf-8")
                    + str(reference_state.get("reference_index", 0)).encode("ascii")
                ).hexdigest()[:16]
            ),
            sheet_columns=profile.columns,
            anchor_x=profile.anchor_x,
            anchor_ground_y=profile.anchor_ground_y,
            reuse_if_identical=True,
        )
        if reference_state["kind"] == "single":
            preset = service.create_character_preset(reference_image=source, **common)
        else:
            preset = service.create_character_preset_from_sheet(
                sprite_sheet=source,
                cell_size=profile.cell_width,
                reference_frame_index=int(reference_state["reference_index"]),
                **common,
            )
        return preset.character_id, {
            **reference_state,
            "character_id": preset.character_id,
            "signature": signature,
        }

    def job_label(job: Any) -> str:
        source = {"pixellab": "AI 生成", "import": "已有 Sheet", "fixture": "流程示例"}.get(job.request.provider, job.request.provider)
        when = job.updated_at.astimezone().strftime("%m-%d %H:%M")
        character = "流程测试机器人" if job.character.character_id == "diagnostic_dummy" else job.character.display_name
        return f"{source} · {job.action.display_name or job.action.action_id} · {character} · {when} · {JOB_STATUS_CN.get(job.status.value, job.status.value)}"

    def job_summary_label(row: dict[str, Any]) -> str:
        source = {"pixellab": "AI 生成", "import": "已有 Sheet", "fixture": "流程示例"}.get(
            str(row.get("provider", "")), str(row.get("provider", ""))
        )
        try:
            when = datetime.fromisoformat(str(row.get("updated_at", ""))).astimezone().strftime("%m-%d %H:%M")
        except (TypeError, ValueError):
            when = "时间未知"
        character = (
            "流程测试机器人"
            if row.get("character_id") == "diagnostic_dummy"
            else str(row.get("character_name") or row.get("character_id") or "未知角色")
        )
        candidate_count = int(row.get("candidate_count") or 0)
        saved_count = int(row.get("saved_candidate_count") or 0)
        candidate_note = f"{saved_count}/{candidate_count} 个候选已保存" if candidate_count else "尚无候选"
        status = JOB_STATUS_CN.get(str(row.get("status", "")), str(row.get("status", "")))
        return (
            f"{source} · {row.get('action_name') or row.get('action_id')} · {character} · "
            f"{candidate_note} · {when} · {status}"
        )

    def job_choices(*, approved_only: bool = False, repair_only: bool = False) -> list[tuple[str, str]]:
        result: list[tuple[str, str]] = []
        # Workflow selectors address durable works, not the archived history view.
        for row in service.store.list_jobs():
            job_id = str(row.get("job_id", ""))
            if row.get("execution_only") or row.get("status") == "invalid":
                continue
            if row.get("character_id") == "diagnostic_dummy" and job_id not in visible_diagnostic_jobs:
                continue
            if approved_only and int(row.get("approved_candidate_count") or 0) < 1:
                continue
            if repair_only and int(row.get("repair_frame_count") or 0) < 1:
                continue
            result.append((job_summary_label(row), job_id))
        return result

    def saved_asset_choices(preferred: str | None = None) -> list[tuple[str, str]]:
        # Keep history archived, but preserve an explicitly opened artwork's context.
        rows = service.list_jobs()
        if preferred and not any(row["job_id"] == preferred for row in rows):
            rows.extend(row for row in service.store.list_jobs() if row["job_id"] == preferred)
        return [
            (job_summary_label(row) if row.get("status") != "invalid" else f"记录无法读取 · {row['job_id']}", str(row["job_id"]))
            for row in rows
        ]

    def saved_asset_catalog_projection(job_id: str | None) -> str:
        if not job_id:
            return _notice(
                "info",
                "还没有选择任务",
                "启动时只读取轻量摘要。选择或打开任务后，才会读取候选、帧和详细记录。",
            )
        row = next(
            (item for item in service.store.list_jobs() if str(item.get("job_id")) == str(job_id)),
            None,
        )
        if row is None or row.get("status") == "invalid":
            return _notice("error", "任务摘要不可用", "任务文件夹存在，但轻量摘要无法读取。")
        candidate_count = int(row.get("candidate_count") or 0)
        saved_count = int(row.get("saved_candidate_count") or 0)
        frame_count = int(row.get("total_frame_count") or 0)
        repair_count = int(row.get("repair_frame_count") or 0)
        return _notice(
            "info",
            f"{row.get('action_name') or row.get('action_id')} · {JOB_STATUS_CN.get(str(row.get('status')), str(row.get('status')))}",
            f"任务文件夹 {row['job_id']}；{candidate_count} 个候选中 {saved_count} 个已有画面，共 {frame_count} 帧，{repair_count} 帧待修补。当前只读取了摘要。",
        )

    def task_center_projection(job_id: str | None) -> tuple[str, dict[str, Any], Any]:
        if not job_id:
            return (
                _notice("info", "还没有真实生成任务", "提交后任务会立即保存到本机；刷新或重新打开页面仍会出现在这里。"),
                {},
                gr.update(choices=[], value=None, interactive=False),
            )
        try:
            job = service.get_job(str(job_id))
            cards: list[str] = []
            attach_choices: list[tuple[str, int]] = []
            integrity_problem = False
            for candidate in job.candidates:
                safety = service.candidate_safety(job.job_id, candidate.candidate_index)
                stage = safety["stage"]
                submitted = bool(safety["provider_job_id"] or safety["submitted_at"] or safety["result_saved_at"])
                provider_done = bool(safety["provider_completed_at"] or safety["result_saved_at"])
                saved = bool(safety["result_saved_at"])
                unknown = stage == "submission_unknown"
                failed = stage == "failed"

                def step_class(done: bool, current: bool = False, problem: bool = False) -> str:
                    if problem:
                        return "problem"
                    if done:
                        return "done"
                    return "current" if current else ""

                remote = safety["provider_job_id"] or "尚未取得"
                detail = (
                    f"远端任务编号：{remote}；本地提交次数：{safety['submission_attempts']}/{candidate.attack_sequence['maximum_submissions'] if candidate.attack_sequence else 1}。"
                )
                if saved:
                    integrity = "校验通过" if safety["result_integrity"] else "校验异常"
                    integrity_problem = integrity_problem or not bool(safety["result_integrity"])
                    detail += f" 保存时间：{safety['result_saved_at']}；完整性：{integrity}。"
                elif candidate.error:
                    detail += f" 当前说明：{_human_error(Exception(candidate.error.get('message', '')))}。"
                cards.append(
                    '<div class="safety-card">'
                    f"<h4>候选 {_candidate_letter(candidate.candidate_index)} · {_escape(CANDIDATE_STATUS_CN.get(candidate.status.value, candidate.status.value))}</h4>"
                    f"<p>{_escape(detail)}</p>"
                    '<div class="safety-track">'
                    f'<div class="safety-step {step_class(True)}">1. 任务已保存</div>'
                    f'<div class="safety-step {step_class(submitted, stage == "submitting", unknown)}">2. 已提交</div>'
                    f'<div class="safety-step {step_class(provider_done, stage == "processing", failed)}">3. 模型处理</div>'
                    f'<div class="safety-step {step_class(saved, stage == "saving", failed and provider_done)}">4. 结果已保存</div>'
                    "</div></div>"
                )
                if unknown and not safety["provider_job_id"]:
                    attach_choices.append(
                        (f"候选 {_candidate_letter(candidate.candidate_index)}", candidate.candidate_index)
                    )
            title_kind = "error" if job.status.value in {"failed", "attention_required"} or integrity_problem else "ok" if any(c.result_saved_at for c in job.candidates) else "info"
            header = _notice(
                title_kind,
                f"任务 {job.job_id}",
                f"{JOB_STATUS_CN.get(job.status.value, job.status.value)}。页面刷新不会删除此任务；后台只会查询或保存，绝不会自动重复收费提交。",
            )
            return (
                header + "".join(cards),
                {"ok": True, "job": job.model_dump(mode="json")},
                gr.update(
                    choices=attach_choices,
                    value=attach_choices[0][1] if attach_choices else None,
                    interactive=bool(attach_choices),
                ),
            )
        except Exception as exc:
            return (
                _notice("error", "任务安全记录无法读取", _human_error(exc)),
                _error_payload(exc),
                gr.update(choices=[], value=None, interactive=False),
            )

    def task_job_update(preferred: str | None = None) -> Any:
        choices = saved_asset_choices(preferred)
        values = {value for _label, value in choices}
        selected = preferred if preferred in values else choices[0][1] if choices else None
        return gr.update(choices=choices, value=selected)

    def attach_remote_job(
        job_id: str | None,
        candidate_index: int | None,
        provider_job_id: str,
    ) -> tuple[str, Any, str, dict[str, Any], Any, Any]:
        try:
            if not job_id or candidate_index is None:
                raise ValidationHarnessError("请先选择需要恢复的候选")
            if not provider_job_id.strip():
                raise ValidationHarnessError("请填写 PixelLab 返回的远端任务编号")
            job = service.attach_provider_job_id(
                str(job_id),
                int(candidate_index),
                provider_job_id,
            )
            job = service.generate_job(job.job_id, wait=False, candidate_index=int(candidate_index))
            projection = task_center_projection(job.job_id)
            return (
                _notice("ok", "远端任务已绑定", "刚才只查询了已有任务，没有创建新的收费生成。"),
                task_job_update(job.job_id),
                *projection,
                gr.update(value=""),
            )
        except Exception as exc:
            projection = task_center_projection(job_id)
            return (
                _notice("error", "远端任务没有绑定", _human_error(exc)),
                task_job_update(job_id),
                *projection,
                gr.update(),
            )

    def candidate_choices(job: Any, *, approved_only: bool = False, repair_only: bool = False) -> list[tuple[str, int]]:
        result: list[tuple[str, int]] = []
        for candidate in job.candidates:
            if repair_only and (
                candidate.status.value in {"approved", "rejected", "failed"}
                or (job.export and job.export.candidate_index == candidate.candidate_index)
            ):
                continue
            if approved_only and candidate.status.value != "approved":
                continue
            if repair_only and not any(frame.review_status.value == "repair_requested" for frame in candidate.frames):
                continue
            recoverable = (
                candidate.status.value == "failed"
                and candidate.provider_status == "completed"
                and bool(candidate.provider_job_id)
                and not candidate.frames
            )
            recovery_label = " · 可取回已完成结果" if recoverable else ""
            result.append((f"生成结果 {_candidate_letter(candidate.candidate_index)} · {CANDIDATE_STATUS_CN.get(candidate.status.value, candidate.status.value)}{recovery_label}", candidate.candidate_index))
        return result

    def default_candidate(job: Any, *, approved_only: bool = False, repair_only: bool = False) -> int | None:
        choices = candidate_choices(job, approved_only=approved_only, repair_only=repair_only)
        if not choices:
            return None
        if job.export and any(value == job.export.candidate_index for _label, value in choices):
            return job.export.candidate_index
        return int(choices[0][1])

    def saved_asset_projection(
        job_id: str | None,
        candidate_index: int | None = None,
    ) -> tuple[Any, str, str | None, list[tuple[str, str]], Any, Any]:
        empty = (
            gr.update(choices=[], value=None, visible=False),
            _notice(
                "info",
                "尚未打开任务内容",
                "上方目录只有轻量摘要。点击“打开所选任务”后，才会读取候选和逐帧图片。",
            ),
            None,
            [],
            gr.update(interactive=False),
            gr.update(interactive=False),
        )
        if not job_id:
            return empty
        try:
            job = service.get_job(str(job_id))
            choices = candidate_choices(job)
            values = {int(value) for _label, value in choices}
            requested = int(candidate_index) if candidate_index is not None else None
            selected = requested if requested in values else default_candidate(job)
            if selected is None:
                return (
                    gr.update(choices=[], value=None, visible=False),
                    _notice("info", "任务尚无候选内容", "任务记录已经保存，但模型结果还没有写入本机。"),
                    None,
                    [],
                    gr.update(interactive=False),
                    gr.update(interactive=False),
                )
            candidate = next(item for item in job.candidates if item.candidate_index == selected)
            qa_current = bool(
                candidate.qa_completed_at is not None
                and candidate.qa_input_sha256
                and candidate.qa_algorithm_version == QA_ALGORITHM_VERSION
                and candidate.error is None
            )
            prefix = service.store.job_dir(job.job_id) / "previews" / candidate.candidate_id
            preview_path = prefix.with_suffix(".zoom.gif")
            if not preview_path.is_file():
                preview_path = prefix.with_suffix(".preview.gif")
            preview = str(preview_path) if qa_current and preview_path.is_file() else None
            gallery: list[tuple[str, str]] = []
            for frame in candidate.frames:
                frame_path = service.store.resolve_job_path(job.job_id, frame.active_path)
                if frame_path.is_file():
                    gallery.append(
                        (
                            str(frame_path),
                            f"第 {frame.index + 1} 帧 · {REVIEW_STATUS_CN.get(frame.review_status.value, frame.review_status.value)}" + motion_tag_caption(frame),
                        )
                    )
            repairable = bool(
                candidate.status.value not in {"approved", "rejected", "failed"}
                and not (job.export and job.export.candidate_index == candidate.candidate_index)
                and any(frame.review_status.value == "repair_requested" for frame in candidate.frames)
            )
            source = {"pixellab": "AI 生成", "import": "已有 Sheet", "fixture": "流程示例"}.get(
                job.request.provider, job.request.provider
            )
            summary = (
                '<div class="section-intro">'
                f"<h3>{_escape(job.action.display_name or job.action.action_id)} · 候选 {_candidate_letter(selected)}</h3>"
                f"<p>来源：{_escape(source)}；当前候选 {len(candidate.frames)} 帧；任务内共 {len(job.candidates)} 个候选，全部保存在同一个任务文件夹中。</p>"
                f'<p class="path-list">任务文件夹：<code>{_escape(service.store.job_dir(job.job_id))}</code></p>'
                f'<div class="qa-counts"><span class="qa-count">{_escape(CANDIDATE_STATUS_CN.get(candidate.status.value, candidate.status.value))}</span>'
                f'<span class="qa-count hard">{len(candidate.hard_failures)} 个阻止问题</span>'
                f'<span class="qa-count warn">{len(candidate.warnings)} 条提醒</span></div></div>'
            )
            summary += motion_review_html(job, candidate)
            if candidate.frames and not qa_current:
                summary += _notice(
                    "warn",
                    "动画预览需要重新检查",
                    "逐帧原图仍可查看；动态预览会在播放检查重新运行后更新，不会调用生成 API。",
                )
            return (
                gr.update(choices=choices, value=selected, visible=len(choices) > 1),
                summary,
                preview,
                gallery,
                gr.update(interactive=bool(candidate.frames)),
                gr.update(interactive=repairable),
            )
        except Exception as exc:
            return (
                gr.update(choices=[], value=None, visible=False),
                _notice("error", "任务内容无法打开", _human_error(exc)),
                None,
                [],
                gr.update(interactive=False),
                gr.update(interactive=False),
            )

    def open_saved_asset(job_id: str | None, candidate_index: int | None = None) -> tuple[Any, ...]:
        return (
            saved_asset_catalog_projection(job_id),
            *saved_asset_projection(job_id, candidate_index),
            *task_center_projection(job_id),
        )

    def select_saved_asset_summary(job_id: str | None) -> tuple[Any, ...]:
        """Change catalog selection without opening the full task payload."""
        return (
            saved_asset_catalog_projection(job_id),
            *saved_asset_projection(None),
            *task_center_projection(None),
        )

    def reload_saved_asset_catalog(current: str | None) -> tuple[Any, str]:
        choices = saved_asset_choices(current)
        values = {value for _label, value in choices}
        selected = current if current in values else choices[0][1] if choices else None
        return (
            gr.update(choices=choices, value=selected),
            saved_asset_catalog_projection(selected),
        )

    def refresh_saved_assets(
        current: str | None,
        candidate_index: int | None,
    ) -> tuple[Any, ...]:
        try:
            service.recover_pending_jobs()
        except Exception:
            pass
        choices = saved_asset_choices()
        values = {value for _label, value in choices}
        selected = current if current in values else choices[0][1] if choices else None
        return (
            gr.update(choices=choices, value=selected),
            *open_saved_asset(selected, candidate_index if selected == current else None),
        )

    def issue_markdown(candidate: Any) -> str:
        if not candidate.hard_failures and not candidate.warnings:
            return "### 自动检查明细\n\n没有发现阻止问题或提醒。仍请人工确认角色、服装、武器、肢体和动作意图。"
        lines = ["### 自动检查明细"]
        if candidate.hard_failures:
            lines.append("\n**必须先解决**")
            for item in candidate.hard_failures:
                frame = f"（第 {item.frame_index + 1} 帧）" if item.frame_index is not None else ""
                lines.append(f"- {QA_CODE_CN.get(item.code, item.code)}{frame}")
        if candidate.warnings:
            lines.append("\n**请重点留意**")
            for item in candidate.warnings:
                frame = f"（第 {item.frame_index + 1} 帧）" if item.frame_index is not None else ""
                lines.append(f"- {QA_CODE_CN.get(item.code, item.code)}{frame}")
        lines.append("\n自动检查无法替你判断角色身份、服装、武器和肢体是否符合美术要求。")
        return "\n".join(lines)

    def motion_tag_caption(frame):
        if frame.review_status.value=="approved":
            return ""
        labels=list(dict.fromkeys(("待核实 · " if t.get("evidence_status")!="confirmed" else "AI 提醒 · ")+t.get("label","视觉提醒") for t in frame.motion_tags))
        stale=any(t.get("frame_sha256")!=frame.sha256 for t in frame.motion_tags)
        return (" · 旧版提醒：" if stale else " · ⚠ ")+" / ".join(labels) if labels else ""

    def motion_frame_html(job, candidate, frame_index, phase="auto"):
        from .motion_correction import MotionCorrection
        from .motion_constraints import phase_context, PHASE_LABELS
        if job.action.action_id not in {"attack","attack_in_air"} or not candidate.frames:
            return ""
        frame=candidate.frames[frame_index]
        paths=[service.store.resolve_job_path(job.job_id,f.active_path) for f in candidate.frames]
        digest=MotionCorrection.digest(paths)
        guidance=phase_context(job,candidate,frame_index,digest,phase)
        tags=[]
        for tag in frame.motion_tags:
            stale=tag.get("review_digest")!=digest
            label=("旧版提醒 · " if stale else "已人工确认 · " if frame.review_status.value=="approved" else "AI 复核意见 · " if tag.get("evidence_status")=="confirmed" else "未经复核 · ")+tag["label"]
            stage=PHASE_LABELS.get(tag.get("phase"),"阶段待确认") if tag.get("evidence_status")=="confirmed" else "阶段待确认"
            tags.append(f'<span class="qa-count warn">{_escape(stage)} · {_escape(label)}</span>')
        previous=f"第 {guidance['previous_frame']+1} 帧" if guidance["previous_frame"] is not None else "无前帧（首帧）"
        following=f"第 {guidance['next_frame']+1} 帧" if guidance["next_frame"] is not None else "无后帧（末帧）"
        return '<div class="qa-counts">'+"".join(tags)+'</div>'+_notice(
            "warn" if guidance["phase"]=="unknown" else "info",
            f"当前帧阶段：{guidance['phase_label']} · {guidance['phase_source']}",
            f"{guidance['constraint_cn']} {guidance['grip_constraint_cn']} 修补参考：{previous} → 当前帧 → {following}。只替换当前帧，原版和其他帧保留。")

    def ai_repair_guidance(job_id, candidate_index, frame_index, phase):
        try:
            job=service.get_job(str(job_id))
            candidate=service._candidate(job,int(candidate_index))
            return motion_frame_html(job,candidate,int(frame_index),phase)
        except Exception as exc:
            return _notice("info","选择问题帧后显示阶段约束",_human_error(exc) if job_id and candidate_index is not None else "由你决定是否生成修补预览。")

    def selected_frame_html(job: Any, candidate: Any, frame_index: int) -> str:
        if not candidate.frames:
            return _notice("info", "还没有画面", "等待生成完成或先导入一张 Sheet。")
        frame_index = max(0, min(frame_index, len(candidate.frames) - 1))
        frame = candidate.frames[frame_index]
        issues = len(frame.hard_failures) + len(frame.warnings)
        return _notice(
            "info",
            f"第 {frame.index + 1} 帧",
            f"人工状态：{REVIEW_STATUS_CN.get(frame.review_status.value, frame.review_status.value)}；"
            f"自动提示 {issues} 项；手工像素版本 {frame.manual_edit_versions} 个；"
            f"上传替换 {frame.repair_attempts}/2 次。",
        ) + motion_frame_html(job,candidate,frame_index)

    def motion_review_html(job, candidate):
        from .motion_correction import MotionCorrection
        state=job.motion_control or {}
        review=candidate.motion_review
        count=len(candidate.frames)
        if review:
            try:
                paths=[service.store.resolve_job_path(job.job_id,f.active_path) for f in candidate.frames]
                current=MotionCorrection.digest(paths)==review.get("digest")
            except Exception:
                current=False
            report=review["report"]
            if not current:
                return _notice("warn","当前版本尚未经过视觉检查","现有视觉记录与当前帧未能匹配，旧结论不能证明当前版本。已采用作品仍可返回导出查看已保存文件。")
            verdict=report["verdict"]
            legacy=report.get("review_protocol_version",0)<2
            incomplete_legacy_pass=verdict=="pass" and report.get("review_protocol_version",0)<3
            hand_legacy_pass=verdict=="pass" and 3<=report.get("review_protocol_version",0)<4
            tail_legacy_pass=verdict=="pass" and report.get("review_protocol_version",0)==4
            appearance_legacy_pass=verdict=="pass" and report.get("review_protocol_version",0)==5
            title=("当前候选视觉检查未完成；不影响其他候选" if report.get("check_unavailable") else "旧版检查未独立核验人物与武器形态" if appearance_legacy_pass else "旧版检查尚未核实末尾收招" if tail_legacy_pass else "旧版检查未验证持刀手连续性" if hand_legacy_pass else "旧版检查未验证动作完整性" if incomplete_legacy_pass else "旧版 AI 意见：未经复核" if legacy else
                   {"pass":"视觉检查通过：动作完整","fail":"视觉检查发现问题：已定位待修补帧","uncertain":"视觉检查未通过：部分证据不足"}[verdict])
            evidence="；".join(f"第 {', '.join(str(i) for i in issue['frames'])} 帧：{issue['description']}" for issue in report.get("issues",[]))
            model=report.get("requested_model",report.get("model","未记录"))
            note=("这份旧报告只做过一次判断，可能误报；不作为自动阶段约束。" if legacy else
                  f"本次 {report.get('request_count',1)} 次视觉调用，未自动重新生成。")
            if report.get("review_protocol_version",0)<4:
                note+=" 本报告尚未检查持刀手连续性。"
            appearance=report.get("appearance_continuity",{})
            if appearance:
                labels={"consistent":"已核验","changed":"发现变化","uncertain":"证据不足"}
                note+=" 人物外形："+labels.get(appearance.get("body_status"),"未完成")+"；武器形态："+labels.get(appearance.get("weapon_status"),"未完成")+"。"
            hand_report=report.get("hand_continuity",{})
            if hand_report:
                note+=" 持刀手连续性："+{"consistent":"已核验","changed":"发现换手","uncertain":"连接证据不足"}.get(hand_report.get("status"),"未完成")+"。"
            from .motion_constraints import PHASE_LABELS
            stage_lines=[]
            for item in report.get('action_completeness',{}).get('stages',[]):
                label={"present":"已检出","missing":"缺失","uncertain":"证据不足"}[item['status']]
                frame_text=', '.join(str(o['frame']) for o in item['observations'])
                stage_lines.append(f"{PHASE_LABELS[item['stage']]}：{label}（第 {frame_text} 帧）。{item.get('evidence_note') or item['reason']}")
            details='<details><summary>查看逐帧证据与调用记录</summary><p>'+_escape(report.get('summary','')+' '+evidence)+'</p>'
            for item in report.get('observations',[]):
                details+='<p>'+_escape(f"第 {item['frame']} 帧：{item['observation']}")+'</p>'
            if incomplete_legacy_pass:
                note="旧版只检查了异常，没有验证举刀、蓄力、挥击、收招是否实际发生；这份通过记录不能证明攻击完整。"
            for record in report.get('requests',[]):
                details+='<p>'+_escape(f"{record['stage']} · 请求 {record.get('requested_model','未记录')} · 回传 {record.get('response_model') or '服务未回传模型名'} · 响应 ID {record.get('response_id') or '未取得'}")+'</p>'
            for decision in report.get('verification',[]):
                details+='<p>'+_escape(f"初检意见 {decision['issue_index']+1} · {decision['decision']} · {decision.get('reason','')}")+'</p>'
            details+='</details>'
            sent_label="本候选共" if report.get("check_unavailable") else "已送检全部"
            return _notice("info" if legacy or verdict!="fail" else "warn",title,
                f"{sent_label} {report.get('frame_count',count)} 帧 · 请求模型 {model}。{note} 检出问题会标记待修补帧；选择修补时带入已确认的阶段与前后帧约束。"
                + (" "+evidence if not legacy else ""))+"".join("<p>"+_escape(line)+"</p>" for line in stage_lines)+details
        record=state.get("reviews",{}).get(f"initial-{candidate.candidate_index}",{})
        legacy=MotionCorrection._legacy_unsent(job,f"initial-{candidate.candidate_index}",record)
        if state.get("state") in {"waiting","checking","repairing"}:
            title="视觉检查请求已开始" if record.get("request_started") else "等待视觉检查"
            detail=f"将检查全部 {count} 帧；请稍后刷新当前结果。"
        elif record.get("request_started") or (record.get("state")=="checking" and not legacy):
            title="视觉检查未取得有效结论"
            detail="请求已开始或结果未知；为避免重复计费，已停止自动重试。"+state.get("message","")
        else:
            title="视觉检查未执行"
            detail=(f"实际 {count} 帧。旧版本误要求 16 帧，尚未发送检查请求；现在可点击下方“继续视觉检查”。"
                    if legacy else f"实际 {count} 帧。"+state.get("message","此结果没有视觉检查记录。"))
        return _notice("info" if state.get("state") in {"waiting","checking","repairing"} else "warn",title,detail)

    def resume_vision_projection(job_id):
        from .motion_correction import MotionCorrection
        try:
            job=service.get_job(str(job_id))
            state=job.motion_control or {}
            available=(state.get("state")=="needs_repair" and bool(MotionCorrection(service).unsent_candidates(job)))
            return gr.update(visible=available)
        except Exception:
            return gr.update(visible=False)

    def resume_motion_review(job_id, candidate_index):
        try:
            from .motion_correction import MotionCorrection
            if not job_id:
                raise ValidationHarnessError("请先选择动画")
            MotionCorrection(service).resume(str(job_id))
            status=_notice("info","已继续视觉检查","复用已保存的全部帧，只检查并标记问题，不自动重新生成。视觉检查按用量计费；稍后刷新当前结果。")
        except Exception as exc:
            status=_notice("error","未继续视觉检查",_human_error(exc))
        return status,*review_payload(job_id,candidate_index)

    def review_payload(job_id: str | None, candidate_index: int | None = None) -> tuple[Any, ...]:
        empty = (
            gr.update(choices=[], value=None, visible=False), None, [], _notice("info", "还没有可检查的动画", "请先到“1 · 生成”创建动画，或展开本页底部的已有 Sheet 入口。"),
            "### 自动检查明细\n\n任务完成后会显示在这里。", {}, 0, _notice("info", "尚未选择画面", "点击下方任意帧查看。"),
            gr.update(visible=False, value=False), gr.update(interactive=False), None, None, gr.update(visible=False),
            gr.update(interactive=False), gr.update(interactive=False), gr.update(interactive=False),
            gr.update(interactive=False),
        )
        if not job_id:
            return empty
        try:
            job = service.get_job(str(job_id))
            selected = int(candidate_index) if candidate_index else default_candidate(job)
            if selected is None:
                return empty
            candidate = next(item for item in job.candidates if item.candidate_index == selected)
            integrity_ok = True
            if job.request.provider != "import":
                safety = service.candidate_safety(job.job_id, selected)
                integrity_ok = safety["result_integrity"] is True
                # The safety read may recover old commit metadata.
                job = service.get_job(job.job_id)
                candidate = next(item for item in job.candidates if item.candidate_index == selected)
            choices = candidate_choices(job)
            prefix = service.store.job_dir(job.job_id) / "previews" / candidate.candidate_id
            gallery = [
                (str(service.store.resolve_job_path(job.job_id, frame.active_path)), f"第 {frame.index + 1} 帧 · {REVIEW_STATUS_CN.get(frame.review_status.value, frame.review_status.value)}" + motion_tag_caption(frame))
                for frame in candidate.frames
            ]
            qa_current = bool(
                candidate.qa_completed_at is not None
                and candidate.qa_input_sha256
                and candidate.qa_algorithm_version == QA_ALGORITHM_VERSION
                and candidate.error is None
                and integrity_ok
            )
            hard_count = len(candidate.hard_failures) if qa_current else 0
            warning_count = len(candidate.warnings) if qa_current else 0
            repair_count = sum(
                frame.review_status.value == "repair_requested"
                for frame in candidate.frames
            )
            source = {"pixellab": "AI 生成", "import": "已有 Sheet", "fixture": "流程示例"}.get(job.request.provider, job.request.provider)
            diagnostic = '<span class="diagnostic-badge">仅供流程测试，不可作为游戏美术</span>' if candidate.diagnostic_only else ""
            summary = (
                '<div class="section-intro">'
                f"<h3>{_escape(job.action.display_name or job.action.action_id)} · {_escape(CANDIDATE_STATUS_CN.get(candidate.status.value, candidate.status.value))}</h3>"
                f"<p>来源：{_escape(source)} · {len(candidate.frames)} 帧 · {job.action.fps:g} FPS · {'循环' if job.action.loop else '单次'}</p>"
                f'<div class="qa-counts"><span class="qa-count hard">{hard_count} 个阻止问题</span><span class="qa-count warn">{warning_count} 条提醒</span></div>{diagnostic}</div>'
            )
            summary += motion_review_html(job, candidate)
            if not integrity_ok:
                summary += _notice(
                    "error",
                    "原始生成结果完整性异常",
                    "为保护已生成资产，当前候选已停止复检、批准和导出。请先从备份恢复原始结果文件。",
                )
            elif not qa_current:
                summary += _notice(
                    "warn",
                    "当前版本尚未完成本机检查",
                    "旧版本的动画预览和问题计数已隐藏。点击“重新运行本机检查”即可重建，不会调用生成 API。",
                )
            elif repair_count:
                summary += _notice(
                    "warn",
                    f"还有 {repair_count} 帧等待处理",
                    "进入逐帧修补后，可修改问题帧，也可对误标或无需改动的帧点击“采用当前帧，不修改并继续”。",
                )
            status = candidate.status.value
            recheck_enabled = integrity_ok and bool(candidate.frames) and (
                status in {"received", "check_failed", "review_ready"}
                or (
                    status == "approved"
                    and not (job.export and job.export.candidate_index == candidate.candidate_index)
                    and not qa_current
                )
            )
            mark_ok_enabled = qa_current and status == "review_ready"
            mark_repair_enabled = qa_current and status in {"review_ready", "check_failed"}
            approve_enabled = (
                qa_current
                and status == "review_ready"
                and hard_count == 0
                and repair_count == 0
            )
            repair_step_enabled = bool(repair_count) and status not in {
                "approved",
                "rejected",
                "failed",
            }
            return (
                gr.update(choices=choices, value=selected, visible=len(choices) > 1),
                _animation_player_embed(job.job_id, candidate) if qa_current and candidate.frames else "",
                gallery, summary,
                issue_markdown(candidate) if qa_current else "### 自动检查明细\n\n当前版本尚未完成本机检查；旧版本问题已隐藏。",
                {"ok": True, "job": job.model_dump(mode="json")}, 0,
                selected_frame_html(job, candidate, 0), gr.update(visible=warning_count > 0, value=False),
                gr.update(value="已采用：返回导出 →" if status == "approved" else "全部可用：采用并进入导出 →", interactive=approve_enabled or status == "approved"),
                str(prefix.with_suffix(".overlay.png")) if qa_current and prefix.with_suffix(".overlay.png").is_file() else None,
                str(prefix.with_suffix(".baseline.png")) if qa_current and prefix.with_suffix(".baseline.png").is_file() else None,
                gr.update(visible=len(choices) > 1),
                gr.update(interactive=recheck_enabled),
                gr.update(interactive=mark_ok_enabled),
                gr.update(interactive=mark_repair_enabled),
                gr.update(interactive=repair_step_enabled),
            )
        except Exception as exc:
            return gr.update(), None, [], _notice("error", "动画无法加载", _human_error(exc)), "", _error_payload(exc), 0, _notice("error", "无法选择画面", _human_error(exc)), gr.update(visible=False, value=False), gr.update(interactive=False), None, None, gr.update(visible=False), gr.update(interactive=False), gr.update(interactive=False), gr.update(interactive=False), gr.update(interactive=False)

    def review_job_update(preferred: str | None = None) -> Any:
        choices = job_choices()
        values = {value for _label, value in choices}
        selected = preferred if preferred in values else choices[0][1] if choices else None
        return gr.update(choices=choices, value=selected)

    def generation_continue_projection(job_id: str | None) -> Any:
        if not job_id:
            return gr.update(
                value="生成完成后可进入播放检查",
                interactive=False,
            )
        try:
            summary = next(
                row for row in service.store.list_jobs()
                if row.get("job_id") == str(job_id)
            )
        except (StopIteration, OSError, ValueError):
            return gr.update(
                value="正在读取任务状态…",
                interactive=False,
            )
        if summary.get("motion_state") in {"waiting", "checking", "repairing"}:
            return gr.update(value=summary.get("motion_message") or "正在检查攻击动作…", interactive=False)
        if int(summary.get("saved_candidate_count") or 0) > 0:
            return gr.update(
                value="进入 2 · 播放检查 →",
                interactive=True,
            )
        status = str(summary.get("status") or "")
        failed = status in {"failed", "attention_required"}
        return gr.update(
            value="生成需要处理，请查看状态" if failed else "模型处理中，结果保存后可继续",
            interactive=False,
        )

    def generate_animation(
        uploaded_reference: Any,
        reference_state: dict[str, Any],
        character_name: str,
        identity_prompt: str,
        saved_character_id: str | None,
        action_id: str,
        count: float,
        description: str,
        seed_text: str,
        request_key: str,
    ) -> tuple[Any, ...]:
        job = None
        updated_reference_state = reference_state or {}
        try:
            if not api_configured():
                raise ValidationHarnessError("PixelLab API key is not configured")
            if not action_id:
                raise ValidationHarnessError("请选择要生成的动作")
            if action_id in {"attack", "attack_in_air"}:
                from .vision_review import VisionReviewer
                if not VisionReviewer(service.settings).configured:
                    raise ValidationHarnessError("请先在设置中保存 视觉检查 API Key，再开始攻击生成")
            character_id, updated_reference_state = resolve_generation_character(
                uploaded_reference,
                updated_reference_state,
                character_name,
                identity_prompt,
                saved_character_id,
            )
            seed = int(seed_text.strip()) if seed_text and seed_text.strip() else None
            job = service.create_job(GenerationRequest(
                character_id=character_id, action_id=action_id, provider="pixellab", candidate_count=int(count or 1), seed=seed,
                action_description=(description or "").strip() or None,
                request_key=request_key,
            ))
            job = service.generate_job(job.job_id, wait=False)
            pending = any(item.status.value in {"provider_pending", "saving"} for item in job.candidates)
            asset_projection = saved_asset_projection(job.job_id)
            task_projection = task_center_projection(job.job_id)
            return (
                _notice(
                    "info" if pending else "ok",
                    "任务已保存并提交" if pending else "结果已安全保存",
                    "现在可以刷新或关闭页面；后台会继续查询并在完成后校验保存，不会重复提交。"
                    if pending
                    else "结果已进入“播放检查”，请播放整段动画并逐帧确认。",
                ),
                {"ok": True, "job": job.model_dump(mode="json")},
                updated_reference_state,
                gr.update(choices=official_character_choices(), value=character_id),
                uuid.uuid4().hex,
                task_job_update(job.job_id),
                saved_asset_catalog_projection(job.job_id),
                *asset_projection,
                *task_projection,
                review_job_update(job.job_id),
                *review_payload(job.job_id),
            )
        except Exception as exc:
            job_id = job.job_id if job is not None else None
            asset_projection = saved_asset_projection(job_id)
            task_projection = task_center_projection(job_id)
            keep_request_key = False
            if job_id:
                try:
                    persisted = service.get_job(job_id)
                    keep_request_key = any(
                        candidate.submission_attempts > 0
                        for candidate in persisted.candidates
                    )
                except Exception:
                    keep_request_key = True
            return (
                _notice("error", "生成没有完成", _human_error(exc)),
                _error_payload(exc),
                updated_reference_state,
                gr.update(),
                request_key if keep_request_key else uuid.uuid4().hex,
                task_job_update(job_id),
                saved_asset_catalog_projection(job_id),
                *asset_projection,
                *task_projection,
                review_job_update(job_id),
                *review_payload(job_id),
            )

    def inspect_uploaded_sheet(uploaded: Any, action_id: str | None) -> tuple[Any, str, dict[str, Any], Any]:
        if uploaded is None:
            return None, _notice("info", "等待上传", "请选择一张透明 PNG Sprite Sheet。"), {}, gr.update(interactive=False)
        try:
            source = _uploaded_path(uploaded)
            result = inspect_sprite_sheet(source, cell_width=profile.cell_width, cell_height=profile.cell_height, columns=profile.columns)
            action = project_action(action_id)
            problems: list[str] = []
            compatibility_notes: list[str] = []
            occupied_cells = {
                (index % result["columns"], index // result["columns"])
                for index, bounds in enumerate(result["cell_bounds"])
                if bounds is not None
            }
            selected_cells: list[tuple[int, int]] = []
            layout_kind = "unselected"
            if action is None:
                problems.append("还没有选择动画类型")
            elif not occupied_cells:
                problems.append("Sheet 中没有找到任何有内容的格子")
            else:
                current_cells = list(action.frame_cells)
                legacy_cells = list(action.legacy_frame_cells)
                if (
                    (result["width"], result["height"]) == action.sheet_size
                    and occupied_cells == set(current_cells)
                ):
                    selected_cells = current_cells
                    layout_kind = "current_16"
                elif (
                    action.legacy_sheet_rows is not None
                    and result["rows"] == action.legacy_sheet_rows
                    and legacy_cells
                    and occupied_cells == set(legacy_cells)
                ):
                    selected_cells = legacy_cells
                    layout_kind = "known_legacy"
                    compatibility_notes.append(
                        f"识别为“{action.display_name}”旧版 {len(legacy_cells)} 帧布局；将保留原播放顺序进入检查"
                    )
                else:
                    selected_cells = sorted(occupied_cells, key=lambda cell: (cell[1], cell[0]))
                    layout_kind = "detected_visible_cells"
                    compatibility_notes.append(
                        f"这不是新的 16 帧标准 Sheet；将按从左到右、从上到下的 {len(selected_cells)} 个可见格进入检查"
                    )
            occupied_count = len(occupied_cells)
            order_text = (
                " → ".join(
                    f"F{index + 1}=第{row + 1}行第{column + 1}格"
                    for index, (column, row) in enumerate(selected_cells)
                )
                if selected_cells
                else "选择动作后显示"
            )
            summary = (
                '<div class="section-intro"><h3>网格预检</h3>'
                f"<p>图片尺寸：{result['width']}×{result['height']}；已识别：{profile.cell_width}×{profile.cell_height}/格 · "
                f"{result['columns']} 列×{result['rows']} 行 · {occupied_count} 个有内容的格。</p>"
                f"<p>实际播放顺序：{_escape(order_text)}</p>"
            )
            if problems:
                summary += f'<div class="notice error"><strong>暂时不能加入检查</strong>{_escape("；".join(problems))}</div>'
            elif compatibility_notes:
                assert action is not None
                summary += f'<div class="notice warn"><strong>兼容旧版或非标准帧数</strong>{_escape("；".join(compatibility_notes))}。动作仍按“{_escape(action.display_name)}”的 {action.fps:g} FPS、{"循环" if action.loop else "单次"}方式播放。</div>'
            else:
                assert action is not None
                summary += f'<div class="notice ok"><strong>符合新的统一规格</strong>这是完整 16 帧、4×4 Sheet；将按“{_escape(action.display_name)}”的 {action.fps:g} FPS、{"循环" if action.loop else "单次"}方式进入检查。</div>'
            summary += "</div>"
            state = {
                **result,
                "valid": not problems,
                "action_id": action_id,
                "frame_cells": [list(cell) for cell in selected_cells],
                "layout_kind": layout_kind,
            }
            return build_grid_overlay(
                source,
                result,
                frame_cells=selected_cells or None,
            ), summary, state, gr.update(interactive=not problems)
        except Exception as exc:
            return None, _notice("error", "无法识别这张 Sheet", _human_error(exc)), {}, gr.update(interactive=False)

    def import_sheet(uploaded: Any, action_id: str, inspection: dict[str, Any]) -> tuple[Any, ...]:
        job = None
        try:
            if uploaded is None or not inspection.get("valid"):
                raise ValidationHarnessError("请先完成网格预检并选择匹配的动画类型")
            source = _uploaded_path(uploaded).resolve()
            if str(source) != str(Path(str(inspection.get("path", ""))).resolve()) or action_id != inspection.get("action_id"):
                raise ValidationHarnessError("上传文件或动画类型已变化，请重新进行网格预检")
            frame_cells = [
                (int(cell[0]), int(cell[1]))
                for cell in inspection.get("frame_cells", [])
            ]
            if not frame_cells:
                raise ValidationHarnessError("网格预检没有提供可导入的播放格位")
            job = service.create_job(GenerationRequest(
                character_id=profile.character_id, action_id=action_id, provider="import", candidate_count=1,
            ))
            job = service.ingest_candidate(
                job.job_id,
                1,
                source,
                source_kind="sheet",
                columns=profile.columns,
                frame_cells=frame_cells,
            )
            return _notice("ok", "Sheet 已切分并加入检查", "请继续在本页播放整段动画，再决定采用或修补。"), {"ok": True, "job": job.model_dump(mode="json")}, review_job_update(job.job_id), *review_payload(job.job_id)
        except Exception as exc:
            job_id = job.job_id if job is not None else None
            return _notice("error", "已有 Sheet 没有加入检查", _human_error(exc)), _error_payload(exc), review_job_update(job_id), *review_payload(job_id)

    def refresh_review(current: str | None) -> tuple[Any, ...]:
        choices = job_choices()
        values = {value for _label, value in choices}
        selected = current if current in values else choices[0][1] if choices else None
        return gr.update(choices=choices, value=selected), *review_payload(selected)

    def recover_provider_result(
        job_id: str | None,
        candidate_index: int | None,
    ) -> tuple[Any, ...]:
        try:
            if not api_configured():
                raise ValidationHarnessError("PixelLab API key is not configured")
            if not job_id:
                raise ValidationHarnessError("请先选择要取回的任务")
            job = service.get_job(str(job_id))
            selected = int(candidate_index) if candidate_index else None
            if selected is None:
                selected = next(
                    (
                        item.candidate_index
                        for item in job.candidates
                        if item.status.value == "failed"
                        and item.provider_status == "completed"
                        and item.provider_job_id
                        and not item.frames
                    ),
                    None,
                )
            if selected is None:
                raise ValidationHarnessError("所选任务没有可取回的已完成结果")
            job = service.recover_completed_candidate(job.job_id, selected)
            candidate = next(item for item in job.candidates if item.candidate_index == selected)
            pending = candidate.status.value == "provider_pending"
            return (
                _notice(
                    "info" if pending else "ok",
                    "正在读取已有结果" if pending else "已取回已有结果",
                    "没有创建新的生成任务；请稍后再点一次此按钮。"
                    if pending
                    else f"没有创建新的生成任务；已保留 {len(candidate.frames)} 个有效帧。",
                ),
                review_job_update(job.job_id),
                *review_payload(job.job_id, selected),
            )
        except Exception as exc:
            return (
                _notice("error", "已有结果没有取回", _human_error(exc)),
                review_job_update(job_id),
                *review_payload(job_id, candidate_index),
            )

    def select_frame(job_id: str | None, candidate_index: int | None, evt: gr.SelectData) -> tuple[int, str]:
        try:
            raw_index, raw_value = getattr(evt, "index", 0), getattr(evt, "value", None)
            caption = str(raw_value.get("caption") or raw_value.get("label") or "") if isinstance(raw_value, dict) else str(raw_value[1]) if isinstance(raw_value, (list, tuple)) and len(raw_value) > 1 else ""
            match = re.search(r"第\s*(\d+)\s*帧", caption)
            frame_index = int(match.group(1)) - 1 if match else int(raw_index[-1]) if isinstance(raw_index, (list, tuple)) else int(raw_index)
            job = service.get_job(str(job_id))
            candidate = next(item for item in job.candidates if item.candidate_index == int(candidate_index))
            return frame_index, selected_frame_html(job, candidate, frame_index)
        except Exception as exc:
            return 0, _notice("error", "无法选择这帧", _human_error(exc))

    def mark_frame(job_id: str | None, candidate_index: int | None, frame_index: int, status: str, issue_type: str, note: str) -> tuple[Any, ...]:
        try:
            service.review_frame(str(job_id), int(candidate_index), FrameReviewRequest(
                frame_index=int(frame_index), status=status, issue_type=issue_type if status == "repair_requested" else None,
                note=note or "", reviewer="web_user",
            ))
            message = "这帧已加入“逐帧修补”列表。" if status == "repair_requested" else "这帧已标记为没有问题。"
            repairs = job_choices(repair_only=True)
            selected = str(job_id) if any(value == str(job_id) for _label, value in repairs) else repairs[0][1] if repairs else None
            return (
                _notice("ok", "判断已保存", message),
                *review_payload(str(job_id), int(candidate_index)),
                gr.update(choices=repairs, value=selected),
                *repair_projection(selected, int(candidate_index) if selected == str(job_id) else None, int(frame_index) if selected == str(job_id) else None),
            )
        except Exception as exc:
            repairs = job_choices(repair_only=True)
            selected = str(job_id) if any(value == str(job_id) for _label, value in repairs) else repairs[0][1] if repairs else None
            return (
                _notice("error", "没有保存成功", _human_error(exc)),
                *review_payload(job_id, candidate_index),
                gr.update(choices=repairs, value=selected),
                *repair_projection(selected),
            )

    def approve_candidate(job_id: str | None, candidate_index: int | None, acknowledge: bool) -> tuple[Any, ...]:
        try:
            job = service.get_job(str(job_id))
            selected = next(item for item in job.candidates if item.candidate_index == int(candidate_index))
            if selected.status.value != "approved":
                service.approve_candidate(str(job_id), int(candidate_index), reviewer="web_user", acknowledge_warnings=bool(acknowledge))
            return (
                _notice("ok", "已打开所选动画的导出页", "已有采用结果直接复用；查看、下载或交付不会再次审批。"),
                gr.update(selected="export"),
                *review_payload(str(job_id), int(candidate_index)),
                gr.update(choices=job_choices(approved_only=True), value=str(job_id)),
                *export_projection(str(job_id), int(candidate_index)),
                *_export_download_files(service, str(job_id), int(candidate_index)),
            )
        except Exception as exc:
            return (
                _notice("error", "还不能采用这组动画", _human_error(exc)),
                gr.update(),
                *review_payload(job_id, candidate_index),
                gr.update(choices=job_choices(approved_only=True)),
                *export_projection(None),
                None, None, [],
            )

    def reject_candidate(job_id: str | None, candidate_index: int | None, note: str) -> tuple[Any, ...]:
        try:
            service.reject_candidate(str(job_id), int(candidate_index), reviewer="web_user", note=note or "")
            return _notice("ok", "已放弃这组结果", "其他生成结果和原始文件仍保留。"), *review_payload(str(job_id), int(candidate_index))
        except Exception as exc:
            return _notice("error", "暂时无法放弃", _human_error(exc)), *review_payload(job_id, candidate_index)

    def recheck_candidate(job_id: str | None, candidate_index: int | None) -> tuple[Any, ...]:
        if not job_id or candidate_index is None:
            return _notice("error", "没有可检查的动画", "请先选择一个已经保存的生成结果。"), *review_payload(job_id, candidate_index)
        try:
            service.check_candidate(str(job_id), int(candidate_index))
            return (
                _notice(
                    "ok",
                    "本机检查已重新完成",
                    "没有调用生成 API，也没有消耗生成次数；当前预览和问题计数已更新。",
                ),
                *review_payload(str(job_id), int(candidate_index)),
            )
        except Exception as exc:
            return (
                _notice(
                    "error",
                    "本机检查仍未完成",
                    f"已保存的帧不会丢失，也不会消耗生成次数。{_human_error(exc)}",
                ),
                *review_payload(job_id, candidate_index),
            )

    def repair_job_choices_with_context(current: str | None = None) -> list[tuple[str, str]]:
        choices = job_choices(repair_only=True)
        if not current or any(value == str(current) for _label, value in choices):
            return choices
        try:
            job = service.get_job(str(current))
            has_safe_context = any(
                candidate.frames
                and candidate.status.value not in {"approved", "rejected", "failed"}
                and not (job.export and job.export.candidate_index == candidate.candidate_index)
                for candidate in job.candidates
            )
            if has_safe_context:
                choices.insert(0, (job_label(job) + " · 当前修补上下文", job.job_id))
        except Exception:
            pass
        return choices

    def repair_projection(job_id: str | None, candidate_index: int | None = None, frame_index: int | None = None) -> tuple[Any, ...]:
        empty = (
            gr.update(choices=[], value=None, visible=False), gr.update(choices=[], value=None), None, [],
            _notice("info", "当前没有待修补帧", "先到“播放检查”选择问题帧并点击“把当前帧送去修补”。"),
            gr.update(interactive=False), gr.update(value="other"), gr.update(value=""),
            _pixel_editor_embed(None, None, None), None, gr.update(value=None), {},
            [], gr.update(interactive=False), gr.update(interactive=False),
            gr.update(interactive=False), gr.update(interactive=False),
        )
        if not job_id:
            return empty
        try:
            job = service.get_job(str(job_id))
            candidates = candidate_choices(job, repair_only=True)
            explicit_candidate = None
            if candidate_index is not None:
                explicit_candidate = next(
                    (
                        item
                        for item in job.candidates
                        if item.candidate_index == int(candidate_index)
                        and item.frames
                        and item.status.value not in {"approved", "rejected", "failed"}
                        and not (job.export and job.export.candidate_index == item.candidate_index)
                    ),
                    None,
                )
            if explicit_candidate is not None and not any(
                value == explicit_candidate.candidate_index for _label, value in candidates
            ):
                candidates.append(
                    (
                        f"生成结果 {_candidate_letter(explicit_candidate.candidate_index)} · "
                        f"{CANDIDATE_STATUS_CN.get(explicit_candidate.status.value, explicit_candidate.status.value)} · 当前上下文",
                        explicit_candidate.candidate_index,
                    )
                )
            selected_candidate = (
                explicit_candidate.candidate_index
                if explicit_candidate is not None
                else default_candidate(job, repair_only=True)
            )
            if selected_candidate is None:
                return empty
            candidate = next(item for item in job.candidates if item.candidate_index == selected_candidate)
            frames = list(candidate.frames)
            problem_indices = [
                frame.index
                for frame in frames
                if frame.review_status.value == "repair_requested"
            ]
            selected_frame = (
                int(frame_index)
                if frame_index is not None and any(frame.index == int(frame_index) for frame in frames)
                else problem_indices[0] if problem_indices else frames[0].index
            )
            frame_position = next(
                index for index, item in enumerate(frames) if item.index == selected_frame
            )
            frame = frames[frame_position]
            current = service.store.resolve_job_path(job.job_id, frame.active_path)
            neighbor_specs: list[tuple[int, str]] = []
            if frame_position > 0:
                neighbor_specs.append((frame_position - 1, "上一帧"))
            elif job.action.loop and len(frames) > 1:
                neighbor_specs.append((len(frames) - 1, "循环上一帧"))
            neighbor_specs.append((frame_position, "当前帧"))
            if frame_position + 1 < len(frames):
                neighbor_specs.append((frame_position + 1, "下一帧"))
            elif job.action.loop and len(frames) > 1:
                neighbor_specs.append((0, "循环下一帧"))
            seen_neighbor_positions: set[int] = set()
            neighbors = []
            for position, relationship in neighbor_specs:
                if position in seen_neighbor_positions:
                    continue
                seen_neighbor_positions.add(position)
                neighbor_frame = frames[position]
                neighbors.append(
                    (
                        str(service.store.resolve_job_path(job.job_id, neighbor_frame.active_path)),
                        f"{relationship} · 第 {neighbor_frame.index + 1} 帧",
                    )
                )
            frame_choices = []
            timeline = []
            for item in frames:
                _state_key, icon, state_label = _repair_frame_state(candidate, item)
                suffix = f" · {item.review_note}" if item.review_note else ""
                caption = f"{icon} 第 {item.index + 1} 帧 · {state_label}{suffix}" + motion_tag_caption(item)
                frame_choices.append((caption, item.index))
                timeline.append(
                    (
                        str(service.store.resolve_job_path(job.job_id, item.active_path)),
                        caption,
                    )
                )
            state_key, _icon, state_label = _repair_frame_state(candidate, frame)
            can_manual_edit = bool(
                candidate.status.value not in {"approved", "rejected", "failed"}
                and not (job.export and job.export.candidate_index == candidate.candidate_index)
            )
            can_replace = (
                can_manual_edit
                and frame.review_status.value == "repair_requested"
                and frame.repair_attempts < 2
            )
            qa_current = bool(
                candidate.qa_completed_at is not None
                and candidate.qa_input_sha256
                and candidate.qa_algorithm_version == QA_ALGORITHM_VERSION
                and candidate.error is None
            )
            can_accept_frame = bool(
                can_manual_edit
                and qa_current
                and candidate.status.value == "review_ready"
                and not frame.hard_failures
                and frame.review_status.value != "approved"
            )
            can_finish_repair = bool(
                can_manual_edit
                and qa_current
                and candidate.status.value == "review_ready"
                and not candidate.hard_failures
                and not problem_indices
            )
            navigation_enabled = bool(problem_indices) and (
                len(problem_indices) > 1 or selected_frame not in problem_indices
            )
            notice_kind = {
                "blocked": "error",
                "repair": "warn",
                "modified": "ok",
                "approved": "ok",
                "pending": "info",
            }[state_key]
            notice_title = (
                f"正在修补第 {selected_frame + 1} 帧 · {state_label}"
                if can_manual_edit
                else f"正在查看第 {selected_frame + 1} 帧 · {state_label}"
            )
            edit_guidance = (
                "当前帧可以直接进行手工像素修补；保存后会回到待复审状态。"
                if can_manual_edit
                else "当前候选已批准、拒绝、失败或导出，因此保持只读。"
            )
            return (
                gr.update(choices=candidates, value=selected_candidate, visible=len(candidates) > 1), gr.update(choices=frame_choices, value=selected_frame),
                str(current), neighbors, _notice(
                    notice_kind,
                    notice_title,
                    f"只修改这一格；其他 {len(candidate.frames) - 1} 帧不变。"
                    f"当前还有 {len(problem_indices)} 帧待修补。{edit_guidance}"
                    f"手工像素版本 {frame.manual_edit_versions} 个；上传替换 {frame.repair_attempts}/2 次。",
                ) + motion_review_html(job, candidate) + motion_frame_html(job,candidate,selected_frame) + _repair_qa_change_html(candidate),
                gr.update(interactive=can_replace), gr.update(value=frame.issue_type.value if frame.issue_type else "other"), gr.update(value=frame.review_note),
                _pixel_editor_embed(job.job_id, selected_candidate, selected_frame), frame.sha256,
                gr.update(value=None), {},
                timeline,
                gr.update(interactive=navigation_enabled),
                gr.update(interactive=navigation_enabled),
                gr.update(interactive=can_accept_frame),
                gr.update(interactive=can_finish_repair),
            )
        except Exception as exc:
            return (*empty[:4], _notice("error", "修补任务无法加载", _human_error(exc)), *empty[5:])

    def refresh_repairs(
        current: str | None,
        candidate_index: int | None,
        frame_index: int | None,
    ) -> tuple[Any, ...]:
        choices = repair_job_choices_with_context(current)
        values = {value for _label, value in choices}
        selected = current if current in values else choices[0][1] if choices else None
        preserve = selected == current
        return gr.update(choices=choices, value=selected), *repair_projection(
            selected,
            candidate_index if preserve else None,
            frame_index if preserve else None,
        )

    def load_saved_asset_in_review(
        job_id: str | None,
        candidate_index: int | None,
    ) -> tuple[Any, ...]:
        try:
            if not job_id or candidate_index is None:
                raise ValidationHarnessError("请先打开一个已有画面的候选")
            job = service.get_job(str(job_id))
            candidate = next(
                item for item in job.candidates if item.candidate_index == int(candidate_index)
            )
            if not candidate.frames:
                raise ValidationHarnessError("这个候选还没有保存任何画面")
            choices = job_choices()
            return (
                _notice("ok", "已载入播放检查", "当前任务和候选已经打开，可以继续检查或标记待修补帧。"),
                gr.update(selected="review"),
                gr.update(choices=choices, value=str(job_id)),
                *review_payload(str(job_id), int(candidate_index)),
            )
        except Exception as exc:
            return (
                _notice("error", "无法进入播放检查", _human_error(exc)),
                gr.update(),
                review_job_update(job_id),
                *review_payload(job_id, candidate_index),
            )

    def load_saved_asset_in_repair(
        job_id: str | None,
        candidate_index: int | None,
    ) -> tuple[Any, ...]:
        try:
            if not job_id or candidate_index is None:
                raise ValidationHarnessError("请先打开一个含待修补帧的候选")
            job = service.get_job(str(job_id))
            candidate = next(
                item for item in job.candidates if item.candidate_index == int(candidate_index)
            )
            if not any(frame.review_status.value == "repair_requested" for frame in candidate.frames):
                raise ValidationHarnessError("这个候选当前没有待修补帧；请先到播放检查中标记")
            choices = repair_job_choices_with_context(str(job_id))
            return (
                _notice("ok", "已载入逐帧修补", "已打开该候选的第一个待修补帧。"),
                gr.update(selected="repair"),
                gr.update(choices=choices, value=str(job_id)),
                *repair_projection(str(job_id), int(candidate_index)),
            )
        except Exception as exc:
            return (
                _notice("error", "无法进入逐帧修补", _human_error(exc)),
                gr.update(),
                gr.update(choices=repair_job_choices_with_context(job_id), value=job_id),
                *repair_projection(job_id, candidate_index),
            )

    def navigate_problem_frame(
        job_id: str | None,
        candidate_index: int | None,
        frame_index: int | None,
        direction: int,
    ) -> tuple[Any, ...]:
        try:
            job = service.get_job(str(job_id))
            candidate = next(
                item for item in job.candidates if item.candidate_index == int(candidate_index)
            )
            problem_indices = [
                frame.index
                for frame in candidate.frames
                if frame.review_status.value == "repair_requested"
            ]
            target = _adjacent_problem_frame_index(problem_indices, frame_index, direction)
            return repair_projection(job.job_id, candidate.candidate_index, target)
        except Exception:
            return repair_projection(job_id, candidate_index, frame_index)

    def accept_repair_frame(
        job_id: str | None,
        candidate_index: int | None,
        frame_index: int | None,
    ) -> tuple[Any, ...]:
        unchanged_export = (gr.update(), gr.update(), gr.update(), gr.update(), gr.update(), gr.update())
        try:
            if not job_id or candidate_index is None or frame_index is None:
                raise ValidationHarnessError("请先选择要采用的当前帧")
            updated = service.review_frame(
                str(job_id),
                int(candidate_index),
                FrameReviewRequest(
                    frame_index=int(frame_index),
                    status="approved",
                    reviewer="web_user",
                    note="accepted current frame without another pixel edit",
                ),
            )
            candidate = next(
                item for item in updated.candidates
                if item.candidate_index == int(candidate_index)
            )
            if candidate.status.value == "approved":
                export_choices = job_choices(approved_only=True)
                return (
                    _notice("ok", "当前帧已采用，整组检查完成", "所有帧都已通过，已经为你打开导出页。"),
                    gr.update(selected="export"),
                    gr.update(choices=repair_job_choices_with_context(None), value=None),
                    *repair_projection(None),
                    gr.update(choices=export_choices, value=str(job_id)),
                    *export_projection(str(job_id), int(candidate_index)),
                )
            remaining = [
                frame.index
                for frame in candidate.frames
                if frame.review_status.value == "repair_requested"
            ]
            target = _adjacent_problem_frame_index(remaining, int(frame_index), 1)
            if target is None:
                target = int(frame_index)
            choices = repair_job_choices_with_context(str(job_id))
            return (
                _notice(
                    "ok",
                    "当前帧已采用",
                    "没有建立新的修改版本；已保留当前显示的帧，并转到下一个待处理位置。",
                ),
                gr.update(selected="repair"),
                gr.update(choices=choices, value=str(job_id)),
                *repair_projection(str(job_id), int(candidate_index), target),
                *unchanged_export,
            )
        except Exception as exc:
            return (
                _notice("error", "当前帧还不能直接采用", _human_error(exc)),
                gr.update(),
                gr.update(),
                *repair_projection(job_id, candidate_index, frame_index),
                *unchanged_export,
            )

    def finish_repair_and_review(
        job_id: str | None,
        candidate_index: int | None,
    ) -> tuple[Any, ...]:
        unchanged_export = (gr.update(), gr.update(), gr.update(), gr.update(), gr.update(), gr.update())
        try:
            if not job_id or candidate_index is None:
                raise ValidationHarnessError("请先选择已经完成修补的候选")
            job = service.get_job(str(job_id))
            candidate = next(
                item for item in job.candidates
                if item.candidate_index == int(candidate_index)
            )
            remaining = [
                frame.index + 1
                for frame in candidate.frames
                if frame.review_status.value == "repair_requested"
            ]
            if remaining:
                raise ValidationHarnessError(
                    "仍有待修补帧：" + "、".join(str(index) for index in remaining)
                )
            if candidate.status.value == "approved":
                export_choices = job_choices(approved_only=True)
                return (
                    _notice("ok", "整组动画已经通过", "已直接打开导出页。"),
                    gr.update(selected="export"),
                    review_job_update(str(job_id)),
                    *review_payload(str(job_id), int(candidate_index)),
                    gr.update(choices=export_choices, value=str(job_id)),
                    *export_projection(str(job_id), int(candidate_index)),
                )
            checked = service.check_candidate(str(job_id), int(candidate_index))
            checked_candidate = next(
                item for item in checked.candidates
                if item.candidate_index == int(candidate_index)
            )
            hard_count = len(checked_candidate.hard_failures)
            return (
                _notice(
                    "error" if hard_count else "ok",
                    "修补后仍有阻止问题" if hard_count else "修补完成，请重新播放确认",
                    "已经重新运行本机检查；请在播放检查页从头播放，再决定采用或继续修补。",
                ),
                gr.update(selected="review"),
                review_job_update(str(job_id)),
                *review_payload(str(job_id), int(candidate_index)),
                *unchanged_export,
            )
        except Exception as exc:
            return (
                _notice("error", "还不能进入下一步", _human_error(exc)),
                gr.update(),
                review_job_update(job_id),
                *review_payload(job_id, candidate_index),
                *unchanged_export,
            )

    def select_repair_timeline_frame(
        job_id: str | None,
        candidate_index: int | None,
        evt: gr.SelectData,
    ) -> tuple[Any, ...]:
        try:
            job = service.get_job(str(job_id))
            candidate = next(
                item for item in job.candidates if item.candidate_index == int(candidate_index)
            )
            raw_index = getattr(evt, "index", 0)
            position = int(raw_index[-1]) if isinstance(raw_index, (list, tuple)) else int(raw_index)
            if position < 0 or position >= len(candidate.frames):
                raise IndexError(position)
            return repair_projection(job.job_id, candidate.candidate_index, candidate.frames[position].index)
        except Exception:
            return repair_projection(job_id, candidate_index)

    def replace_repair_frame(
        job_id: str | None,
        candidate_index: int | None,
        frame_index: int | None,
        replacement: Any,
        base_sha256: str | None,
        upload_context: dict[str, Any] | None,
    ) -> tuple[Any, ...]:
        try:
            if replacement is None:
                raise ValidationHarnessError("请上传修补后的透明 PNG")
            expected_upload_context = {
                "job_id": str(job_id or ""),
                "candidate_index": int(candidate_index) if candidate_index is not None else None,
                "frame_index": int(frame_index) if frame_index is not None else None,
                "base_sha256": str(base_sha256 or ""),
            }
            if upload_context != expected_upload_context:
                raise ValidationHarnessError(
                    "上传图片所属的任务、候选或帧已经变化；为防止写错帧，请重新选择文件"
                )
            updated = service.replace_frame(
                str(job_id),
                int(candidate_index),
                int(frame_index),
                _uploaded_path(replacement),
                base_sha256=str(base_sha256 or ""),
            )
            updated_candidate = next(
                item for item in updated.candidates if item.candidate_index == int(candidate_index)
            )
            qa_current = bool(
                updated_candidate.qa_completed_at is not None
                and updated_candidate.qa_input_sha256
                and updated_candidate.qa_algorithm_version == QA_ALGORITHM_VERSION
                and updated_candidate.error is None
            )
            choices = repair_job_choices_with_context(str(job_id))
            selected = str(job_id) if any(value == str(job_id) for _label, value in choices) else choices[0][1] if choices else None
            notice = (
                _notice(
                    "warn",
                    "替换帧已保存，自动复查未完成",
                    "原图和新版本都已保留；可在播放检查中重新运行检查。",
                )
                if not qa_current
                else _notice(
                    "ok",
                    "替换帧已保存并重新检查",
                    "原图仍保留；请回到“播放检查”重新播放整段动画。",
                )
            )
            preserve = selected == str(job_id)
            return notice, gr.update(choices=choices, value=selected), *repair_projection(
                selected,
                int(candidate_index) if preserve and candidate_index is not None else None,
                int(frame_index) if preserve and frame_index is not None else None,
            )
        except Exception as exc:
            choices = repair_job_choices_with_context(str(job_id) if job_id else None)
            return _notice("error", "替换没有生效", _human_error(exc)), gr.update(choices=choices, value=job_id), *repair_projection(job_id, candidate_index, frame_index)

    def vision_status():
        from .vision_review import VisionReviewer
        reviewer=VisionReviewer(service.settings)
        configured=reviewer.configured
        note=("可复用服务端 TOKENHUB_API_KEY，或在此保存 TokenHub Key。" if reviewer.provider=="hunyuan" else "使用独立的 OpenAI API Key。")
        return _notice("ok" if configured else "warn", "视觉检查已配置" if configured else "视觉检查待配置",
            f"请求模型 {reviewer.info['model']}，检查全部实际帧（1–64 帧）；初检加至多一次复核，按 API 用量计费。TokenHub Key 是访问凭据，不会自动选择 Image V3；Image V3 用于生图，本页使用图片理解模型。" + note)

    def select_vision_provider(provider):
        from .vision_review import VisionReviewer
        try:
            VisionReviewer(service.settings).select(provider)
            return vision_status(), "", gr.update(value=provider)
        except Exception as exc:
            return _notice("error","切换失败",_human_error(exc)), "", gr.update(value=VisionReviewer(service.settings).provider)

    def save_vision_key(value, provider):
        from .vision_review import VisionReviewer
        try:
            reviewer=VisionReviewer(service.settings)
            if reviewer.provider!=provider:
                raise ValidationHarnessError("所选服务已改变，请重新选择服务再保存 Key")
            reviewer.save_key(value)
            return vision_status(), ""
        except Exception as exc:
            return _notice("error", "保存失败", _human_error(exc)), ""

    def ai_repair_display(job_id, attempt):
        token={"job_id":job_id, "attempt_id":attempt["id"], "candidate_index":attempt["candidate_index"], "frame_index":attempt["targets"][0]}
        ready=attempt["state"]=="proposed"
        path=service.store.job_dir(job_id)/"motion"/attempt["id"]/f"proposed_{attempt['targets'][0]}.png"
        report=attempt.get("report",{})
        message=report.get("summary") or "请求已保存；稍后点击刷新结果，不会再次生成。"
        return _notice("info", "修补预览：确认后再采用" if ready else "正在修补", message), str(path) if ready else None, token

    def ai_repair_selection(job_id, candidate_index, frame_index, base_sha256):
        # Clear a previous frame's error/preview when the selected context changes.
        # Selection itself never reserves a generation or changes review status.
        if not job_id or candidate_index is None or frame_index is None:
            return _notice("info", "尚未选择修补帧", "在上方完整帧条中选择要修补的画面。"), None, {}
        return _notice(
            "info", f"已选中第 {int(frame_index) + 1} 帧",
            "可直接生成修补预览，无需先标记待修补。请确认攻击阶段，只有点击生成按钮才会请求 AI。"
            if base_sha256 else "正在加载当前帧版本，请稍候。",
        ), None, {}

    def ai_repair_start(job_id, candidate_index, frame_index, base_sha256, phase="auto", note="", retry=False):
        try:
            from .motion_correction import MotionCorrection
            result=MotionCorrection(service).manual(str(job_id),int(candidate_index),int(frame_index),base_sha256,note,phase=phase,retry=retry,wait=False)
            return ai_repair_display(str(job_id),result)
        except Exception as exc:
            return _notice("error","AI 修补未完成",_human_error(exc)),None,{}

    def ai_repair_refresh(token):
        try:
            from .motion_correction import MotionCorrection
            if not token:
                raise ValidationHarnessError("请先生成修补预览")
            controller=MotionCorrection(service)
            with service.store.operation_lock(token["job_id"],"motion",timeout_seconds=2):
                job=service.get_job(token["job_id"])
                attempt=controller._attempt(job,token["attempt_id"])
                if attempt["state"]=="reserved":
                    controller._advance_attempt(token["job_id"],token["attempt_id"],False)
                attempt=controller._attempt(service.get_job(token["job_id"]),token["attempt_id"])
            return ai_repair_display(token["job_id"],attempt)
        except Exception as exc:
            return _notice("error","查询未完成",_human_error(exc)),None,token

    def ai_repair_adopt(token, job_id, candidate_index, frame_index):
        try:
            from .motion_correction import MotionCorrection
            if not token or (str(job_id),int(candidate_index),int(frame_index)) != (token["job_id"],token["candidate_index"],token["frame_index"]):
                raise ValidationHarnessError("请回到生成预览时选中的帧再采用")
            MotionCorrection(service).adopt(str(job_id),token["attempt_id"],manual=True)
            return _notice("ok","已采用修补帧","原版已保留；请播放检查衔接。"), *repair_projection(job_id,candidate_index,frame_index)
        except Exception as exc:
            return _notice("error","采用失败",_human_error(exc)), *repair_projection(job_id,candidate_index,frame_index)

    def capture_repair_upload_context(
        replacement: Any,
        job_id: str | None,
        candidate_index: int | None,
        frame_index: int | None,
        base_sha256: str | None,
    ) -> dict[str, Any]:
        if replacement is None:
            return {}
        return {
            "job_id": str(job_id or ""),
            "candidate_index": int(candidate_index) if candidate_index is not None else None,
            "frame_index": int(frame_index) if frame_index is not None else None,
            "base_sha256": str(base_sha256 or ""),
        }

    def export_projection(job_id: str | None, candidate_index: int | None = None) -> tuple[Any, ...]:
        empty = gr.update(choices=[], value=None, visible=False), _notice("info", "还没有可导出的动画", "先在“播放检查”确认采用一组动画。"), None, gr.update(value=""), gr.update(interactive=False)
        if not job_id:
            return empty
        try:
            job = service.get_job(str(job_id))
            choices = candidate_choices(job, approved_only=True)
            choice_values = {value for _label, value in choices}
            requested = int(candidate_index) if candidate_index else None
            if requested is not None and requested not in choice_values:
                return (*empty[:1], _notice("warn", "该候选尚未采用", "请先检查并采用所选候选；不会自动切换到其他已采用结果。"), *empty[2:])
            selected = requested if requested is not None else default_candidate(job, approved_only=True)
            if selected is None:
                return empty
            candidate = next(item for item in job.candidates if item.candidate_index == selected)
            integrity_ok = True
            if job.request.provider != "import":
                safety = service.candidate_safety(job.job_id, selected)
                integrity_ok = safety["result_integrity"] is True
                job = service.get_job(job.job_id)
                candidate = next(item for item in job.candidates if item.candidate_index == selected)
            qa_current = bool(
                candidate.qa_completed_at is not None
                and candidate.qa_input_sha256
                and candidate.qa_algorithm_version == QA_ALGORITHM_VERSION
                and candidate.error is None
                and integrity_ok
            )
            already_exported = bool(
                job.export and job.export.candidate_index == candidate.candidate_index
            )
            columns = job.action.sheet_columns or job.character.sheet_columns
            if len(candidate.frames) == job.action.frame_count:
                rows = job.action.sheet_rows or math.ceil(len(candidate.frames) / columns)
                frame_cells = job.action.frame_cells
            else:
                rows = max(job.action.sheet_rows or 0, math.ceil(len(candidate.frames) / columns))
                frame_cells = []
            width, height = job.character.cell_width * columns, job.character.cell_height * rows
            regular_cells = [(index % columns, index // columns) for index in range(len(candidate.frames))]
            order_text = (
                "按项目指定格位读取（透明空格不参与播放）"
                if frame_cells and frame_cells != regular_cells
                else "从左到右、从上到下"
            )
            try:
                action = profile.action(job.action.action_id)
                filename = action.filename if job.character.character_id == profile.character_id else f"{job.character.character_id}_{job.action.action_id}.png"
            except KeyError:
                filename = f"{job.character.character_id}_{job.action.action_id}.png"
            unused_count = columns * rows - len(candidate.frames)
            count_note = (
                f"实际采用 {len(candidate.frames)} 帧；末尾 {unused_count} 个格子保持透明。"
                if unused_count
                else f"实际采用 {len(candidate.frames)} 帧；没有空格。"
            )
            summary = (
                '<div class="section-intro"><h3>最终 Sprite Sheet</h3>'
                f"<p>输出尺寸：{width}×{height}；单帧：{job.character.cell_width}×{job.character.cell_height}；"
                f"排列：{columns} 列×{rows} 行；顺序：{order_text}；背景：透明 RGBA。{count_note}</p>"
                '<div class="notice info"><strong>关于位置对齐</strong>每帧保留完整画布，不会紧贴角色裁切，也不会逐帧自动居中。导出会保持你在检查页确认过的坐标。</div></div>'
            )
            if not integrity_ok:
                summary += _notice(
                    "error",
                    "原始生成结果完整性异常",
                    "新的导出已被阻止。若此前已经导出，旧文件仍保持只读可用；请先恢复任务的原始结果文件。",
                )
            elif not qa_current and already_exported:
                summary += _notice(
                    "warn",
                    "已有导出已保留，当前页面只读",
                    "此候选使用的是旧版检查规则，已导出的文件不会消失；为避免覆盖历史结果，当前版本不允许重新导出。",
                )
            elif not qa_current:
                summary += _notice(
                    "warn",
                    "导出前需要重新检查",
                    "检查规则已经升级。请回到“播放检查”运行一次本机检查，再确认采用；不会消耗 API 次数。",
                )
            prefix = service.store.job_dir(job.job_id) / "previews" / candidate.candidate_id
            preview = prefix.with_suffix(".sheet.png")
            if already_exported and job.export is not None:
                exported_sheet = service.settings.resolve_record_path(job.export.sheet_path)
                if exported_sheet.is_file():
                    preview = exported_sheet
                filename = Path(job.export.sheet_path).name
                if not _export_download_files(service, job.job_id, selected)[1]:
                    # A legacy PNG export stays intact while a new complete bundle is written.
                    stem = Path(filename).stem + "_godot"
                    folder = exported_sheet.parent
                    suffix = 1
                    filename = stem + ".png"
                    while any((folder / (Path(filename).stem + ext)).exists() for ext in (".png", ".godot.zip", ".preview.gif", ".recipe.json", ".qa.json")):
                        suffix += 1
                        filename = f"{stem}_{suffix}.png"
                    summary += _notice("info", "此旧导出尚无可用 Godot 包", "已建议新的文件名。点击导出可补齐资源包，原 PNG 与旧导出文件保留。")
            return (
                gr.update(choices=choices, value=selected, visible=len(choices) > 1),
                summary,
                str(preview) if preview.is_file() else None,
                gr.update(value=filename),
                gr.update(interactive=qa_current),
            )
        except Exception as exc:
            return (*empty[:1], _notice("error", "导出信息无法加载", _human_error(exc)), *empty[2:])

    def refresh_exports(current: str | None, candidate_index: int | None = None) -> tuple[Any, ...]:
        choices = job_choices(approved_only=True)
        values = {value for _label, value in choices}
        selected = current if current in values else choices[0][1] if choices else None
        return gr.update(choices=choices, value=selected), *export_projection(selected, candidate_index if selected == current else None)

    def export_downloads(job_id: str | None, candidate_index: int | None = None) -> tuple[Any, ...]:
        return _export_download_files(service, job_id, candidate_index)

    def export_one(job_id: str | None, candidate_index: int | None, filename: str, overwrite: bool) -> tuple[str, str | None, str | None, list[str], dict[str, Any]]:
        try:
            job = service.export_candidate(str(job_id), int(candidate_index), ExportOptions(filename=(filename or "").strip(), overwrite=bool(overwrite)))
            assert job.export is not None
            return (
                _notice("ok", "PNG 与 Godot 动画包已导出", "Godot 包已包含 SpriteFrames，无需逐帧添加。在 Forge 中可选择游戏项目并复制 WorkBuddy 接入请求；独立工具仍可下载 ZIP。"),
                *_export_download_files(service, job.job_id, int(candidate_index)),
                {"ok": True, "job": job.model_dump(mode="json")},
            )
        except Exception as exc:
            return _notice("error", "导出没有完成", _human_error(exc)), None, None, [], _error_payload(exc)

    def run_demo() -> tuple[Any, ...]:
        job = None
        try:
            job = service.create_job(GenerationRequest(character_id="diagnostic_dummy", action_id="idle", provider="fixture", candidate_count=1))
            job = service.generate_job(job.job_id, wait=True)
            visible_diagnostic_jobs.add(job.job_id)
            return _notice("ok", "离线示例已完成", "请到“播放检查”体验后续按钮；这不是游戏美术，也不代表模型质量。"), {"ok": True, "job": job.model_dump(mode="json")}, review_job_update(job.job_id), *review_payload(job.job_id)
        except Exception as exc:
            job_id = job.job_id if job is not None else None
            return _notice("error", "示例没有完成", _human_error(exc)), _error_payload(exc), review_job_update(job_id), *review_payload(job_id)

    characters, actions = official_character_choices(), project_action_choices()
    initial_character = profile.character_id if any(value == profile.character_id for _label, value in characters) else characters[0][1] if characters else None
    initial_action = actions[0][1] if actions else None
    initial_reference, _initial_character_summary = character_projection(initial_character)
    # Startup only builds small catalog rows. Candidate records, frame paths and
    # previews are loaded after the operator explicitly opens a task.
    initial_jobs = job_choices(); initial_job = None; initial_review = review_payload(None)
    initial_tasks = saved_asset_choices(); initial_task_job = initial_tasks[0][1] if initial_tasks else None
    initial_asset_catalog = saved_asset_catalog_projection(initial_task_job)
    initial_asset = saved_asset_projection(None)
    initial_task = task_center_projection(None)
    initial_repairs = job_choices(repair_only=True); initial_repair_job = None; initial_repair = repair_projection(None)
    initial_exports = job_choices(approved_only=True); initial_export_job = None; initial_export = export_projection(None)

    workbench_theme = gr.themes.Base(
        primary_hue="violet",
        secondary_hue="cyan",
        neutral_hue="slate",
        text_size="lg",
        spacing_size="md",
        radius_size="md",
        font=("Segoe UI", "Microsoft YaHei UI", "PingFang SC", "sans-serif"),
        font_mono=("Cascadia Mono", "Consolas", "monospace"),
    ).set(
        body_background_fill="light-dark(var(--theme-light-bg), #080d19)",
        body_background_fill_dark="light-dark(var(--theme-light-bg), #080d19)",
        body_text_color="light-dark(var(--theme-light-text), #f4f7ff)",
        body_text_color_dark="light-dark(var(--theme-light-text), #f4f7ff)",
        body_text_color_subdued="light-dark(var(--theme-light-muted), #c1c9dc)",
        body_text_color_subdued_dark="light-dark(var(--theme-light-muted), #c1c9dc)",
        body_text_size="16px",
        background_fill_primary="light-dark(var(--theme-light-bg), #080d19)",
        background_fill_primary_dark="light-dark(var(--theme-light-bg), #080d19)",
        background_fill_secondary="light-dark(var(--theme-light-surface), #0e1729)",
        background_fill_secondary_dark="light-dark(var(--theme-light-surface), #0e1729)",
        border_color_primary="light-dark(var(--theme-light-border), #2d3c5a)",
        border_color_primary_dark="light-dark(var(--theme-light-border), #2d3c5a)",
        border_color_accent="light-dark(var(--theme-light-accent), #a894ff)",
        border_color_accent_dark="light-dark(var(--theme-light-accent), #a894ff)",
        color_accent="light-dark(var(--theme-light-accent), #a894ff)",
        color_accent_soft="light-dark(var(--theme-light-accent-soft), rgba(168, 148, 255, .16))",
        color_accent_soft_dark="light-dark(var(--theme-light-accent-soft), rgba(168, 148, 255, .16))",
        link_text_color="light-dark(var(--theme-light-text), #70d8ff)",
        link_text_color_dark="light-dark(var(--theme-light-text), #70d8ff)",
        link_text_color_hover="light-dark(var(--theme-light-text), #a7e8ff)",
        link_text_color_hover_dark="light-dark(var(--theme-light-text), #a7e8ff)",
        prose_text_size="16px",
        block_background_fill="light-dark(var(--theme-light-panel), #111b2f)",
        block_background_fill_dark="light-dark(var(--theme-light-panel), #111b2f)",
        block_border_color="light-dark(var(--theme-light-border), #2d3c5a)",
        block_border_color_dark="light-dark(var(--theme-light-border), #2d3c5a)",
        block_info_text_color="light-dark(var(--theme-light-muted), #c1c9dc)",
        block_info_text_color_dark="light-dark(var(--theme-light-muted), #c1c9dc)",
        block_info_text_size="15px",
        block_label_background_fill="light-dark(var(--theme-light-panel), #111b2f)",
        block_label_background_fill_dark="light-dark(var(--theme-light-panel), #111b2f)",
        block_label_border_color="light-dark(var(--theme-light-border), #2d3c5a)",
        block_label_border_color_dark="light-dark(var(--theme-light-border), #2d3c5a)",
        block_label_text_color="light-dark(var(--theme-light-text), #e3e9f8)",
        block_label_text_color_dark="light-dark(var(--theme-light-text), #e3e9f8)",
        block_label_text_size="15px",
        panel_background_fill="light-dark(var(--theme-light-surface), #0e1729)",
        panel_background_fill_dark="light-dark(var(--theme-light-surface), #0e1729)",
        panel_border_color="light-dark(var(--theme-light-border), #2d3c5a)",
        panel_border_color_dark="light-dark(var(--theme-light-border), #2d3c5a)",
        accordion_text_color="light-dark(var(--theme-light-text), #e3e9f8)",
        accordion_text_color_dark="light-dark(var(--theme-light-text), #e3e9f8)",
        table_text_color="light-dark(var(--theme-light-text), #edf2ff)",
        table_text_color_dark="light-dark(var(--theme-light-text), #edf2ff)",
        input_background_fill="light-dark(var(--theme-light-panel), #0b1425)",
        input_background_fill_dark="light-dark(var(--theme-light-panel), #0b1425)",
        input_background_fill_focus="light-dark(var(--theme-light-panel), #111f36)",
        input_background_fill_focus_dark="light-dark(var(--theme-light-panel), #111f36)",
        input_background_fill_hover="light-dark(var(--theme-light-surface), #0f1b30)",
        input_background_fill_hover_dark="light-dark(var(--theme-light-surface), #0f1b30)",
        input_border_color="light-dark(var(--theme-light-control-border), #3a4968)",
        input_border_width="1px",
        input_border_width_dark="1px",
        input_border_color_dark="light-dark(var(--theme-light-control-border), #3a4968)",
        input_border_color_focus="light-dark(var(--theme-light-accent), #a894ff)",
        input_border_color_focus_dark="light-dark(var(--theme-light-accent), #a894ff)",
        input_border_color_hover="light-dark(var(--theme-light-control-border), #5c6e94)",
        input_border_color_hover_dark="light-dark(var(--theme-light-control-border), #5c6e94)",
        input_placeholder_color="light-dark(var(--theme-light-placeholder), #919db8)",
        input_placeholder_color_dark="light-dark(var(--theme-light-placeholder), #919db8)",
        input_text_size="16px",
        checkbox_label_text_color="light-dark(var(--theme-light-text), #e3e9f8)",
        checkbox_label_text_color_dark="light-dark(var(--theme-light-text), #e3e9f8)",
        checkbox_label_text_color_selected="light-dark(var(--theme-light-text), #ffffff)",
        checkbox_label_text_color_selected_dark="light-dark(var(--theme-light-text), #ffffff)",
        checkbox_label_text_size="16px",
        button_medium_text_size="16px",
        button_large_text_size="17px",
        button_primary_background_fill="light-dark(var(--theme-light-primary), #765cf2)",
        button_primary_background_fill_dark="light-dark(var(--theme-light-primary), #765cf2)",
        button_primary_background_fill_hover="light-dark(var(--theme-light-primary-hover), #8b74ff)",
        button_primary_background_fill_hover_dark="light-dark(var(--theme-light-primary-hover), #8b74ff)",
        button_primary_border_color="light-dark(var(--theme-light-border), #a894ff)",
        button_primary_border_color_dark="light-dark(var(--theme-light-border), #a894ff)",
        button_primary_text_color="light-dark(var(--theme-light-on-primary), #ffffff)",
        button_primary_text_color_dark="light-dark(var(--theme-light-on-primary), #ffffff)",
        button_primary_text_color_hover="light-dark(var(--theme-light-on-primary), #ffffff)",
        button_primary_text_color_hover_dark="light-dark(var(--theme-light-on-primary), #ffffff)",
        button_secondary_background_fill="light-dark(var(--theme-light-surface), #182641)",
        button_secondary_background_fill_dark="light-dark(var(--theme-light-surface), #182641)",
        button_secondary_background_fill_hover="light-dark(var(--theme-light-surface), #233454)",
        button_secondary_background_fill_hover_dark="light-dark(var(--theme-light-surface), #233454)",
        button_secondary_border_color="light-dark(var(--theme-light-border), #3a4b6d)",
        button_secondary_border_color_dark="light-dark(var(--theme-light-border), #3a4b6d)",
        button_secondary_text_color="light-dark(var(--theme-light-text), #f0f4ff)",
        button_secondary_text_color_dark="light-dark(var(--theme-light-text), #f0f4ff)",
        button_secondary_text_color_hover="light-dark(var(--theme-light-text), #ffffff)",
        button_secondary_text_color_hover_dark="light-dark(var(--theme-light-text), #ffffff)",
        button_cancel_background_fill="light-dark(var(--theme-light-danger-soft), #321b29)",
        button_cancel_background_fill_dark="light-dark(var(--theme-light-danger-soft), #321b29)",
        button_cancel_background_fill_hover="light-dark(var(--theme-light-danger-soft), #482337)",
        button_cancel_background_fill_hover_dark="light-dark(var(--theme-light-danger-soft), #482337)",
        button_cancel_border_color="light-dark(var(--theme-light-border), #87415a)",
        button_cancel_border_color_dark="light-dark(var(--theme-light-border), #87415a)",
        button_cancel_text_color="light-dark(var(--theme-light-danger), #ffb3c2)",
        button_cancel_text_color_dark="light-dark(var(--theme-light-danger), #ffb3c2)",
        button_cancel_text_color_hover="light-dark(var(--theme-light-danger), #ffd3dc)",
        button_cancel_text_color_hover_dark="light-dark(var(--theme-light-danger), #ffd3dc)",
    )

    with gr.Blocks(title="像素角色动画工作台", fill_width=True) as demo:
        gr.HTML(
            '<button id="sprite-theme-toggle" type="button">切换深浅模式</button>'
            '<div id="sprite-hero"><div class="product-row"><div class="product-copy">'
            '<span class="product-eyebrow">SPRITE PIPELINE</span><h1>像素角色动画工作台</h1>'
            '<p>从作品继续创作。找到角色原图、预览动画、整理地图，再开始下一步。</p>'
            f'</div><span class="project-pill">{_escape(profile.project_name)} · {_escape(profile.character_name)}</span></div>'
            '<details class="workflow-guide"><summary>查看制作流程</summary><div class="flow-map">'
            '<div class="flow-box"><span class="flow-number">1</span><div><b>导入并生成</b><small>原图、角色与动作</small></div></div>'
            '<div class="flow-box"><span class="flow-number">2</span><div><b>播放并检查</b><small>整段预览、逐帧判断</small></div></div>'
            '<div class="flow-box"><span class="flow-number">3</span><div><b>按需修补</b><small>只处理有问题的帧</small></div></div>'
            '<div class="flow-box"><span class="flow-number">4</span><div><b>确认并导出</b><small>固定 4×4 PNG Sheet</small></div></div>'
            '</div></details></div>'
        )
        header_status = gr.HTML(header_status_html())
        with gr.Tabs(selected="assets", elem_classes=["workflow-tabs"]) as workflow_tabs:
            with gr.Tab("作品库", id="assets") as library_tab:
                gr.HTML(_stage_header("作品库", "你的作品，接着做", "用画面找到素材，从当前状态继续创作。"))
                with gr.Row(elem_classes=["library-toolbar"]):
                    library_kind = gr.Radio([("全部", "all"), ("角色原图", "character"), ("动画", "animation"), ("地图", "map")], value="all", label="作品类型", elem_classes=["choice-cards"], scale=3)
                    library_search = gr.Textbox(label="搜索作品", placeholder="搜索角色、动作或地图名称", scale=2)
                with gr.Row():
                    library_import_toggle = gr.Button("＋ 导入素材", variant="primary")
                    library_generate = gr.Button("制作新动作 →")
                    library_refresh = gr.Button("刷新作品")
                    library_records = gr.Button("执行记录")
                library_action_status = gr.HTML()
                with gr.Accordion("导入素材", open=False) as library_import_panel:
                    library_import_kind = gr.Radio([("角色原图", "character"), ("地图", "map")], value="character", label="素材类型")
                    gr.Markdown("角色支持 128×128 透明 PNG 或每格 128×128、4 列的 Sheet；地图支持静态 PNG / JPEG / WebP。保存原图不会消耗生成额度。已有动画可从右侧入口导入。")
                    library_import_file = gr.File(label="选择素材文件", file_types=[".png", ".jpg", ".jpeg", ".webp"], type="filepath")
                    library_import_name = gr.Textbox(label="作品名称（可选）")
                    with gr.Row():
                        library_import_save = gr.Button("保存到作品库", variant="primary")
                        library_import_animation = gr.Button("导入已有动画 Sheet →")
                library_rows = gr.State(library.list_artworks())
                library_page = gr.State(1)
                with gr.Column(elem_classes=["artwork-grid"]) as library_grid:
                    pass
                with gr.Row(elem_classes=["library-pagination"]):
                    library_previous = gr.Button("← 上一页")
                    library_page_label = gr.Markdown()
                    library_next = gr.Button("下一页 →")
                with gr.Accordion("作品详情与执行记录", open=False, elem_id="artwork-detail") as library_detail_panel:
                    library_detail_title = gr.HTML(_notice("info", "选择一件作品查看详情", "卡片上的按钮可以直接继续创作。全部执行记录也可在这里查找。"))
                    library_detail_image = gr.Image(label="作品预览", interactive=False, type="filepath", height=300, visible=False, elem_classes=["pixel-preview"])
                    library_download = gr.File(label="导出文件", file_count="multiple", interactive=False, visible=False)
                    with gr.Group(elem_classes=["context-panel"]):
                        gr.Markdown("失败、重试、未生成和测试记录保留在这里。选择记录后可查看结果和恢复信息。")
                        with gr.Row():
                            task_job = gr.Dropdown(initial_tasks, value=initial_task_job, label="执行记录", filterable=False, elem_classes=["static-choice"], scale=6)
                            open_asset_button = gr.Button("打开所选任务", variant="primary", scale=1, elem_classes=["compact-action"])
                            refresh_asset_catalog_button = gr.Button("刷新", scale=1, elem_classes=["compact-action"])
                    asset_catalog_status = gr.HTML(initial_asset_catalog)
                    with gr.Accordion("记录中的候选画面", open=False, elem_id="artwork-candidate") as record_content_panel:
                        asset_candidate = gr.Radio(
                            initial_asset[0].get("choices", []),
                            value=initial_asset[0].get("value"),
                            visible=bool(initial_asset[0].get("visible", False)),
                            label="该任务中的候选",
                            elem_classes=["choice-cards"],
                        )
                        asset_summary = gr.HTML(initial_asset[1])
                        with gr.Row():
                            with gr.Column(elem_classes=["workspace-card"]):
                                asset_animation_preview = gr.Image(initial_asset[2], label="动画预览", type="filepath", interactive=False, height=360, elem_classes=["pixel-preview"])
                            with gr.Column(elem_classes=["workspace-card"]):
                                asset_frame_gallery = gr.Gallery(initial_asset[3], label="逐帧画面", columns=4, rows=2, height=360, object_fit="contain", allow_preview=False, elem_classes=["frame-gallery"])
                        with gr.Row(elem_classes=["step-actions"]):
                            asset_review_button = gr.Button("在播放检查中打开", interactive=bool(initial_asset[4].get("interactive", False)))
                            asset_repair_button = gr.Button("打开待修补帧", interactive=bool(initial_asset[5].get("interactive", False)))
                        asset_action_status = gr.HTML()
                    with gr.Accordion("任务保存与恢复（仅异常时使用）", open=False, elem_classes=["secondary-zone"]):
                        gr.Markdown("只有打开任务后才读取完整安全记录。后台只会继续查询已经提交的任务，不会自动创建第二次生成。")
                        refresh_task_button = gr.Button("安全刷新 / 继续取回已有结果")
                        task_status = gr.HTML(initial_task[0])
                        with gr.Accordion("任务完整记录（排错时再看）", open=False, elem_classes=["advanced-panel"]):
                            task_details = gr.JSON(initial_task[1])
                        with gr.Accordion("提交结果未知时的人工恢复", open=False, elem_classes=["advanced-panel"]):
                            gr.Markdown("只有在 PixelLab 网页或其他记录中能找到此次生成的远端任务编号时才填写。此操作只绑定并查询已有任务，绝不会再次提交生成。")
                            attach_candidate = gr.Dropdown(
                                initial_task[2].get("choices", []),
                                value=initial_task[2].get("value"),
                                label="需要恢复的候选",
                                interactive=bool(initial_task[2].get("interactive", False)),
                                filterable=False,
                                elem_classes=["static-choice"],
                            )
                            attach_provider_id = gr.Textbox(label="PixelLab 远端任务编号")
                            attach_provider_button = gr.Button("绑定并只取回已有结果")
                            attach_status = gr.HTML()


            with gr.Tab("开始", id="example"):
                gr.HTML(
                    _stage_header("开始", "先认识三个输入与输出", "不需要先理解任务编号、候选编号或本机路径；主流程会自动传递当前结果。")
                    + '<div class="guide-grid">'
                    + '<div class="guide-card"><span class="card-number">A</span><b>角色原型</b><p>上传希望保持其形象、装备和比例的透明 PNG。</p></div>'
                    + '<div class="guide-card"><span class="card-number">B</span><b>动作描述</b><p>选择动作模板，再补充这一次希望呈现的节奏和姿势。</p></div>'
                    + '<div class="guide-card"><span class="card-number">C</span><b>最终输出</b><p>经过播放、检查和可选修补后，得到均匀切分的 4×4 PNG Sheet。</p></div>'
                    + '</div>'
                )
                with gr.Accordion("可选：先体验一次不消耗额度的流程示例", open=False, elem_classes=["advanced-panel"]):
                    gr.Markdown("示例只解释按钮与流程，使用测试图形，不代表真实游戏美术质量。")
                    run_demo_button = gr.Button("运行离线流程示例")
                    demo_status = gr.HTML()
                    with gr.Accordion("示例任务详情（排错时再看）", open=False):
                        demo_details = gr.JSON()
                with gr.Row(elem_classes=["step-actions"]):
                    example_next_button = gr.Button("下一步：导入角色原图与提示词 →", variant="primary")

            with gr.Tab("1 · 生成", id="generate", elem_id="generation-tab"):
                gr.HTML(_stage_header("1", "导入角色并生成动作", "左边定义角色，右边定义动作；确认额度后按固定次数生成；攻击会分段完成。"))
                with gr.Row(elem_classes=["status-strip"]):
                    with gr.Column(scale=3):
                        ai_api_banner = gr.HTML(api_banner_html())
                    with gr.Column(scale=3):
                        quota_status = gr.HTML(quota_html())
                    with gr.Column(scale=1):
                        open_api_settings_button = gr.Button("API 设置", elem_classes=["compact-action"])
                        refresh_quota_button = gr.Button("刷新额度", elem_classes=["compact-action"])
                with gr.Row(elem_classes=["generation-workspace"]):
                    with gr.Column(scale=5, min_width=360, elem_classes=["workspace-card", "reference-card"]):
                        gr.HTML(_card_heading("角色", "导入角色原型", "上传新原图；没有新原图时再展开已保存角色。"))
                        with gr.Row(elem_classes=["reference-inputs"]):
                            with gr.Column(min_width=150):
                                generation_reference_file = gr.File(
                                    label="上传角色原型 PNG",
                                    file_count="single",
                                    file_types=[".png"],
                                    type="filepath",
                                )
                            with gr.Column(min_width=150):
                                generation_reference_preview = gr.Image(initial_reference, label="实际送给模型的参考帧", type="pil", interactive=False, height=200, elem_classes=["pixel-preview"], elem_id="generation-reference-preview")
                        gr.Markdown("支持 **128×128 透明 PNG**，也支持 4 列、128×128/格的角色 Sheet；后者会自动取第一个非空格。")
                        generation_reference_status = gr.HTML(_notice("info", "当前使用已保存角色", "上传新的角色原型 PNG 后，会改用上传图片。"))
                        generation_reference_state = gr.State({})
                        edit_reference_button = gr.Button("在像素画布中修改原图", elem_id="edit-reference-button")
                        generation_character_name = gr.Textbox(label="角色名称（可选）", placeholder="例如：赛博剑士；留空时记为“新角色”")
                        generation_identity_prompt = gr.Textbox(
                            label="角色外观提示词（推荐填写）",
                            placeholder="例如：保持蓝黑色盔甲、青色发光线条、头身比例、头盔和长剑外形不变",
                            lines=3,
                        )
                        with gr.Accordion("备用：使用已保存角色", open=False, elem_classes=["advanced-panel"]):
                            generate_character = gr.Dropdown(characters, value=initial_character, label="已保存角色", filterable=False, elem_classes=["static-choice"])
                    with gr.Column(scale=6, min_width=400, elem_classes=["workspace-card", "generation-action-card"]):
                        gr.HTML(_card_heading("动作", "选择并描述动作", "攻击按阶段分配帧数；补充提示词描述本次节奏和姿势。"))
                        generate_action = gr.Dropdown(actions, value=initial_action, label="要生成的动作", filterable=False, elem_classes=["static-choice"])
                        generate_action_summary = gr.HTML(action_projection(initial_action))
                        action_description = gr.Textbox(label="本次动作提示词（可选）", placeholder="例如：起步慢、第三帧开始加速、武器始终朝前；留空使用项目动作规格", lines=4)
                        candidate_count = gr.Slider(1, 5, value=1, step=1, label="生成几个候选？（每个候选单独提交，额度随尺寸和帧数变化）")
                        generation_cost = gr.HTML(generation_cost_html(1, initial_action))
                        with gr.Accordion("复现与调试设置", open=False):
                            seed = gr.Textbox(label="Seed（可选）", placeholder="留空则自动生成并记录")
                        with gr.Group(elem_classes=["action-panel", "generation-submit"]):
                            gr.HTML(_card_heading("提交", "开始制作", "任务自动保存，可稍后回来查看。"))
                            generate_button = gr.Button("开始生成候选", variant="primary", interactive=api_configured(), elem_classes=["primary-action"])
                            generation_status = gr.HTML()
                            generation_next_button = gr.Button("生成完成后可进入播放检查", interactive=False)
                reference_editor_context = gr.State({})
                with gr.Accordion("原图像素画布", open=False, elem_id="reference-canvas-panel") as reference_editor_panel:
                    reference_editor = gr.HTML(_notice("info", "先打开原图", "上传或选择原图后，点击“在像素画布中修改原图”。"))
                reference_transfer_character = gr.Textbox(value="", elem_id="reference-transfer-character", elem_classes=["internal-bridge"], container=False)
                reference_transfer_apply = gr.Button("使用已移送原图", elem_id="reference-transfer-apply", elem_classes=["internal-bridge"])
                generation_request_key = gr.BrowserState(
                    uuid.uuid4().hex,
                    storage_key="sprite_pipeline_generation_request_key_v1",
                    secret="sprite-pipeline-local-idempotency-v1",
                )
                with gr.Accordion("生成任务技术记录（仅排错时查看）", open=False, elem_classes=["advanced-panel"]):
                    generation_details = gr.JSON(label="任务记录")
                generation_job = gr.State(None)
                with gr.Accordion("额度原始记录（仅排错时查看）", open=False, elem_classes=["advanced-panel"]):
                    quota_details = gr.JSON(service.get_cached_balance() or {})
            with gr.Tab("2 · 播放检查", id="review"):
                gr.HTML(_stage_header("2", "先播放，再逐帧判断", "先看动作整体是否连贯，再点击具体帧；只有发现问题时才进入修补。"))
                with gr.Group(elem_classes=["context-panel"]):
                    with gr.Row():
                        review_job = gr.Dropdown(initial_jobs, value=initial_job, label="当前检查的动画", filterable=False, elem_classes=["static-choice"], scale=6)
                        refresh_review_button = gr.Button("刷新当前结果", scale=1, elem_id="refresh-review-button", elem_classes=["compact-action"])
                    with gr.Accordion("结果维护：重新检查或取回旧任务（一般不需要）", open=False, elem_classes=["advanced-panel"]):
                        with gr.Row():
                            recheck_button = gr.Button("重新运行本机检查（不消耗 API）", interactive=bool(initial_review[13].get("interactive", False)))
                            recover_result_button = gr.Button("取回所选旧结果（不重新生成）")
                        recovery_status = gr.HTML()
                with gr.Group(visible=bool(initial_review[12].get("visible", False))) as review_candidate_group:
                    review_candidate = gr.Radio(initial_review[0].get("choices", []), value=initial_review[0].get("value"), label="选择 AI 生成结果", elem_classes=["choice-cards"])
                review_summary = gr.HTML(initial_review[3])
                resume_vision_button = gr.Button("继续视觉检查（仅检查和标记，按用量计费）", visible=False, elem_classes=["compact-action"])
                gr.HTML('<div class="section-label"><span>先看整体</span><h3>播放整段动画</h3><p>选择单次、循环或往返播放；可慢放、快放或直接调整播放 FPS。</p></div>')
                with gr.Row():
                    with gr.Column(scale=3, min_width=420, elem_classes=["workspace-card", "playback-card"]):
                        animation_preview = gr.HTML(initial_review[1] or "", elem_id="animation-preview")
                    with gr.Column(scale=1, min_width=250, elem_classes=["workspace-card", "review-check-card"]):
                        gr.HTML(_card_heading("本机检查", "尺寸与透明度等基础检查", "它用于发现尺寸、透明度和突变位移；最终仍以你的视觉判断为准。"))
                        review_issues = gr.Markdown(initial_review[4])
                gr.HTML('<div class="section-label"><span>再看细节</span><h3>逐帧检查</h3><p>点击一帧后，只做一个判断：采用，或标记为待修补。</p></div>')
                with gr.Column(elem_classes=["workspace-card"]):
                    frame_gallery = gr.Gallery(initial_review[2], label="全部帧（点击选择）", columns=8, rows=2, height=350, object_fit="contain", allow_preview=False, selected_index=0, elem_classes=["frame-gallery", "compact-timeline"])
                    selected_frame_index = gr.State(initial_review[6])
                    selected_frame_banner = gr.HTML(initial_review[7])
                    with gr.Row():
                        issue_type = gr.Dropdown(ISSUE_TYPE_CHOICES, value="other", label="问题类型（仅有问题时选择）", filterable=False, elem_classes=["static-choice"])
                        review_note = gr.Textbox(label="问题说明（可选）", placeholder="例如：剑在这一帧突然变短")
                    with gr.Row():
                        mark_ok_button = gr.Button("✓ 当前帧可用", interactive=bool(initial_review[14].get("interactive", False)))
                        mark_repair_button = gr.Button("标记为待修补", interactive=bool(initial_review[15].get("interactive", False)))
                with gr.Accordion("辅助判断：位置参考线与相邻帧叠影", open=False, elem_classes=["advanced-panel"]):
                    gr.Markdown("十字线只是项目放置参考，不要求每帧人物都严格压在交点上。相邻帧叠影中，紫红色是前一帧、青色是当前帧；连续的小幅位移是正常的，突然分离很远才是问题。工具不会裁剪、缩放或重新居中任何一帧。")
                    with gr.Row():
                        baseline_preview = gr.Image(initial_review[11], label="项目参考线（不强制居中）", type="filepath", interactive=False, elem_classes=["pixel-preview"])
                        overlay_preview = gr.Image(initial_review[10], label="相邻帧叠影", type="filepath", interactive=False, elem_classes=["pixel-preview"])
                with gr.Group(elem_classes=["action-panel"]):
                    gr.HTML(_card_heading("整组决定", "检查完成后选择去向", "有问题就进入修补；没有问题就确认采用并自动带入导出页。"))
                    acknowledge = gr.Checkbox(value=bool(initial_review[8].get("value", False)), label="我已查看自动提醒，仍决定采用", visible=bool(initial_review[8].get("visible", False)))
                    with gr.Row(elem_classes=["decision-bar"]):
                        review_repair_button = gr.Button("有标记问题：进入逐帧修补 →", interactive=bool(initial_review[16].get("interactive", False)))
                        approve_button = gr.Button("全部可用：采用并进入导出 →", variant="primary", interactive=bool(initial_review[9].get("interactive", False)))
                review_action_status = gr.HTML()
                with gr.Accordion("不采用这组结果", open=False, elem_classes=["secondary-zone"]):
                    reject_button = gr.Button("放弃这组结果", variant="stop")
                with gr.Accordion("其他入口：检查一张已有 Sprite Sheet", open=False, elem_classes=["secondary-zone"]) as sheet_import_panel:
                    gr.Markdown("这里只用于已经是动画 Sheet 的 PNG；角色原型图请回到“1 · 生成”上传。")
                    with gr.Row():
                        with gr.Column():
                            import_file = gr.File(label="已有 Sprite Sheet（PNG）", file_count="single", file_types=[".png"], type="filepath")
                            import_action = gr.Dropdown(actions, value=None, label="这是什么动画？（必须确认）", filterable=False, elem_classes=["static-choice"])
                            gr.Markdown("按动画含义选择。检查规格为 **128×128/格、4 列、RGBA**；旧帧数及尾部透明补格仍可进入检查。")
                        with gr.Column(scale=2):
                            import_grid_preview = gr.Image(label="切分网格预览", type="pil", interactive=False, elem_classes=["sheet-preview"])
                    import_inspection = gr.HTML(_notice("info", "等待已有 Sheet", "上传后先确认网格和动作类型。"))
                    import_state = gr.State({})
                    import_button = gr.Button("切分并加入播放检查", variant="primary", interactive=False, elem_classes=["primary-action"])
                    import_status = gr.HTML()
                    with gr.Accordion("检查素材记录（仅排错时查看）", open=False, elem_classes=["advanced-panel"]):
                        import_details = gr.JSON(label="已有 Sheet 任务记录")
                with gr.Accordion("QA 与任务技术记录（仅排错时查看）", open=False, elem_classes=["advanced-panel"]):
                    review_details = gr.JSON(initial_review[5], label="QA 与任务记录")

            with gr.Tab("3 · 逐帧修补", id="repair"):
                gr.HTML(_stage_header("3", "只修补真正有问题的帧", "从时间轴选择帧：需要修改就打开像素画布，已经可用就直接采用并继续。"))
                with gr.Group(elem_classes=["context-panel"]):
                    with gr.Row():
                        repair_job = gr.Dropdown(initial_repairs, value=initial_repair_job, label="当前修补的动画", filterable=False, elem_classes=["static-choice"], scale=6)
                        refresh_repair_button = gr.Button("刷新当前结果", scale=1, elem_id="refresh-repair-button", elem_classes=["compact-action"])
                    with gr.Row():
                        repair_candidate = gr.Dropdown(initial_repair[0].get("choices", []), value=initial_repair[0].get("value"), visible=bool(initial_repair[0].get("visible", False)), label="生成结果", filterable=False, elem_classes=["static-choice"])
                        repair_frame = gr.Dropdown(initial_repair[1].get("choices", []), value=initial_repair[1].get("value"), label="当前帧 / 快速跳转", filterable=False, elem_classes=["static-choice"])
                gr.HTML('<div class="section-label"><span>问题队列</span><h3>选择下一帧</h3><p>完整时间轴始终保留；带工具图标的是待处理帧。</p></div>')
                with gr.Column(elem_classes=["workspace-card"]):
                    repair_timeline = gr.Gallery(
                        initial_repair[12],
                        label="完整帧条（点击任意帧查看）",
                        columns=8,
                        rows=2,
                        height=350,
                        object_fit="contain",
                        allow_preview=False,
                        elem_classes=["frame-gallery", "compact-timeline"],
                    )
                    with gr.Row():
                        previous_problem_button = gr.Button(
                            "← 上一个问题帧",
                            interactive=bool(initial_repair[13].get("interactive", False)),
                        )
                        next_problem_button = gr.Button(
                            "下一个问题帧 →",
                            interactive=bool(initial_repair[14].get("interactive", False)),
                        )
                        accept_repair_frame_button = gr.Button(
                            "当前帧已可用：采用并继续 →",
                            interactive=bool(initial_repair[15].get("interactive", False)),
                        )
                repair_summary = gr.HTML(initial_repair[4])
                with gr.Tabs(selected="manual", elem_id="repair-tools", elem_classes=["tool-tabs"]):
                    with gr.Tab("手工像素画布", id="manual"):
                        gr.HTML('<div class="section-label"><span>像素画布</span><h3>编辑当前帧</h3><p>保存会建立新版本并自动复查，不消耗生成额度；原始帧永久保留。</p></div>')
                        repair_editor = gr.HTML(initial_repair[8], elem_classes=["editor-shell"])
                        repair_base_sha256 = gr.State(initial_repair[9])
                    with gr.Tab("AI 修补当前帧", id="ai"):
                        gr.Markdown("只有点击下方按钮才会请求重新生成，按 PixelLab 和视觉检查用量计费。每帧最多生成 2 次，每次预览至多 2 次视觉调用。参考原图固定服装与配色，前后帧约束动作；先预览再由你采用。阶段不确定时请先选择。")
                        from .motion_constraints import PHASE_LABELS
                        ai_repair_phase = gr.Dropdown([("自动使用可靠的视觉判断","auto"), *[(label,key) for key,label in PHASE_LABELS.items() if key!="unknown"]], value="auto", label="当前帧应处于的阶段", filterable=False)
                        ai_phase_guidance = gr.HTML()
                        with gr.Row():
                            ai_repair_button = gr.Button("按阶段与前后帧约束生成预览", variant="primary")
                            ai_retry_button = gr.Button("再试一次（最多两次）")
                            ai_refresh_button = gr.Button("刷新修补结果")
                        ai_repair_status = gr.HTML()
                        ai_repair_preview = gr.Image(label="修补预览", type="filepath", interactive=False, height=256, elem_classes=["pixel-preview"])
                        ai_repair_token = gr.State({})
                        ai_adopt_button = gr.Button("采用这张修补帧")
                    with gr.Tab("上传替换整帧", id="external"):
                        gr.Markdown("备用：使用外部绘图软件替换整帧")
                        gr.Markdown("如需使用 Aseprite、Krita 等外部工具，可上传相同尺寸的透明 PNG。这个入口仍保留两次替换限制；内置手工像素版本没有该限制。")
                        replacement_file = gr.File(label="修补后的透明 PNG（必须仍为 128×128）", file_count="single", file_types=[".png"], type="filepath")
                        repair_upload_context = gr.State({})
                        replace_button = gr.Button("保存外部替换并重新检查", variant="primary", interactive=bool(initial_repair[5].get("interactive", False)), elem_classes=["primary-action"])
                with gr.Accordion("辅助判断：相邻帧与原问题记录", open=False, elem_classes=["advanced-panel"]):
                    with gr.Row():
                        repair_current = gr.Image(initial_repair[2], label="当前版本", type="filepath", interactive=False, height=330, elem_classes=["pixel-preview"])
                        repair_neighbors = gr.Gallery(initial_repair[3], label="上一帧 / 当前帧 / 下一帧", columns=3, height=330, allow_preview=False, elem_classes=["frame-gallery"])
                    with gr.Row():
                        repair_issue_type = gr.Dropdown(ISSUE_TYPE_CHOICES, value=initial_repair[6].get("value", "other"), label="问题类型（记录用）", interactive=False, filterable=False, elem_classes=["static-choice"])
                        repair_note = gr.Textbox(value=initial_repair[7].get("value", ""), label="原问题说明", interactive=False)
                with gr.Group(elem_classes=["action-panel"]):
                    gr.HTML(_card_heading("完成", "所有问题帧处理完毕", "回到整段动画重新播放；确认无误后再进入导出。"))
                    repair_action_status = gr.HTML()
                    finish_repair_button = gr.Button(
                        "修补完成：返回整段播放确认 →",
                        variant="primary",
                        interactive=bool(initial_repair[16].get("interactive", False)),
                    )

            with gr.Tab("4 · 导出", id="export") as export_tab:
                gr.HTML(_stage_header("4", "确认文件名并导出", "当前已采用的动画会自动带入；一次导出透明 PNG 和 Godot SpriteFrames 动画包，导入后无需手动添加帧。"))
                with gr.Group(elem_classes=["context-panel"]):
                    with gr.Row():
                        export_job = gr.Dropdown(initial_exports, value=initial_export_job, label="当前导出的动画", filterable=False, elem_classes=["static-choice"], scale=6)
                        refresh_export_button = gr.Button("刷新列表", scale=1, elem_classes=["compact-action"])
                export_candidate = gr.Radio(initial_export[0].get("choices", []), value=initial_export[0].get("value"), visible=bool(initial_export[0].get("visible", False)), label="已采用结果", elem_classes=["choice-cards"])
                with gr.Row():
                    with gr.Column(scale=3, elem_classes=["workspace-card"]):
                        gr.HTML(_card_heading("预览", "最终 Sprite Sheet", "空白格保持透明，所有有效帧按项目固定网格排列。"))
                        export_summary = gr.HTML(initial_export[1])
                        export_sheet_preview = gr.Image(initial_export[2], label="主要交付物预览", type="filepath", interactive=False, elem_classes=["sheet-preview"])
                    with gr.Column(scale=2, elem_classes=["workspace-card"]):
                        gr.HTML(_card_heading("保存", "命名并写入导出目录", f"位置：{service.settings.exports_dir}"))
                        export_filename = gr.Textbox(value=initial_export[3].get("value", ""), label="文件名", placeholder="例如：赛博人物行走.png")
                        with gr.Accordion("覆盖设置", open=False, elem_classes=["advanced-panel"]):
                            export_overwrite = gr.Checkbox(label="允许覆盖工具暂存区内的同名文件")
                        export_button = gr.Button("导出 PNG + Godot 包", variant="primary", interactive=bool(initial_export[4].get("interactive", False)), elem_classes=["primary-action"])
                        export_status = gr.HTML()
                        exported_godot = gr.File(label="Godot SpriteFrames 包（ZIP）", interactive=False)
                        game_export_button = gr.Button("选择游戏项目并交付给 WorkBuddy", visible=False, interactive=False, elem_id="forge-sprite-game-export")
                        godot_help = gr.Markdown("**Godot 用法：** 将 ZIP 中的 `forge_sprites` 文件夹放入项目；把 `sprite_frames.tres` 赋给 AnimatedSprite2D，或直接拖入 `animated_sprite.tscn`。")
                        exported_sheet = gr.File(label="Sprite Sheet PNG", interactive=False)
                with gr.Accordion("附加文件：预览、配方与 QA 报告", open=False, elem_classes=["advanced-panel"]):
                    export_attachments = gr.File(label="附加文件", file_count="multiple", interactive=False)
                    export_details = gr.JSON(label="导出记录")

            with gr.Tab("设置", id="settings"):
                gr.HTML(_stage_header("设置", "API 与项目合同", "日常流程不需要修改这里；首次生成前配置一次 API Key 即可。"))
                with gr.Row():
                    with gr.Column(elem_classes=["workspace-card"]):
                        gr.HTML(_card_heading("API", "PixelLab 生成权限", "用于生成与 AI 补做；手工像素修补和导出不需要 API。"))
                        api_status = gr.HTML(api_settings_status())
                        api_key = gr.Textbox(label="API Key", type="password", placeholder="粘贴后点击保存；保存成功会自动清空输入框")
                        with gr.Row():
                            save_api_button = gr.Button("保存并立即生效", variant="primary")
                            clear_api_button = gr.Button("清除已保存的 Key")
                    with gr.Column(elem_classes=["workspace-card"]):
                        gr.HTML(_card_heading("视觉检查", "检查服务与权限", "检查动画并标记问题；修补由你决定。"))
                        from .vision_review import VisionReviewer
                        vision_provider = gr.Dropdown(choices=[("混元 HY Vision 2.0（默认）", "hunyuan"), ("OpenAI GPT-5.4", "openai")], value=VisionReviewer(service.settings).provider, label="视觉检查服务", filterable=False)
                        vision_api_status = gr.HTML(vision_status())
                        vision_api_key = gr.Textbox(label="视觉检查 API Key", type="password", placeholder="保存后清空；无需每次填写")
                        with gr.Row():
                            save_vision_button = gr.Button("保存视觉检查 Key")
                            clear_vision_button = gr.Button("清除视觉检查 Key")
                with gr.Accordion("存储位置与恢复记录", open=False, elem_classes=["advanced-panel"]):
                    gr.HTML(_card_heading("存储", "用户数据与恢复位置", "任务、缓存、导出和程序代码彼此分离。"))
                    storage_status = gr.HTML(storage_status_html())
                    refresh_storage_button = gr.Button("刷新存储状态")
                    with gr.Accordion("迁移与存储技术记录", open=False, elem_classes=["advanced-panel"]):
                        storage_details = gr.JSON(service.storage_status())
                with gr.Accordion("当前游戏项目规格（只读）", open=False, elem_classes=["advanced-panel"]):
                    gr.HTML('<div class="section-label"><span>只读合同</span><h3>当前游戏项目规格</h3><p>这些规格由项目配置提供，不是每次生成都要填写的表单。</p></div>')
                    gr.HTML(
                        '<div class="workspace-card">'
                        f'<p>项目：{_escape(profile.project_name)}　·　引擎：{_escape(profile.engine)}　·　目标角色：{_escape(profile.character_name)}</p>'
                        f'<div class="contract-grid"><div class="contract-card"><small>单帧</small><b>{profile.cell_width}×{profile.cell_height} RGBA</b></div><div class="contract-card"><small>统一网格</small><b>所有动作 16 帧 · {profile.columns} 列×4 行</b></div><div class="contract-card"><small>参考锚点 / 运行时偏移</small><b>({profile.anchor_x},{profile.anchor_ground_y}) / ({profile.sprite_offset_x},{profile.sprite_offset_y})</b></div></div>'
                        + '<table class="project-table"><thead><tr><th>动画</th><th>输出规格</th><th>播放</th><th>文件名</th><th>工程状态</th></tr></thead><tbody>'
                        + "".join(
                            f"<tr><td>{_escape(item.display_name)}</td>"
                            f"<td>{item.sheet_size[0]}×{item.sheet_size[1]} · {item.frame_count} 帧</td>"
                            f"<td>{item.fps:g} FPS{'（资源场景 ' + format(item.scene_fps, 'g') + '）' if item.scene_fps != item.fps else ''} · {'循环' if item.loop else '单次'}</td>"
                            f"<td>{_escape(item.filename)}</td>"
                            f"<td>{_escape(PROJECT_INTEGRATION_STATUS_CN.get(item.integration_status, item.integration_status))}</td></tr>"
                            for item in profile.actions
                        )
                        + '</tbody></table>'
                        + _notice("info", "新生成规格已统一为 16 帧", "所有动作都生成并导出完整 4×4 Sheet，不再为攻击、跳跃、受击或闪避降低默认帧数。旧 Sheet 仍可导入检查；替换旧资产时需要同步 Godot 的动画帧列表。")
                        + '</div>'
                    )
                with gr.Row(elem_classes=["step-actions"]):
                    settings_back_button = gr.Button("返回 1 · 生成 →", variant="primary")

        asset_outputs = [asset_candidate, asset_summary, asset_animation_preview, asset_frame_gallery, asset_review_button, asset_repair_button]
        task_outputs = [task_status, task_details, attach_candidate]
        review_outputs = [review_candidate, animation_preview, frame_gallery, review_summary, review_issues, review_details, selected_frame_index, selected_frame_banner, acknowledge, approve_button, overlay_preview, baseline_preview, review_candidate_group, recheck_button, mark_ok_button, mark_repair_button, review_repair_button]
        repair_outputs = [repair_candidate, repair_frame, repair_current, repair_neighbors, repair_summary, replace_button, repair_issue_type, repair_note, repair_editor, repair_base_sha256, replacement_file, repair_upload_context, repair_timeline, previous_problem_button, next_problem_button, accept_repair_frame_button, finish_repair_button]
        export_outputs = [export_candidate, export_summary, export_sheet_preview, export_filename, export_button]

        def refresh_library(current: list[dict[str, Any]]) -> Any:
            rows = library.list_artworks()
            return gr.skip() if rows == current else rows

        def import_library_material(uploaded: Any, kind: str, name: str) -> tuple[Any, ...]:
            try:
                source = _uploaded_path(uploaded)
                if kind == "map":
                    library.import_map(source, name or "")
                elif kind == "character":
                    resolve_generation_character(uploaded, {}, name or source.stem, "", None)
                else:
                    raise ValidationHarnessError("请选择素材类型")
                return library.list_artworks(), 1, "all", "", _notice("ok", "作品已保存", "可直接从卡片继续创作。"), None
            except Exception as exc:
                return gr.skip(), gr.skip(), gr.skip(), gr.skip(), _notice("error", "素材未能入库", _human_error(exc)), gr.skip()

        def show_library_details(artwork_id: str | None = None, *, download: bool = False) -> dict[Any, Any]:
            try:
                row = library.get(artwork_id) if artwork_id else None
                records = service.list_jobs()
                if row:
                    records = [record for record in records if
                               record.get("job_id") == row.get("job_id") or
                               (row["kind"] == "character" and record.get("character_id") == row.get("character_id"))]
                choices = [(job_summary_label(record) if record.get("status") != "invalid" else f"记录无法读取 · {record['job_id']}", record["job_id"]) for record in records]
                selected = row.get("job_id") if row else None
                source = library.preview_source(row) if row else None
                files = [str(source)] if download and source else []
                title = _notice("info", row["title"] if row else "全部执行记录",
                                f"{KIND_LABELS[row['kind']]} · {row['status_label']} · {row['subtitle']}" if row else "这里保留失败、未生成、重试和测试记录；已有画面的作品在上方卡片中展示。")
                updates = {
                    library_detail_panel: gr.update(open=True),
                    record_content_panel: gr.update(open=False),
                    library_detail_title: title,
                    library_detail_image: gr.update(value=str(source) if source else None, visible=source is not None),
                    library_download: gr.update(value=files, visible=bool(files)),
                    task_job: gr.update(choices=choices, value=selected),
                }
                for component, value in zip([asset_catalog_status, *asset_outputs, *task_outputs], select_saved_asset_summary(selected)):
                    updates[component] = value
                if download and not files:
                    updates[library_action_status] = _notice("error", "原图暂不可用", "素材记录仍保留，请检查文件是否被移动或删除。")
                return updates
            except Exception as exc:
                return {library_action_status: _notice("error", "详情无法打开", _human_error(exc))}

        def open_reference_canvas(uploaded: Any, saved_id: str | None, name: str, identity: str, context: dict[str, Any]) -> dict[Any, Any]:
            try:
                canvas = ReferenceCanvas(service)
                if uploaded is not None:
                    image, _state = inspect_generation_reference_source(_uploaded_path(uploaded))
                    character = CharacterPreset(
                        character_id="reference_edit", display_name=(name or "").strip() or "新角色",
                        cell_width=image.width, cell_height=image.height,
                        facing=profile.facing, reference_frame="idle_reference.png",
                        identity_description=(identity or "").strip(),
                        anchor=Anchor(x=profile.anchor_x, ground_y=profile.anchor_ground_y),
                        sheet_columns=profile.columns,
                    )
                else:
                    if not saved_id:
                        raise ValidationHarnessError("请先上传或选择角色原图")
                    character, preset_path = service.presets.load_character(saved_id)
                    with Image.open(preset_path.parent / character.reference_frame) as source:
                        image = source.convert("RGBA")
                    character = character.model_copy(update={
                        "display_name": (name or "").strip() or character.display_name,
                        "identity_description": (identity or "").strip() or character.identity_description,
                    })
                signature = hashlib.sha256(image.tobytes() + character.model_dump_json().encode("utf-8")).hexdigest()
                edit_id = (context or {}).get("edit_id") if (context or {}).get("signature") == signature else None
                if edit_id:
                    canvas.directory(edit_id)
                else:
                    edit_id = canvas.start(image, character)["edit_id"]
                embed = (f'<iframe class="pixel-editor-frame reference-editor-frame" src="/pixel-editor?reference_edit={edit_id}" '
                         'title="原图像素画布" sandbox="allow-scripts allow-same-origin allow-downloads allow-modals"></iframe>')
                return {reference_editor: embed, reference_editor_panel: gr.update(open=True),
                        reference_editor_context: {"edit_id": edit_id, "signature": signature}}
            except Exception as exc:
                return {generation_reference_status: _notice("error", "原图画布暂时无法打开", _human_error(exc))}

        def select_transferred_reference(character_id: str) -> dict[Any, Any]:
            try:
                if not re.fullmatch(r"edited_[0-9a-f]{32}_v[0-9]+", character_id or ""):
                    raise ValidationHarnessError("修改版原图编号无效")
                character, _ = service.presets.load_character(character_id)
                preview, _status, _state = prepare_generation_reference(None, character_id)
                return {
                    workflow_tabs: gr.update(selected="generate"),
                    generate_character: gr.update(choices=official_character_choices(), value=character_id),
                    generation_reference_file: None, generation_reference_state: {},
                    generation_reference_preview: preview,
                    generation_reference_status: _notice("ok", "修改版已作为新的生成原图", "下次生成将使用上方这张修改后的原图。"),
                    generation_character_name: character.display_name,
                    generation_identity_prompt: character.identity_description,
                    generation_request_key: uuid.uuid4().hex,
                    generation_job: None, generation_details: {},
                    generation_status: _notice("ok", "新原图已就绪", "选择动作并确认后即可开始生成。"),
                    generation_next_button: gr.update(value="生成完成后可进入播放检查", interactive=False),
                    reference_editor_panel: gr.update(open=False),
                    library_rows: library.list_artworks(),
                }
            except Exception as exc:
                return {generation_reference_status: _notice("error", "原图移送暂未完成", _human_error(exc))}

        def artwork_action(artwork_id: str, action: str) -> dict[Any, Any]:
            try:
                row = library.get(artwork_id)
                if action not in row["actions"]:
                    raise ValidationHarnessError("作品状态已经改变，请刷新后继续")
                if action == "download":
                    return show_library_details(artwork_id, download=True)
                if action in {"generate", "edit_reference"}:
                    character, _path = service.presets.load_character(row["character_id"])
                    reference, notice = character_projection(character.character_id)
                    updates = {
                        workflow_tabs: gr.update(selected="generate"),
                        generate_character: gr.update(choices=official_character_choices(), value=character.character_id),
                        generation_reference_file: None, generation_reference_state: {},
                        generation_reference_preview: reference, generation_reference_status: notice,
                        generation_character_name: character.display_name,
                        generation_identity_prompt: character.identity_description,
                        action_description: "", seed: "", candidate_count: 1,
                        generation_request_key: uuid.uuid4().hex,
                        generation_job: None, generation_details: {},
                        generation_next_button: gr.update(value="生成完成后可进入播放检查", interactive=False),
                        generation_status: _notice("info", "角色已带入", "选择动作并确认后再开始生成。"),
                    }
                    if action == "edit_reference":
                        updates.update(open_reference_canvas(None, character.character_id, character.display_name, character.identity_description, {}))
                    return updates
                job = service.get_job(row["job_id"])
                candidate = next(item for item in job.candidates if item.candidate_index == row["candidate_index"])
                if action == "review":
                    values = load_saved_asset_in_review(job.job_id, candidate.candidate_index)
                    return dict(zip([library_action_status, workflow_tabs, review_job, *review_outputs], values))
                if action == "edit":
                    service._assert_candidate_editable(job, candidate, operation="open_artwork")
                    return {
                        workflow_tabs: gr.update(selected="repair"),
                        repair_job: gr.update(choices=repair_job_choices_with_context(job.job_id), value=job.job_id),
                        **dict(zip(repair_outputs, repair_projection(job.job_id, candidate.candidate_index))),
                    }
                if action == "export":
                    sheet, godot, attachments = _export_download_files(service, job.job_id, candidate.candidate_index)
                    return {
                        workflow_tabs: gr.update(selected="export"),
                        export_job: gr.update(choices=job_choices(approved_only=True), value=job.job_id),
                        **dict(zip(export_outputs, export_projection(job.job_id, candidate.candidate_index))),
                        exported_sheet: sheet,
                        exported_godot: godot,
                        export_attachments: attachments,
                        export_status: _notice("info", "已打开所选动画", "已有文件可直接下载；已有 Godot 包可选择游戏项目交付。"),
                    }
                raise ValidationHarnessError("当前作品不支持此操作")
            except Exception as exc:
                return {library_action_status: _notice("error", "暂时无法继续", _human_error(exc))}

        detail_outputs = [library_action_status, library_detail_panel, record_content_panel, library_detail_title, library_detail_image, library_download, task_job, asset_catalog_status, *asset_outputs, *task_outputs]
        artwork_action_outputs = list(dict.fromkeys([
            *detail_outputs, workflow_tabs, generate_character, generation_reference_file,
            reference_editor, reference_editor_panel, reference_editor_context, library_rows,
            generation_reference_state, generation_reference_preview, generation_reference_status,
            generation_character_name, generation_identity_prompt, action_description, seed, candidate_count,
            generation_request_key, generation_status, generation_job, generation_details, generation_next_button, review_job, *review_outputs,
            repair_job, *repair_outputs, export_job, *export_outputs, exported_sheet, exported_godot, export_attachments, export_status,
        ]))

        artwork_outputs_by_action = {
            "export": [library_action_status, workflow_tabs, export_job, *export_outputs, exported_sheet, exported_godot, export_attachments, export_status],
            "review": [library_action_status, workflow_tabs, review_job, *review_outputs],
            "edit": [library_action_status, workflow_tabs, repair_job, *repair_outputs],
            "download": detail_outputs,
        }

        with library_grid:
            @gr.render(inputs=[library_rows, library_kind, library_search, library_page])
            def render_artwork_cards(rows: list[dict[str, Any]], kind: str, query: str, page: int) -> None:
                cards, selected_page, total = library.filter_page(rows, kind, query, page)
                gr.HTML(f'<p class="library-count">{total} 件作品 · 第 {selected_page} / {max(1, math.ceil(total / 12))} 页</p>')
                if not cards:
                    gr.HTML('<div class="library-empty"><b>这里还没有作品</b><p>导入角色原图或地图，或制作第一段动画。已有执行记录可从“执行记录”查看。</p></div>' if not query and kind == "all" else '<div class="library-empty"><b>没有匹配的作品</b><p>试试其他名称或切换作品类型。</p></div>')
                for start in range(0, len(cards), 3):
                    with gr.Row(equal_height=True, elem_classes=["artwork-row"]):
                        for row in cards[start:start + 3]:
                            artwork_id = row["id"]
                            with gr.Column(min_width=250, scale=1, elem_classes=["artwork-card"], key=artwork_id):
                                thumbnail = library.thumbnail(row)
                                if thumbnail:
                                    gr.Image(thumbnail, label=row["title"], interactive=False, type="filepath", show_label=False, height=220, buttons=[], elem_classes=["artwork-thumbnail"], key=artwork_id + ":image", preserved_by_key=[])
                                else:
                                    gr.HTML('<div class="artwork-missing">预览暂不可用<br><small>作品记录仍保留，可查看详情</small></div>')
                                gr.HTML(f'<div class="artwork-caption"><span class="artwork-kind">{_escape(KIND_LABELS[row["kind"]])}</span><h3>{_escape(row["title"])}</h3><p>{_escape(row["subtitle"])}</p><span class="artwork-status">{_escape(row["status_label"])}</span></div>')
                                with gr.Row(elem_classes=["artwork-actions"]):
                                    for index, action in enumerate(row["actions"]):
                                        button = gr.Button(ACTION_LABELS[action] + (" →" if index == 0 else ""), variant="primary" if index == 0 else "secondary", size="sm", min_width=90, key=artwork_id + ":" + action)
                                        button.click(partial(artwork_action, artwork_id, action), outputs=artwork_outputs_by_action.get(action, artwork_action_outputs), show_progress="minimal").then(
                                            fn=None, js=LIBRARY_DETAIL_SCROLL_JS if action == "download" else "() => window.scrollTo({top: 0, behavior: 'smooth'})", queue=False,
                                        )
                                    details = gr.Button("详情", size="sm", min_width=60, key=artwork_id + ":details")
                                    details.click(partial(show_library_details, artwork_id), outputs=detail_outputs, show_progress="minimal").then(fn=None, js=LIBRARY_DETAIL_SCROLL_JS, queue=False)

        def page_controls(rows: list[dict[str, Any]], kind: str, query: str, page: int) -> tuple[Any, ...]:
            _cards, selected, total = library.filter_page(rows, kind, query, page)
            return gr.update(interactive=selected > 1), f"第 {selected} / {max(1, math.ceil(total / 12))} 页", gr.update(interactive=selected * 12 < total)

        def move_library_page(rows: list[dict[str, Any]], kind: str, query: str, page: int, offset: int) -> int:
            _cards, selected, _total = library.filter_page(rows, kind, query, page)
            return library.filter_page(rows, kind, query, selected + offset)[1]

        library_import_toggle.click(lambda: gr.update(open=True), outputs=library_import_panel, queue=False)
        library_generate.click(lambda: gr.update(selected="generate"), outputs=workflow_tabs, queue=False)
        library_import_animation.click(lambda: (gr.update(selected="review"), gr.update(open=True)), outputs=[workflow_tabs, sheet_import_panel], queue=False)
        library_import_save.click(import_library_material, inputs=[library_import_file, library_import_kind, library_import_name], outputs=[library_rows, library_page, library_kind, library_search, library_action_status, library_import_file], concurrency_limit=1)
        library_records.click(show_library_details, outputs=detail_outputs, queue=False).then(fn=None, js=LIBRARY_DETAIL_SCROLL_JS, queue=False)
        library_refresh.click(refresh_library, inputs=library_rows, outputs=library_rows, queue=False)
        library_tab.select(refresh_library, inputs=library_rows, outputs=library_rows, queue=False)
        library_kind.input(lambda: 1, outputs=library_page, queue=False)
        library_search.input(lambda: 1, outputs=library_page, queue=False)
        library_previous.click(partial(move_library_page, offset=-1), inputs=[library_rows, library_kind, library_search, library_page], outputs=library_page, queue=False)
        library_next.click(partial(move_library_page, offset=1), inputs=[library_rows, library_kind, library_search, library_page], outputs=library_page, queue=False)
        for control in [library_rows, library_kind, library_search, library_page]:
            control.change(page_controls, inputs=[library_rows, library_kind, library_search, library_page], outputs=[library_previous, library_page_label, library_next], queue=False)
        demo.load(page_controls, inputs=[library_rows, library_kind, library_search, library_page], outputs=[library_previous, library_page_label, library_next], queue=False)

        edit_reference_button.click(
            open_reference_canvas,
            inputs=[generation_reference_file, generate_character, generation_character_name, generation_identity_prompt, reference_editor_context],
            outputs=[reference_editor, reference_editor_panel, reference_editor_context, generation_reference_status],
            concurrency_limit=1,
        ).then(fn=None, js=REFERENCE_CANVAS_SCROLL_JS, queue=False)
        reference_transfer_apply.click(select_transferred_reference, inputs=reference_transfer_character, outputs=artwork_action_outputs, queue=False).then(
            fn=None, js="""() => document.getElementById("edit-reference-button")?.scrollIntoView({behavior: "smooth", block: "center"})""", queue=False,
        )
        def load_canvas_character(request: gr.Request) -> dict[Any, Any]:
            character_id = request.query_params.get("canvas_character", "") if request else ""
            return select_transferred_reference(character_id) if character_id else {workflow_tabs: gr.update()}

        demo.load(load_canvas_character, outputs=artwork_action_outputs, queue=False)
        generation_reference_file.upload(
            prepare_generation_reference,
            inputs=[generation_reference_file, generate_character],
            outputs=[generation_reference_preview, generation_reference_status, generation_reference_state],
            queue=False,
        )
        generation_reference_file.clear(
            prepare_generation_reference,
            inputs=[generation_reference_file, generate_character],
            outputs=[generation_reference_preview, generation_reference_status, generation_reference_state],
            queue=False,
        )
        generate_character.input(
            prepare_generation_reference,
            inputs=[generation_reference_file, generate_character],
            outputs=[generation_reference_preview, generation_reference_status, generation_reference_state],
            queue=False,
        )
        generate_action.input(action_projection, inputs=generate_action, outputs=generate_action_summary, queue=False)
        candidate_count.change(
            generation_cost_html,
            inputs=[candidate_count, generate_action],
            outputs=generation_cost,
            queue=False,
        )
        generate_action.input(
            generation_cost_html,
            inputs=[candidate_count, generate_action],
            outputs=generation_cost,
            queue=False,
        )
        refresh_quota_button.click(refresh_quota, outputs=[quota_status, quota_details])
        example_next_button.click(
            lambda: gr.update(selected="generate"),
            outputs=workflow_tabs,
            queue=False,
        )
        open_api_settings_button.click(
            lambda: gr.update(selected="settings"),
            outputs=workflow_tabs,
            queue=False,
        )
        generate_button.click(
            generate_animation,
            inputs=[
                generation_reference_file,
                generation_reference_state,
                generation_character_name,
                generation_identity_prompt,
                generate_character,
                generate_action,
                candidate_count,
                action_description,
                seed,
                generation_request_key,
            ],
            outputs=[
                generation_status,
                generation_details,
                generation_reference_state,
                generate_character,
                generation_request_key,
                task_job,
                asset_catalog_status,
                *asset_outputs,
                *task_outputs,
                review_job,
                *review_outputs,
            ],
            trigger_mode="once",
            concurrency_limit=1,
            concurrency_id="pixellab_generation_submission",
        )
        def continue_generation_result(job_id: str | None) -> tuple[Any, ...]:
            candidate_index = None
            if job_id:
                try:
                    job = service.get_job(job_id)
                    candidate_index = next((candidate.candidate_index for candidate in job.candidates if candidate.frames), None)
                except Exception:
                    pass
            return load_saved_asset_in_review(job_id, candidate_index)

        generation_details.change(
            lambda details: (details or {}).get("job", {}).get("job_id"),
            inputs=generation_details, outputs=generation_job, queue=False,
        )
        generation_next_button.click(
            continue_generation_result,
            inputs=generation_job,
            outputs=[generation_status, workflow_tabs, review_job, *review_outputs],
            queue=False,
        )
        task_job.input(
            select_saved_asset_summary,
            inputs=task_job,
            outputs=[asset_catalog_status, *asset_outputs, *task_outputs],
            queue=False,
        )
        open_asset_button.click(
            open_saved_asset,
            inputs=[task_job, asset_candidate],
            outputs=[asset_catalog_status, *asset_outputs, *task_outputs],
            queue=False,
        ).then(lambda: gr.update(open=True), outputs=record_content_panel, queue=False)
        asset_candidate.input(
            saved_asset_projection,
            inputs=[task_job, asset_candidate],
            outputs=asset_outputs,
            queue=False,
        )
        refresh_asset_catalog_button.click(
            reload_saved_asset_catalog,
            inputs=task_job,
            outputs=[task_job, asset_catalog_status],
            queue=False,
        )
        refresh_task_button.click(
            refresh_saved_assets,
            inputs=[task_job, asset_candidate],
            outputs=[task_job, asset_catalog_status, *asset_outputs, *task_outputs],
        )
        asset_review_button.click(
            load_saved_asset_in_review,
            inputs=[task_job, asset_candidate],
            outputs=[asset_action_status, workflow_tabs, review_job, *review_outputs],
        )
        asset_repair_button.click(
            load_saved_asset_in_repair,
            inputs=[task_job, asset_candidate],
            outputs=[asset_action_status, workflow_tabs, repair_job, *repair_outputs],
        )
        attach_provider_button.click(
            attach_remote_job,
            inputs=[task_job, attach_candidate, attach_provider_id],
            outputs=[
                attach_status,
                task_job,
                task_status,
                task_details,
                attach_candidate,
                attach_provider_id,
            ],
        )
        def load_workbench_entry(current: str | None, request: gr.Request) -> dict[Any, Any]:
            """Open the linked job's visible details without changing its saved state."""
            from .workbench_links import selected_candidate

            requested = request.query_params.get("workbench_job", "") if request else ""
            if not requested:
                catalog = reload_saved_asset_catalog(current)
                updates = {task_job: catalog[0], asset_catalog_status: catalog[1]}
                if request and request.query_params.get("workbench_embedded") == "1":
                    updates[workflow_tabs] = gr.update(selected="generate")
                return updates

            choices = saved_asset_choices(requested)
            found = requested in {value for _label, value in choices}
            updates = {
                workflow_tabs: gr.update(selected="assets"),
                library_action_status: "",
                library_detail_panel: gr.update(open=True),
                record_content_panel: gr.update(open=True),
                library_detail_image: gr.update(value=None, visible=False),
                library_download: gr.update(value=[], visible=False),
                task_job: gr.update(choices=choices, value=requested if found else None),
                **dict(zip([asset_catalog_status, *asset_outputs, *task_outputs], open_saved_asset(None))),
            }
            if not found:
                notice = _notice("warn", "找不到所选任务", "请在此服务的已保存资产目录中选择任务；没有创建或重新提交生成。")
                updates.update({library_detail_title: notice, asset_catalog_status: notice})
                return updates
            try:
                job = service.get_job(requested)
                candidate = selected_candidate(job, request.query_params.get("workbench_candidate", ""))
                if candidate is None:
                    candidate = default_candidate(job)
            except ValueError:
                notice = _notice("warn", "所选候选不存在", "请重新选择作品版本；没有切换到其他候选，也没有重新生成。")
                updates.update({library_detail_title: notice, asset_catalog_status: notice})
                return updates
            except Exception as exc:
                notice = _notice("error", "作品暂时无法打开", _human_error(exc))
                updates.update({library_detail_title: notice, asset_catalog_status: notice})
                return updates
            title = animation_title(job.character.display_name or job.character.character_id, job.action.display_name or job.action.action_id)
            if candidate is not None:
                title += f" · 候选 {_candidate_letter(candidate)}"
            updates[library_detail_title] = _notice("info", title, "已打开所选作品。可查看动画与逐帧画面，或进入播放检查。")
            updates.update(dict(zip([asset_catalog_status, *asset_outputs, *task_outputs], open_saved_asset(requested, candidate))))
            return updates

        demo.load(
            load_workbench_entry,
            inputs=task_job,
            outputs=[workflow_tabs, *detail_outputs],
            queue=False,
        ).then(
            fn=None,
            inputs=asset_candidate,
            js="""(candidate) => {
              if (!new URLSearchParams(window.location.search).get('workbench_job')) return;
              window.requestAnimationFrame(() => document.getElementById(candidate ? 'artwork-candidate' : 'artwork-detail')?.scrollIntoView({behavior: 'instant', block: 'start'}));
            }""",
            queue=False,
        )
        def refresh_shared_api_state() -> tuple[Any, ...]:
            return (header_status_html(), api_settings_status(), api_banner_html(),
                    gr.update(interactive=api_configured()))

        demo.load(
            refresh_shared_api_state,
            outputs=[header_status, api_status, ai_api_banner, generate_button],
            queue=False,
        )
        def load_workbench_character(request: gr.Request) -> tuple[Any, ...]:
            requested = request.query_params.get("workbench_character", "") if request else ""
            if not requested:
                return tuple(gr.update() for _ in range(8))
            choices = official_character_choices()
            if requested not in {value for _label, value in choices}:
                return (gr.update(selected="generate"), gr.update(), gr.update(),
                        _notice("warn", "参考角色不存在", "请重新从原图工具移送，或选择已保存角色。"),
                        gr.update(), gr.update(), gr.update(), gr.update())
            character, _ = service.presets.load_character(requested)
            preview, status, state = prepare_generation_reference(None, requested)
            return (gr.update(selected="generate"), gr.update(choices=choices, value=requested),
                    preview, status, state, character.display_name, character.identity_description, None)

        demo.load(
            load_workbench_character,
            outputs=[workflow_tabs, generate_character, generation_reference_preview,
                     generation_reference_status, generation_reference_state,
                     generation_character_name, generation_identity_prompt, generation_reference_file],
            queue=False,
        )
        task_job.change(
            fn=None,
            inputs=task_job,
            js="""(job) => {
                const origin = new URLSearchParams(window.location.search).get('workbench_origin');
                if (origin && /^https?:\\/\\//.test(origin) && window.parent !== window) {
                    window.parent.postMessage({type: 'workbench:sprite-job', jobId: String(job || '')}, origin);
                }
                return [];
            }""",
            queue=False,
            api_visibility="private",
        )
        demo.load(
            fn=None,
            js=PIXEL_EDITOR_BRIDGE_JS,
            queue=False,
            api_visibility="private",
        )
        task_timer = gr.Timer(value=5.0, active=True)
        task_timer.tick(refresh_library, inputs=library_rows, outputs=library_rows, queue=False)
        demo.load(fn=None, js="""() => {
            document.documentElement.classList.toggle('workbench-embedded',
                new URLSearchParams(location.search).get('workbench_embedded') === '1');
        }""", queue=False)
        task_timer.tick(
            generation_continue_projection,
            inputs=generation_job,
            outputs=generation_next_button,
            queue=False,
        )
        import_file.change(inspect_uploaded_sheet, inputs=[import_file, import_action], outputs=[import_grid_preview, import_inspection, import_state, import_button], queue=False)
        import_action.input(inspect_uploaded_sheet, inputs=[import_file, import_action], outputs=[import_grid_preview, import_inspection, import_state, import_button], queue=False)
        import_button.click(import_sheet, inputs=[import_file, import_action, import_state], outputs=[import_status, import_details, review_job, *review_outputs])

        refresh_review_button.click(refresh_review, inputs=review_job, outputs=[review_job, *review_outputs], queue=False)
        recover_result_button.click(
            recover_provider_result,
            inputs=[review_job, review_candidate],
            outputs=[recovery_status, review_job, *review_outputs],
        )
        review_job.input(review_payload, inputs=review_job, outputs=review_outputs, queue=False)
        review_candidate.input(review_payload, inputs=[review_job, review_candidate], outputs=review_outputs, queue=False)
        review_summary.change(resume_vision_projection, inputs=review_job, outputs=resume_vision_button, queue=False)
        resume_vision_button.click(resume_motion_review, inputs=[review_job, review_candidate], outputs=[review_action_status, *review_outputs])
        recheck_button.click(recheck_candidate, inputs=[review_job, review_candidate], outputs=[review_action_status, *review_outputs])
        frame_gallery.select(select_frame, inputs=[review_job, review_candidate], outputs=[selected_frame_index, selected_frame_banner], queue=False)
        mark_ok_button.click(lambda j, c, f, i, n: mark_frame(j, c, f, "approved", i, n), inputs=[review_job, review_candidate, selected_frame_index, issue_type, review_note], outputs=[review_action_status, *review_outputs, repair_job, *repair_outputs])
        mark_repair_button.click(lambda j, c, f, i, n: mark_frame(j, c, f, "repair_requested", i, n), inputs=[review_job, review_candidate, selected_frame_index, issue_type, review_note], outputs=[review_action_status, *review_outputs, repair_job, *repair_outputs])
        review_repair_button.click(
            load_saved_asset_in_repair,
            inputs=[review_job, review_candidate],
            outputs=[review_action_status, workflow_tabs, repair_job, *repair_outputs],
        )
        approve_button.click(
            approve_candidate,
            inputs=[review_job, review_candidate, acknowledge],
            outputs=[review_action_status, workflow_tabs, *review_outputs, export_job, *export_outputs, exported_sheet, exported_godot, export_attachments],
        )
        reject_button.click(reject_candidate, inputs=[review_job, review_candidate, review_note], outputs=[review_action_status, *review_outputs])

        refresh_repair_button.click(
            refresh_repairs,
            inputs=[repair_job, repair_candidate, repair_frame],
            outputs=[repair_job, *repair_outputs],
            queue=False,
        )
        repair_job.input(repair_projection, inputs=repair_job, outputs=repair_outputs, queue=False)
        repair_candidate.input(repair_projection, inputs=[repair_job, repair_candidate], outputs=repair_outputs, queue=False)
        repair_frame.input(repair_projection, inputs=[repair_job, repair_candidate, repair_frame], outputs=repair_outputs, queue=False)
        repair_timeline.select(
            select_repair_timeline_frame,
            inputs=[repair_job, repair_candidate],
            outputs=repair_outputs,
            queue=False,
        )
        previous_problem_button.click(
            lambda job_id, candidate_index, frame_index: navigate_problem_frame(
                job_id, candidate_index, frame_index, -1
            ),
            inputs=[repair_job, repair_candidate, repair_frame],
            outputs=repair_outputs,
            queue=False,
        )
        next_problem_button.click(
            lambda job_id, candidate_index, frame_index: navigate_problem_frame(
                job_id, candidate_index, frame_index, 1
            ),
            inputs=[repair_job, repair_candidate, repair_frame],
            outputs=repair_outputs,
            queue=False,
        )
        accept_repair_frame_button.click(
            accept_repair_frame,
            inputs=[repair_job, repair_candidate, repair_frame],
            outputs=[
                repair_action_status,
                workflow_tabs,
                repair_job,
                *repair_outputs,
                export_job,
                *export_outputs,
            ],
        )
        finish_repair_button.click(
            finish_repair_and_review,
            inputs=[repair_job, repair_candidate],
            outputs=[
                repair_action_status,
                workflow_tabs,
                review_job,
                *review_outputs,
                export_job,
                *export_outputs,
            ],
        )
        replacement_file.change(
            capture_repair_upload_context,
            inputs=[replacement_file, repair_job, repair_candidate, repair_frame, repair_base_sha256],
            outputs=repair_upload_context,
            queue=False,
        )
        replace_button.click(
            replace_repair_frame,
            inputs=[repair_job, repair_candidate, repair_frame, replacement_file, repair_base_sha256, repair_upload_context],
            outputs=[repair_action_status, repair_job, *repair_outputs],
        )

        export_tab.select(refresh_exports, inputs=[export_job, export_candidate], outputs=[export_job, *export_outputs], queue=False)
        refresh_export_button.click(refresh_exports, inputs=[export_job, export_candidate], outputs=[export_job, *export_outputs], queue=False)
        export_job.input(export_projection, inputs=export_job, outputs=export_outputs, queue=False)
        export_candidate.input(export_projection, inputs=[export_job, export_candidate], outputs=export_outputs, queue=False)
        export_button.click(export_one, inputs=[export_job, export_candidate, export_filename, export_overwrite], outputs=[export_status, exported_sheet, exported_godot, export_attachments, export_details]).then(fn=None, inputs=export_details, js=EXPORTED_GODOT_JS, queue=False, api_visibility="private")
        game_export_button.click(fn=None, inputs=[export_job, export_candidate, exported_godot, export_filename], js=REQUEST_GODOT_EXPORT_JS, queue=False, api_visibility="private")
        exported_godot.change(lambda file: gr.update(interactive=bool(file)), inputs=exported_godot, outputs=game_export_button, queue=False)

        def load_workbench_export(request: gr.Request):
            embedded = bool(request and request.query_params.get("workbench_embedded") == "1")
            return gr.update(visible=embedded), gr.update(value="**交付到游戏：** 导出成功后选择 Godot 项目路径，再复制给 WorkBuddy 完成动作合并与脚本接入。已有包可点击上方按钮再次交付。" if embedded else "**Godot 用法：** 下载 ZIP，将 forge_sprites 放到项目，使用其中的 SpriteFrames 资源或动画场景。")

        demo.load(load_workbench_export, outputs=[game_export_button, godot_help], queue=False)
        export_job.change(export_downloads, inputs=[export_job, export_candidate], outputs=[exported_sheet, exported_godot, export_attachments], queue=False)
        export_candidate.change(export_downloads, inputs=[export_job, export_candidate], outputs=[exported_sheet, exported_godot, export_attachments], queue=False)

        vision_provider.input(select_vision_provider, inputs=vision_provider, outputs=[vision_api_status, vision_api_key, vision_provider]).then(generation_cost_html, inputs=[candidate_count, generate_action], outputs=generation_cost)
        save_vision_button.click(save_vision_key, inputs=[vision_api_key, vision_provider], outputs=[vision_api_status, vision_api_key]).then(generation_cost_html, inputs=[candidate_count, generate_action], outputs=generation_cost)
        clear_vision_button.click(lambda p: save_vision_key("",p), inputs=vision_provider, outputs=[vision_api_status, vision_api_key]).then(generation_cost_html, inputs=[candidate_count, generate_action], outputs=generation_cost)
        ai_inputs = [repair_job, repair_candidate, repair_frame, repair_base_sha256, ai_repair_phase, repair_note]
        for component in [repair_job, repair_candidate, repair_frame]:
            component.change(lambda: gr.update(value="auto"), outputs=ai_repair_phase, queue=False)
        for component in [repair_job, repair_candidate, repair_frame, repair_base_sha256, ai_repair_phase]:
            component.change(ai_repair_guidance, inputs=[repair_job,repair_candidate,repair_frame,ai_repair_phase], outputs=ai_phase_guidance, queue=False)
        ai_outputs = [ai_repair_status, ai_repair_preview, ai_repair_token]
        for component in [repair_job, repair_candidate, repair_frame]:
            component.change(ai_repair_selection, inputs=[repair_job, repair_candidate, repair_frame, repair_base_sha256], outputs=ai_outputs, queue=False)
        # A new pixel version invalidates the proposal, but must not erase the
        # successful adoption message that produced that version.
        repair_base_sha256.change(lambda: (None, {}), outputs=[ai_repair_preview, ai_repair_token], queue=False)
        ai_repair_button.click(ai_repair_start, inputs=ai_inputs, outputs=ai_outputs)
        ai_retry_button.click(lambda j,c,f,b,p,n: ai_repair_start(j,c,f,b,p,n,True), inputs=ai_inputs, outputs=ai_outputs)
        ai_refresh_button.click(ai_repair_refresh, inputs=ai_repair_token, outputs=ai_outputs)
        ai_adopt_button.click(ai_repair_adopt, inputs=[ai_repair_token, repair_job, repair_candidate, repair_frame], outputs=[ai_repair_status, *repair_outputs])
        save_api_button.click(save_api_key, inputs=api_key, outputs=[header_status, api_status, ai_api_banner, generate_button, api_key])
        clear_api_button.click(clear_api_key, outputs=[header_status, api_status, ai_api_banner, generate_button, api_key])
        settings_back_button.click(
            lambda: gr.update(selected="generate"),
            outputs=workflow_tabs,
            queue=False,
        )
        refresh_storage_button.click(
            refresh_storage_status,
            outputs=[storage_status, storage_details],
            queue=False,
        )
        run_demo_button.click(run_demo, outputs=[demo_status, demo_details, review_job, *review_outputs])

    # Gradio 6 applies themes when an app is mounted/launched, rather than
    # while the Blocks tree is constructed.
    demo.sprite_pipeline_theme = workbench_theme
    return demo


def create_ui_app(
    *,
    root: str | Path | None = None,
    host: str = "127.0.0.1",
    port: int = 7860,
) -> Any:
    """Mount the workflow UI and its exact-pixel REST endpoints together."""

    try:
        import gradio as gr
    except ImportError as exc:  # pragma: no cover
        raise ProviderConfigurationError(
            "operator UI requires Gradio; install requirements.txt",
            details={"dependency": "gradio"},
        ) from exc
    from .api_app import create_api

    service = SpritePipelineService(root)
    app = create_api(root, service=service)
    demo = build_ui(root, service=service)
    from .ui_session import install_ui_session
    session_head = install_ui_session(app, demo)
    return gr.mount_gradio_app(
        app,
        demo,
        path="/",
        server_name=host,
        server_port=port,
        theme=demo.sprite_pipeline_theme,
        css=UI_CSS,
        head="<style>" + THEME_CSS + "</style><script>" + THEME_JS + "</script>" + session_head,
        footer_links=[],
        max_file_size="32mb",
    )


def run_ui(*, root: str | Path | None = None, host: str = "127.0.0.1", port: int = 7860) -> None:
    try:
        import uvicorn
    except ImportError as exc:  # pragma: no cover
        raise ProviderConfigurationError(
            "operator UI server requires uvicorn; install requirements.txt",
            details={"dependency": "uvicorn"},
        ) from exc
    uvicorn.run(create_ui_app(root=root, host=host, port=port), host=host, port=port)
