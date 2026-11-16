'use client';
/* oxlint-disable next/no-img-element -- exact pixel state images */
import { Plus, Trash2, ArrowDown } from 'lucide-react';
import { motionUrl } from '../sprite-generator/open-motion-model';
import {
  draftLimits, edgeStatusLabels, nodeSourceLabels,
  type GraphEdge, type GraphNode, type InteractableDraft, type Selection,
} from './motion-graph';

export function StateGraphView({ workId, nodes, edges, selection, onSelect, draft, onDraft, editable, referenceUrl }: {
  workId: string | null; nodes: GraphNode[]; edges: GraphEdge[]; selection: Selection | null; onSelect: (value: Selection) => void;
  draft: InteractableDraft; onDraft: (value: InteractableDraft) => void; editable: boolean; referenceUrl: string;
}) {
  const image = (node: GraphNode) => node.index === 0 && referenceUrl ? referenceUrl
    : node.image && workId ? motionUrl(`open-motion/${workId}/${node.image.path}`, { v: node.image.v }) : '';
  const states = draft.states;
  const update = (index: number, change: Partial<InteractableDraft['states'][number]>) =>
    onDraft({ ...draft, states: states.map((s, i) => (i === index ? { ...s, ...change } : s)) });
  return <nav className="im-graph" aria-label="状态图">
    <ol>
      {nodes.map((node, i) => {
        const edge = edges.find(e => e.from === node.index);
        const src = image(node);
        return <li key={node.index}>
          <button className="im-node" aria-pressed={selection?.kind === 'node' && selection.index === node.index}
            onClick={() => onSelect({ kind: 'node', index: node.index })} data-source={node.source}>
            <span className="im-node-thumb">{src ? <img src={src} alt="" decoding="async" /> : <span aria-hidden="true">{String.fromCharCode(65 + i)}</span>}</span>
            <span><b>{String.fromCharCode(65 + i)} · {node.name}</b><small>{nodeSourceLabels[node.source]}</small></span>
          </button>
          {editable && <div className="im-node-edit">
            <label>名称<input value={states[i]?.name ?? ''} maxLength={draftLimits.name} onChange={e => update(i, { name: e.target.value })} /></label>
            {i > 0 && <label>外观（与上一状态的差别）<textarea rows={2} maxLength={draftLimits.appearance} value={states[i]?.appearance ?? ''}
              placeholder="例如：拉杆转到右侧，底座不动" onChange={e => update(i, { appearance: e.target.value })} /></label>}
            {i > 0 && <label className="im-file">可选目标图（128 × 128 透明 PNG）
              <input type="file" accept="image/png" onChange={e => {
                const file = e.target.files?.[0];
                if (!file) { update(i, { targetPng: undefined }); return; }
                const reader = new FileReader();
                reader.onload = () => { if (typeof reader.result === 'string') update(i, { targetPng: reader.result.split(',')[1] }); };
                reader.readAsDataURL(file);
              }} /></label>}
            {i > 0 && states[i]?.targetPng && <img className="im-target-preview" src={`data:image/png;base64,${states[i].targetPng}`} alt="待绑定目标图" />}
            {i > 1 && <button className="motion-secondary" onClick={() => onDraft({ ...draft, states: states.filter((_, j) => j !== i) })}>
              <Trash2 size={14} />删除此状态</button>}
          </div>}
          {edge && <button className="im-edge" aria-pressed={selection?.kind === 'edge' && selection.stage === edge.stage}
            onClick={() => onSelect({ kind: 'edge', stage: edge.stage })} data-status={edge.status}>
            <ArrowDown size={14} aria-hidden="true" />
            <span>{edge.frames ? `${edge.frames} 帧` : '帧数待规划'} · {edgeStatusLabels[edge.status]}</span>
          </button>}
        </li>;
      })}
    </ol>
    {editable && <div className="im-graph-actions">
      <button disabled={states.length >= draftLimits.states} onClick={() => onDraft({ ...draft, states: [...states, { name: `状态 ${states.length + 1}`, appearance: '' }] })}>
        <Plus size={14} />添加状态</button>
      <label className="motion-check"><input type="checkbox" className="ui-switch" checked={draft.returnToStart}
        onChange={e => onDraft({ ...draft, returnToStart: e.target.checked })} />最后回到初始状态</label>
      <label className="motion-check"><input type="checkbox" className="ui-switch" checked={draft.loop}
        onChange={e => onDraft({ ...draft, loop: e.target.checked })} />循环播放</label>
      <label>终点停留（可选）<input value={draft.hold} maxLength={120} placeholder="例如：打开后停留半秒" onChange={e => onDraft({ ...draft, hold: e.target.value })} /></label>
      <p className="motion-muted">状态按顺序连接，最多 {draftLimits.states - 1} 段过渡；分支或并行状态请拆成多个作品。</p>
    </div>}
  </nav>;
}
