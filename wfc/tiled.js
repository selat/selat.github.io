// Tiled Wave Function Collapse. Each cell starts as a superposition over all
// tile/rotation variants (stored as a bitset). At each step we observe the
// lowest-entropy cell, collapse it to one variant weighted by tile frequency,
// then run AC-3 propagation to prune neighbour options whose sockets no longer
// have support. Repeats until every cell is collapsed or we hit a contradiction.

(function () {
  const OPP = [2, 3, 0, 1]; // opposite direction: N<->S, E<->W
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0]; // grid y grows down, so N is dy=-1

  function rotateSockets(sockets, r) {
    const out = [0, 0, 0, 0];
    for (let d = 0; d < 4; d++) out[d] = sockets[(d - r + 4) % 4];
    return out;
  }

  function buildVariants(baseTiles) {
    const variants = [];
    for (let i = 0; i < baseTiles.length; i++) {
      const base = baseTiles[i];
      for (const rot of base.rotations) {
        variants.push({
          baseIdx: i,
          rot,
          sockets: rotateSockets(base.sockets, rot),
          weight: base.weight,
        });
      }
    }
    if (variants.length > 31) {
      throw new Error(`tileset exceeds 31 variants (${variants.length}); upgrade to typed-array bitset`);
    }
    return variants;
  }

  function buildAdjacency(variants) {
    const n = variants.length;
    const adj = [];
    for (let t = 0; t < n; t++) {
      const row = [0, 0, 0, 0];
      for (let d = 0; d < 4; d++) {
        for (let t2 = 0; t2 < n; t2++) {
          if (variants[t].sockets[d] === variants[t2].sockets[OPP[d]]) {
            row[d] |= (1 << t2);
          }
        }
      }
      adj.push(row);
    }
    return adj;
  }

  // Wire-style draw helpers. All base tiles draw on a unit box centred at
  // (0, 0) with side `s`, using canvas y-down. `rot` is applied by the caller
  // via translate/rotate.

  const WIRE = '#6ecfff';
  const WIRE_DIM = 'rgba(110, 207, 255, 0.18)';
  const PAD = '#143040';

  function strokeWire(ctx, s, drawPath) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // soft glow pass
    ctx.strokeStyle = WIRE_DIM;
    ctx.lineWidth = Math.max(2, s * 0.32);
    drawPath(ctx, s);
    // core pass
    ctx.strokeStyle = WIRE;
    ctx.lineWidth = Math.max(1, s * 0.12);
    drawPath(ctx, s);
  }

  function dot(ctx, s) {
    ctx.fillStyle = PAD;
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1, s * 0.06), 0, Math.PI * 2);
    ctx.fill();
  }

  const CIRCUIT_TILES = [
    {
      name: 'blank',
      sockets: [0, 0, 0, 0],
      weight: 2.5,
      rotations: [0],
      draw(ctx, s) {
        dot(ctx, s);
      },
    },
    {
      name: 'straight',
      sockets: [0, 1, 0, 1], // wire W-E
      weight: 1.0,
      rotations: [0, 1],
      draw(ctx, s) {
        strokeWire(ctx, s, (c, ss) => {
          c.beginPath();
          c.moveTo(-ss / 2, 0);
          c.lineTo(ss / 2, 0);
        });
      },
    },
    {
      name: 'corner',
      sockets: [0, 0, 1, 1], // wire S-W
      weight: 0.9,
      rotations: [0, 1, 2, 3],
      draw(ctx, s) {
        strokeWire(ctx, s, (c, ss) => {
          c.beginPath();
          c.arc(-ss / 2, ss / 2, ss / 2, -Math.PI / 2, 0);
        });
      },
    },
    {
      name: 'tjunc',
      sockets: [0, 1, 1, 1], // wire E, S, W
      weight: 0.45,
      rotations: [0, 1, 2, 3],
      draw(ctx, s) {
        strokeWire(ctx, s, (c, ss) => {
          c.beginPath();
          c.moveTo(-ss / 2, 0);
          c.lineTo(ss / 2, 0);
          c.moveTo(0, 0);
          c.lineTo(0, ss / 2);
        });
      },
    },
    {
      name: 'cross',
      sockets: [1, 1, 1, 1],
      weight: 0.15,
      rotations: [0],
      draw(ctx, s) {
        strokeWire(ctx, s, (c, ss) => {
          c.beginPath();
          c.moveTo(-ss / 2, 0);
          c.lineTo(ss / 2, 0);
          c.moveTo(0, -ss / 2);
          c.lineTo(0, ss / 2);
        });
      },
    },
  ];

  const PRESETS = [
    { name: 'Circuit', tiles: CIRCUIT_TILES },
  ];

  function initWorld(world, preset, params) {
    const variants = buildVariants(preset.tiles);
    world.variants = variants;
    world.weights = variants.map((v) => v.weight);
    world.logWeights = variants.map((v) => Math.log(v.weight));
    world.adjacency = buildAdjacency(variants);
    world.nVariants = variants.length;
    world.baseTiles = preset.tiles;
    world.fullMask = (1 << variants.length) - 1;
    world.N = params.gridSize | 0;

    const total = world.N * world.N;
    const cells = new Array(total);
    for (let i = 0; i < total; i++) {
      cells[i] = {
        mask: world.fullMask,
        collapsed: -1,
        // small per-cell noise makes entropy-tie-breaking deterministic
        noise: Math.random() * 1e-4,
      };
    }
    world.cells = cells;
    world.collapsedCount = 0;
    world.contradictions = 0;
    world.done = false;
    world.contradicted = false;
    world.stepAccum = 0;
  }

  function observe(world) {
    // find min-entropy uncollapsed cell
    const cells = world.cells;
    const weights = world.weights;
    const logWeights = world.logWeights;
    const nVariants = world.nVariants;

    let best = -1;
    let bestH = Infinity;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (c.collapsed >= 0) continue;
      let sumW = 0;
      let sumWlogW = 0;
      let count = 0;
      for (let t = 0; t < nVariants; t++) {
        if (c.mask & (1 << t)) {
          const w = weights[t];
          sumW += w;
          sumWlogW += w * logWeights[t];
          count++;
        }
      }
      if (count === 0) { world.contradicted = true; return false; }
      if (count === 1) {
        // already determined — collapse in place, no propagation needed (it
        // would have been propagated on the assignment that narrowed this
        // cell). Keep searching for an actual superposition.
        const t = 31 - Math.clz32(c.mask);
        c.collapsed = t;
        world.collapsedCount++;
        continue;
      }
      const H = Math.log(sumW) - sumWlogW / sumW + c.noise;
      if (H < bestH) { bestH = H; best = i; }
    }

    if (best < 0) {
      world.done = true;
      return false;
    }

    // collapse chosen cell by weight
    const c = cells[best];
    let totalW = 0;
    for (let t = 0; t < nVariants; t++) {
      if (c.mask & (1 << t)) totalW += weights[t];
    }
    let r = Math.random() * totalW;
    let chosen = -1;
    for (let t = 0; t < nVariants; t++) {
      if (c.mask & (1 << t)) {
        r -= weights[t];
        if (r <= 0) { chosen = t; break; }
      }
    }
    if (chosen < 0) {
      // floating-point fallback: pick highest set bit
      chosen = 31 - Math.clz32(c.mask);
    }
    c.mask = 1 << chosen;
    c.collapsed = chosen;
    world.collapsedCount++;
    propagate(world, best);
    return true;
  }

  function propagate(world, startIdx) {
    const N = world.N;
    const cells = world.cells;
    const adjacency = world.adjacency;
    const nVariants = world.nVariants;
    const queue = [startIdx];

    while (queue.length) {
      const idx = queue.shift();
      const cx = idx % N;
      const cy = (idx / N) | 0;
      const mask = cells[idx].mask;
      if (mask === 0) continue;

      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d];
        const ny = cy + DY[d];
        if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
        const nIdx = ny * N + nx;
        const nc = cells[nIdx];
        if (nc.mask === 0) continue;

        // allowed = union of adjacency[t][d] for each t still in this cell
        let allowed = 0;
        for (let t = 0; t < nVariants; t++) {
          if (mask & (1 << t)) allowed |= adjacency[t][d];
        }
        const newMask = nc.mask & allowed;
        if (newMask !== nc.mask) {
          if (newMask === 0) {
            nc.mask = 0;
            world.contradicted = true;
            world.contradictions++;
            return;
          }
          nc.mask = newMask;
          if (nc.collapsed < 0 && (newMask & (newMask - 1)) === 0) {
            nc.collapsed = 31 - Math.clz32(newMask);
            world.collapsedCount++;
          }
          queue.push(nIdx);
        }
      }
    }
  }

  function drawVariant(ctx, cx, cy, s, variant, baseTiles) {
    const base = baseTiles[variant.baseIdx];
    ctx.save();
    ctx.translate(cx, cy);
    if (variant.rot) ctx.rotate(variant.rot * Math.PI / 2);
    base.draw(ctx, s);
    ctx.restore();
  }

  const APPROACH = {
    id: 'tiled',
    name: 'Tiled WFC',
    presets: PRESETS,
    params: [
      { key: 'gridSize', label: 'grid', min: 8, max: 60, step: 1, default: 30, fmt: (v) => `${v | 0}×${v | 0}` },
    ],

    init(world, preset, params) {
      initWorld(world, preset, params);
    },

    step(world, dt, params, speed) {
      if (world.done || world.contradicted) return;
      world.stepAccum += dt * speed;
      let budget = Math.floor(world.stepAccum);
      if (budget <= 0) return;
      world.stepAccum -= budget;
      // cap to keep a single frame responsive
      if (budget > 2000) budget = 2000;
      while (budget-- > 0) {
        if (!observe(world)) break;
      }
    },

    draw(ctx, project, world) {
      if (!world.cells) return;
      const N = world.N;

      // compute tile size in screen px via two projected points
      const a = project(0, 0);
      const b = project(1, -1);
      const s = b.x - a.x;

      // cell background (very dark teal to distinguish grid from canvas bg)
      const gridOrigin = project(0, 0);
      const totalPx = s * N;
      ctx.fillStyle = '#05090c';
      ctx.fillRect(gridOrigin.x, gridOrigin.y, totalPx, totalPx);

      // grid lines
      ctx.strokeStyle = '#12202a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const p = gridOrigin.x + i * s;
        ctx.moveTo(p, gridOrigin.y);
        ctx.lineTo(p, gridOrigin.y + totalPx);
        const q = gridOrigin.y + i * s;
        ctx.moveTo(gridOrigin.x, q);
        ctx.lineTo(gridOrigin.x + totalPx, q);
      }
      ctx.stroke();

      // collapsed cells
      const variants = world.variants;
      const baseTiles = world.baseTiles;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const c = world.cells[y * N + x];
          if (c.collapsed < 0) continue;
          const cx = gridOrigin.x + (x + 0.5) * s;
          const cy = gridOrigin.y + (y + 0.5) * s;
          drawVariant(ctx, cx, cy, s, variants[c.collapsed], baseTiles);
        }
      }
    },

    bbox(world) {
      if (!world.N) return null;
      return { minX: 0, maxX: world.N, minY: -world.N, maxY: 0 };
    },

    status(world) {
      const total = world.N * world.N;
      let suffix = '';
      if (world.contradicted) suffix = ' ✗';
      else if (world.done) suffix = ' ✓';
      return `cells=${world.collapsedCount}/${total}${suffix}`;
    },
  };

  (window.APPROACHES = window.APPROACHES || []).push(APPROACH);
})();
