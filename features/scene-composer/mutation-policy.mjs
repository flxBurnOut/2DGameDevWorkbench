const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const locked = (message) => {
  throw Object.assign(new Error(message), { status: 400, code: 'LOCKED_NODE' });
};

export function assertEditableSceneNodes(nodes) {
  if (nodes.some(node => node.locked)) locked('A selected node is locked. 请先显式解锁要修改的节点。');
}

// Commands supply explicit intent (e.g. which node is being reordered). A full
// snapshot has no such intent, so it must preserve locked nodes' relative order
// against surviving nodes. Adding/removing unrelated nodes does not move a lock.
export function assertSceneMutationLocks(before, after, { command } = {}) {
  const placement = node => node && ({ materialId: node.materialId, x: node.x, y: node.y, scale: node.scale, flipH: node.flipH, anchor: node.anchor });
  const orderChanged = !command && !same(before.order, after.order);
  const afterPositions = orderChanged ? new Map(after.order.map((id, index) => [id, index])) : null;
  const checkOrder = id => {
    if (!orderChanged || !afterPositions.has(id)) return;
    const previousIndex = before.order.indexOf(id), nextIndex = afterPositions.get(id);
    if (before.order.some((key, index) => afterPositions.has(key) && (index < previousIndex) !== (afterPositions.get(key) < nextIndex)))
      locked('快照不能改变锁定节点的遮挡关系；请先解锁，或使用明确选择未锁定节点的排序命令。');
  };
  if (command?.type === 'reorder') {
    const ids = new Set(command.ids);
    assertEditableSceneNodes([...before.instances, ...(before.map?.layers || []), ...(before.mapSplit?.elements || [])].filter(node => ids.has(node.id)));
  }
  for (const node of before.instances.filter(node => node.locked)) {
    const next = after.instances.find(item => item.id === node.id);
    if (!same(placement(node), placement(next))) locked('不能移动、替换或移除锁定实例，请先显式解锁。');
    const material = scene => scene.materials.find(item => item.id === node.materialId)?.project;
    if (!same(material(before), material(after))) locked('不能通过替换共享素材改写锁定实例，请先显式解锁。');
    checkOrder(node.id);
  }
  for (const node of before.map?.layers.filter(node => node.locked) || []) checkOrder(node.id);
  for (const node of before.mapSplit?.elements.filter(node => node.locked) || []) {
    const next = after.mapSplit?.elements.find(item => item.id === node.id);
    const content = value => {
      if (!value) return value;
      const { locked: _locked, hidden: _hidden, included: _included, ...rest } = value;
      return rest;
    };
    if (!same(content(node), content(next))) locked('不能修改或移除锁定的分层物件，请先显式解锁。');
    checkOrder(node.id);
  }
}
