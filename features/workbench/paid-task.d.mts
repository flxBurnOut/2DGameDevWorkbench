import type { RequestJournal } from '@/features/editor-documents/request-journal.mjs';

export type TaskPayload = { capabilityId: string; input: Record<string, unknown> };
export type TaskReceipt = { taskId: string; commandId: string; status: string; outputs: string[]; error?: string;
  adapter?: Record<string, unknown>; refreshError?: string; executionPhase?: string; replayed?: boolean };
export function isPaidTask(capabilityId: string, operation: unknown): boolean;
export function submitPaidTask(journal: RequestJournal, payload: TaskPayload, options?: { commandId?: string; request?: typeof fetch; resume?: false }): Promise<TaskReceipt>;
export function submitPaidTask(journal: RequestJournal, payload: undefined, options: { request?: typeof fetch; resume: true }): Promise<TaskReceipt | null>;
