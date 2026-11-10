const clone = value => structuredClone(value);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fail = message => { throw new Error(message); };

export function journalRequestIdentity(request) {
  if (!request || typeof request.operation !== 'string' || !request.operation || !request.input ||
      typeof request.input.commandId !== 'string' || !request.input.commandId)
    fail('恢复请求缺少操作或原命令身份。');
  return canonical(request);
}

// The store's update must be one atomic read/modify/write transaction. Keeping
// the original body and response lets another tab recover without inventing IDs.
export class RequestJournal {
  constructor({ scope, documentId, store, now = () => new Date().toISOString() }) {
    this.scope = scope;
    this.documentId = documentId;
    this.store = store;
    this.now = now;
    this.key = `request-journal:v1:${scope}:${documentId}`;
  }
  validate(value) {
    if (!value) return { version: 1, scope: this.scope, documentId: this.documentId, pending: null, history: [] };
    if (value.version !== 1 || value.scope !== this.scope || value.documentId !== this.documentId || !Array.isArray(value.history))
      fail('原请求记录损坏或不属于当前场景，请保留记录后恢复。');
    if (value.pending) journalRequestIdentity(value.pending.request);
    return value;
  }
  async pending() { return clone(this.validate(await this.store.read(this.key)).pending); }
  async begin(request) {
    const identity = journalRequestIdentity(request), original = clone(request);
    const value = await this.store.update(this.key, previous => {
      const journal = this.validate(previous);
      if (journal.pending) {
        if (journalRequestIdentity(journal.pending.request) !== identity)
          fail('还有待确认的原请求，请先恢复该请求；新操作未发送。');
        return journal;
      }
      const replay = journal.history.find(entry => entry.request.input.commandId === original.input.commandId);
      if (replay && journalRequestIdentity(replay.request) !== identity) fail('不能将原命令身份用于不同的请求。');
      return { ...journal, pending: replay ? { ...replay, completedAt: undefined } : {
        request: original, state: 'pending', createdAt: this.now(), updatedAt: this.now(),
      } };
    });
    return clone(value.pending);
  }
  async respond(request, response) {
    const identity = journalRequestIdentity(request), receipt = clone(response);
    const value = await this.store.update(this.key, previous => {
      const journal = this.validate(previous);
      if (!journal.pending || journalRequestIdentity(journal.pending.request) !== identity)
        fail('原请求记录已变化，响应未覆盖另一项操作。');
      return { ...journal, pending: { ...journal.pending, state: 'responded', response: receipt, updatedAt: this.now() } };
    });
    return clone(value.pending);
  }
  async complete(request, outcome = 'completed') {
    const identity = journalRequestIdentity(request);
    await this.store.update(this.key, previous => {
      const journal = this.validate(previous);
      if (!journal.pending) {
        if (journal.history.some(entry => journalRequestIdentity(entry.request) === identity)) return journal;
        fail('找不到待确认的原请求，未清除其他记录。');
      }
      if (journalRequestIdentity(journal.pending.request) !== identity) fail('原请求记录已变化，未清除其他操作。');
      const entry = { ...journal.pending, outcome, completedAt: this.now() };
      return { ...journal, pending: null, history: [...journal.history.filter(item => item.request.input.commandId !== request.input.commandId), entry].slice(-40) };
    });
  }
}
