'use client';
/* oxlint-disable next/no-img-element -- exact pixel target previews */
import { Plus, Trash2 } from 'lucide-react';
import { draftLimits, draftProblems, type InteractableDraft } from './motion-graph';

/**
 * Centre view while defining states: one card per state in reading order,
 * then the options that apply to the whole chain.
 */
export function StateEditor({ draft, onDraft, referenceUrl, disabled }: {
  draft: InteractableDraft; onDraft: (value: InteractableDraft) => void; referenceUrl: string; disabled: boolean;
}) {
  const states = draft.states;
  const update = (index: number, change: Partial<InteractableDraft['states'][number]>) =>
    onDraft({ ...draft, states: states.map((s, i) => (i === index ? { ...s, ...change } : s)) });
  const problems = draftProblems(draft);
  const transitions = states.length - 1 + (draft.returnToStart ? 1 : 0);
  return <section className="im-editor" aria-label="定义状态">
    <p className="motion-muted">按播放顺序列出状态。第一个状态就是对象原图；之后每个状态写清与上一个状态的差别，规划会为每对相邻状态安排一段过渡（当前 {transitions} 段）。</p>
    <ol className="im-state-cards">
      {states.map((state, i) => <li key={i} className="im-state-card">
        <div className="im-state-head">
          <span className="im-state-badge">{String.fromCharCode(65 + i)}</span>
          <input aria-label={`状态 ${String.fromCharCode(65 + i)} 名称`} value={state.name} maxLength={draftLimits.name} disabled={disabled}
            onChange={e => update(i, { name: e.target.value })} placeholder="状态名称" />
          {i > 1 && <button className="im-icon-button" aria-label={`删除状态 ${String.fromCharCode(65 + i)}`} disabled={disabled}
            onClick={() => onDraft({ ...draft, states: states.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>}
        </div>
        {i === 0 ? <div className="im-state-reference">
          {referenceUrl ? <img src={referenceUrl} alt="对象原图" /> : <span className="im-object-empty" aria-hidden="true" />}
          <p className="motion-muted">初始状态使用对象原图{referenceUrl ? '' : '；先在上方选择交互物对象'}。可选填写原图里能看到的样子，帮助规划核对。</p>
        </div> : null}
        <label className="im-field">{i === 0 ? '原图外观（可选）' : '外观：与上一状态的差别'}
          <textarea rows={2} maxLength={draftLimits.appearance} value={state.appearance} disabled={disabled}
            placeholder={i === 0 ? '例如：拉杆在左侧，指示灯熄灭' : '例如：拉杆转到右侧，底座保持不动'}
            onChange={e => update(i, { appearance: e.target.value })} /></label>
        {i > 0 && <div className="im-state-target">
          {state.targetPng ? <img src={`data:image/png;base64,${state.targetPng}`} alt={`状态 ${String.fromCharCode(65 + i)} 目标图`} /> : null}
          <label className="im-file-button">{state.targetPng ? '更换目标图' : '可选：上传目标图'}
            <input type="file" accept="image/png" disabled={disabled} onChange={e => {
              const file = e.target.files?.[0]; e.target.value = '';
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => { if (typeof reader.result === 'string') update(i, { targetPng: reader.result.split(',')[1] }); };
              reader.readAsDataURL(file);
            }} /></label>
          {state.targetPng && <button className="motion-secondary" disabled={disabled} onClick={() => update(i, { targetPng: undefined })}>移除</button>}
          <small className="motion-muted">128 × 128 透明 PNG；方案就绪后绑定为该段的末帧目标。</small>
        </div>}
      </li>)}
      {states.length < draftLimits.states && <li>
        <button className="im-add-state" disabled={disabled}
          onClick={() => onDraft({ ...draft, states: [...states, { name: `状态 ${states.length + 1}`, appearance: '' }] })}>
          <Plus size={16} />添加状态</button>
      </li>}
    </ol>
    <fieldset className="im-chain-options" disabled={disabled}>
      <legend>整段设置</legend>
      <label className="motion-check"><input type="checkbox" checked={draft.returnToStart}
        onChange={e => onDraft({ ...draft, returnToStart: e.target.checked })} />最后回到初始状态（多一段过渡）</label>
      <label className="motion-check"><input type="checkbox" checked={draft.loop}
        onChange={e => onDraft({ ...draft, loop: e.target.checked })} />循环播放</label>
      <label className="im-field">终点停留（可选）<input value={draft.hold} maxLength={120} placeholder="例如：打开后停留半秒"
        onChange={e => onDraft({ ...draft, hold: e.target.value })} /></label>
      <p className="motion-muted">状态按顺序连接，最多 {draftLimits.states} 个状态；需要分支的状态请拆成多个作品。</p>
    </fieldset>
    {!!problems.length && <ul className="im-problems">{problems.map(p => <li key={p}>{p}</li>)}</ul>}
  </section>;
}
