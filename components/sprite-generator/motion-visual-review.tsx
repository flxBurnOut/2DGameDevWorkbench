'use client';
import type { MotionReview, MotionReviewOpinion } from './open-motion-model';

const dimensions: Record<string,string> = {state_frame:'状态帧可用', transition:'过渡可用', fixed_parts:'固定内容保持', completeness:'动作完整性', equipment:'外观与装备', rhythm:'节奏'};
const phases: Record<string,string> = {appearance:'外观专家独立检查',motion:'运动专家独立检查',dispute:'针对争议复核证据',done:'复核完成'};
const statuses = {pass:'通过', fail:'未通过', uncertain:'待核对'};

function Evidence({opinion}: {opinion?: MotionReviewOpinion}) {
  return <>{opinion?.summary && <p>{opinion.summary}</p>}{opinion?.checks?.map(c=><p key={c.dimension}>
    <b>{dimensions[c.dimension]}{c.status && ' · ' + statuses[c.status]}</b> · 第 {c.frames.join('、')} 帧：{c.evidence}
  </p>)}</>;
}

export function MotionVisualReview({report,compact=false}: {report: MotionReview;compact?:boolean}) {
  const extra=report.expert_review;
  const busy=['pending','running'].includes(report.state);
  const failed=['failed','unknown','stale'].includes(report.state);
  const title=busy?'正在检查实际帧':report.state==='failed'?'检查请求失败，已有动画仍保留':report.state==='unknown'?'检查结果尚未确认':report.state==='stale'?'画面已变更，旧检查已过期':
    ({pass:'模型建议通过',fail:'模型报告问题',uncertain:'待实际画面确认'}[report.verdict]||'待实际画面确认');
  const classifications=extra?.resolution?.checks;
  return <div className={`motion-visual-review ${report.verdict==='fail'&&!busy?'motion-error':'motion-notice'}`}>
    <b>视觉验收：{title}</b>
    {compact?<p>{busy?'正在核对这组动画，请稍候。':failed?'检查未完成，动画仍可播放；详情中保留了失败记录。':report.verdict==='pass'?'请实际播放后决定是否采用。':'请结合实际播放决定；需要时可查看具体帧与专家依据。'}</p>:<>
    {extra?.simulated&&<p>模拟专家报告，仅用于隔离流程验收，没有调用真实模型。</p>}
    {report.protocol==='experts_v1'&&<p className="motion-review-progress">
      独立专家与争议复核 · {phases[extra?.phase||''] || (report.state==='diagnostic'?'诊断流程，未调用视觉模型':'基础观察与审核')}
      {' · '}{report.requests?.length ?? extra?.calls_used ?? 0} / {extra?.max_calls ?? 5} 次
    </p>}
    <p>{report.summary || '正在核对实际帧…'}</p>
    {report.protocol==='experts_v1'&&<p>检查的是当前这组图片，不生成或替换帧；是否采用仍由实际播放确认。</p>}
    <details><summary>查看判断依据与具体帧</summary><Evidence opinion={{checks:report.checks}} />
      {classifications?.filter(c=>c.classification==='preference').map(c=><p key={c.dimension}><b>{dimensions[c.dimension]} · 可选优化</b>：属于表现偏好，结合整体播放决定是否调整。</p>)}
    </details>
    {report.motion_evidence?.tracked_parts && <details><summary>查看部件逐帧测量</summary>
      {report.motion_evidence.tracked_parts.unavailable && <p>{report.motion_evidence.tracked_parts.unavailable}</p>}
      {report.motion_evidence.tracked_parts.reference_radius_px != null && <p>参考半径 {report.motion_evidence.tracked_parts.reference_radius_px.toFixed(1)} 像素，允许偏差 {report.motion_evidence.tracked_parts.tolerance_px?.toFixed(1)} 像素</p>}
      {report.motion_evidence.tracked_parts.frames?.map(f => <p key={f.frame}>第 {f.frame} 帧
        {f.radius_px != null && ` · 半径 ${f.radius_px} 像素`} · 固定区域变化像素 {Object.entries(f.fixed_changed_pixels).map(([part,n]) => `${part} ${n}`).join('、')}</p>)}
    </details>}
    {!!report.motion_evidence?.alpha_changes?.length && <details><summary>查看透明度突变帧</summary>
      {report.motion_evidence.alpha_changes.map((change, i)=><p key={i}>第 {change.frame} 帧 · {change.region}，与{change.compared_to === 'reference' ? '参考图' : '第 ' + change.compared_to + ' 帧'}相比，{change.lost_pixels} 个像素的 Alpha 下降至少 128，{change.gained_pixels} 个上升至少 128。</p>)}
    </details>}
    {extra&&extra.state!=='diagnostic'&&<details><summary>查看独立专家与争议复核过程</summary>
      <h3>基础检查</h3><Evidence opinion={extra.baseline} />
      {(['appearance','motion'] as const).map(role=><div key={role}><h3>{role==='appearance'?'外观专家':'运动专家'} · 独立意见</h3>
        {extra.experts?.[role]?<Evidence opinion={extra.experts[role]} />:<p>尚无完成的意见。</p>}</div>)}
      {extra.resolution?<><h3>争议复核</h3><p>{extra.resolution.summary}</p>{classifications?.map(c=><p key={c.dimension}>
        <b>{dimensions[c.dimension]}</b>：{c.observation} {c.prior_claim_correction}
      </p>)}</>:<p>{extra.state==='complete'?'意见一致，无需追加争议复核。':'有争议时最多追加一次复核；失败或未知请求不会自动重试。'}</p>}
      {!!extra.requires_human_adjudication?.length&&<p><b>需要实际画面裁决</b>：{extra.requires_human_adjudication.map(c=>dimensions[c.dimension]||c.dimension).join('、')}。请对照原始画面、模型意见和测量记录作出决定。</p>}
      {failed&&<p>{extra.summary || '已保存已有意见和请求，未自动重发。'}</p>}
    </details>}
    </>}
  </div>;
}
