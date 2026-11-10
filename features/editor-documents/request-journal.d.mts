export type JournalRequest = { operation: string; input: Record<string, unknown> };
export type JournalEntry = { request: JournalRequest; state: 'pending' | 'responded'; response?: unknown; createdAt: string; updatedAt: string; outcome?: string; completedAt?: string };
export type JournalState = { version: 1; scope: string; documentId: string; pending: JournalEntry | null; history: JournalEntry[] };
export function journalRequestIdentity(request: JournalRequest): string;
export class RequestJournal {
  constructor(options: { scope: string; documentId: string; store: { read(key: string): Promise<JournalState | undefined>; update(key: string, modify: (value: JournalState | undefined) => JournalState): Promise<JournalState> }; now?: () => string });
  pending(): Promise<JournalEntry | null>;
  begin(request: JournalRequest): Promise<JournalEntry>;
  respond(request: JournalRequest, response: unknown): Promise<JournalEntry>;
  complete(request: JournalRequest, outcome?: string): Promise<void>;
}
