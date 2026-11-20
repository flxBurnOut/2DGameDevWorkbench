// Also imported by the Web worker. Keep this module independent of Node APIs.
export const bridgeProtocolVersion = 1;

export function bridgeBaseUrl() {
  return process.env.WORKBENCH_RUNTIME_URL?.trim() || `http://127.0.0.1:${process.env.WORKBENCH_RUNTIME_PORT || 8790}`;
}

export function endpointUrl(baseUrl, pathname) {
  const normalized = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('Adapter endpoint is empty.');
  return `${normalized}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

// A local URI with a path prefix may be a reverse proxy for another installation.
export function expectedBridgeWorkspace(baseUrl, localId) {
  const url = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && /^\/+$/.test(url.pathname);
  return process.env.WORKBENCH_RUNTIME_WORKSPACE_ID?.trim() || (local ? localId : undefined);
}

export const pairedBridgePrefix = '/paired/v' + bridgeProtocolVersion;
export const paidBridgePrefix = '/paid/v1';
export const paidWorkspacePath = '/v1/paid-workspace';
let verifiedBridge;

export async function readPaidBridgeIdentity(response) {
  const identity = response.ok ? await response.json().catch(() => null) : null;
  const validId = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
  return identity?.service === '2d-game-workbench-runtime' && identity.version === bridgeProtocolVersion &&
    validId(identity.workspaceId) && validId(identity.paidWorkspaceId) && identity.paidWorkspaceId !== identity.workspaceId
    ? identity : null;
}

/** @param {string} [pinnedWorkspace] */
export async function fetchBridge(pathname, init, localId, pinnedWorkspace) {
  const base = bridgeBaseUrl();
  let expected = expectedBridgeWorkspace(base, localId);
  const headers = new Headers(init?.headers);
  let prefix = pairedBridgePrefix;
  if (pinnedWorkspace) {
    // Probe without a command ID or body before forwarding anything from the journal.
    const probe = await fetchBridge(paidWorkspacePath, { cache: 'no-store', redirect: 'manual', signal: init?.signal }, localId);
    if (probe.status === 503) return probe;
    const identity = await readPaidBridgeIdentity(probe);
    const legacyRead = identity && pinnedWorkspace === identity.workspaceId && (init?.method || 'GET') === 'GET';
    if (!identity || (expected && expected !== identity.workspaceId) || (pinnedWorkspace !== identity.paidWorkspaceId && !legacyRead))
      return Response.json({ code: 'WORKSPACE_MISMATCH', error: '原任务属于另一份工作区或数据目录。请切回原工作区恢复。' }, { status: 409 });
    expected = identity.workspaceId;
    headers.set('x-forge-paid-workspace', identity.paidWorkspaceId);
    prefix += paidBridgePrefix;
  }
  if (!expected) return fetch(endpointUrl(base, pathname), init);
  const identity = JSON.stringify([base, expected]);
  if (verifiedBridge !== identity) {
    const response = await fetch(endpointUrl(base, '/health'), {
      cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    const health = response.ok ? await response.json().catch(() => null) : null;
    if (health?.service !== '2d-game-workbench-runtime' || health.version !== bridgeProtocolVersion || health.workspaceId !== expected)
      return Response.json({ code: 'WORKSPACE_MISMATCH', error: 'Bridge 的工作区或协议不匹配。请核对服务地址与版本。' }, { status: 409 });
    verifiedBridge = identity;
  }
  headers.set('x-forge-workspace', expected);
  // A listener can be replaced after the probe. Older bridges have no route under this prefix.
  const response = await fetch(endpointUrl(base, prefix + pathname), { ...init, headers, redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(response.status))
    return Response.json({ code: 'BRIDGE_REDIRECT', error: '已配对的 Bridge 返回了重定向。请核对连接地址。' }, { status: 502 });
  if (pinnedWorkspace && response.headers.get('x-forge-paid-workspace') !== headers.get('x-forge-paid-workspace'))
    return Response.json({ code: 'WORKSPACE_MISMATCH', error: '无法验证处理本次请求的付费数据目录。请切回原工作区恢复。' },
      { status: response.status === 503 ? 503 : 409 });
  return response;
}
