export const previewIdentityKeys: readonly string[];
export function previewSnapshotPath(value: string): string;
export function canonicalView(value: string): string;
export function followDecision(input: { currentPath: string; targetPath: string; following: boolean; busy: boolean; editing: boolean; handled: boolean }): 'paused' | 'displayed' | 'ignore' | 'busy' | 'editing' | 'navigate';
