export async function documentFingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

// CAS, an immutable retry identity and a local baseline keep remote edits from replacing drafts.
export class DocumentSyncController {
  constructor(options) {
    this.options = options;
    this.listeners = new Set();
    this.state = { status: 'connecting', message: '正在连接共享工程', revision: null, conflict: false };
    this.cache = null;
    this.pending = null;
    this.disposed = false;
    this.initialized = false;
  }
  getState = () => this.state;
  subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  update(value) {
    if (this.disposed) return;
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
  async whenIdle() {
    while (this.saving) await new Promise(resolve => { (this.idleWaiters ||= []).push(resolve); });
  }
  finishOperation() {
    this.saving = false;
    for (const resolve of this.idleWaiters || []) resolve();
    this.idleWaiters = [];
  }
  async prepared() {
    const snapshot = this.options.current();
    const content = await this.options.prepare(snapshot);
    return { snapshot, content, fingerprint: await documentFingerprint(content) };
  }
  async isCurrent(local) {
    if (this.options.current() === local.snapshot) return true;
    const latest = await this.prepared();
    return this.options.current() === latest.snapshot && latest.fingerprint === local.fingerprint;
  }
  async remember(revision, fingerprint, pending) {
    const cache = { revision, fingerprint, ...(pending ? { pending } : {}) };
    await this.options.writeCache(cache);
    this.cache = cache;
  }
  async reconcile() {
    if (this.disposed) return;
    const local = await this.prepared();
    let remote;
    try { remote = (await this.options.api.read(this.options.id)).document; }
    catch (error) {
      if (error.status !== 404) throw error;
      this.initialized = true;
      this.update({ status: 'pending', message: '本机已保存，等待创建共享工程', revision: null, conflict: false });
      return;
    }
    if (remote.id !== this.options.id || remote.kind !== this.options.kind) throw new Error('共享工程身份或类型不匹配。');
    const fingerprint = await documentFingerprint(await this.options.prepare(remote.content));
    if (this.disposed) return;
    if (this.options.busy()) {
      this.update({ status: 'pending', message: '编辑器正在处理内容，稍后继续共享同步', conflict: false });
      return;
    }
    const uncertain = this.cache?.pending;
    if (uncertain && uncertain.fingerprint !== local.fingerprint && fingerprint === this.cache?.fingerprint) {
      this.update({ status: 'conflict', message: '上次同步结果尚未确认，当前本机修改已保留', revision: remote.revision, conflict: true });
    } else if (fingerprint === local.fingerprint) {
      await this.remember(remote.revision, fingerprint);
      this.pending = null;
      this.update({ status: 'synced', message: `共享工程已同步 · 版本 ${remote.revision}`, revision: remote.revision, conflict: false });
    } else if (fingerprint === this.cache?.fingerprint || fingerprint === this.cache?.pending?.fingerprint) {
      // The server still has our baseline, or confirms an ambiguously returned save.
      const retry = fingerprint === this.cache?.fingerprint && uncertain?.fingerprint === local.fingerprint ? uncertain : undefined;
      await this.remember(remote.revision, fingerprint, retry);
      if (!retry) this.pending = null;
      this.update({ status: 'pending', message: '本机修改等待同步', revision: remote.revision, conflict: false });
    } else if (local.fingerprint === this.cache?.fingerprint && await this.isCurrent(local) && !this.options.busy()) {
      await this.options.applyRemote(remote.content, { reason: 'remote', document: remote });
      await this.remember(remote.revision, fingerprint);
      this.pending = null;
      this.update({ status: 'synced', message: `已读取共享修改 · 版本 ${remote.revision}`, revision: remote.revision, conflict: false });
    } else {
      this.update({ status: 'conflict', message: `共享工程有新版本 ${remote.revision}；本机修改已保留`, revision: remote.revision, conflict: true });
    }
    this.initialized = true;
  }
  async initialize() {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      this.cache = await this.options.readCache() || null;
      const original = await this.options.journal?.pending();
      if (original) {
        const { operation, input } = original.request;
        const expectedRevision = operation === 'create' ? 0 : input.expectedRevision;
        if (!['save', 'create'].includes(operation) || input.documentId !== this.options.id ||
            input.kind !== this.options.kind || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !input.content)
          throw new Error('原共享保存记录与当前工程不匹配，请保留记录后恢复。');
        this.pending = { commandId: input.commandId, expectedRevision, content: input.content,
          fingerprint: await documentFingerprint(await this.options.prepare(input.content)) };
        this.initialized = true;
        this.update({ status: 'pending', message: '已恢复原共享保存请求，正在核对结果', conflict: false });
        return;
      }
      await this.reconcile();
    })();
    try { await this.initializing; } finally { this.initializing = null; }
  }
  async sync() {
    if (this.disposed || this.options.busy() || this.saving) return;
    this.saving = true;
    let submittedRequest, awaitingResponse = false;
    try {
      await this.initialize();
      if (this.disposed || this.state.conflict) return;
      while (!this.disposed && !this.options.busy()) {
        const local = await this.prepared();
        if (!this.pending && local.fingerprint === this.cache?.fingerprint) return;
        await this.options.saveLocal(local.snapshot);
        if (this.disposed || this.options.busy()) return;
        let pending = this.pending;
        if (!pending) {
          const cached = this.cache?.pending;
          pending = {
            commandId: cached?.fingerprint === local.fingerprint ? cached.commandId : crypto.randomUUID(),
            expectedRevision: cached?.fingerprint === local.fingerprint ? cached.expectedRevision : this.cache?.revision ?? 0,
            fingerprint: local.fingerprint, content: local.content,
          };
          this.pending = pending;
          await this.remember(this.cache?.revision ?? null, this.cache?.fingerprint ?? null, {
            commandId: pending.commandId, expectedRevision: pending.expectedRevision, fingerprint: pending.fingerprint,
          });
        }
        if (this.disposed || this.options.busy()) return;
        const request = { operation: pending.expectedRevision ? 'save' : 'create', input: {
          documentId: this.options.id, kind: this.options.kind, commandId: pending.commandId,
          expectedRevision: pending.expectedRevision, content: pending.content,
        } };
        await this.options.journal?.begin(request);
        submittedRequest = request;
        this.update({ status: 'saving', message: '正在同步共享工程', conflict: false });
        awaitingResponse = true;
        const result = pending.expectedRevision
          ? await this.options.api.save(this.options.id, pending.expectedRevision, pending.content, pending.commandId)
          : await this.options.api.create(this.options.kind, pending.content, pending.commandId);
        awaitingResponse = false;
        if (result.document.id !== this.options.id || result.document.kind !== this.options.kind)
          throw new Error('共享工程保存响应身份不匹配。');
        await this.options.journal?.respond(request, result);
        if (this.disposed) return;
        await this.remember(result.document.revision, pending.fingerprint);
        await this.options.journal?.complete(request);
        this.pending = null;
        this.update({ status: 'synced', message: `共享工程已同步 · 版本 ${result.document.revision}`, revision: result.document.revision, conflict: false });
        if (pending.fingerprint === local.fingerprint && await this.isCurrent(local)) return;
      }
    } catch (error) {
      if (awaitingResponse && submittedRequest && error.status >= 400 && error.status < 500 && error.status !== 408) {
        try { await this.options.journal?.complete(submittedRequest, 'rejected'); }
        catch (storageError) {
          this.update({ status: 'offline', message: `原保存请求的拒绝回执未记录，请恢复同一请求：${storageError.message}`, conflict: false });
          return;
        }
        this.pending = null;
      }
      if (error.status === 409) {
        // A rejected CAS was never committed. Re-read the server and compare
        // with the saved baseline before issuing a new submission.
        this.pending = null;
        try { await this.remember(this.cache?.revision ?? null, this.cache?.fingerprint ?? null); }
        catch (storageError) {
          this.update({ status: 'offline', message: `共享冲突已保留，本机恢复记录写入失败：${storageError.message}`, conflict: false });
          return;
        }
        this.update({ status: 'conflict', message: '共享工程已被其他编辑修改；本机草稿已保留', conflict: true });
      } else {
        this.update({ status: 'offline', message: `共享工程未同步，本机草稿保留：${error.message}`, conflict: false });
      }
    } finally { this.finishOperation(); }
  }
  async retry() {
    if (this.saving || this.disposed || this.options.busy()) return;
    try {
      // Retry an uncertain submission with the exact command ID and content.
      if (!this.pending) {
        this.saving = true;
        try { await this.reconcile(); } finally { this.finishOperation(); }
      }
      await this.sync();
    } catch (error) { this.update({ status: 'offline', message: `连接未恢复：${error.message}` }); }
  }
  async poll() {
    if (this.disposed || this.saving || this.options.busy() || !this.initialized || this.state.status === 'offline' || this.state.conflict) return;
    this.saving = true;
    let completed = false;
    try {
      const remote = (await this.options.api.metadata(this.options.id)).document;
      if (this.disposed || this.options.busy()) return;
      if (remote.revision !== this.cache?.revision) await this.reconcile();
      completed = true;
    } catch (error) {
      if (error.status !== 404) this.update({ status: 'offline', message: `共享连接中断，本机草稿保留：${error.message}` });
    } finally { this.finishOperation(); }
    // A local autosave may have been deferred while metadata was in flight.
    if (completed && !this.state.conflict && this.state.status !== 'offline') await this.sync();
  }
  async reloadRemote() {
    if (this.disposed || this.saving || this.options.busy()) return;
    this.saving = true;
    try {
      const local = await this.prepared();
      const remote = (await this.options.api.read(this.options.id)).document;
      if (remote.id !== this.options.id || remote.kind !== this.options.kind) throw new Error('共享工程身份或类型不匹配。');
      if (this.disposed) return;
      if (!await this.isCurrent(local)) throw new Error('读取期间本机工程已变化，请再次读取。');
      const backup = await this.options.backupLocal(this.options.current());
      if (this.disposed) return;
      if (!await this.isCurrent(local)) throw new Error('备份期间本机工程已变化，已保留本机内容。');
      if (this.options.busy()) throw new Error('编辑器正在处理内容，本机备份已保留，请稍后读取共享版本。');
      await this.options.applyRemote(remote.content, { reason: 'reload', document: remote });
      const fingerprint = await documentFingerprint(await this.options.prepare(remote.content));
      await this.remember(remote.revision, fingerprint);
      this.pending = null; this.initialized = true;
      this.update({ status: 'synced', message: `已读取共享版本 ${remote.revision}；本机备份：${backup}`, revision: remote.revision, conflict: false });
    } catch (error) { this.update({ status: 'conflict', message: error.message, conflict: true }); }
    finally { this.finishOperation(); }
  }
  async flushSaved() {
    while (!this.disposed) {
      await this.whenIdle();
      if (this.disposed) break;
      if (this.options.busy()) throw new Error('编辑器正在处理内容，请完成后再打开图片调整。');
      await this.sync();
      await this.whenIdle();
      if (this.state.conflict || this.state.status === 'offline') throw new Error(this.state.message);
      const local = await this.prepared();
      if (local.fingerprint !== this.cache?.fingerprint) continue;
      const remote = (await this.options.api.read(this.options.id)).document;
      if (this.disposed) break;
      if (remote.id !== this.options.id || remote.kind !== this.options.kind) throw new Error('共享工程身份或类型不匹配。');
      if (remote.revision !== this.cache?.revision) {
        await this.poll();
        if (this.state.conflict || this.state.status === 'offline') throw new Error(this.state.message);
        continue;
      }
      const current = await this.prepared();
      if (current.fingerprint !== local.fingerprint) continue;
      if (remote.revision !== this.cache?.revision) continue;
      if (this.options.busy()) throw new Error('编辑器正在处理内容，请完成后再打开图片调整。');
      return { document: remote, fingerprint: local.fingerprint };
    }
    throw new Error('共享工程已切换，请重新打开图片调整。');
  }
  async acceptAdopted(remote, guard) {
    await this.whenIdle();
    if (this.disposed) throw new Error('共享工程已切换，已采用候选仍保留在服务端。');
    this.saving = true;
    try {
      const local = await this.prepared();
      if (remote.id !== this.options.id || remote.kind !== this.options.kind || !Number.isSafeInteger(remote.revision) || remote.revision < guard.document.revision)
        throw new Error('已采用候选的共享版本或身份不匹配。');
      if (this.cache?.revision !== guard.document.revision || local.fingerprint !== guard.fingerprint)
        throw new Error('本机工程在候选制作期间已变化；已采用结果保留在服务端，本机草稿未替换。');
      const head = (await this.options.api.metadata(this.options.id)).document;
      if (head.revision !== remote.revision) throw new Error('采用后共享工程已有更新，请保留本机草稿并读取最新版本。');
      if (!await this.isCurrent(local)) throw new Error('读取采用结果期间本机工程已变化，已保留本机内容。');
      if (remote.revision === guard.document.revision) {
        if (await documentFingerprint(await this.options.prepare(remote.content)) !== local.fingerprint)
          throw new Error('重复采用响应与当前本机版本内容不匹配。');
        this.update({ status: 'synced', message: `候选已采用 · 共享版本 ${remote.revision}`, revision: remote.revision, conflict: false });
        return guard;
      }
      await this.options.applyRemote(remote.content, { reason: 'adopt', document: remote });
      const fingerprint = await documentFingerprint(await this.options.prepare(remote.content));
      await this.remember(remote.revision, fingerprint);
      this.pending = null;
      this.initialized = true;
      this.update({ status: 'synced', message: `候选已采用 · 共享版本 ${remote.revision}`, revision: remote.revision, conflict: false });
      return { document: remote, fingerprint };
    } catch (error) {
      // Once the server adopted a candidate, never autosave the old local image over it.
      this.update({ status: 'conflict', message: error.message, conflict: true });
      throw error;
    } finally { this.finishOperation(); }
  }
}
