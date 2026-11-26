import { fetchWorkbenchRuntime, runtimeUnavailable } from '@/lib/workbench/runtime-proxy';
import { trustedRequest } from '@/lib/workbench/request-security.mjs';
import { paidWorkspacePath, readPaidBridgeIdentity } from '@/lib/workbench/service-endpoints.mjs';

async function paidTask(request: Request) {
  const post = request.method === 'POST';
  const denied = trustedRequest(request, { json: post });
  if (denied) return denied;
  const commandId = new URL(request.url).searchParams.get('commandId');
  try {
    if (!post && commandId === null) {
      const response = await fetchWorkbenchRuntime(paidWorkspacePath, { redirect: 'manual' });
      if (!response.ok) return response;
      const identity = await readPaidBridgeIdentity(response);
      if (!identity) return Response.json({ error: '无法验证 Bridge 的付费数据目录身份。' }, { status: 409 });
      return Response.json({ workspaceId: identity.paidWorkspaceId }, { headers: { 'cache-control': 'no-store' } });
    }
    const workspaceId = request.headers.get('x-forge-workspace');
    if (!workspaceId || !/^[a-f0-9]{64}$/.test(workspaceId))
      return Response.json({ error: '付费请求缺少原工作区身份。' }, { status: 409 });
    const route = post ? '/v1/tasks' : '/v1/tasks?' + new URLSearchParams({ commandId: commandId!, refresh: 'true' });
    return await fetchWorkbenchRuntime(route, post ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: request.body, duplex: 'half',
    } as RequestInit : {}, workspaceId);
  } catch (error) {
    return runtimeUnavailable(error);
  }
}

export const GET = paidTask;
export const POST = paidTask;
