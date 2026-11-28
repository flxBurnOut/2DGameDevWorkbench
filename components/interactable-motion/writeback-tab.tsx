'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWorkbenchActions } from '@/components/workbench/workbench-provider';
import { offerGodotExport } from '@/lib/workbench/godot-export';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  applyDocument, DocumentClientError, listDocuments, readDocument, readMotionBindings,
  type MotionBindings, type MotionSlotBinding, type SharedDocumentSummary,
} from '@/features/editor-documents/client';
import type { InteractableProject } from '@/features/interactable-editor/contract.mjs';
import { motionRequest, motionUrl, type MotionCandidate, type MotionWork } from '../sprite-generator/open-motion-model';
import { Preview } from '../interactable-editor/preview';
import '../interactable-editor/interactable-editor.css';
import { panelHref, type GraphEdge, type GraphNode } from './motion-graph';
import type { Playback } from './transition-canvas';
import type { DerivedRecord } from './derived-assets';

export type Rhythm = { durations?: number[]; playback?: Playback };
type Choice = { assetId: string; label: string; source: 'state' | 'transition'; derived?: string; stage: number | null; frameCount?: number };
type Slot = { index: number; name: string; kind: 'state' | 'transition'; label: string; suggested?: string };

async function fingerprint(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

/** Map graph states to toggle A/B or sequence entries; the user can change every choice. */
export function proposedSlots(kind: 'toggle' | 'sequence', entries: string[], initialToggle: boolean, nodes: GraphNode[], edges: GraphEdge[], choices: Choice[]): Slot[] {
  const stateChoice = (node?: GraphNode) => node && choices.find(c => c.source === 'state' && !c.derived && c.stage === node.stage)?.assetId;
  const edgeChoice = (edge?: GraphEdge) => edge && choices.find(c => c.source === 'transition' && !c.derived && c.stage === edge.stage)?.assetId;
  if (kind === 'toggle') {
    const first = initialToggle ? 1 : 0, second = 1 - first;
    const name = (index: number) => nodes[index]?.name.trim();
    const initialName = entries[first]?.trim(), nextName = entries[second]?.trim();
    // The reference belongs to the actual initial state. A mislabeled or
    // differently ordered chain cannot safely seed these writeback slots.
    const matching = initialName && nextName && initialName !== nextName && name(0) === initialName && name(1) === nextName;
    const forward = matching ? edges.find(e => e.from === 0 && e.to === 1) : undefined;
    const back = matching ? edges.find(e => e.from === 1 && name(e.to) === initialName) : undefined;
    const reverse = forward && choices.find(c => c.source === 'transition' && c.derived === 'reverse' && c.stage === forward.stage)?.assetId;
    return [
      { index: first, name: entries[first], kind: 'state', label: `${entries[first]} · 状态图（初始）`, suggested: matching ? stateChoice(nodes[0]) : undefined },
      { index: second, name: entries[second], kind: 'state', label: `${entries[second]} · 状态图`, suggested: matching ? stateChoice(nodes[1]) : undefined },
      { index: second, name: entries[second], kind: 'transition', label: `进入「${entries[second]}」的过渡`, suggested: edgeChoice(forward) },
      { index: first, name: entries[first], kind: 'transition', label: `回到「${entries[first]}」的过渡`, suggested: edgeChoice(back) || reverse },
    ];
  }
  return entries.flatMap((name, index) => [
    { index, name, kind: 'state' as const, label: `${index + 1} · ${name} · 状态图`, suggested: stateChoice(nodes[index]) },
    ...(index > 0 ? [{ index, name, kind: 'transition' as const, label: `${index + 1} · ${name} · 进入过渡`, suggested: edgeChoice(edges[index - 1]) }] : []),
  ]);
}

export function WritebackTab({ work, candidate, graph, documentId, definitionId, rhythms, readOnly, onProject, onSaved, busy, run, mutate }: {
  work: MotionWork | null; candidate?: MotionCandidate; graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  documentId: string; definitionId: string; rhythms: Record<number, Rhythm>; readOnly: boolean;
  onProject: (p: InteractableProject) => void; onSaved: (w: MotionWork) => void; busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>; mutate: (op: string, values?: Record<string, unknown>) => Promise<MotionWork | undefined>;
}) {
  const wb = useWorkbenchActions();
  const [documents, setDocuments] = useState<SharedDocumentSummary[]>([]);
  const [pickDocument, setPickDocument] = useState(documentId);
  const [pickProject, setPickProject] = useState<InteractableProject | null>(null);
  const [bindings, setBindings] = useState<MotionBindings | null>(null);
  const [project, setProject] = useState<InteractableProject | null>(null);
  const [derived, setDerived] = useState<DerivedRecord[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const jobId = work?.job?.job_id;
  const reload = useCallback(async () => {
    if (!documentId) return;
    const [value, doc] = await Promise.all([readMotionBindings(documentId, definitionId || undefined),
      readDocument<InteractableProject>(documentId, undefined, { media: 'references' })]);
    setBindings(value); setProject(doc.document.content); onProject(doc.document.content);
  }, [documentId, definitionId, onProject]);
  useEffect(() => { queueMicrotask(() => void reload().catch(e => setError((e as Error).message))); }, [reload]);
  useEffect(() => {
    if (documentId) return;
    void listDocuments('interactable').then(p => setDocuments(p.documents)).catch(e => setError((e as Error).message));
  }, [documentId]);
  useEffect(() => {
    if (!pickDocument || documentId) return;
    void readDocument<InteractableProject>(pickDocument, undefined, { media: 'references' }).then(r => setPickProject(r.document.content)).catch(e => setError((e as Error).message));
  }, [pickDocument, documentId]);
  useEffect(() => {
    if (!work?.job) return;
    void motionRequest<{ derived: DerivedRecord[] }>(`open-motion/${work.id}/derived`, undefined, { revision: String(work.revision) })
      .then(v => setDerived(v.derived.filter(d => d.state === 'accepted' && d.candidate === candidate?.candidate_index)))
      .catch(() => setDerived([]));
  }, [work, candidate?.candidate_index]);
  // Confirmed states and accepted transitions of this candidate, plus accepted derived assets.
  const choices: Choice[] = useMemo(() => {
    if (!jobId || !candidate?.state_chain) return [];
    const rows: Choice[] = [];
    candidate.state_chain.forEach((state, n) => {
      rows.push({ assetId: `motion-state:${jobId}:${candidate.candidate_index}:${n}`, label: `状态图 · ${state.name}`, source: 'state', stage: state.stage });
      const run = state.stage === null ? undefined : candidate.plan_execution.stages[state.stage];
      if (state.stage !== null && run?.state === 'accepted') {
        const edge = graph.edges[state.stage];
        rows.push({ assetId: `motion-transition:${jobId}:${candidate.candidate_index}:${n}`, label: `过渡 · ${graph.nodes[edge.from]?.name} → ${graph.nodes[edge.to]?.name}`,
          source: 'transition', stage: state.stage, frameCount: edge.frames });
      }
    });
    for (const d of derived) rows.push({ assetId: d.asset_id, label: `派生${d.kind === 'state' ? '状态图' : '过渡'} · ${d.name}（${d.method_label}）`,
      source: d.kind, derived: d.method, stage: d.source_stage ?? null, frameCount: d.frames.length });
    return rows;
  }, [jobId, candidate, graph, derived]);
  const object = bindings?.objects.find(o => o.definitionId === definitionId);
  const entries = object?.slots.map(s => s.name) || [];
  const skeleton = work?.spec.interactable_skeleton?.states;
  const knownNames = entries.map(name => name.trim());
  const bindingNodes = skeleton?.length === graph.nodes.length
    ? graph.nodes.map((node, index) => knownNames.includes(node.name.trim()) ? node : { ...node, name: skeleton[index].name })
    : graph.nodes;
  const slots = object ? proposedSlots(object.kind, entries, Boolean(object.initialToggle), bindingNodes, graph.edges, choices) : [];
  const key = (slot: Slot) => `${slot.kind}:${slot.index}`;
  const value = (slot: Slot) => selected[key(slot)] ?? slot.suggested ?? '';
  const write = async () => {
    if (!object || !bindings) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const commands: Record<string, unknown>[] = [];
      for (const slot of slots) {
        const assetId = value(slot);
        if (!assetId) continue;
        const response = await fetch('/api/workbench/assets?' + new URLSearchParams({ assetId }), { cache: 'no-store' });
        const { asset } = await response.json() as { asset?: { id: string; revision: string; motionSource?: string; frameCount?: number } };
        if (!response.ok || asset?.id !== assetId || asset.motionSource !== slot.kind || !asset.revision) throw new Error('所选素材已变化或尚未登记，请刷新后重选。');
        const choice = choices.find(c => c.assetId === assetId);
        const rhythm = slot.kind === 'transition' && choice && !choice.derived && choice.stage !== null ? rhythms[choice.stage] : undefined;
        commands.push({ type: 'import-motion-asset', definitionId: object.definitionId, target: object.target, index: slot.index, assetId, assetRevision: asset.revision,
          ...(rhythm?.durations && rhythm.durations.length === asset.frameCount ? { durations: rhythm.durations } : {}),
          ...(rhythm?.playback === 'ping_pong' ? { playback: 'ping_pong' } : {}) });
      }
      if (!commands.length) throw new Error('请至少为一个位置选择素材。');
      // A stable commandId makes a retried request idempotent; a changed revision is a conflict, not an overwrite.
      const commandId = 'motion-panel-' + (await fingerprint([bindings.documentId, bindings.revision, commands])).slice(0, 48);
      await applyDocument(bindings.documentId, bindings.revision, commands, commandId);
      await reload();
      setMessage(`已写回 ${commands.length} 个位置。可在下方预览，或回到交互物编辑器继续配置行为。`);
    } catch (e) {
      if (e instanceof DocumentClientError && e.status === 409) {
        await reload().catch(() => undefined);
        setError('交互物工程已在别处修改。已重新读取当前版本，未提交的选择保留，请核对后再写回。');
      } else setError((e as Error).message);
    } finally { setSaving(false); }
  };
  const describe = (b: MotionSlotBinding | null) => !b ? '未绑定动画资产' : <>
    作品 {b.workId.slice(0, 8)} · 版本 {b.workRevision} · 候选 {b.candidateIndex}{b.stageIndex !== null ? ` · 第 ${b.stageIndex + 1} 段` : ' · 原图'}
    {b.derivation ? ` · 派生（${b.derivation}）` : ''} · {b.frameHashes.length} 帧 · {b.frameHashes.at(-1)?.slice(0, 12)}
    {b.playback === 'ping_pong' ? ' · 往返' : ''}{b.durations ? ' · 自定节奏' : ''}
    {work && (b.workId === work.id && b.workRevision === work.revision ? ' · 与当前作品一致' : ' · 来自其他作品或版本')}
    {!b.current && ' · 已被后续编辑替换'}</>;
  const approved = candidate?.status === 'approved';
  const previewObject = project?.objects.find(o => o.definitionId === definitionId);
  return <section className="im-slots">
    {!documentId ? <div className="im-tool">
      <h3>选择写回的交互物</h3>
      <label>交互物工程<NativeSelect aria-label="交互物工程" value={pickDocument} onChange={e => setPickDocument(e.target.value)}>
        <NativeSelectOption value="">请选择</NativeSelectOption>
        {documents.map(d => <NativeSelectOption key={d.id} value={d.id}>{d.name}</NativeSelectOption>)}</NativeSelect></label>
      {pickProject && <div className="im-tool-row">{pickProject.objects.filter(o => o.behavior.kind === 'toggle' || o.behavior.kind === 'sequence').map(o =>
        <button key={o.definitionId} onClick={() => void wb.navigate(panelHref({ work: work?.id, version: work && work.revision !== work.latest_revision ? work.revision : undefined },
          { documentId: pickDocument, definitionId: o.definitionId }))}>{o.displayName}（{o.behavior.kind === 'toggle' ? '切换' : '序列'}）</button>)}</div>}
      {!documents.length && <p className="motion-muted">还没有保存过的共享交互物工程；在交互物编辑器中保存后再写回。</p>}
    </div> : !object ? <p className="motion-muted">{bindings ? '所选物件不是切换或序列物件，或已不存在。' : '正在读取交互物绑定…'}</p> : <>
      <h3>{object.name}（{object.kind === 'toggle' ? '切换' : '序列'}） · 工程版本 {bindings?.revision}</h3>
      {slots.map(slot => {
        const current = object.slots[slot.index]?.[slot.kind];
        const options = choices.filter(c => c.source === slot.kind);
        return <div key={key(slot)} className="im-slot" data-current={current ? String(current.current) : undefined}>
          <b>{slot.label}</b>
          <small>当前：{describe(current)}</small>
          <NativeSelect aria-label={slot.label} value={value(slot)} disabled={readOnly || saving}
            onChange={e => setSelected(s => ({ ...s, [key(slot)]: e.target.value }))}>
            <NativeSelectOption value="">保持不变</NativeSelectOption>
            {options.map(c => <NativeSelectOption key={c.assetId} value={c.assetId}>{c.label}</NativeSelectOption>)}
          </NativeSelect>
        </div>;
      })}
      {!choices.length && <p className="motion-muted">还没有已确认的状态图或已接受的过渡。确认状态帧或过渡后即可写回。</p>}
      <button className="motion-primary" disabled={readOnly || saving || busy || !slots.some(s => value(s))} onClick={() => void write()}>写回所选位置</button>
      <p className="motion-muted">写回只调用 import-motion-asset，并带上工程版本与稳定命令编号；工程已被修改时会提示冲突，不会覆盖。</p>
      {project && previewObject && <details><summary>场景预览：触发 → 过渡 → 停在新状态</summary>
        <div className="im-preview"><Preview key={bindings?.revision} object={previewObject} assets={project.assets} edit={() => undefined} /></div>
        <p className="motion-muted">使用交互物编辑器的同一模拟器；拖动等编辑在此不会保存。</p></details>}
      <a href={`/tools/interactable-editor?document=${encodeURIComponent(documentId)}`}>回到交互物编辑器</a>
    </>}
    {message && <p className="motion-good">{message}</p>}
    {error && <p className="motion-danger">{error}</p>}
    {work?.job && <div className="im-tool">
      <h3>导出</h3>
      <p className="motion-muted">{approved ? '导出包含实际 PNG、预览和 Godot SpriteFrames。' : '采用完整候选后可导出整段动画；状态图和已接受过渡可直接写回。'}</p>
      <button disabled={!approved || readOnly || busy} onClick={() => void run(async () => {
        const value = await mutate('export', { candidate_index: candidate?.candidate_index });
        if (value?.job?.export?.godot_package_path) offerGodotExport({ name: `${value.plan?.title} · 候选 ${candidate?.candidate_index}`, jobId: value.job.job_id, candidateIndex: candidate!.candidate_index });
        if (value) onSaved(value);
      })}>导出到 Godot 项目</button>
      {work.job.export?.candidate_index === candidate?.candidate_index && <div className="motion-downloads">
        <a href={motionUrl(`jobs/${work.job.job_id}/exports/godot`)} download>Godot ZIP</a>
        <a href={motionUrl(`jobs/${work.job.job_id}/exports/sheet`)} download>PNG 精灵表</a></div>}
    </div>}
  </section>;
}
