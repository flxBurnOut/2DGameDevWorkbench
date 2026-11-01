'use client';
/* oxlint-disable next/no-img-element -- users inspect the exact local evidence being sent. */
import { useRef, useState } from 'react';
import type { AttributePolicy } from '@/features/image-edit/attribute-plan.mjs';
import type { PixelBounds, RegionSpec } from '@/features/image-edit/core.mjs';
import { PartTargetPreview } from './part-target-preview';
import { imageEditRequest, imageGuards, imageResolveInput, type ImageEditSession, type ImageTargetInfo } from '@/features/image-edit/client';

export interface PartSuggestion {
  decision: 'propose' | 'needs_input';
  reason: string;
  part: string;
  kind: string;
  policy: AttributePolicy;
  successCriteria: string[];
  changesSilhouette: boolean;
  target?: RegionSpec;
  influence?: RegionSpec | null;
  protect?: { part: string; region: RegionSpec }[];
  targetClipped?: boolean;
  count?: number;
  previewPng?: string;
}
interface PartContext {
  partRef: string;
  regionRef: string;
  status: string;
  instruction: string;
  preserveAlpha: boolean;
  expectedEditRevision: number;
  baseCandidateVersion: string;
  crop: PixelBounds;
  service: { configured: boolean; endpoint: string; profile: { model: string } };
  views: { role: string; png: string }[];
  suggestion?: PartSuggestion;
  error?: string;
}
interface Props {
  target: ImageTargetInfo;
  session: ImageEditSession;
  baseVersion: string;
  allowed: RegionSpec | null;
  instruction: string;
  preserveAlpha: boolean;
  disabled: boolean;
  onBusy: (label: string) => void;
  onUse: (partRef: string, suggestion: PartSuggestion, allowed: RegionSpec, useBox: boolean) => void;
}
const labels: Record<string,string> = { whole: '全图', 'clean-crop': '干净局部', 'authorized-crop': '局部授权范围' };
const statusLabel: Record<string,string> = { prepared: '已准备', requesting: '分析中', completed: '已返回', attention_required: '原请求需核查', failed: '分析失败' };

