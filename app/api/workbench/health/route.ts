import { bridgeProtocolVersion } from '@/lib/workbench/service-endpoints.mjs';
declare const __FORGE_WORKSPACE_ID__: string;
import { trustedRequest } from '@/lib/workbench/request-security.mjs';

export function GET(request: Request) {
  const denied = trustedRequest(request);
  if (denied) return denied;
  return Response.json({
    ok: true,
    service: '2d-game-workbench-web',
    version: bridgeProtocolVersion,
    workspaceId: typeof __FORGE_WORKSPACE_ID__ === 'string' ? __FORGE_WORKSPACE_ID__ : undefined,
  });
}
