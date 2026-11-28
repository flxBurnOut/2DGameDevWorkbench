const endpoint = '/api/workbench/paid-tasks';

export async function requestFingerprint(request) {
  const canonical = JSON.stringify(request, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(key => [key, value[key]])) : value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export { isPaidTask } from '../../lib/workbench/paid-operations.mjs';

async function json(request, url, init = {}) {
  const response = await request(url, { cache: 'no-store', signal: AbortSignal.timeout(600000), ...init });
  return { response, value: await response.json() };
}

export async function readPaidWorkspace(request = fetch) {
  const { response, value } = await json(request, endpoint).catch(() => { throw new Error('暂时无法查询工作区身份。'); });
  if (!response.ok) throw new Error(value?.error || '暂时无法查询工作区身份。');
  if (!/^[a-f0-9]{64}$/.test(value?.workspaceId || '')) throw new Error('暂时无法查询工作区身份。');
  return value.workspaceId;
}

async function lookup(request, commandId, requestSha256, workspaceId) {
  const query = new URLSearchParams({ commandId, refresh: 'true' });
  const { response, value } = await json(request, `${endpoint}?${query}`, { headers: { 'x-forge-workspace': workspaceId } }).catch(() => {
    throw new Error('暂时无法查询原任务。');
  });
  const storeId = response.headers.get('x-forge-paid-workspace');
  const legacyCheckout = storeId && storeId !== workspaceId;
  if (legacyCheckout && (response.status === 404 || value.task?.status === 'prepared'))
    throw new Error('旧请求缺少付费数据目录身份，请在原工作区查询原任务回执。');
  if (response.status === 404 && value.code === 'ENOENT') return null;
  if (!response.ok) throw new Error(value.error || '暂时无法查询原任务。');
  const { task } = value;
  if (!task?.id || task.commandId !== commandId) throw new Error('原任务回执与命令标识不符。');
  if (task.requestSha256 !== requestSha256)
    throw Object.assign(new Error('该命令号已用于不同的任务参数。'), { code: legacyCheckout ? 'RECEIPT_MISMATCH' : 'COMMAND_ID_REUSED' });
  if (task.status === 'prepared') return null;
  return { taskId: task.id, commandId, status: task.status, outputs: task.outputs || [], adapter: task.adapter,
    error: task.error, refreshError: value.refreshError, executionPhase: task.executionPhase, replayed: true };
}

export async function submitPaidTask(journal, payload, { request = fetch, commandId, resume = false } = {}) {
  const pending = await journal.pending();
  if (resume && !pending) return null;
  const original = resume ? pending.request : { operation: 'run-task', input: { ...payload, commandId: commandId ?? crypto.randomUUID() } };
  const originalId = original.input.commandId;
  // The selecting GET never sends task parameters. Both later requests must be
  // rejected by the Bridge itself if the listener changes after this probe.
  let workspaceId = pending?.workspaceId;
  workspaceId ||= await readPaidWorkspace(request);
  const entry = await journal.begin(original, { workspaceId });
  workspaceId = entry.workspaceId ?? workspaceId;
  const { capabilityId, input } = entry.request.input;
  const requestSha256 = await requestFingerprint({ capabilityId, input });
  const findOriginal = async () => {
    try { return await lookup(request, originalId, requestSha256, workspaceId); }
    catch (error) {
      if (entry.workspaceId && error.code === 'COMMAND_ID_REUSED') await journal.complete(entry.request, 'rejected');
      throw error;
    }
  };
  // Reconcile an existing attempt before replaying the exact stored payload.
  let result = pending || !entry.workspaceId || entry.outcome || entry.state === 'responded' ? await findOriginal() : null;
  if (!result && !entry.workspaceId)
    throw new Error('旧请求缺少工作区身份，请在原工作区查询原任务回执。');
  if (!result && (entry.state === 'responded' || entry.outcome))
    throw new Error('已保存原任务回执，当前无法读取对应任务。请保留原命令号并核对工作台记录。');
  if (!result) {
    let response, value;
    try {
      ({ response, value } = await json(request, endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-workspace': workspaceId }, body: JSON.stringify(entry.request.input),
      }));
    } catch {
      throw new Error('暂未收到本次提交的回复。连接恢复后可恢复原请求。');
    }
    if (!response.ok) {
      if (value.taskId && value.code !== 'COMMAND_ID_REUSED') result = await findOriginal();
      if (!result) {
        if ([400, 401, 403, 413, 422].includes(response.status) || value.code === 'COMMAND_ID_REUSED')
          await journal.complete(entry.request, 'rejected');
        throw new Error(value.error || '暂时无法确认原任务。');
      }
    } else {
      if (!value.taskId || value.commandId !== originalId || value.requestSha256 !== requestSha256)
        throw new Error('任务回复与本次命令不符。请恢复原请求。');
      result = value;
    }
  }
  try { await journal.respond(entry.request, result); }
  catch (error) {
    // A concurrent tab may already have completed this exact attempt.
    if (await journal.pending()) throw error;
  }
  await journal.complete(entry.request);
  return result;
}