export function ImagePartPlanner(props: Props) {
  const [record, setRecord] = useState<PartContext | null>(null);
  const [boundKey, setBoundKey] = useState('');
  const [message, setMessage] = useState('');
  const [correction,setCorrection]=useState<Extract<RegionSpec,{type:'rectangle'}> | null>(null);
  const [omitted,setOmitted]=useState<number[]>([]);
  const busy = useRef(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const submit = useRef<{ ref: string; id: string } | null>(null);
  const key = JSON.stringify([props.session.editId, props.session.revision, props.baseVersion, props.allowed, props.instruction.trim(), props.preserveAlpha]);
  const current = record && boundKey === key;
  const recent = props.session.partContexts?.filter(item => item.baseCandidateVersion === props.baseVersion).at(-1);

  async function work(label: string, fn: () => Promise<void>) {
    if (busy.current || props.disabled) return;
    busy.current = true;
    props.onBusy(label);
    setMessage('');
    try { await fn(); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); }
    finally { busy.current = false; props.onBusy(''); }
  }

  const prepare = () => work('准备部件定位视图', async () => {
    if (!props.allowed || !props.instruction.trim()) return;
    const { regionRef } = await imageEditRequest<{ regionRef: string }>('resolve', imageResolveInput(props.target, props.allowed));
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    const result = await imageEditRequest<{ part: PartContext }>('part-context', {
      ...imageGuards(props.target), editId: props.session.editId, expectedEditRevision: props.session.revision,
      baseCandidateVersion: props.baseVersion, regionRef, instruction: props.instruction.trim(),
      preserveAlpha: props.preserveAlpha, commandId: attempt.current.id,
    });
    setRecord(result.part);
    setCorrection(null);
    setOmitted([]);
    setBoundKey(key);
    attempt.current = null;
  });
  const suggest = () => work('视觉模型正在定位部件', async () => {
    if (!current || !record || record.status !== 'prepared') return;
    if (submit.current?.ref !== record.partRef) submit.current = { ref: record.partRef, id: crypto.randomUUID() };
    const result = await imageEditRequest<{ part: PartContext }>('part-suggest', { partRef: record.partRef, commandId: submit.current.id });
    setRecord(result.part);
  });
  const recover = () => work('读取原定位记录', async () => {
    const partRef = record?.partRef ?? recent?.partRef;
    if (!partRef) return;
    const { part } = await imageEditRequest<{ part: PartContext }>('part-get', { partRef });
    setRecord(part);
    setCorrection(null);
    setOmitted([]);
    let matches = false;
    if (props.allowed && part.instruction === props.instruction.trim() && part.preserveAlpha === props.preserveAlpha &&
        part.expectedEditRevision === props.session.revision && part.baseCandidateVersion === props.baseVersion) {
      const selection = await imageEditRequest<{regionRef:string}>('resolve', imageResolveInput(props.target, props.allowed));
      matches = selection.regionRef === part.regionRef;
    }
    setBoundKey(matches ? key : '');
  });
  const suggestion = record?.suggestion;
  const clean = record?.views.find(view=>view.role==='clean-crop');
  const suggestedBox = suggestion?.target?.type==='rectangle' ? suggestion.target : undefined;
  const protections = (suggestion?.protect ?? []).filter((_,i)=>!omitted.includes(i));
  const boxes = protections.flatMap(item=>item.region.type==='rectangle'?[{part:item.part,region:item.region}]:[]);
  return <section className="ie-part-planner" aria-label="视觉部件定位">
    <p>在画布上框住大致范围，填写上方的修改描述。可以先查看将送给视觉模型的图片。</p>
    {props.instruction.trim().length>4000 && <p>视觉定位描述最多 4000 字，请缩短后准备视图。</p>}
    <button type="button" disabled={props.disabled || !props.allowed || !props.instruction.trim() || props.instruction.trim().length > 4000} onClick={()=>void prepare()}>准备部件定位视图（本地）</button>
    {(record || recent) && <button type="button" disabled={props.disabled} onClick={()=>void recover()}>查询原定位记录</button>}
    {record && <>
      <p>定位指令：{record.instruction}</p>
      <div className="ie-ai-references">{record.views.map(view=><figure key={view.role}><img alt={labels[view.role]} src={'data:image/png;base64,'+view.png}/><figcaption>{labels[view.role]}</figcaption></figure>)}</div>
      <p>{record.service.profile.model} · {new URL(record.service.endpoint).host} · {statusLabel[record.status] ?? record.status}</p>
      {!record.service.configured && <p>请配置视觉服务 Key 后重新准备。</p>}
      {!current && <p>当前描述、授权范围或基准与记录不符。可重看原记录，或重新准备定位视图。</p>}
      {current && record.status === 'prepared' && <button type="button" disabled={props.disabled || !record.service.configured} onClick={()=>void suggest()}>发送这三张视图并定位（1 次视觉调用）</button>}
      {record.error && <output role="alert">{record.error}</output>}
      {suggestion && <><p>{suggestion.part} · {suggestion.reason}</p>
        {suggestedBox && clean && <PartTargetPreview crop={record.crop} png={clean.png} target={correction ?? suggestedBox} protectedBoxes={boxes} onChange={setCorrection}/>}
        {correction && <button type="button" onClick={()=>setCorrection(null)}>还原建议框</button>}
        {suggestion.targetClipped && <p>建议框跨过授权边界，准备计划时只取授权范围内的部分。</p>}
        {suggestion.protect?.map((item,i)=><label key={i}><input type="checkbox" checked={!omitted.includes(i)} onChange={e=>setOmitted(e.target.checked?omitted.filter(n=>n!==i):[...omitted,i])}/>保护 {item.part}</label>)}
        {suggestion.decision === 'propose' && <>
          <button type="button" disabled={!current || props.disabled} onClick={()=>props.allowed && props.onUse(record.partRef,suggestion,props.allowed,false)}>只载入属性，保留手选范围</button>
          <button type="button" disabled={!current || props.disabled} onClick={()=>props.allowed && props.onUse(record.partRef,{...suggestion,target:correction ?? suggestion.target,protect:protections},props.allowed,true)}>使用核对后的框和属性</button>
        </>}
      </>}
    </>}
    {message && <output role="alert">{message}</output>}
  </section>;
}
