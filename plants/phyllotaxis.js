// Vogel's phyllotaxis: dot i at (r cos θ, r sin θ) with θ = i × divergence,
// r = spacing × √i. At divergence = 137.508° (golden angle) the dots tile
// optimally and form sunflower/pinecone Fibonacci spirals. Slight detuning
// (e.g. 137.3°) breaks the packing into visible radial arms.

(function () {
  const NUM_BUCKETS = 24;

  function mixCh(a, b, t) { return Math.round(a + (b - a) * t); }
  function rgbStr(a, b, t) {
    return `rgb(${mixCh(a[0], b[0], t)},${mixCh(a[1], b[1], t)},${mixCh(a[2], b[2], t)})`;
  }

  function colorAt(palette, t) {
    switch (palette) {
      case 'seed': return rgbStr([95, 60, 30], [230, 200, 60], t);
      case 'petal': return rgbStr([220, 200, 210], [240, 150, 180], t);
      case 'pinecone': return rgbStr([80, 50, 25], [140, 180, 80], t);
      case 'rose': return rgbStr([140, 40, 60], [230, 100, 120], t);
      case 'aster': return rgbStr([120, 60, 140], [230, 180, 80], t);
      case 'spiral': return `hsl(${(t * 360) | 0}, 70%, 60%)`;
      default: return rgbStr([100, 80, 50], [210, 190, 80], t);
    }
  }

  const PRESETS = [
    { name: 'Sunflower', palette: 'seed',     params: { angle: 137.508, count: 1800, spacing: 3.5, size: 2 } },
    { name: 'Daisy',     palette: 'petal',    params: { angle: 137.508, count: 300,  spacing: 9,   size: 5 } },
    { name: 'Pinecone',  palette: 'pinecone', params: { angle: 137.508, count: 800,  spacing: 4,   size: 2.5 } },
    { name: 'Rose',      palette: 'rose',     params: { angle: 137.508, count: 1200, spacing: 3,   size: 2.5 } },
    { name: 'Aster',     palette: 'aster',    params: { angle: 137.508, count: 1500, spacing: 3.5, size: 2 } },
    { name: 'Mis-tuned', palette: 'spiral',   params: { angle: 137.3,   count: 1500, spacing: 4,   size: 2 } },
  ];

  const APPROACH = {
    id: 'phyllotaxis',
    name: 'Phyllotaxis',
    presets: PRESETS,
    params: [
      { key: 'angle',   label: 'angle', min: 90,  max: 180,  step: 0.01, default: 137.508, fmt: (v) => v.toFixed(3) + '°' },
      { key: 'count',   label: 'count', min: 50,  max: 3000, step: 50,   default: 1500,    fmt: (v) => String(v | 0) },
      { key: 'spacing', label: 'space', min: 1,   max: 15,   step: 0.1,  default: 4,       fmt: (v) => v.toFixed(1) },
      { key: 'size',    label: 'size',  min: 0.5, max: 8,    step: 0.1,  default: 2,       fmt: (v) => v.toFixed(1) },
    ],

    init(world, preset, params) {
      world.count = params.count | 0;
      world.angle = params.angle * Math.PI / 180;
      world.spacing = params.spacing;
      world.size = params.size;
      world.palette = preset.palette;
      world.reveal = 0;
      const maxR = params.spacing * Math.sqrt(world.count) + params.size + 4;
      world.rawBbox = { minX: -maxR, maxX: maxR, minY: -maxR, maxY: maxR };
    },

    step(world, dt, params, speed) {
      if (world.reveal >= world.count) return;
      world.reveal = Math.min(world.count, world.reveal + speed * dt);
    },

    draw(ctx, project, world) {
      const reveal = world.reveal | 0;
      if (reveal <= 0) return;
      const n = world.count;
      const angle = world.angle;
      const spacing = world.spacing;
      const size = world.size;

      for (let bi = 0; bi < NUM_BUCKETS; bi++) {
        const lo = Math.ceil((bi * n) / NUM_BUCKETS);
        const hi = Math.min(reveal, Math.ceil(((bi + 1) * n) / NUM_BUCKETS));
        if (hi <= lo) continue;
        const t = NUM_BUCKETS > 1 ? bi / (NUM_BUCKETS - 1) : 0.5;
        ctx.fillStyle = colorAt(world.palette, t);
        ctx.beginPath();
        for (let i = lo; i < hi; i++) {
          const r = spacing * Math.sqrt(i);
          const theta = i * angle;
          const x = r * Math.cos(theta);
          const y = r * Math.sin(theta);
          const p = project(x, y);
          ctx.moveTo(p.x + size, p.y);
          ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    },

    bbox(world) { return world.rawBbox; },

    status(world) {
      return `n=${world.reveal | 0}/${world.count}`;
    },
  };

  (window.APPROACHES = window.APPROACHES || []).push(APPROACH);
})();
