import { createProject } from './contract.mjs';
import type { WorkItem } from '@/lib/workbench/work-items';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function content(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { projectId: _id, objects, ...rest } = value as Record<string, unknown>;
  return {
    ...rest,
    objects: Array.isArray(objects)
      ? objects.map((object) => {
          if (!object || typeof object !== 'object') return object;
          const { definitionId: _objectId, ...fields } = object;
          return fields;
        })
      : objects,
  };
}

// Ignore only generated identities. Names, behavior, geometry and assets all count as content.
// Workers reject crypto.randomUUID during module evaluation. Initialize the
// identity-free comparison baseline when called within a request or browser.
let starter: string | undefined;
export const isUntouchedStarterProject = (project: unknown) => {
  starter ??= canonical(content(createProject()));
  return canonical(content(project)) === starter;
};

export function isLegacyEmptyWorkItem(item: WorkItem, draft: unknown): boolean {
  return (
    item.capabilityId === 'interactable-editor' &&
    !item.userInitiated &&
    !item.taskIds?.length &&
    !item.outputs?.length &&
    item.state === 'saved' &&
    isUntouchedStarterProject(draft)
  );
}
