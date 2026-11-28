import { forwardDocumentHttp } from '@/lib/workbench/document-proxy';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forwardDocumentHttp(request, `/${encodeURIComponent(id)}`);
}
