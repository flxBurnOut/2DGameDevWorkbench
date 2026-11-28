import type { WorkbenchModule } from './modules';
export function operationLabel(operation: unknown): string {
  const labels: Record<string, string> = { generate: '生成素材', import: '导入素材', transfer: '导入角色', 'save-project': '保存项目', 'export-godot': '导出 Godot', create: '创建作业', submit: '提交生成', get: '更新状态', review: '检查素材', export: '导出素材', approve: '确认素材', prepare: '准备输入' };
  return typeof operation === 'string' ? labels[operation] || '制作步骤' : '制作';
}


export type WorkItemState =
  | 'saved'
  | 'not_submitted'
  | 'editing'
  | 'running'
  | 'attention'
  | 'completed';
export type WorkItem = {
  id: string;
  capabilityId: string;
  title: string;
  detail: string;
  state: WorkItemState;
  updatedAt: string;
  savedAt?: string;
  href: string;
  draftKey?: string;
  userInitiated?: boolean;
  scopeId?: string;
  stage?: number;
  taskIds?: string[];
  outputs?: string[];
};
export type StoredTask = {
  id: string;
  capabilityId: string;
  status: string;
  input?: Record<string, unknown>;
  outputs?: string[];
  error?: string;
  refreshError?: string;
  requiredEnvironment?: string;
  createdAt?: string;
  updatedAt?: string;
  adapter?: { remoteJobId?: string; remoteStatus?: string };
};
export type SpriteJob = {
  job_id: string;
  status: string;
  updated_at: string;
  character_name?: string;
  character_id?: string;
  action_name?: string;
  action_id?: string;
};

export const workStateLabels: Record<WorkItemState, string> = {
  saved: '已保存，可继续',
  editing: '正在编辑',
  not_submitted: '尚未提交制作',
  running: '正在生成',
  attention: '需要处理',
  completed: '已完成',
};

export function spriteState(
  status: string,
): Pick<WorkItem, 'state' | 'detail' | 'stage'> {
  if (status === 'exported')
    return { state: 'completed', detail: '动作素材已导出', stage: 2 };
  if (status === 'approved')
    return { state: 'saved', detail: '已检查通过，可以导出', stage: 2 };
  if (status === 'created')
    return { state: 'saved', detail: '作业已保存，等待生成', stage: 0 };
  if (status === 'review_required')
    return { state: 'attention', detail: '生成结束，等待播放检查', stage: 2 };
  if (['failed', 'attention_required', 'invalid'].includes(status))
    return {
      state: 'attention',
      detail: '任务需要处理，请进入工具查看',
      stage: 1,
    };
  if (['submitting', 'provider_pending', 'saving'].includes(status))
    return { state: 'running', detail: '正在处理动作帧', stage: 1 };
  return { state: 'attention', detail: '需要进入工具确认当前状态', stage: 1 };
}

export function spriteWorkItem(job: SpriteJob, href: string): WorkItem {
  return {
    id: `sprite:${job.job_id}`,
    capabilityId: 'sprite-generator',
    title: `${job.character_name || job.character_id || '角色'} · ${job.action_name || job.action_id || '动作'}`,
    updatedAt: job.updated_at,
    savedAt: job.updated_at,
    href: `${href}?job=${encodeURIComponent(job.job_id)}`,
    ...spriteState(job.status),
  };
}

export function interactableItemId(projectId: string, objectId: string) {
  return `interactable:${projectId}:${objectId}`;
}

