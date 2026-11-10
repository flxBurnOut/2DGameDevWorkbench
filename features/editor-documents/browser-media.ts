import { readWorkspaceDraft, updateWorkspaceDraft } from '@/lib/workbench/browser-store';
import { DocumentMediaCache } from './media-cache.mjs';

export const browserDocumentMedia = new DocumentMediaCache({
  store: {
    read: key => readWorkspaceDraft<Blob>(`document-media:${key}`),
    write: (key, blob) => updateWorkspaceDraft<Blob>(`document-media:${key}`, () => blob),
  },
});
export const documentMediaUrl = (source: string) => browserDocumentMedia.url(source);
