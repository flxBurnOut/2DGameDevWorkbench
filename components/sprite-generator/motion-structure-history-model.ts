export type StructureHistoryEntry = { revision: number; note: string; origin?: string; created_at?: string };
export type StructureSnapshot = { id: string; revision: number; source_current: boolean; document: { revision: number; token: string } | null };
export type StructureRestoreRequest = { expected_revision: number; token: string; request_key: string; restore_revision: number; note: string };

export function structureRestoreRequest(current: StructureSnapshot & { history: StructureHistoryEntry[] }, historical: StructureSnapshot, requestKey: string): StructureRestoreRequest {
  if (!current.source_current || !historical.source_current) throw new Error('源图片或参考结构已改变，不能恢复历史。');
  if (current.id !== historical.id || current.revision !== historical.revision || !current.document || current.document.revision !== current.revision)
    throw new Error('当前结构版本已改变，请刷新后再恢复。');
  const target = historical.document?.revision;
  if (!target || target >= current.revision || !current.history.some((entry) => entry.revision === target)) throw new Error('请选择当前结构已有的历史版本。');
  return { expected_revision: current.revision, token: current.document.token, request_key: requestKey, restore_revision: target, note: `恢复结构版本 ${target} 的内容，保留所有历史` };
}
