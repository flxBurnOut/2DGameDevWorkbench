import { readWorkspaceDraft, updateWorkspaceDraft } from '@/lib/workbench/browser-store';
import { RequestJournal, type JournalState } from './request-journal.mjs';

export function browserRequestJournal(scope: string, documentId: string) {
  return new RequestJournal({ scope, documentId, store: {
    read: key => readWorkspaceDraft<JournalState>(key),
    update: (key, modify) => updateWorkspaceDraft<JournalState>(key, modify),
  } });
}
