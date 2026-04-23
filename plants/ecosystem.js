// Ecosystem cellular automaton. Each cell holds a species id (0 = empty).
// Two update rules:
//   - rps: every cell looks at one random 4-neighbor per tick. Empty cells
//     get colonized (weighted by spread); occupied cells get invaded when the
//     neighbor's species beats theirs, otherwise die at a baseline rate.
//     With a 3-cycle beats relation this produces spiral waves.
//   - fire: Drossel-Schwabl forest fire. Burning spreads to adjacent trees;
//     burning cells become empty next tick; empty cells regrow with prob g;
//     a tree spontaneously ignites with prob f (lightning).
// Grid is toroidal. Pixels painted to an off-screen buffer via
// Uint32Array(ImageData.data.buffer); full buffer repaint per tick.

(function () {
  const MAX_TICKS_PER_FRAME = 30;

  function makeBuffer(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    return { canvas: c, ctx: cx };
  }

  function pack(rgb) {
    return ((0xFF << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;
  }

  function updateRPS(world, params) {
    const W = world.W, H = world.H;
    const grid = world.grid, next = world.next;
    const sp = world.species;
    const spreadK = params.spreadScale;
    const deathK = params.deathScale;
    const invasion = params.aggression;

    for (let j = 0; j < H; j++) {
      const row = j * W;
      for (let i = 0; i < W; i++) {
        const idx = row + i;
        const cur = grid[idx];

        const d = (Math.random() * 4) | 0;
        let di = 0, dj = 0;
        if (d === 0) di = 1; else if (d === 1) di = -1; else if (d === 2) dj = 1; else dj = -1;
        const ni = (i + di + W) % W;
        const nj = (j + dj + H) % H;
        const nbr = grid[nj * W + ni];

        if (cur === 0) {
          if (nbr !== 0 && Math.random() < sp[nbr].spread * spreadK) {
            next[idx] = nbr;
          } else {
            next[idx] = 0;
          }
        } else {
          const beats = nbr !== 0 && nbr !== cur && sp[nbr].beats && sp[nbr].beats.indexOf(cur) >= 0;
          if (beats && Math.random() < sp[nbr].spread * spreadK * invasion) {
            next[idx] = nbr;
          } else if (Math.random() < sp[cur].death * deathK) {
            next[idx] = 0;
          } else {
            next[idx] = cur;
          }
        }
      }
    }

    const tmp = world.grid; world.grid = world.next; world.next = tmp;
  }

  function updateFire(world, params) {
    const W = world.W, H = world.H;
    const grid = world.grid, next = world.next;
    const growth = params.growth;
    const lightning = params.lightning;

    for (let j = 0; j < H; j++) {
      const row = j * W;
      const jm = ((j - 1 + H) % H) * W;
      const jp = ((j + 1) % H) * W;
      for (let i = 0; i < W; i++) {
        const idx = row + i;
        const cur = grid[idx];
        if (cur === 2) {
          next[idx] = 0;
        } else if (cur === 0) {
          next[idx] = Math.random() < growth ? 1 : 0;
        } else {
          const im = (i - 1 + W) % W;
          const ip = (i + 1) % W;
          if (grid[jm + i] === 2 || grid[jp + i] === 2 || grid[row + im] === 2 || grid[row + ip] === 2) {
            next[idx] = 2;
          } else if (Math.random() < lightning) {
            next[idx] = 2;
          } else {
            next[idx] = 1;
          }
        }
      }
    }

    const tmp = world.grid; world.grid = world.next; world.next = tmp;
  }

  function initGrid(world, preset) {
    const W = world.W, H = world.H;
    const grid = world.grid;
    const nSpecies = preset.species.length;
    switch (preset.init) {
      case 'empty-seed': {
        const cx = (W / 2) | 0, cy = (H / 2) | 0;
        for (let dy = -3; dy <= 3; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            grid[((cy + dy + H) % H) * W + ((cx + dx + W) % W)] = 1;
          }
        }
        break;
      }
      case 'random-sparse': {
        for (let k = 0; k < W * H; k++) {
          const r = Math.random();
          if (r < 0.08) grid[k] = 1;
          else if (r < 0.12) grid[k] = 2;
        }
        break;
      }
      case 'random-dense': {
        for (let k = 0; k < W * H; k++) {
          grid[k] = (Math.random() * nSpecies) | 0;
        }
        break;
      }
      case 'trees-some': {
        for (let k = 0; k < W * H; k++) {
          grid[k] = Math.random() < 0.5 ? 1 : 0;
        }
        for (let s = 0; s < 3; s++) {
          grid[(Math.random() * W * H) | 0] = 2;
        }
        break;
      }
    }
  }

  function renderBuffer(world) {
    const n = world.W * world.H;
    const data32 = world.data32;
    const palette = world.palette32;
    const grid = world.grid;
    for (let i = 0; i < n; i++) data32[i] = palette[grid[i]];
    world.buffer.ctx.putImageData(world.imgData, 0, 0);
  }

  function countSpecies(world) {
    const counts = new Array(world.species.length).fill(0);
    const grid = world.grid;
    const n = world.W * world.H;
    for (let i = 0; i < n; i++) counts[grid[i]]++;
    return counts;
  }

  const PRESETS = [
    {
      name: 'Moss',
      W: 200, H: 200,
      type: 'rps',
      init: 'empty-seed',
      species: [
        { name: 'empty', color: [15, 15, 18] },
        { name: 'moss', color: [93, 187, 79], spread: 0.25, death: 0.003 },
      ],
    },
    {
      name: 'Grass vs trees',
      W: 220, H: 180,
      type: 'rps',
      init: 'random-sparse',
      species: [
        { name: 'empty', color: [15, 15, 18] },
        { name: 'grass', color: [150, 220, 80], spread: 0.4, death: 0.04, beats: [] },
        { name: 'tree', color: [55, 110, 45], spread: 0.08, death: 0.002, beats: [1] },
      ],
    },
    {
      name: 'Rock-paper-scissors',
      W: 260, H: 200,
      type: 'rps',
      init: 'random-dense',
      species: [
        { name: 'empty', color: [15, 15, 18] },
        { name: 'A', color: [220, 80, 80], spread: 0.35, death: 0.002, beats: [2] },
        { name: 'B', color: [80, 190, 200], spread: 0.35, death: 0.002, beats: [3] },
        { name: 'C', color: [220, 200, 80], spread: 0.35, death: 0.002, beats: [1] },
      ],
    },
    {
      name: 'Forest fire',
      W: 240, H: 180,
      type: 'fire',
      init: 'trees-some',
      species: [
        { name: 'empty', color: [20, 15, 10] },
        { name: 'tree', color: [65, 140, 55] },
        { name: 'burning', color: [255, 140, 40] },
      ],
    },
  ];

  const APPROACH = {
    id: 'ecosystem',
    name: 'Ecosystem CA',
    presets: PRESETS,

    params(preset) {
      if (preset && preset.type === 'fire') {
        return [
          { key: 'growth', label: 'grow', min: 0.001, max: 0.05, step: 0.001, default: 0.01, fmt: (v) => v.toFixed(3) },
          { key: 'lightning', label: 'spark', min: 0, max: 0.001, step: 0.00001, default: 0.00005, fmt: (v) => v.toExponential(1) },
        ];
      }
      return [
        { key: 'spreadScale', label: 'spread', min: 0.1, max: 3, step: 0.05, default: 1, fmt: (v) => v.toFixed(2) },
        { key: 'deathScale', label: 'death', min: 0.1, max: 5, step: 0.1, default: 1, fmt: (v) => v.toFixed(1) },
        { key: 'aggression', label: 'invade', min: 0.1, max: 1, step: 0.05, default: 0.7, fmt: (v) => v.toFixed(2) },
      ];
    },

    init(world, preset, params) {
      const W = preset.W, H = preset.H;
      world.W = W; world.H = H;
      world.grid = new Uint8Array(W * H);
      world.next = new Uint8Array(W * H);
      world.buffer = makeBuffer(W, H);
      world.imgData = world.buffer.ctx.createImageData(W, H);
      world.data32 = new Uint32Array(world.imgData.data.buffer);
      world.species = preset.species;
      world.palette32 = preset.species.map((s) => pack(s.color));
      world.updateFn = preset.type === 'fire' ? updateFire : updateRPS;
      world.tick = 0;
      world.stepAccum = 0;
      world.done = false;
      world.rawBbox = { minX: -W / 2, maxX: W / 2, minY: -H / 2, maxY: H / 2 };
      initGrid(world, preset);
      renderBuffer(world);
      world.counts = countSpecies(world);
    },

    step(world, dt, params, speed) {
      if (world.done) return;
      world.stepAccum += dt * speed;
      let budget = Math.floor(world.stepAccum);
      if (budget <= 0) return;
      if (budget > MAX_TICKS_PER_FRAME) budget = MAX_TICKS_PER_FRAME;
      world.stepAccum -= budget;
      for (let i = 0; i < budget; i++) {
        world.updateFn(world, params);
        world.tick++;
      }
      renderBuffer(world);
      world.counts = countSpecies(world);
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
      const parts = [`tick=${world.tick}`];
      for (let i = 1; i < world.species.length; i++) {
        if (world.counts[i] > 0) parts.push(`${world.species[i].name}=${world.counts[i]}`);
      }
      return parts.join(' ');
    },
  };

  (window.APPROACHES = window.APPROACHES || []).push(APPROACH);
})();
