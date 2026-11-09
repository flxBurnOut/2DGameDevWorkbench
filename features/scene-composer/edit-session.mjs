// One owner coordinates preview, candidate preparation/adoption and shared undo.
// Network mutations remain in DocumentSyncController and keep its CAS/journal.
export class SceneEditSession {
  constructor(options) {
    this.options = options;
    this.state = { phase: 'editing', tool: null, canUndo: false, canRedo: false };
    this.listeners = new Set();
    this.past = [];
    this.future = [];
    this.guard = null;
    this.epoch = 0;
  }
  getState = () => this.state;
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  update(value = {}) {
    this.state = { ...this.state, ...value, canUndo: this.past.length > 0, canRedo: this.future.length > 0 };
    for (const listener of this.listeners) listener();
  }
  get blocksSync() { return ['preview', 'candidate', 'adopting'].includes(this.state.phase); }
  get blocksEditing() { return this.state.phase !== 'editing'; }
  preview(enabled) {
    if (enabled && this.state.phase !== 'editing') throw new Error('请先完成当前场景操作再开始预览。');
    if (!enabled && this.state.phase !== 'preview') return;
    this.update({ phase: enabled ? 'preview' : 'editing', tool: null });
  }
  async open(tool) {
    if (this.blocksEditing) throw new Error('请先退出预览或完成当前场景操作。');
    const epoch = ++this.epoch;
    this.update({ phase: 'preparing', tool });
    try {
      const original = await this.options.fingerprint(this.options.current());
      await this.options.saveLocal();
      const guard = await this.options.flushSaved();
      if (epoch !== this.epoch || original !== guard.fingerprint || this.options.current().id !== guard.document.id)
        throw new Error('保存期间场景发生变化，草稿已保留，请重新打开。');
      this.guard = guard;
      this.update({ phase: 'candidate', tool });
      return guard;
    } catch (error) {
      if (epoch === this.epoch) this.close();
      throw error;
    }
  }
  openReadOnly(tool) {
    if (this.blocksEditing) throw new Error('请先完成当前场景操作。');
    this.guard = null;
    this.update({ phase: 'candidate', tool });
  }
  close() {
    if (this.state.phase === 'adopting') throw new Error('正在接收采用结果，请稍后关闭。');
    this.epoch++;
    this.guard = null;
    this.update({ phase: 'editing', tool: null });
  }
  async check() {
    const guard = this.guard;
    if (!guard || !['candidate', 'adopting'].includes(this.state.phase) || this.options.current().id !== guard.document.id ||
        await this.options.fingerprint(this.options.current()) !== guard.fingerprint)
      throw new Error('本机场景已变化或历史入口只读，请保留候选并重新打开。');
    return guard;
  }
  async accept(receipt) {
    const guard = await this.check();
    if (receipt.documentId !== guard.document.id || !Number.isSafeInteger(receipt.revision) ||
        (receipt.currentRevision !== undefined && receipt.currentRevision !== receipt.revision))
      throw new Error('采用回执与当前场景或最新版本不匹配。');
    this.update({ phase: 'adopting' });
    try {
      const { document } = await this.options.readDocument(receipt.documentId, receipt.revision);
      if (document.id !== receipt.documentId || document.revision !== receipt.revision ||
          (receipt.contentHash && document.contentHash !== receipt.contentHash))
        throw new Error('采用后的确切场景版本或哈希校验未通过。');
      const next = await this.options.acceptAdopted(document, guard);
      this.guard = next;
      return next;
    } finally { this.update({ phase: 'candidate' }); }
  }
  record(snapshot, adoption) {
    this.past.push({ snapshot, ...(adoption ? { adoption } : {}) });
    this.past = this.past.slice(-60);
    this.future = [];
    this.update();
  }
  clearHistory() { this.past = []; this.future = []; this.update(); }
  async travel(direction, apply) {
    if (this.blocksEditing) return;
    const from = direction === 'undo' ? this.past : this.future;
    const to = direction === 'undo' ? this.future : this.past;
    const entry = from.at(-1);
    if (!entry) return;
    this.update({ phase: 'history', tool: null });
    try {
      if (entry.adoption) {
        const fingerprint = await this.options.fingerprint(this.options.current());
        const saved = await this.options.flushSaved();
        if (from !== (direction === 'undo' ? this.past : this.future) || from.at(-1) !== entry || fingerprint !== saved.fingerprint)
          throw new Error('共享场景已有新内容，未撤销或重做旧的采用事务。');
      }
      const current = this.options.current();
      // apply may reject; leave both stacks untouched until it succeeds.
      await apply(entry.snapshot);
      from.pop();
      to.push({ snapshot: current, ...(entry.adoption ? { adoption: entry.adoption } : {}) });
      this.update();
      if (entry.adoption) await this.options.flushSaved();
    } finally { this.update({ phase: 'editing' }); }
  }
}
