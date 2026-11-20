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
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/';
  return process.env.WORKBENCH_RUNTIME_WORKSPACE_ID?.trim() || (local ? localId : undefined);
}
