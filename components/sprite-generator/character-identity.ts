import type { StoredTask } from '@/lib/workbench/work-items';

export const referenceIdentityLimit = 300;
export const uploadedIdentityLimit = 1000;

export function referenceIdentityDescription(tasks: StoredTask[], sourceTaskId: string, drafts: Record<string, string>) {
  if (Object.hasOwn(drafts, sourceTaskId)) return drafts[sourceTaskId];
  const saved = tasks.filter((task) => task.capabilityId === 'reference-art' && task.status === 'completed' && task.input?.operation === 'transfer' && task.input.sourceTaskId === sourceTaskId)
    .sort((left, right) => (right.updatedAt || right.createdAt || '').localeCompare(left.updatedAt || left.createdAt || ''))[0];
  return typeof saved?.input?.identityDescription === 'string' ? saved.input.identityDescription : '';
}

export function referenceTransferInput(sourceTaskId: string, identityDescription: string) {
  const identity = identityDescription.trim();
  if (identity.length > referenceIdentityLimit) throw new Error(`角色外观约束最多 ${referenceIdentityLimit} 字符。`);
  return { operation: 'transfer', sourceTaskId, ...(identity ? { identityDescription: identity } : {}) };
}

export function uploadedReferenceIdentity(value: string) {
  const identity = value.trim();
  if (identity.length > uploadedIdentityLimit) throw new Error(`上传角色的外观约束最多 ${uploadedIdentityLimit} 字符。`);
  return identity;
}
