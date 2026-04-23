// Diffusion-limited aggregation. Random walkers drift until they land next to
// a stuck cell, then stick (with some probability). Growth forms dendritic
// fractals. Each preset picks a seed shape + walker launch region.

(function () {
  const LAUNCH_MARGIN = 4;
  const MAX_WALKER_STEPS = 50000;
  const MAX_WALKERS_PER_FRAME = 800;

  const TRUNK = [120, 78, 42];
  const MID = [150, 140, 60];
  const LEAF = [110, 200, 90];
  function mixCh(a, b, t) { return Math.round(a + (b - a) * t); }
  function colorAt(t) {
    if (t < 0.5) {
      const u = t * 2;
      return `rgb(${mixCh(TRUNK[0], MID[0], u)},${mixCh(TRUNK[1], MID[1], u)},${mixCh(TRUNK[2], MID[2], u)})`;
    }
    const u = (t - 0.5) * 2;
    return `rgb(${mixCh(MID[0], LEAF[0], u)},${mixCh(MID[1], LEAF[1], u)},${mixCh(MID[2], LEAF[2], u)})`;
  }

  function makeBuffer(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    return { canvas: c, ctx: cx };
  }

  function setCell(world, i, j, params) {
    const idx = j * world.W + i;
    if (world.occupancy[idx]) return;
    world.occupancy[idx] = 1;
    world.stuckCount++;
    const cap = Math.max(1, params.maxParticles | 0);
    const t = Math.min(1, world.stuckCount / cap);
    world.buffer.ctx.fillStyle = colorAt(t);
    world.buffer.ctx.fillRect(i, j, 1, 1);
    const dx = i - world.seedCx, dy = j - world.seedCy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > world.maxRadius) world.maxRadius = d;
  }

  function spawnWalker(world) {
    const W = world.W, H = world.H;
    if (world.launch === 'circle') {
      const r = world.maxRadius + LAUNCH_MARGIN;
      for (let tries = 0; tries < 30; tries++) {
        const theta = Math.random() * Math.PI * 2;
        const i = Math.round(world.seedCx + Math.cos(theta) * r);
        const j = Math.round(world.seedCy + Math.sin(theta) * r);
        if (i > 0 && i < W - 1 && j > 0 && j < H - 1 && !world.occupancy[j * W + i]) {
          return [i, j];
        }
      }
      return null;
    }
    if (world.launch === 'top-row') {
      for (let tries = 0; tries < 20; tries++) {
        const i = Math.floor(Math.random() * W);
        if (!world.occupancy[1 * W + i]) return [i, 1];
      }
      return null;
    }
    return null;
  }

  function runWalker(world, params) {
    const spawn = spawnWalker(world);
    if (!spawn) return;
    let i = spawn[0], j = spawn[1];
    const W = world.W, H = world.H;
    const stickiness = params.stickiness;
    const dx = params.driftX || 0;
    const dy = params.driftY || 0;

    // Cumulative thresholds for 4-direction step with drift bias.
    const cR = 0.25 + dx * 0.25;
    const cL = cR + 0.25 - dx * 0.25;
    const cD = cL + 0.25 + dy * 0.25;

    let killR2 = Infinity;
    if (world.launch === 'circle') {
      const killR = world.maxRadius * 2 + 20;
      killR2 = killR * killR;
    }

    for (let s = 0; s < MAX_WALKER_STEPS; s++) {
      const r = Math.random();
      let di = 0, dj = 0;
      if (r < cR) di = 1;
      else if (r < cL) di = -1;
      else if (r < cD) dj = 1;
      else dj = -1;

      const ni = i + di, nj = j + dj;
      if (ni <= 0 || ni >= W - 1 || nj <= 0 || nj >= H - 1) return;
      if (killR2 !== Infinity) {
        const ddx = ni - world.seedCx, ddy = nj - world.seedCy;
        if (ddx * ddx + ddy * ddy > killR2) return;
      }

      if (world.occupancy[nj * W + ni]) {
        if (Math.random() < stickiness) {
          setCell(world, i, j, params);
          return;
        }
        continue;
      }
      i = ni; j = nj;
    }
  }

  const PRESETS = [
    {
      name: 'Radial',
      gridW: 260, gridH: 260,
      seed: 'center', launch: 'circle',
      params: { stickiness: 1, driftX: 0, driftY: 0, maxParticles: 5000 },
    },
    {
      name: 'Coral',
      gridW: 320, gridH: 220,
      seed: 'bottom-line', launch: 'top-row',
      params: { stickiness: 1, driftX: 0, driftY: 0.5, maxParticles: 12000 },
    },
    {
      name: 'Frost',
      gridW: 300, gridH: 220,
      seed: 'bottom-line', launch: 'top-row',
      params: { stickiness: 0.3, driftX: 0, driftY: 0.4, maxParticles: 14000 },
    },
    {
      name: 'Windswept',
      gridW: 280, gridH: 240,
      seed: 'center', launch: 'circle',
      params: { stickiness: 1, driftX: 0.3, driftY: 0, maxParticles: 6000 },
    },
  ];

  const APPROACH = {
    id: 'dla',
    name: 'DLA',
    presets: PRESETS,
    params: [
      { key: 'stickiness', label: 'stick', min: 0.05, max: 1, step: 0.05, default: 1, fmt: (v) => v.toFixed(2) },
      { key: 'driftX', label: 'driftX', min: -1, max: 1, step: 0.05, default: 0, fmt: (v) => v.toFixed(2) },
      { key: 'driftY', label: 'driftY', min: -1, max: 1, step: 0.05, default: 0, fmt: (v) => v.toFixed(2) },
      { key: 'maxParticles', label: 'max', min: 500, max: 30000, step: 500, default: 5000, fmt: (v) => String(v | 0) },
    ],

    init(world, preset, params) {
      const W = preset.gridW, H = preset.gridH;
      world.W = W; world.H = H;
      world.occupancy = new Uint8Array(W * H);
      world.buffer = makeBuffer(W, H);
      world.stuckCount = 0;
      world.maxRadius = 1;
      world.done = false;
      world.stepAccum = 0;
      world.launch = preset.launch;
      world.seedCx = Math.floor(W / 2);
      world.seedCy = Math.floor(H / 2);

      if (preset.seed === 'center') {
        setCell(world, world.seedCx, world.seedCy, params);
      } else if (preset.seed === 'bottom-line') {
        const j = H - 2;
        for (let i = 0; i < W; i++) setCell(world, i, j, params);
        world.seedCy = j;
      }

      world.rawBbox = { minX: -W / 2, maxX: W / 2, minY: -H / 2, maxY: H / 2 };
    },

    step(world, dt, params, speed) {
      if (world.done) return;
      world.stepAccum += dt * speed;
      let budget = Math.floor(world.stepAccum);
      if (budget <= 0) return;
      if (budget > MAX_WALKERS_PER_FRAME) budget = MAX_WALKERS_PER_FRAME;
      world.stepAccum -= budget;
      const cap = params.maxParticles | 0;
      for (let i = 0; i < budget; i++) {
        if (world.stuckCount >= cap) { world.done = true; break; }
        runWalker(world, params);
      }
    },

    draw(ctx, project, world) {
      const W = world.W, H = world.H;
      const tl = project(-W / 2, H / 2);
      const br = project(W / 2, -H / 2);
      const prev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(world.buffer.canvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.imageSmoothingEnabled = prev;
    },

    bbox(world) { return world.rawBbox; },

    status(world) {
      return `part=${world.stuckCount}${world.done ? ' ✓' : ''}`;
    },
  };

  (window.APPROACHES = window.APPROACHES || []).push(APPROACH);
})();
