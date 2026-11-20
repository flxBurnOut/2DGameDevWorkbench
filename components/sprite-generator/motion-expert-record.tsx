'use client';
import type { MotionWork } from './open-motion-model';

/** Planning roles shared by the character studio and the interactable panel. */
export const motionPlanningRoles: Record<string, string> = {
  appearance: '外观专家',
  motion: '动作专家',
  strategy: '生成策略专家',
  coordinator: '协调专家',
  validator: '本机方案校验',
};

const actions: Record<string, string> = {
  propose: '提出建议',
  consult: '请求协作',
  inspect_reference: '观察参考图',
  finalize: '形成方案',
  validation_feedback: '返回校验意见',
};

export function ExpertRecord({ work }: { work: MotionWork }) {
  return (
    <details>
      <summary>专家协作记录 · {work.planning_calls.length} 次调用</summary>
      <div className="motion-expert-record">
        {work.messages.map((m, i) => (
          <article key={i}>
            <b>{motionPlanningRoles[m.role]} · {m.reused_from ? `沿用第 ${m.reused_from.revision} 版意见` : actions[m.response.action]}</b>
            <p>{m.response.summary}</p>
            {m.response.question && <p>{m.response.question}</p>}
          </article>
        ))}
      </div>
    </details>
  );
}