/** Group execution attempts only when a durable asset identity is known. */
export function taskWorkItems(
  tasks: StoredTask[],
  modules: readonly WorkbenchModule[],
): WorkItem[] {
  const grouped = new Map<string, WorkItem>();
  for (const task of [...tasks].sort((a, b) =>
    (a.updatedAt || '').localeCompare(b.updatedAt || ''),
  )) {
    const capabilityModule = modules.find((m) => m.id === task.capabilityId);
    if (!capabilityModule) continue;
    const input = task.input || {};
    const jobId =
      task.capabilityId === 'sprite-generator'
        ? task.adapter?.remoteJobId ||
          (typeof input.jobId === 'string' ? input.jobId : undefined)
        : undefined;
    const project = input.project as
      | {
          projectId?: string;
          name?: string;
          objects?: { definitionId: string; displayName?: string }[];
        }
      | undefined;
    const definitions = Array.isArray(project?.objects)
      ? project.objects.filter((o) => o && typeof o.definitionId === 'string')
      : [];
    const targets =
      task.capabilityId === 'reference-art'
        ? [
            {
              id: `task:${task.id}`,
              title:
                typeof input.name === 'string'
                  ? input.name
                  : input.operation === 'transfer'
                    ? '原图已移送序列帧'
                    : input.subject === 'prop' ? '物品原图' : '角色原图',
              href: input.subject === 'prop'
                ? `${modules.find((m) => m.id === 'interactable-editor')?.href || capabilityModule.href}?artTask=${encodeURIComponent(task.id)}`
                : `${capabilityModule.href}?task=${encodeURIComponent(typeof input.sourceTaskId === 'string' ? input.sourceTaskId : task.id)}`,
            },
          ]
        : task.capabilityId === 'interactable-editor' &&
            project?.projectId &&
            definitions.length
          ? // Agent exports can exist without a browser draft. A matching local draft
            // supplies its editable URL when mergeWorkItems combines these records.
            definitions.map((o) => ({
              id: interactableItemId(project.projectId!, o.definitionId),
              title: o.displayName || project.name || '交互物',
              href: `${capabilityModule.href}?task=${encodeURIComponent(task.id)}&object=${encodeURIComponent(o.definitionId)}`,
            }))
          : [
              {
                id: jobId ? `sprite:${jobId}` : `task:${task.id}`,
                title: jobId
                  ? `角色动画 · ${jobId}`
                  : `${capabilityModule.entryTitle} · ${operationLabel(input.operation)}`,
                href: jobId
                  ? `${capabilityModule.href}?job=${encodeURIComponent(jobId)}`
                  : `/advanced?tab=records&task=${encodeURIComponent(task.id)}`,
              },
            ];
    const state: WorkItemState =
      task.status === 'completed'
        ? input.operation === 'save-project' ? 'saved' : 'completed'
        : task.status === 'running'
          ? 'running'
          : 'attention';
    for (const target of targets) {
      const previous = grouped.get(target.id);
      grouped.set(target.id, {
        ...target,
        capabilityId: task.capabilityId === 'reference-art' && input.subject === 'prop' ? 'interactable-editor' : capabilityModule.id,
        state,
        detail:
          (input.operation === 'save-project' && task.status === 'completed' ? '交互物已保存，可继续编辑；尚未导出' : '') ||
          task.error ||
          task.refreshError ||
          (task.status === 'awaiting_configuration'
            ? '等待服务配置'
            : task.status === 'prepared'
              ? '输入已准备，尚未执行'
              : workStateLabels[state]),
        updatedAt: task.updatedAt || task.createdAt || '',
        stage: state === 'completed' ? capabilityModule.stages.length - 1 : 0,
        ...(jobId && task.adapter?.remoteStatus
          ? spriteState(task.adapter.remoteStatus)
          : {}),
        taskIds: [...new Set([...(previous?.taskIds || []), task.id])],
        outputs: [
          ...new Set([...(previous?.outputs || []), ...(task.outputs || [])]),
        ],
      });
    }
  }
  return [...grouped.values()];
}

export function mergeWorkItems(...sources: WorkItem[][]): WorkItem[] {
  const grouped = new Map<string, WorkItem>();
  for (const items of sources)
    for (const item of items) {
      const previous = grouped.get(item.id);
      const current =
        !previous || item.updatedAt >= previous.updatedAt ? item : previous;
      grouped.set(item.id, {
        ...previous,
        ...item,
        ...current,
        // Native editable sources and their names take precedence over generic task labels.
        ...(previous?.draftKey
          ? {
              draftKey: previous.draftKey,
              href: previous.href,
              title: previous.title,
              savedAt: previous.savedAt,
            }
          : {}),
        taskIds: [
          ...new Set([...(previous?.taskIds || []), ...(item.taskIds || [])]),
        ],
        outputs: [
          ...new Set([...(previous?.outputs || []), ...(item.outputs || [])]),
        ],
      });
    }
  return [...grouped.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}
