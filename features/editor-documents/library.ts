import { listDocuments, type DocumentKind, type SharedDocumentPage, type SharedDocumentSummary } from './client';

export async function readSharedDocumentLibrary(kind: DocumentKind, signal: AbortSignal, read = listDocuments) {
  const documents = new Map<string, SharedDocumentSummary>();
  const issues: NonNullable<SharedDocumentPage['issues']> = [];
  let offset = 0;
  while (true) {
    signal.throwIfAborted();
    const page = await read(kind, offset, signal);
    signal.throwIfAborted();
    if (!Array.isArray(page.documents)) throw new Error('共享工程列表格式无效，请刷新重试。');
    for (const document of page.documents) {
      if (document.kind !== kind || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(document.id) || typeof document.name !== 'string' || !Number.isSafeInteger(document.revision) || document.revision < 1) throw new Error('共享工程摘要不完整，请刷新重试。');
      const previous = documents.get(document.id);
      if (!previous || document.revision >= previous.revision) documents.set(document.id, document);
    }
    if (page.issues) issues.push(...page.issues);
    if (page.nextOffset === undefined || page.nextOffset === null) break;
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('共享工程分页没有推进，请刷新重试。');
    offset = page.nextOffset;
  }
  return { documents: [...documents.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.id.localeCompare(b.id)), issues };
}

export function sharedDocumentPage(documents: SharedDocumentSummary[], search: string, page = 0, pageSize = 12) {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matching = documents.filter(document => terms.every(term => `${document.name} ${document.id}`.toLocaleLowerCase().includes(term)));
  const pages = Math.max(1, Math.ceil(matching.length / pageSize));
  const currentPage = Math.max(0, Math.min(page, pages - 1));
  return { documents: matching.slice(currentPage * pageSize, (currentPage + 1) * pageSize), total: matching.length, page: currentPage, pages };
}

export function sharedDocumentHref(pathname: string, documentId: string) {
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(pathname) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(documentId)) throw new Error('共享工程地址无效。');
  return `${pathname}?${new URLSearchParams({ document: documentId })}`;
}
