// Space colonization (Runions, Lane, Měch 2007).
// Scatter attractors in a crown region; each growth tick:
//   1. each alive attractor picks the nearest tree node within influence radius
//   2. every node with >= 1 influencer spawns one child in the normalized
//      sum of unit-vectors toward its influencers (+ optional up-bias)
//   3. attractors within kill radius of any node are removed.
// When no attractor is in range of any tip, fall back to "stem" growth along
// the tip's heading so the trunk can reach the crown.

(function () {
  const MAX_NODES = 8000;
  const MAX_STEM_STEPS = 400;
  const MAX_STEPS_PER_FRAME = 200;

  function sampleEllipse(n, cx, cy, rx, ry) {
    const pts = [];
    let tries = 0;
    const maxTries = n * 20;
    while (pts.length < n && tries < maxTries) {
      tries++;
      const x = cx + (Math.random() * 2 - 1) * rx;
      const y = cy + (Math.random() * 2 - 1) * ry;
      const nx = (x - cx) / rx, ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) pts.push({ x, y, alive: true });
    }
    return pts;
  }

  function sampleRect(n, minX, maxX, minY, maxY) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      pts.push({
        x: minX + Math.random() * (maxX - minX),
        y: minY + Math.random() * (maxY - minY),
        alive: true,
      });
    }
    return pts;
  }

  function sampleCrown(n, crown) {
    if (crown.type === 'ellipse') return sampleEllipse(n, crown.cx, crown.cy, crown.rx, crown.ry);
    if (crown.type === 'rect') return sampleRect(n, crown.minX, crown.maxX, crown.minY, crown.maxY);
    return [];
  }

  function crownBbox(crown) {
    if (crown.type === 'ellipse') {
      return { minX: crown.cx - crown.rx, maxX: crown.cx + crown.rx, minY: crown.cy - crown.ry, maxY: crown.cy + crown.ry };
    }
    if (crown.type === 'rect') {
      return { minX: crown.minX, maxX: crown.maxX, minY: crown.minY, maxY: crown.maxY };
    }
    return { minX: -50, maxX: 50, minY: 0, maxY: 100 };
  }

  function growStep(world, params) {
    if (world.done) return 0;
    const nodes = world.nodes;
    const attractors = world.attractors;
    if (nodes.length >= MAX_NODES) { world.done = true; return 0; }
    if (world.attractorsAlive === 0) { world.done = true; return 0; }

    const di2 = params.influenceRadius * params.influenceRadius;
    const dk2 = params.killRadius * params.killRadius;

    const influencers = new Map();
    let anyInfluence = false;
    for (let ai = 0; ai < attractors.length; ai++) {
      const a = attractors[ai];
      if (!a.alive) continue;
      let nearestN = -1;
      let nearestD = di2;
      for (let ni = 0; ni < nodes.length; ni++) {
        const n = nodes[ni];
        const dx = a.x - n.x, dy = a.y - n.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < nearestD) { nearestD = d2; nearestN = ni; }
      }
      if (nearestN >= 0) {
        anyInfluence = true;
        let list = influencers.get(nearestN);
        if (!list) { list = []; influencers.set(nearestN, list); }
        list.push(ai);
      }
    }

    const newNodes = [];
    if (!anyInfluence) {
      if (world.stemSteps >= MAX_STEM_STEPS) { world.done = true; return 0; }
      world.stemSteps++;
      for (let ni = 0; ni < nodes.length; ni++) {
        const n = nodes[ni];
        if (n.hasChildren) continue;
        newNodes.push({
          x: n.x + n.hx * params.stepLength,
          y: n.y + n.hy * params.stepLength,
          hx: n.hx, hy: n.hy,
          parentIdx: ni,
          depth: n.depth + 1,
          subtreeSize: 1,
          hasChildren: false,
        });
      }
    } else {
      for (const [ni, atIdxs] of influencers) {
        const n = nodes[ni];
        let dx = 0, dy = 0;
        for (let k = 0; k < atIdxs.length; k++) {
          const a = attractors[atIdxs[k]];
          const vx = a.x - n.x, vy = a.y - n.y;
          const mag = Math.sqrt(vx * vx + vy * vy);
          if (mag > 1e-9) { dx += vx / mag; dy += vy / mag; }
        }
        dy += params.upBias || 0;
        const mag = Math.sqrt(dx * dx + dy * dy);
        if (mag < 1e-9) continue;
        dx /= mag; dy /= mag;
        newNodes.push({
          x: n.x + dx * params.stepLength,
          y: n.y + dy * params.stepLength,
          hx: dx, hy: dy,
          parentIdx: ni,
          depth: n.depth + 1,
          subtreeSize: 1,
          hasChildren: false,
        });
      }
    }

    if (newNodes.length === 0) { world.done = true; return 0; }

    for (let i = 0; i < newNodes.length; i++) {
      const nn = newNodes[i];
      nodes.push(nn);
      nodes[nn.parentIdx].hasChildren = true;
      let p = nn.parentIdx;
      while (p !== -1) {
        nodes[p].subtreeSize += 1;
        p = nodes[p].parentIdx;
      }
      if (nn.x < world.rawBbox.minX) world.rawBbox.minX = nn.x;
      else if (nn.x > world.rawBbox.maxX) world.rawBbox.maxX = nn.x;
      if (nn.y < world.rawBbox.minY) world.rawBbox.minY = nn.y;
      else if (nn.y > world.rawBbox.maxY) world.rawBbox.maxY = nn.y;
    }

    for (let ai = 0; ai < attractors.length; ai++) {
      const a = attractors[ai];
      if (!a.alive) continue;
      for (let ni = 0; ni < nodes.length; ni++) {
        const n = nodes[ni];
        const dx = a.x - n.x, dy = a.y - n.y;
        if (dx * dx + dy * dy < dk2) {
          a.alive = false;
          world.attractorsAlive--;
          break;
        }
      }
    }

    if (world.attractorsAlive === 0) world.done = true;
    return newNodes.length;
  }

  const TRUNK = [120, 78, 42];
  const MID = [150, 140, 60];
  const LEAF = [110, 200, 90];
  function mix(a, b, t) { return Math.round(a + (b - a) * t); }
  function colorAt(t) {
    if (t < 0.5) {
      const u = t * 2;
      return `rgb(${mix(TRUNK[0], MID[0], u)},${mix(TRUNK[1], MID[1], u)},${mix(TRUNK[2], MID[2], u)})`;
    }
    const u = (t - 0.5) * 2;
    return `rgb(${mix(MID[0], LEAF[0], u)},${mix(MID[1], LEAF[1], u)},${mix(MID[2], LEAF[2], u)})`;
  }

  const PRESETS = [
    {
      name: 'Oak',
      root: { x: 0, y: 0, hx: 0, hy: 1 },
      crown: { type: 'ellipse', cx: 0, cy: 90, rx: 55, ry: 35 },
      params: { attractorCount: 500, influenceRadius: 25, killRadius: 5, stepLength: 2.5, upBias: 0.1 },
    },
    {
      name: 'Pine',
      root: { x: 0, y: 0, hx: 0, hy: 1 },
      crown: { type: 'ellipse', cx: 0, cy: 120, rx: 25, ry: 70 },
      params: { attractorCount: 400, influenceRadius: 20, killRadius: 3, stepLength: 2, upBias: 0.3 },
    },
    {
      name: 'Willow',
      root: { x: 0, y: 0, hx: 0, hy: 1 },
      crown: { type: 'ellipse', cx: 0, cy: 80, rx: 60, ry: 40 },
      params: { attractorCount: 500, influenceRadius: 28, killRadius: 5, stepLength: 2.5, upBias: -0.35 },
    },
    {
      name: 'Hedge',
      root: { x: 0, y: 0, hx: 0, hy: 1 },
      crown: { type: 'rect', minX: -75, maxX: 75, minY: 35, maxY: 75 },
      params: { attractorCount: 700, influenceRadius: 18, killRadius: 4, stepLength: 2, upBias: 0 },
    },
    {
      name: 'Bonsai',
      root: { x: 0, y: 0, hx: 0, hy: 1 },
      crown: { type: 'ellipse', cx: 0, cy: 40, rx: 28, ry: 18 },
      params: { attractorCount: 220, influenceRadius: 14, killRadius: 3, stepLength: 1.2, upBias: 0.15 },
    },
  ];

  const APPROACH = {
    id: 'colonization',
    name: 'Space colonization',
    presets: PRESETS,
    params: [
      { key: 'attractorCount', label: 'attr', min: 50, max: 1500, step: 10, default: 500, fmt: (v) => String(v | 0) },
      { key: 'influenceRadius', label: 'infl', min: 5, max: 60, step: 1, default: 25, fmt: (v) => v.toFixed(0) },
      { key: 'killRadius', label: 'kill', min: 1, max: 15, step: 0.5, default: 5, fmt: (v) => v.toFixed(1) },
      { key: 'stepLength', label: 'step', min: 0.5, max: 5, step: 0.1, default: 2.5, fmt: (v) => v.toFixed(1) },
      { key: 'upBias', label: 'bias', min: -1, max: 1, step: 0.05, default: 0.1, fmt: (v) => v.toFixed(2) },
    ],

    init(world, preset, params) {
      const attractors = sampleCrown(params.attractorCount | 0, preset.crown);
      world.attractors = attractors;
      world.attractorsAlive = attractors.length;
      world.nodes = [{
        x: preset.root.x, y: preset.root.y,
        hx: preset.root.hx, hy: preset.root.hy,
        parentIdx: -1, depth: 0, subtreeSize: 1, hasChildren: false,
      }];
      world.done = false;
      world.stemSteps = 0;
      world.stepAccum = 0;
      const cb = crownBbox(preset.crown);
      const margin = 12;
      world.rawBbox = {
        minX: Math.min(cb.minX, preset.root.x) - margin,
        maxX: Math.max(cb.maxX, preset.root.x) + margin,
        minY: Math.min(cb.minY, preset.root.y) - margin,
        maxY: Math.max(cb.maxY, preset.root.y) + margin,
      };
    },

    step(world, dt, params, speed) {
      if (world.done) return;
      world.stepAccum += dt * speed;
      let budget = Math.floor(world.stepAccum);
      if (budget <= 0) return;
      if (budget > MAX_STEPS_PER_FRAME) budget = MAX_STEPS_PER_FRAME;
      world.stepAccum -= budget;
      for (let i = 0; i < budget; i++) {
        growStep(world, params);
        if (world.done) break;
      }
    },

    draw(ctx, project, world) {
      const nodes = world.nodes;
      if (!nodes.length) return;

      ctx.fillStyle = 'rgba(140, 220, 140, 0.35)';
      for (let i = 0; i < world.attractors.length; i++) {
        const a = world.attractors[i];
        if (!a.alive) continue;
        const p = project(a.x, a.y);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }

      let maxDepth = 0;
      for (let i = 0; i < nodes.length; i++) if (nodes[i].depth > maxDepth) maxDepth = nodes[i].depth;
      const invMaxDepth = 1 / Math.max(1, maxDepth);

      const buckets = new Map();
      for (let i = 1; i < nodes.length; i++) {
        const n = nodes[i];
        const width = Math.max(0.8, Math.min(14, Math.sqrt(n.subtreeSize) * 0.55));
        const wKey = Math.round(width * 2);
        const cKey = Math.round(n.depth * invMaxDepth * 8);
        const key = wKey * 16 + cKey;
        let b = buckets.get(key);
        if (!b) { b = { w: wKey / 2, t: cKey / 8, edges: [] }; buckets.set(key, b); }
        b.edges.push(i);
      }

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const b of buckets.values()) {
        ctx.lineWidth = b.w;
        ctx.strokeStyle = colorAt(b.t);
        ctx.beginPath();
        for (let k = 0; k < b.edges.length; k++) {
          const n = nodes[b.edges[k]];
          const p = nodes[n.parentIdx];
          const p1 = project(p.x, p.y);
          const p2 = project(n.x, n.y);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();
      }
    },

    bbox(world) { return world.rawBbox; },

    status(world) {
      return `nodes=${world.nodes.length} attr=${world.attractorsAlive}${world.done ? ' ✓' : ''}`;
    },
  };

  (window.APPROACHES = window.APPROACHES || []).push(APPROACH);
})();
