import { forwardDocumentHttp } from '@/lib/workbench/document-proxy';
export async function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await context.params;
  return forwardDocumentHttp(request, `/${encodeURIComponent(id)}/${encodeURIComponent(action)}`);
}
export async function GET(request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await context.params;
  if (action !== 'motion-bindings') return Response.json({ error: 'Unsupported document route or method.' }, { status: 405 });
  return forwardDocumentHttp(request, `/${encodeURIComponent(id)}/motion-bindings`);
}
