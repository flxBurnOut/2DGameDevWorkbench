import { trustedRequest } from '@/lib/workbench/request-security.mjs';

export function GET(request: Request) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  return Response.json({
    ok: true,
    service: '2d-game-workbench-web',
    version: 1,
  });
}
