import type { StoredTask } from '../../lib/workbench/work-items';

const task = (id: string, input: Record<string, unknown>, outputs: string[] = []): StoredTask => ({
  id, capabilityId: 'image-assets', status: 'completed', input: { operation: 'generate-background', prompt: `fixture ${id}`, name: id, ...input }, outputs,
});
export const fixtureTasks = [
  task('custom-history', { width: 2560, height: 1440 }),
  task('preset-history', { width: 1024, height: 1536 }),
  task('missing-dimensions', {}),
  task('processed-history', { operation: 'process-image', kind: 'background' }, ['outputs/processed-history/result.json']),
  task('broken-result', {}, ['outputs/broken-result/result.json']),
  task('slow-result', {}, ['outputs/slow-result/result.json']),
];
export function useWorkbench() {
  return { tasks: fixtureTasks, refresh: async () => undefined };
}
