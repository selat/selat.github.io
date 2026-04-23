// Iterated function system via the chaos game: start at a point, each tick
// pick an affine transform by its weight, apply it, plot the new point, repeat.
// After ~20 burn-in steps the orbit lies on the attractor. Each transform has
// its own color so the sub-regions are visually distinguishable. Points are
// written directly into an off-screen ImageData via a Uint32 view (one write
// per point), then putImageData once per frame.

(function () {
  function pack(rgb) {
    return ((0xFF << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;
  }

  function makeBuffer(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    return { canvas: c, ctx: cx };
  }

  const PRESETS = [
    {
      name: 'Barnsley fern',
      transforms: [
        { a:  0.00, b:  0.00, c:  0.00, d: 0.16, e: 0.00, f: 0.00, w: 0.01, color: [90, 60, 35] },
        { a:  0.85, b:  0.04, c: -0.04, d: 0.85, e: 0.00, f: 1.60, w: 0.85, color: [95, 185, 90] },
        { a:  0.20, b: -0.26, c:  0.23, d: 0.22, e: 0.00, f: 1.60, w: 0.07, color: [120, 220, 70] },
        { a: -0.15, b:  0.28, c:  0.26, d: 0.24, e: 0.00, f: 0.44, w: 0.07, color: [70, 175, 115] },
      ],
      bbox: { minX: -3, maxX: 3, minY: 0, maxY: 10 },
      bufScale: 80,
    },
    {
      name: 'Maple leaf',
      transforms: [
        { a: 0.14, b:  0.01, c:  0.00, d: 0.51, e: -0.08, f: -1.31, w: 0.10, color: [155, 80, 40] },
        { a: 0.43, b:  0.52, c: -0.45, d: 0.50, e:  1.49, f: -0.75, w: 0.35, color: [220, 100, 50] },
        { a: 0.45, b: -0.49, c:  0.47, d: 0.47, e: -1.62, f: -0.74, w: 0.35, color: [200, 140, 60] },
        { a: 0.49, b:  0.00, c:  0.00, d: 0.51, e:  0.02, f:  1.62, w: 0.20, color: [180, 200, 80] },
      ],
      bbox: { minX: -3, maxX: 3, minY: -3, maxY: 3 },
      bufScale: 120,
    },
    {
      name: 'Dragon',
      transforms: [
        { a:  0.50, b: -0.50, c:  0.50, d:  0.50, e: 0, f: 0, w: 0.5, color: [80, 180, 220] },
        { a: -0.50, b: -0.50, c:  0.50, d: -0.50, e: 1, f: 0, w: 0.5, color: [220, 120, 180] },
      ],
      bbox: { minX: -0.5, maxX: 1.5, minY: -0.7, maxY: 1.0 },
      bufScale: 400,
    },
    {
      name: 'Sierpinski',
      transforms: [
        { a: 0.5, b: 0, c: 0, d: 0.5, e: 0.00, f: 0.0, w: 0.334, color: [220, 200, 100] },
        { a: 0.5, b: 0, c: 0, d: 0.5, e: 0.50, f: 0.0, w: 0.333, color: [100, 200, 220] },
        { a: 0.5, b: 0, c: 0, d: 0.5, e: 0.25, f: 0.5, w: 0.333, color: [220, 100, 200] },
      ],
      bbox: { minX: -0.05, maxX: 1.05, minY: -0.05, maxY: 1.05 },
      bufScale: 600,
    },
  ];

  function chooseTransform(transforms) {
    const r = Math.random();
    let acc = 0;
    for (let i = 0; i < transforms.length; i++) {
      acc += transforms[i].w;
      if (r < acc) return transforms[i];
    }
    return transforms[transforms.length - 1];
  }

  const APPROACH = {
    id: 'ifs',
    name: 'IFS',
    presets: PRESETS,
    params: [
      { key: 'budget', label: 'points', min: 1000, max: 300000, step: 1000, default: 60000, fmt: (v) => `${((v | 0) / 1000).toFixed(0)}k` },
    ],

    init(world, preset, params) {
      world.transforms = preset.transforms;
      world.colorU32 = preset.transforms.map((t) => pack(t.color));
      world.ibbox = preset.bbox;
      world.bufScale = preset.bufScale;
      world.bufW = Math.ceil((preset.bbox.maxX - preset.bbox.minX) * preset.bufScale);
      world.bufH = Math.ceil((preset.bbox.maxY - preset.bbox.minY) * preset.bufScale);
      world.buffer = makeBuffer(world.bufW, world.bufH);
      world.imgData = world.buffer.ctx.createImageData(world.bufW, world.bufH);
      world.data32 = new Uint32Array(world.imgData.data.buffer);
      world.x = 0;
      world.y = 0;
      world.plotted = 0;
      world.budget = params.budget | 0;
      world.done = false;
      world.stepAccum = 0;
      world.dirty = false;

      for (let i = 0; i < 20; i++) {
        const t = chooseTransform(world.transforms);
        const nx = t.a * world.x + t.b * world.y + t.e;
        const ny = t.c * world.x + t.d * world.y + t.f;
        world.x = nx;
        world.y = ny;
      }

      const pad = 0.05 * Math.max(preset.bbox.maxX - preset.bbox.minX, preset.bbox.maxY - preset.bbox.minY);
      world.rawBbox = {
        minX: preset.bbox.minX - pad,
        maxX: preset.bbox.maxX + pad,
        minY: preset.bbox.minY - pad,
        maxY: preset.bbox.maxY + pad,
      };
    },

    step(world, dt, params, speed) {
      if (world.done) {
        if (world.dirty) {
          world.buffer.ctx.putImageData(world.imgData, 0, 0);
          world.dirty = false;
        }
        return;
      }
      const effective = speed * 50;
      world.stepAccum += dt * effective;
      let budget = Math.floor(world.stepAccum);
      if (budget <= 0) return;
      if (budget > 120000) budget = 120000;
      world.stepAccum -= budget;

      const target = world.budget;
      const W = world.bufW, H = world.bufH;
      const scale = world.bufScale;
      const minX = world.ibbox.minX, maxY = world.ibbox.maxY;
      const data32 = world.data32;
      const colors = world.colorU32;
      const transforms = world.transforms;
      let x = world.x, y = world.y;

      for (let i = 0; i < budget; i++) {
        if (world.plotted >= target) { world.done = true; break; }
        const r = Math.random();
        let acc = 0;
        let ti = 0;
        for (; ti < transforms.length; ti++) {
          acc += transforms[ti].w;
          if (r < acc) break;
        }
        if (ti >= transforms.length) ti = transforms.length - 1;
        const t = transforms[ti];
        const nx = t.a * x + t.b * y + t.e;
        const ny = t.c * x + t.d * y + t.f;
        x = nx; y = ny;
        const px = ((x - minX) * scale) | 0;
        const py = ((maxY - y) * scale) | 0;
        if (px >= 0 && px < W && py >= 0 && py < H) {
          data32[py * W + px] = colors[ti];
        }
        world.plotted++;
      }

      world.x = x;
      world.y = y;
      world.buffer.ctx.putImageData(world.imgData, 0, 0);
      world.dirty = false;
    },

    draw(ctx, project, world) {
      const bb = world.ibbox;
      const tl = project(bb.minX, bb.maxY);
      const br = project(bb.maxX, bb.minY);
      const prev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(world.buffer.canvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.imageSmoothingEnabled = prev;
    },

    bbox(world) { return world.rawBbox; },

    status(world) {
      const k = (world.plotted / 1000).toFixed(1);
      const kb = (world.budget / 1000).toFixed(0);
      return `n=${k}k/${kb}k${world.done ? ' ✓' : ''}`;
    },
  };

  (window.APPROACHES = window.APPROACHES || []).push(APPROACH);
})();
