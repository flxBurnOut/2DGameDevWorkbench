import manifest from '../../workbench/manifest.json' with { type: 'json' };

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

/** @param {Headers | import('node:http').IncomingHttpHeaders} headers */
function header(headers, name) {
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return typeof value === 'string' ? value : null;
}

function denied() {
  return { status: 403, error: '请求来源不受信任，请从工作台页面执行操作。' };
}

function addAuthority(authorities, url) {
  authorities.add(url.host);
  if (!url.port) authorities.add(`${url.hostname}:${url.protocol === 'https:' ? 443 : 80}`);
}

function trustedAuthority(authority, authorities) {
  try {
    const url = new URL(`http://${authority}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    const port = authority.match(/:(\d+)$/)?.[1];
    return authorities.has(port ? `${url.hostname}:${Number(port)}` : url.hostname);
  } catch {
    return false;
  }
}

/**
 * Explicit origins also cover a configured frontend on another origin. Requests
 * without browser headers remain available to MCP, CLI and server-side proxies.
 * @param {Headers | import('node:http').IncomingHttpHeaders} headers
 * @param {Set<string>} origins
 */
function sourceFailure(headers, origins, requireOrigin = false) {
  const origin = header(headers, 'origin');
  if (origin !== null) return origins.has(origin) ? null : denied();
  if (requireOrigin || header(headers, 'sec-fetch-site') === 'cross-site') return denied();
  return null;
}

/** @param {Headers | import('node:http').IncomingHttpHeaders} headers */
export function jsonRequestFailure(headers) {
  const mime = header(headers, 'content-type')?.split(';')[0].trim().toLowerCase();
  return mime === 'application/json'
    ? null
    : { status: 415, error: 'JSON 请求必须使用 application/json。' };
}

function frontendOrigins(value) {
  const frontend = new URL(value);
  const origins = new Set([frontend.origin]);
  if (loopbackHosts.includes(frontend.hostname)) {
    for (const name of loopbackHosts) origins.add(new URL(`${frontend.protocol}//${name}${frontend.port ? `:${frontend.port}` : ''}`).origin);
  }
  return origins;
}

/** @param {Request} request */
export function trustedRequest(request, { json = false, requireOrigin = false } = {}) {
  const requestOrigin = new URL(request.url).origin;
  const origins = frontendOrigins(configuredFrontendUrl());
  const authorities = new Set();
  for (const origin of origins) addAuthority(authorities, new URL(origin));
  const authority = header(request.headers, 'host');
  const failure = (!origins.has(requestOrigin) || (authority !== null && !trustedAuthority(authority, authorities)) || header(request.headers, 'sec-fetch-site') === 'cross-site' ? denied() : null)
    || sourceFailure(request.headers, new Set([requestOrigin]), requireOrigin)
    || (json ? jsonRequestFailure(request.headers) : null);
  return failure ? Response.json({ error: failure.error }, { status: failure.status }) : null;
}

export function configuredFrontendUrl() {
  return process.env.WORKBENCH_FRONTEND_URL?.trim() || manifest.workspace.frontend.url;
}

/**
 * Trust only the listener's exact authorities and explicitly configured URLs.
 * A wildcard bind address grants no trust to arbitrary Host headers.
 */
export function createRuntimeRequestPolicy({ host, port, runtimeUrl, frontendUrl }) {
  const authorities = new Set();
  const origins = new Set();
  const addUrl = value => {
    if (!value) return;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    addAuthority(authorities, url);
    origins.add(url.origin);
  };
  for (const name of loopbackHosts) addUrl(`http://${name}:${port}`);
  const name = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  if (!['0.0.0.0', '[::]'].includes(name)) addUrl(`http://${name}:${port}`);
  addUrl(runtimeUrl);
  if (frontendUrl) for (const origin of frontendOrigins(frontendUrl)) origins.add(origin);
  return { authorities, origins };
}

/** @param {import('node:http').IncomingMessage} request */
export function runtimeRequestFailure(request, policy) {
  const authority = header(request.headers, 'host');
  if (!authority || !trustedAuthority(authority, policy.authorities)) return denied();
  return safeMethods.has(request.method || '') ? null : sourceFailure(request.headers, policy.origins);
}
