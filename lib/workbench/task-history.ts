import type { StoredTask } from './work-items';

type TaskPage = {
  tasks?: StoredTask[];
  nextOffset?: number | null;
  snapshot?: string;
  revision?: string;
  unchanged?: boolean;
};
export type TaskHistory = { tasks: StoredTask[]; revision: string };

// Read the complete history into the existing work-item search/filter UI.
// Refresh running jobs on the first page, then follow one stable snapshot.
export async function readTaskHistory(request: (url: string) => Promise<TaskPage>) {
  return (await readTaskHistoryRevision(request)).tasks;
}

// With `previous`, an unchanged history returns without resending records.
export async function readTaskHistoryRevision(
  request: (url: string) => Promise<TaskPage>,
  previous?: TaskHistory,
): Promise<TaskHistory> {
  const tasks: StoredTask[] = [];
  let offset = 0;
  let snapshot = '';
  let revision = '';
  while (true) {
    const query = new URLSearchParams({ limit: '200', offset: String(offset), refresh: String(offset === 0) });
    if (snapshot) query.set('snapshot', snapshot);
    if (!offset && previous?.revision) query.set('since', previous.revision);
    const page = await request(`/api/workbench/tasks?${query}`);
    if (!offset && page.unchanged && previous && page.revision === previous.revision) return previous;
    if (!Array.isArray(page.tasks)) throw new Error('任务响应无效');
    if (offset && page.snapshot !== snapshot) throw new Error('制作历史已变化，请刷新后重试');
    if (!offset) revision = page.revision || '';
    tasks.push(...page.tasks);
    if (page.nextOffset == null) {
      // Older bridges have no pagination contract. Do not silently claim completeness at their cap.
      if (page.nextOffset === undefined && page.tasks.length >= 200) throw new Error('请重启本地运行服务以读取完整制作历史');
      return { tasks, revision };
    }
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || !page.snapshot) throw new Error('制作历史分页无效');
    offset = page.nextOffset;
    snapshot = page.snapshot;
  }
}
