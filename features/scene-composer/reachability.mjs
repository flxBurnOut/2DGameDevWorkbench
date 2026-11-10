// Read-only reachability over physical standable surfaces. A simple fixed-step
// platformer integrator (1/60 s, axis-separated pixel moves) approximates a
// Godot CharacterBody2D; engine replay is the validation step, not this file.

const DT = 1 / 60;

/** Column and row prefix sums give O(1) "any solid in this strip" queries. */
export function solidIndex(grid) {
  const { width: w, height: h, data } = grid;
  const column = new Int32Array(w * (h + 1));
  const row = new Int32Array(h * (w + 1));
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) column[x * (h + 1) + y + 1] = column[x * (h + 1) + y] + data[y * w + x];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) row[y * (w + 1) + x + 1] = row[y * (w + 1) + x] + data[y * w + x];
  const inColumn = (x, y0, y1) => {
    if (x < 0 || x >= w) return 0;
    const a = Math.max(0, y0);
    const b = Math.min(h, y1);
    return b > a ? column[x * (h + 1) + b] - column[x * (h + 1) + a] : 0;
  };
  const inRow = (y, x0, x1) => {
    if (y < 0 || y >= h) return 0;
    const a = Math.max(0, x0);
    const b = Math.min(w, x1);
    return b > a ? row[y * (w + 1) + b] - row[y * (w + 1) + a] : 0;
  };
  return { inColumn, inRow, width: w, height: h };
}

/**
 * Simulate one airborne move from a standing position (grid-relative feet
 * row). Returns the landing feet position or null when the player leaves the
 * world or the frame limit runs out.
 */
export function simulateMove(index, player, start, motion, maxFrames = 240) {
  const half = Math.floor(player.width / 2);
  let px = start.x;
  let py = start.y;
  let vx = motion.vx;
  let vy = motion.vy;
  let rx = 0;
  let ry = 0;
  const left = () => px - half;
  for (let frame = 0; frame < maxFrames; frame++) {
    vx += (motion.input * player.runSpeed - vx) * player.airControl;
    vy = Math.min(vy + player.gravity * DT, player.maxFallSpeed);
    rx += vx * DT;
    while (rx >= 1) {
      if (index.inColumn(left() + player.width, py - player.height, py)) { rx = 0; vx = 0; break; }
      px++;
      rx -= 1;
    }
    while (rx <= -1) {
      if (index.inColumn(left() - 1, py - player.height, py)) { rx = 0; vx = 0; break; }
      px--;
      rx += 1;
    }
    ry += vy * DT;
    while (ry >= 1) {
      if (index.inRow(py, left(), left() + player.width)) return { x: px, y: py, frames: frame + 1 };
      py++;
      ry -= 1;
    }
    while (ry <= -1) {
      if (index.inRow(py - player.height - 1, left(), left() + player.width)) { ry = 0; vy = 0; break; }
      py--;
      ry += 1;
    }
    if (py - player.height > index.height + player.height * 2) return null;
  }
  return null;
}

function nearestNode(nodes, point) {
  let best = null;
  for (const node of nodes) {
    const d = Math.hypot(node.x - point.x, node.y - point.y);
    if (!best || d < best.d) best = { node, d };
  }
  return best?.node ?? null;
}

/**
 * segments: physical standable segments in world coordinates.
 * Returns which surfaces a player can reach from `start`, using walking along
 * a segment plus simulated jumps and walk-offs between segments.
 */
