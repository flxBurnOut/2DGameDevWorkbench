'use client';
import { useState } from 'react';
import { offerGodotExport } from '@/lib/workbench/godot-export';
import { storeEditorHandoff } from '@/lib/workbench/asset-import';
import { useWorkbench } from '@/components/workbench/workbench-provider';
import {
  motionProject,
  type Graph,
  type Rhythm,
} from '@/features/interactable-motion/delivery';
import {
  motionUrl,
  type MotionCandidate,
  type MotionWork,
} from '../sprite-generator/open-motion-model';
import { nodeImageUrl } from './motion-graph';
export type { Rhythm } from '@/features/interactable-motion/delivery';

export function WritebackTab({
  work,
  candidate,
  graph,
  rhythms,
  readOnly,
  onSaved,
  busy,
  run,
  mutate,
}: {
  work: MotionWork | null;
  candidate?: MotionCandidate;
  graph: Graph;
  rhythms: Record<number, Rhythm>;
  readOnly: boolean;
  onSaved: (value: MotionWork) => void;
  busy: boolean;
  run: (fn: () => Promise<void>) => Promise<void>;
  mutate: (
    op: string,
    values?: Record<string, unknown>,
  ) => Promise<MotionWork | undefined>;
}) {
  const { navigate } = useWorkbench(),
    [handoff, setHandoff] = useState('');
  if (!work?.job || !candidate) return <p>完成制作并采用候选后可以导出。</p>;
  const job = work.job,
    approved = candidate.status === 'approved',
    disabled = busy || readOnly || !approved;
  const exports = job.export?.candidate_index === candidate.candidate_index;
  return (
    <section className="im-tool">
      <h3>动画资源</h3>
      <button
        disabled={disabled}
        onClick={() =>
          void run(async () => {
            const value = await mutate('export', {
              candidate_index: candidate.candidate_index,
            });
            if (value?.job?.export?.godot_package_path)
              offerGodotExport({
                name: value.plan?.title || work.character.display_name,
                jobId: value.job.job_id,
                candidateIndex: candidate.candidate_index,
              });
            if (value) onSaved(value);
          })
        }
      >
        导出到 Godot 项目
      </button>
      {exports && (
        <div className="motion-downloads">
          {(
            [
              ['godot', 'Godot ZIP'],
              ['sheet', 'PNG 精灵表'],
              ['preview', 'GIF 预览'],
            ] as const
          ).map(([kind, label]) => (
            <a
              key={kind}
              href={motionUrl(`jobs/${job.job_id}/exports/${kind}`, {
                revision: String(job.revision),
              })}
              download
            >
              {label}
            </a>
          ))}
        </div>
      )}
      <button
        disabled={disabled}
        onClick={() =>
          void run(async () => {
            const project = await motionProject(
              work,
              candidate,
              graph,
              rhythms,
            );
            setHandoff(
              await storeEditorHandoff('interactable-editor', 'interactable', {
                project,
              }),
            );
          })
        }
      >
        生成交互物编辑器副本
      </button>
      {handoff && (
        <button onClick={() => void navigate(handoff)}>打开已生成的副本</button>
      )}
      <details>
        <summary>下载已确认的状态图</summary>
        {(candidate.state_chain || []).map((state, i) => {
          const node = graph.nodes[i];
          if (!node) return null;
          const ref = motionUrl(`open-motion/${work.id}/reference`, {
            revision: String(work.revision),
            expected_sha256: state.sha256,
          });
          const url = nodeImageUrl(node, work, ref);
          return (
            url && (
              <p key={i}>
                <a href={url} download={state.name + '.png'}>
                  {state.name}
                </a>
              </p>
            )
          );
        })}
      </details>
    </section>
  );
}
