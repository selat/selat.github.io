// Tiled Wave Function Collapse. Each cell starts as a superposition over all
// tile/rotation variants (stored as a bitset). At each step we observe the
// lowest-entropy cell, collapse it to one variant weighted by tile frequency,
// then run AC-3 propagation to prune neighbour options whose sockets no longer
// have support. On contradiction: flash the failed cell, reset, keep going.

(function () {
  const OPP = [2, 3, 0, 1];
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];

  const FLASH_DURATION = 0.7; // seconds

  function popcount(n) {
    let c = 0;
    while (n) { n &= n - 1; c++; }
    return c;
  }

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

  const WIRE = '#6ecfff';
  const WIRE_DIM = 'rgba(110, 207, 255, 0.18)';
  const PAD = '#143040';

  function strokeWire(ctx, s, drawPath) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = WIRE_DIM;
    ctx.lineWidth = Math.max(2, s * 0.32);
    drawPath(ctx, s);
    ctx.stroke();
    ctx.strokeStyle = WIRE;
    ctx.lineWidth = Math.max(1, s * 0.12);
    drawPath(ctx, s);
    ctx.stroke();
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
      draw(ctx, s) { dot(ctx, s); },
      drawGhost() {}, // too noisy to render blanks ghosted
    },
    {
      name: 'straight',
      sockets: [0, 1, 0, 1],
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
      sockets: [0, 0, 1, 1],
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
      sockets: [0, 1, 1, 1],
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

  // ---------- Rooms tileset (dungeon map) ----------

  const ROOM_WALL = '#1a0e08';
  const ROOM_WALL_LINE = '#050201';
  const ROOM_FLOOR = '#7a6450';

  function drawRoomFloor(ctx, s) {
    ctx.fillStyle = ROOM_FLOOR;
    ctx.fillRect(-s / 2, -s / 2, s, s);
  }

  function drawClosedEdges(ctx, s, sockets) {
    ctx.strokeStyle = ROOM_WALL_LINE;
    ctx.lineWidth = Math.max(2, s * 0.18);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    const h = s / 2;
    if (sockets[0] === 0) { ctx.moveTo(-h, -h); ctx.lineTo(h, -h); }
    if (sockets[1] === 0) { ctx.moveTo(h, -h); ctx.lineTo(h, h); }
    if (sockets[2] === 0) { ctx.moveTo(-h, h); ctx.lineTo(h, h); }
    if (sockets[3] === 0) { ctx.moveTo(-h, -h); ctx.lineTo(-h, h); }
    ctx.stroke();
  }

  const ROOMS_TILES = [
    {
      name: 'solid',
      sockets: [0, 0, 0, 0],
      weight: 1.8,
      rotations: [0],
      draw(ctx, s) {
        ctx.fillStyle = ROOM_WALL;
        ctx.fillRect(-s / 2, -s / 2, s, s);
      },
    },
    {
      name: 'straight',
      sockets: [0, 1, 0, 1],
      weight: 1.0,
      rotations: [0, 1],
      draw(ctx, s) {
        drawRoomFloor(ctx, s);
        drawClosedEdges(ctx, s, [0, 1, 0, 1]);
      },
    },
    {
      name: 'corner',
      sockets: [0, 0, 1, 1],
      weight: 0.55,
      rotations: [0, 1, 2, 3],
      draw(ctx, s) {
        drawRoomFloor(ctx, s);
        drawClosedEdges(ctx, s, [0, 0, 1, 1]);
      },
    },
    {
      name: 'tee',
      sockets: [0, 1, 1, 1],
      weight: 0.2,
      rotations: [0, 1, 2, 3],
      draw(ctx, s) {
        drawRoomFloor(ctx, s);
        drawClosedEdges(ctx, s, [0, 1, 1, 1]);
      },
    },
    {
      name: 'dead-end',
      sockets: [0, 0, 0, 1],
      weight: 0.18,
      rotations: [0, 1, 2, 3],
      draw(ctx, s) {
        drawRoomFloor(ctx, s);
        drawClosedEdges(ctx, s, [0, 0, 0, 1]);
      },
    },
    {
      name: 'open',
      sockets: [1, 1, 1, 1],
      weight: 0.1,
      rotations: [0],
      draw(ctx, s) { drawRoomFloor(ctx, s); },
    },
  ];

  // ---------- Knots tileset (Celtic ribbons) ----------

  const KNOT_OUTLINE = '#2a1406';
  const KNOT_FILL = '#d4a74a';

  function strokeRibbon(ctx, s, drawPath) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = KNOT_OUTLINE;
    ctx.lineWidth = Math.max(3, s * 0.38);
    drawPath(ctx, s);
    ctx.stroke();
    ctx.strokeStyle = KNOT_FILL;
    ctx.lineWidth = Math.max(1, s * 0.22);
    drawPath(ctx, s);
    ctx.stroke();
  }

  const KNOTS_TILES = [
    {
      name: 'blank',
      sockets: [0, 0, 0, 0],
      weight: 1.2,
      rotations: [0],
      draw() {},
    },
    {
      name: 'straight',
      sockets: [0, 1, 0, 1],
      weight: 1.0,
      rotations: [0, 1],
      draw(ctx, s) {
        strokeRibbon(ctx, s, (c, ss) => {
          c.beginPath();
          c.moveTo(-ss / 2, 0);
          c.lineTo(ss / 2, 0);
        });
      },
    },
    {
      name: 'corner',
      sockets: [0, 0, 1, 1],
      weight: 0.9,
      rotations: [0, 1, 2, 3],
      draw(ctx, s) {
        strokeRibbon(ctx, s, (c, ss) => {
          c.beginPath();
          c.arc(-ss / 2, ss / 2, ss / 2, -Math.PI / 2, 0);
        });
      },
    },
    {
      name: 'crossing',
      sockets: [1, 1, 1, 1],
      weight: 0.25,
      rotations: [0],
      draw(ctx, s) {
        // vertical ribbon with a gap at centre (passes under)
        const gap = s * 0.34;
        strokeRibbon(ctx, s, (c, ss) => {
          c.beginPath();
          c.moveTo(0, -ss / 2);
          c.lineTo(0, -gap / 2);
        });
        strokeRibbon(ctx, s, (c, ss) => {
          c.beginPath();
          c.moveTo(0, gap / 2);
          c.lineTo(0, ss / 2);
        });
        // horizontal ribbon on top (passes over)
        strokeRibbon(ctx, s, (c, ss) => {
          c.beginPath();
          c.moveTo(-ss / 2, 0);
          c.lineTo(ss / 2, 0);
        });
      },
    },
  ];

  // ---------- Roads tileset (top-down city grid) ----------

  const ROAD_GRASS = '#1f3a22';
  const ROAD_ASPHALT = '#2d2d33';
  const ROAD_LANE = '#e0c458';
  const ROAD_WIDTH_FRAC = 0.6;

  function drawRoadGrass(ctx, s) {
    ctx.fillStyle = ROAD_GRASS;
    ctx.fillRect(-s / 2, -s / 2, s, s);
  }

  function drawHorizontalBand(ctx, s) {
    const w = s * ROAD_WIDTH_FRAC;
    ctx.fillStyle = ROAD_ASPHALT;
    ctx.fillRect(-s / 2, -w / 2, s, w);
  }

  function drawVerticalBand(ctx, s) {
    const w = s * ROAD_WIDTH_FRAC;
    ctx.fillStyle = ROAD_ASPHALT;
    ctx.fillRect(-w / 2, -s / 2, w, s);
  }

  function drawCornerSW(ctx, s) {
    const w = s * ROAD_WIDTH_FRAC;
    const inner = s / 2 - w / 2;
    const outer = s / 2 + w / 2;
    ctx.fillStyle = ROAD_ASPHALT;
    ctx.beginPath();
    ctx.arc(-s / 2, s / 2, outer, -Math.PI / 2, 0);
    ctx.arc(-s / 2, s / 2, inner, 0, -Math.PI / 2, true);
    ctx.closePath();
    ctx.fill();
  }

  function drawDashedHorizontal(ctx, s) {
    ctx.strokeStyle = ROAD_LANE;
    ctx.lineWidth = Math.max(1, s * 0.035);
    ctx.setLineDash([s * 0.14, s * 0.08]);
    ctx.beginPath();
    ctx.moveTo(-s / 2, 0);
    ctx.lineTo(s / 2, 0);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const ROADS_TILES = [
    {
      name: 'grass',
      sockets: [0, 0, 0, 0],
      weight: 2.0,
      rotations: [0],
      draw(ctx, s) { drawRoadGrass(ctx, s); },
    },
    {
      name: 'straight',
      sockets: [0, 1, 0, 1],
      weight: 1.0,
      rotations: [0, 1],
      draw(ctx, s) {
        drawRoadGrass(ctx, s);
        drawHorizontalBand(ctx, s);
        drawDashedHorizontal(ctx, s);
      },
    },
    {
      name: 'corner',
      sockets: [0, 0, 1, 1],
      weight: 0.5,
      rotations: [0, 1, 2, 3],
      draw(ctx, s) {
        drawRoadGrass(ctx, s);
        drawCornerSW(ctx, s);
      },
    },
    {
      name: 'tee',
      sockets: [0, 1, 1, 1],
      weight: 0.3,
      rotations: [0, 1, 2, 3],
      draw(ctx, s) {
        drawRoadGrass(ctx, s);
        drawHorizontalBand(ctx, s);
        const w = s * ROAD_WIDTH_FRAC;
        ctx.fillStyle = ROAD_ASPHALT;
        ctx.fillRect(-w / 2, 0, w, s / 2);
      },
    },
    {
      name: 'cross',
      sockets: [1, 1, 1, 1],
      weight: 0.15,
      rotations: [0],
      draw(ctx, s) {
        drawRoadGrass(ctx, s);
        drawHorizontalBand(ctx, s);
        drawVerticalBand(ctx, s);
      },
    },
  ];

  // ---------- Stained Glass tileset ----------

  const GLASS_PALETTE = [
    '#8a2342', // ruby
    '#1c4d8c', // sapphire
    '#2d6d4a', // emerald
    '#b78c30', // amber
    '#5a2a7a', // amethyst
    '#a54526', // rust
  ];
  const GLASS_LEAD = '#0c0806';
  const GLASS_SHINE = 'rgba(255, 255, 255, 0.10)';

  function glassColor(x, y) {
    let h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return GLASS_PALETTE[h % GLASS_PALETTE.length];
  }

  function drawGlassFill(ctx, s, x, y) {
    ctx.fillStyle = glassColor(x, y);
    ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.fillStyle = GLASS_SHINE;
    ctx.beginPath();
    ctx.moveTo(-s / 2, -s / 2);
    ctx.lineTo(-s / 2 + s * 0.4, -s / 2);
    ctx.lineTo(-s / 2, -s / 2 + s * 0.4);
    ctx.closePath();
    ctx.fill();
  }

  function strokeLead(ctx, s, drawPath) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = GLASS_LEAD;
    ctx.lineWidth = Math.max(2, s * 0.14);
    drawPath(ctx, s);
    ctx.stroke();
  }

  const GLASS_TILES = [
    {
      name: 'pane',
      sockets: [0, 0, 0, 0],
      weight: 1.2,
      rotations: [0],
      draw(ctx, s, x, y) { drawGlassFill(ctx, s, x, y); },
    },
    {
      name: 'straight',
      sockets: [0, 1, 0, 1],
      weight: 1.0,
      rotations: [0, 1],
      draw(ctx, s, x, y) {
        drawGlassFill(ctx, s, x, y);
        strokeLead(ctx, s, (c, ss) => {
          c.beginPath();
          c.moveTo(-ss / 2, 0);
          c.lineTo(ss / 2, 0);
        });
      },
    },
    {
      name: 'corner',
      sockets: [0, 0, 1, 1],
      weight: 0.9,
      rotations: [0, 1, 2, 3],
      draw(ctx, s, x, y) {
        drawGlassFill(ctx, s, x, y);
        strokeLead(ctx, s, (c, ss) => {
          c.beginPath();
          c.arc(-ss / 2, ss / 2, ss / 2, -Math.PI / 2, 0);
        });
      },
    },
    {
      name: 'tee',
      sockets: [0, 1, 1, 1],
      weight: 0.3,
      rotations: [0, 1, 2, 3],
      draw(ctx, s, x, y) {
        drawGlassFill(ctx, s, x, y);
        strokeLead(ctx, s, (c, ss) => {
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
      draw(ctx, s, x, y) {
        drawGlassFill(ctx, s, x, y);
        strokeLead(ctx, s, (c, ss) => {
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
    { name: 'Rooms', tiles: ROOMS_TILES },
    { name: 'Knots', tiles: KNOTS_TILES },
    { name: 'Roads', tiles: ROADS_TILES },
    { name: 'Glass', tiles: GLASS_TILES },
  ];

  // Precomputed entropy-tint palette (dark teal → brighter) for cell bg.
  const TINT_STEPS = 16;
  const TINTS = [];
  for (let i = 0; i < TINT_STEPS; i++) {
    const t = i / (TINT_STEPS - 1);
    const r = Math.round(5 + (30 - 5) * t);
    const g = Math.round(9 + (56 - 9) * t);
    const b = Math.round(12 + (78 - 12) * t);
    TINTS.push(`rgb(${r},${g},${b})`);
  }

  function resetCells(world) {
    const total = world.N * world.N;
    for (let i = 0; i < total; i++) {
      world.cells[i].mask = world.fullMask;
      world.cells[i].collapsed = -1;
      world.cells[i].noise = Math.random() * 1e-4;
    }
    world.collapsedCount = 0;
    world.done = false;
    world.contradicted = false;
    world.contradictionIdx = -1;
    world.stepAccum = 0;
  }

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
      cells[i] = { mask: world.fullMask, collapsed: -1, noise: Math.random() * 1e-4 };
    }
    world.cells = cells;
    world.collapsedCount = 0;
    world.contradictions = 0;
    world.done = false;
    world.contradicted = false;
    world.contradictionIdx = -1;
    world.stepAccum = 0;
    world.flashTimer = 0;
  }

  function collapseAt(world, idx) {
    const c = world.cells[idx];
    if (c.collapsed >= 0 || c.mask === 0) return;
    const { nVariants, weights } = world;
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
    if (chosen < 0) chosen = 31 - Math.clz32(c.mask);
    c.mask = 1 << chosen;
    c.collapsed = chosen;
    world.collapsedCount++;
    propagate(world, idx);
  }

  function observe(world) {
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
      if (count === 0) {
        world.contradicted = true;
        world.contradictionIdx = i;
        return false;
      }
      if (count === 1) {
        c.collapsed = 31 - Math.clz32(c.mask);
        world.collapsedCount++;
        continue;
      }
      const H = Math.log(sumW) - sumWlogW / sumW + c.noise;
      if (H < bestH) { bestH = H; best = i; }
    }

    if (best < 0) { world.done = true; return false; }
    collapseAt(world, best);
    return !world.contradicted;
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

        let allowed = 0;
        for (let t = 0; t < nVariants; t++) {
          if (mask & (1 << t)) allowed |= adjacency[t][d];
        }
        const newMask = nc.mask & allowed;
        if (newMask !== nc.mask) {
          if (newMask === 0) {
            nc.mask = 0;
            world.contradicted = true;
            world.contradictionIdx = nIdx;
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

  function drawVariant(ctx, cx, cy, s, variant, baseTiles, gx, gy) {
    const base = baseTiles[variant.baseIdx];
    ctx.save();
    ctx.translate(cx, cy);
    if (variant.rot) ctx.rotate(variant.rot * Math.PI / 2);
    base.draw(ctx, s, gx, gy);
    ctx.restore();
  }

  function drawVariantAlpha(ctx, cx, cy, s, variant, baseTiles, alpha, gx, gy) {
    const base = baseTiles[variant.baseIdx];
    if (base.drawGhost) { base.drawGhost(ctx, s); return; }
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * alpha;
    ctx.save();
    ctx.translate(cx, cy);
    if (variant.rot) ctx.rotate(variant.rot * Math.PI / 2);
    base.draw(ctx, s, gx, gy);
    ctx.restore();
    ctx.globalAlpha = prev;
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
      if (world.flashTimer > 0) {
        world.flashTimer -= dt;
        if (world.flashTimer <= 0) {
          world.flashTimer = 0;
          resetCells(world);
        }
        return;
      }
      if (world.done) return;
      world.stepAccum += dt * speed;
      let budget = Math.floor(world.stepAccum);
      if (budget <= 0) return;
      world.stepAccum -= budget;
      if (budget > 2000) budget = 2000;
      while (budget-- > 0) {
        if (!observe(world)) break;
      }
      if (world.contradicted) {
        world.contradictions++;
        world.flashTimer = FLASH_DURATION;
      }
    },

    onClick(wx, wy, world) {
      if (!world.cells || world.flashTimer > 0) return;
      const N = world.N;
      const col = Math.floor(wx);
      const row = Math.floor(-wy);
      if (col < 0 || col >= N || row < 0 || row >= N) return;
      const idx = row * N + col;
      if (world.cells[idx].collapsed >= 0) return;
      collapseAt(world, idx);
      if (world.contradicted) {
        world.contradictions++;
        world.flashTimer = FLASH_DURATION;
      }
      if (world.collapsedCount >= N * N && !world.contradicted) {
        world.done = true;
      }
    },

    draw(ctx, project, world) {
      if (!world.cells) return;
      const N = world.N;
      const a = project(0, 0);
      const b = project(1, -1);
      const s = b.x - a.x;
      const gridOrigin = project(0, 0);
      const totalPx = s * N;

      // base fill (darkest tint) under the whole grid
      ctx.fillStyle = TINTS[0];
      ctx.fillRect(gridOrigin.x, gridOrigin.y, totalPx, totalPx);

      // entropy tint overlay: fill any cell whose tint differs from level 0
      const nVariants = world.nVariants;
      const denom = Math.max(1, nVariants - 1);
      // accumulate rects per tint level to minimise fillStyle thrash
      const byTint = new Array(TINT_STEPS);
      for (let i = 0; i < TINT_STEPS; i++) byTint[i] = null;

      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const c = world.cells[y * N + x];
          if (c.collapsed >= 0) continue;
          const count = popcount(c.mask);
          if (count <= 1) continue;
          const t = (nVariants - count) / denom; // 0..1 as cell narrows
          const level = Math.min(TINT_STEPS - 1, Math.max(1, Math.floor(t * TINT_STEPS)));
          if (level <= 0) continue;
          (byTint[level] || (byTint[level] = [])).push(x, y);
        }
      }
      for (let level = 1; level < TINT_STEPS; level++) {
        const arr = byTint[level];
        if (!arr) continue;
        ctx.fillStyle = TINTS[level];
        for (let i = 0; i < arr.length; i += 2) {
          const x = arr[i], y = arr[i + 1];
          ctx.fillRect(gridOrigin.x + x * s, gridOrigin.y + y * s, s, s);
        }
      }

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

      // tiles: collapsed cells full; near-collapsed cells (≤3 options) ghosted
      const variants = world.variants;
      const baseTiles = world.baseTiles;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const c = world.cells[y * N + x];
          const cx = gridOrigin.x + (x + 0.5) * s;
          const cy = gridOrigin.y + (y + 0.5) * s;
          if (c.collapsed >= 0) {
            drawVariant(ctx, cx, cy, s, variants[c.collapsed], baseTiles, x, y);
            continue;
          }
          const count = popcount(c.mask);
          if (count > 0 && count <= 3) {
            const alpha = 0.55 / count;
            let m = c.mask;
            while (m) {
              const t = 31 - Math.clz32(m);
              m &= ~(1 << t);
              drawVariantAlpha(ctx, cx, cy, s, variants[t], baseTiles, alpha, x, y);
            }
          }
        }
      }

      // contradiction flash
      if (world.flashTimer > 0 && world.contradictionIdx >= 0) {
        const k = world.flashTimer / FLASH_DURATION;
        const ix = world.contradictionIdx % N;
        const iy = (world.contradictionIdx / N) | 0;
        ctx.fillStyle = `rgba(220, 70, 70, ${0.12 * k})`;
        ctx.fillRect(gridOrigin.x, gridOrigin.y, totalPx, totalPx);
        ctx.fillStyle = `rgba(240, 80, 80, ${0.85 * k})`;
        ctx.fillRect(gridOrigin.x + ix * s, gridOrigin.y + iy * s, s, s);
      }
    },

    bbox(world) {
      if (!world.N) return null;
      return { minX: 0, maxX: world.N, minY: -world.N, maxY: 0 };
    },

    status(world) {
      const total = world.N * world.N;
      let suffix = '';
      if (world.flashTimer > 0) suffix = ' ✗';
      else if (world.done) suffix = ' ✓';
      const ctra = world.contradictions ? `  contra=${world.contradictions}` : '';
      return `cells=${world.collapsedCount}/${total}${ctra}${suffix}`;
    },
  };

  (window.APPROACHES = window.APPROACHES || []).push(APPROACH);
})();