export function analyzeReachability(grid, segments, player, options = {}) {
  const step = options.sampleStep ?? 4;
  const maxFrames = options.maxFrames ?? 240;
  const index = solidIndex(grid);
  const nodes = [];
  const byColumn = new Map();
  for (const segment of segments)
    segment.points.forEach((point, order) => {
      const node = { id: nodes.length, x: point.x, y: point.y, segmentId: segment.id, order, edges: new Set() };
      nodes.push(node);
      if (!byColumn.has(point.x)) byColumn.set(point.x, []);
      byColumn.get(point.x).push(node);
    });
  if (!nodes.length)
    return { nodes: 0, totalLength: 0, reachableLength: 0, coverage: null, goalReachable: null, start: null, goal: null, segments: [], simulations: 0, unmappedLandings: 0 };
  const segmentNodes = new Map();
  for (const node of nodes) {
    if (!segmentNodes.has(node.segmentId)) segmentNodes.set(node.segmentId, []);
    segmentNodes.get(node.segmentId).push(node);
  }
  for (const list of segmentNodes.values())
    for (let i = 1; i < list.length; i++) {
      list[i - 1].edges.add(list[i].id);
      list[i].edges.add(list[i - 1].id);
    }
  const land = (landing) => {
    const wx = landing.x + grid.x0;
    const wy = landing.y + grid.y0;
    const snapped = Math.round(wx / step) * step;
    let best = null;
    for (const x of [snapped, snapped - step, snapped + step]) {
      for (const node of byColumn.get(x) || []) {
        const d = Math.abs(node.y - wy) + Math.abs(node.x - wx) * 0.01;
        if (Math.abs(node.y - wy) <= 4 && (!best || d < best.d)) best = { node, d };
      }
    }
    return best?.node ?? null;
  };
  const spacing = Math.max(1, Math.round(player.width / 2 / step));
  const speeds = [-1, -0.5, 0, 0.5, 1];
  const inputs = [-1, 0, 1];
  let simulations = 0;
  let unmappedLandings = 0;
  const launch = (node, startX, motion) => {
    simulations++;
    const landing = simulateMove(index, player, { x: startX - grid.x0, y: node.y - grid.y0 }, motion, maxFrames);
    if (!landing) return;
    const target = land(landing);
    if (!target) { unmappedLandings++; return; }
    if (target.id !== node.id) node.edges.add(target.id);
  };
  for (const list of segmentNodes.values()) {
    list.forEach((node, i) => {
      const endpoint = i === 0 || i === list.length - 1;
      if (i % spacing && !endpoint) return;
      for (const s of speeds)
        for (const input of inputs)
          launch(node, node.x, { vx: s * player.runSpeed, vy: -player.jumpVelocity, input });
    });
    // Walking off either end: start with the body just past the edge.
    const half = Math.floor(player.width / 2);
    const first = list[0];
    const last = list[list.length - 1];
    for (const input of [-1, 0]) launch(first, first.x - half - 1, { vx: -player.runSpeed, vy: 0, input });
    for (const input of [1, 0]) launch(last, last.x + half + 1, { vx: player.runSpeed, vy: 0, input });
  }
  const pick = (point, fallback) => (point ? nearestNode(nodes, point) : fallback);
  const leftmost = nodes.reduce((a, b) => (b.x < a.x || (b.x === a.x && b.y > a.y) ? b : a));
  const rightmost = nodes.reduce((a, b) => (b.x > a.x || (b.x === a.x && b.y > a.y) ? b : a));
  const start = pick(options.start, leftmost);
  const goal = pick(options.goal, rightmost);
  const reached = new Uint8Array(nodes.length);
  const queue = [start.id];
  reached[start.id] = 1;
  while (queue.length) {
    const current = nodes[queue.pop()];
    for (const next of current.edges)
      if (!reached[next]) {
        reached[next] = 1;
        queue.push(next);
      }
  }
  const perSegment = [...segmentNodes.entries()].map(([id, list]) => {
    const count = list.filter((node) => reached[node.id]).length;
    return { id, length: list.length * step, reachableLength: count * step, x0: list[0].x, x1: list[list.length - 1].x, y: list[0].y };
  });
  const totalLength = nodes.length * step;
  const reachableLength = reached.reduce((sum, value) => sum + value, 0) * step;
  return {
    nodes: nodes.length,
    totalLength,
    reachableLength,
    coverage: Number((reachableLength / totalLength).toFixed(4)),
    start: { x: start.x, y: start.y, segmentId: start.segmentId },
    goal: { x: goal.x, y: goal.y, segmentId: goal.segmentId },
    goalReachable: Boolean(reached[goal.id]),
    segments: perSegment,
    reachedPoints: nodes.filter((node) => reached[node.id]).map((node) => ({ x: node.x, y: node.y })),
    simulations,
    unmappedLandings,
  };
}
