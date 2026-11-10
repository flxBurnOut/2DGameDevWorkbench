'use client';
import { acceptanceSchema } from '@/lib/workbench/scene-workflow-contract.mjs';
import type { Scene } from '@/features/scene-composer/model.mjs';
import { arrayValue, describePlanStep, describeRegion, describeReplayEvent, eventNames, objectValue, planNames, readableValue, technicalText, textValue, type PlanDetailRow } from '@/features/scene-workflow/plan-details';

function DetailRows({ rows }: { rows: PlanDetailRow[] }) {
  return <dl style={{ display: 'grid', gap: 8, marginBlock: 12 }}>{rows.map((row, index) => <div key={`${row.label}-${index}`}><dt style={{ fontWeight: 600 }}>{row.label}</dt><dd style={{ marginInlineStart: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.value}</dd></div>)}</dl>;
}
function TechnicalRecord({ value }: { value: unknown }) {
  return <details><summary>高级：原始参数（只读）</summary><pre style={{ maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11 }}>{technicalText(value)}</pre></details>;
}
export function WorkflowStepDetails({ step, scene, steps }: { step: { kind?: unknown; input?: unknown }; scene?: Scene; steps?: unknown[] }) {
  const names = planNames(scene, steps), detail = describePlanStep(step, names);
  return <details style={{ marginBlock: 8 }}>
    <summary>查看此步的制作内容与参数</summary>
    {detail.warning && <p>{detail.warning}</p>}
    <DetailRows rows={detail.rows} />
    {!!detail.changes.length && <ol>{detail.changes.map((change, index) => <li key={index}><strong>{change.title}</strong><DetailRows rows={change.rows} /></li>)}</ol>}
    <TechnicalRecord value={step.input} />
  </details>;
}
export function WorkflowAcceptanceDetails({ plan, scene }: { plan: unknown; scene?: Scene }) {
  const record = objectValue(plan), steps = arrayValue(record.steps), names = planNames(scene, steps);
  const visual = arrayValue(record.visualCriteria), behavior = arrayValue(record.acceptance);
  return <section aria-label="方案验收条件">
    <h3>视觉验收条件</h3>
    {visual.length ? <ul>{visual.map((value, index) => {
      const criterion = objectValue(value);
      return <li key={textValue(criterion.id, String(index))}><strong>{textValue(criterion.description, '历史视觉条件')}</strong><p>检查范围：{describeRegion(criterion.region)}</p><TechnicalRecord value={criterion} /></li>;
    })}</ul> : <p>此记录没有可读取的视觉验收条件。</p>}
    <h3>行为验收条件</h3>
    {behavior.length ? behavior.map((value, index) => {
      const criterion = objectValue(value), parsed = acceptanceSchema.safeParse(criterion);
      return <details key={textValue(criterion.id, String(index))} style={{ marginBlock: 8 }}>
        <summary>{textValue(criterion.description, '历史行为条件')}</summary>
        {parsed.success ? <>
          <p>按以下顺序，从保存版本的初始状态重放：</p>
          <ol>{parsed.data.events.map((event: unknown, eventIndex: number) => <li key={eventIndex}>{describeReplayEvent(event, names)}</li>)}</ol>
          {!parsed.data.events.length && <p>不提供输入，检查初始状态。</p>}
          <h4>预期事件</h4>
          {parsed.data.expectEvents.length ? <ul>{parsed.data.expectEvents.map((expected: { name: string; instanceId?: string; count: number }, eventIndex: number) => <li key={eventIndex}>{expected.instanceId ? `${readableValue(expected.instanceId, 'instanceId', names)}：` : '任意物件：'}{eventNames[expected.name] || expected.name}至少 {expected.count} 次</li>)}</ul> : <p>未设置事件次数断言。</p>}
          <h4>预期最终状态</h4>
          {parsed.data.expectStates.length ? <ul>{parsed.data.expectStates.map((expected: Record<string, unknown>, stateIndex: number) => <li key={stateIndex}><strong>{readableValue(expected.instanceId, 'instanceId', names)}</strong><DetailRows rows={Object.entries(expected).filter(([key]) => key !== 'instanceId').map(([key, item]) => ({ label: ({ completed: '已完成', toggleState: '开关打开', enabled: '允许交互', visible: '可见', solidEnabled: '实体碰撞开启', sequenceIndex: '序列位置（从 0 开始）', successCount: '成功次数' } as Record<string, string>)[key] || key, value: readableValue(item, key, names) }))} /></li>)}</ul> : <p>未设置最终状态断言。</p>}
        </> : <p>此历史行为条件缺少当前格式所需的回放或断言参数；保留原记录，未推断检查结果。</p>}
        <TechnicalRecord value={criterion} />
      </details>;
    }) : <p>此方案未包含独立行为断言。</p>}
    <p className="sw-muted">以上为保存方案的只读参数。实际检查结果在复核记录中查看；交互回放不代表 Godot 物理验证。</p>
  </section>;
}
