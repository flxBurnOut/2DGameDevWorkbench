import { forwardDocumentHttp } from '@/lib/workbench/document-proxy';
export const GET = (request: Request) => forwardDocumentHttp(request);
export const POST = (request: Request) => forwardDocumentHttp(request);
