// Cellular forest. 2D grid, y=0 at top of sky, y=GROUND_Y is the ground line,
// y>=GROUND_Y is soil. Every cell is empty, or owned by one plant as a leaf,
// trunk, or root. Plants grow by picking a growth type (weighted by species)
// and trying to capture an adjacent empty cell under directional + shape
// constraints. Competition is purely spatial:
//   - space: a cell is captured by the first plant to reach it.
//   - light: leaves above a cell absorb light, darkening cells below.
//   - soil: each root cell yields a constant mineral income; plants compete
//     by racing to claim soil cells in their root zone.
// Energy budget per plant: leafIncome = sum over leaves of L^(1-shadeTol);
// rootIncome = rootCount * fertility; acquired = min(leaf, root); energy +=
// acquired - maint * cellCount. Growth consumes energy.

(function () {
  const W = 260;
  const H = 140;
  const N = W * H;
  const GROUND_Y = 88;

  const EMPTY = 0, LEAF = 1, TRUNK = 2, ROOT = 3;

  const LEAF_EFF = 0.35;
  const ROOT_EFF = 0.35;
  const MAINT_PER_CELL = 0.022;
  const GROW_COST = 1.0;
  const STARVE_TICKS = 4;
  const MAX_GROW_ATTEMPTS_PER_TICK = 4;
  const DEATH_IF_NO_LEAF_AFTER = 4;

  // Per-gene mutation probability per seed; small so most offspring are
  // identical copies and only rare lineages drift. Numeric traits jitter by a
  // relative step; one colour channel mutates by an absolute step.
  const MUT_PROB = 0.2;
  const MUT_STEP = 0.18;
  const COLOR_STEP = 18;

  const SPECIES = [
    {
      name: 'grass',
      color: { leaf: [170, 220, 80], trunk: [110, 140, 60], root: [95, 75, 40] },
      maxTrunk: 2, maxLeaf: 5, maxRoot: 3,
      maxCrownR: 2, crownHeight: 2,
      maxRootDepth: 2, maxRootSpread: 2,
      leafStartTrunk: 1,
      weights: { trunk: 1, root: 1, leaf: 2 },
      shadeTol: 0.1,
      maxAge: 6,
      maturityAge: 2, seedRate: 0.45, dispersalRadius: 6, seedCost: 0.3,
    },
    {
      name: 'shrub',
      color: { leaf: [85, 155, 65], trunk: [100, 65, 40], root: [75, 55, 30] },
      maxTrunk: 5, maxLeaf: 28, maxRoot: 14,
      maxCrownR: 5, crownHeight: 4,
      maxRootDepth: 4, maxRootSpread: 4,
      leafStartTrunk: 2,
      weights: { trunk: 1, root: 2, leaf: 3 },
      shadeTol: 0.4,
      maxAge: 28,
      maturityAge: 5, seedRate: 0.14, dispersalRadius: 12, seedCost: 0.5,
    },
    {
      name: 'tree',
      color: { leaf: [55, 110, 50], trunk: [80, 55, 35], root: [60, 45, 25] },
      maxTrunk: 320, maxLeaf: 300, maxRoot: 300,
      maxCrownR: 30, crownHeight: 100,
      maxRootDepth: 30, maxRootSpread: 30,
      leafStartTrunk: 10,
      weights: { trunk: 2, root: 3, leaf: 2 },
      shadeTol: 0.7,
      maxAge: 200,
      maturityAge: 15, seedRate: 0.08, dispersalRadius: 22, seedCost: 1.0,
    },
  ];

  function pack(rgb) { return ((0xFF << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0; }
  function mixCh(a, b, t) { return Math.round(a + (b - a) * t); }

  function repackColors(g) {
    g.leafPacked = pack(g.leafColor);
    g.trunkPacked = pack(g.trunkColor);
    g.rootPacked = pack(g.rootColor);
  }

  function speciesGenes(sp) {
    const g = {
      maxTrunk: sp.maxTrunk, maxLeaf: sp.maxLeaf, maxRoot: sp.maxRoot,
      maxCrownR: sp.maxCrownR, crownHeight: sp.crownHeight,
      maxRootDepth: sp.maxRootDepth, maxRootSpread: sp.maxRootSpread,
      leafStartTrunk: sp.leafStartTrunk,
      wTrunk: sp.weights.trunk, wRoot: sp.weights.root, wLeaf: sp.weights.leaf,
      shadeTol: sp.shadeTol,
      maxAge: sp.maxAge, maturityAge: sp.maturityAge,
      seedRate: sp.seedRate, dispersalRadius: sp.dispersalRadius, seedCost: sp.seedCost,
      leafColor: sp.color.leaf.slice(),
      trunkColor: sp.color.trunk.slice(),
      rootColor: sp.color.root.slice(),
    };
    repackColors(g);
    return g;
  }

  function mutN(v, min, max) {
    if (Math.random() >= MUT_PROB) return v;
    const step = Math.max(Math.abs(v), 0.05) * MUT_STEP;
    let x = v + (Math.random() * 2 - 1) * step;
    if (x < min) x = min; else if (x > max) x = max;
    return x;
  }

  function mutI(v, min, max) {
    if (Math.random() >= MUT_PROB) return v;
    const step = Math.max(Math.abs(v) * MUT_STEP, 1);
    let x = Math.round(v + (Math.random() * 2 - 1) * step);
    if (x === v) x += Math.random() < 0.5 ? -1 : 1;
    if (x < min) x = min; else if (x > max) x = max;
    return x;
  }

  function mutColor(rgb) {
    const out = rgb.slice();
    for (let i = 0; i < 3; i++) {
      if (Math.random() >= MUT_PROB) continue;
      let c = out[i] + Math.round((Math.random() * 2 - 1) * COLOR_STEP);
      if (c < 0) c = 0; else if (c > 255) c = 255;
      out[i] = c;
    }
    return out;
  }

  function mutateGenes(parent) {
    const g = {
      maxTrunk: mutI(parent.maxTrunk, 1, 500),
      maxLeaf: mutI(parent.maxLeaf, 1, 500),
      maxRoot: mutI(parent.maxRoot, 1, 200),
      maxCrownR: mutI(parent.maxCrownR, 1, 20),
      crownHeight: mutI(parent.crownHeight, 1, 40),
      maxRootDepth: mutI(parent.maxRootDepth, 1, 40),
      maxRootSpread: mutI(parent.maxRootSpread, 1, 40),
      leafStartTrunk: mutI(parent.leafStartTrunk, 1, 10),
      wTrunk: mutN(parent.wTrunk, 0.2, 5),
      wRoot: mutN(parent.wRoot, 0.2, 5),
      wLeaf: mutN(parent.wLeaf, 0.2, 5),
      shadeTol: mutN(parent.shadeTol, 0.05, 0.95),
      maxAge: mutI(parent.maxAge, 3, 400),
      maturityAge: mutI(parent.maturityAge, 1, 200),
      seedRate: mutN(parent.seedRate, 0.01, 1),
      dispersalRadius: mutI(parent.dispersalRadius, 1, 40),
      seedCost: mutN(parent.seedCost, 0.1, 3),
      leafColor: mutColor(parent.leafColor),
      trunkColor: mutColor(parent.trunkColor),
      rootColor: mutColor(parent.rootColor),
    };
    if (g.maturityAge >= g.maxAge) g.maturityAge = g.maxAge - 1;
    repackColors(g);
    return g;
  }

  const SKY_TABLE = new Uint32Array(256);
  const SOIL_TABLE = new Uint32Array(256);
  (function () {
    const skyDark = [6, 10, 24];
    const skyBright = [95, 125, 165];
    const soilRich = [105, 70, 42];
    const soilPoor = [32, 22, 14];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      SKY_TABLE[i] = pack([mixCh(skyDark[0], skyBright[0], t), mixCh(skyDark[1], skyBright[1], t), mixCh(skyDark[2], skyBright[2], t)]);
      SOIL_TABLE[i] = pack([mixCh(soilPoor[0], soilRich[0], t), mixCh(soilPoor[1], soilRich[1], t), mixCh(soilPoor[2], soilRich[2], t)]);
    }
  })();

  function makeBuffer(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    return { canvas: c, ctx: cx };
  }

  function placeCell(world, plant, idx, tissue) {
    world.tissue[idx] = tissue;
    world.plantId[idx] = plant.id;
    plant.cells.push(idx);
    if (tissue === LEAF) plant.leafCells.push(idx);
    else if (tissue === TRUNK) plant.trunkCells.push(idx);
    else if (tissue === ROOT) plant.rootCells.push(idx);
  }

  function killPlant(world, plant) {
    plant.alive = false;
    const tissue = world.tissue;
    const plantId = world.plantId;
    for (let k = 0; k < plant.cells.length; k++) {
      const idx = plant.cells[k];
      tissue[idx] = EMPTY;
      plantId[idx] = 0;
    }
    world.plants.delete(plant.id);
  }

  function spawnSeedling(world, speciesIdx, baseX, genes) {
    if (baseX < 1 || baseX >= W - 1) return null;
    const trunkIdx = (GROUND_Y - 1) * W + baseX;
    const rootIdx = GROUND_Y * W + baseX;
    if (world.tissue[trunkIdx] !== EMPTY || world.tissue[rootIdx] !== EMPTY) return null;
    const id = world.nextPlantId++;
    const plant = {
      id, species: speciesIdx, baseX,
      genes: genes || speciesGenes(SPECIES[speciesIdx]),
      age: 0, energy: 5, alive: true, starveCount: 0,
      trunkTopY: GROUND_Y - 1,
      cells: [], leafCells: [], trunkCells: [], rootCells: [],
    };
    world.plants.set(id, plant);
    placeCell(world, plant, trunkIdx, TRUNK);
    placeCell(world, plant, rootIdx, ROOT);
    return plant;
  }

  function spawnMature(world, speciesIdx, baseX, age) {
    const p = spawnSeedling(world, speciesIdx, baseX);
    if (!p) return null;
    p.age = age;
    p.energy = 200;
    for (let i = 0; i < 500; i++) {
      if (!tryGrow(p, world)) break;
    }
    p.energy = 2;
    return p;
  }

  function growTrunk(plant, world) {
    const x = plant.baseX;
    const ny = plant.trunkTopY - 1;
    if (ny < 0) return false;
    const idx = ny * W + x;
    if (world.tissue[idx] !== EMPTY) return false;
    placeCell(world, plant, idx, TRUNK);
    plant.trunkTopY = ny;
    return true;
  }

  function growRoot(plant, world) {
    const g = plant.genes;
    const roots = plant.rootCells;
    for (let attempt = 0; attempt < 4; attempt++) {
      const idx = roots[(Math.random() * roots.length) | 0];
      const rx = idx % W;
      const ry = (idx / W) | 0;
      const r = Math.random();
      let di, dj;
      if (r < 0.32) { di = 0; dj = 1; }
      else if (r < 0.52) { di = -1; dj = 1; }
      else if (r < 0.72) { di = 1; dj = 1; }
      else if (r < 0.86) { di = -1; dj = 0; }
      else { di = 1; dj = 0; }
      const nx = rx + di;
      const ny = ry + dj;
      if (nx < 0 || nx >= W || ny < GROUND_Y || ny >= H) continue;
      if (Math.abs(nx - plant.baseX) > g.maxRootSpread) continue;
      if (ny - GROUND_Y >= g.maxRootDepth) continue;
      const nidx = ny * W + nx;
      if (world.tissue[nidx] !== EMPTY) continue;
      placeCell(world, plant, nidx, ROOT);
      return true;
    }
    return false;
  }

  function growLeaf(plant, world) {
    const g = plant.genes;
    const leaves = plant.leafCells;
    if (leaves.length === 0) {
      const x = plant.baseX;
      const y = plant.trunkTopY - 1;
      if (y < 0) return false;
      const idx = y * W + x;
      if (world.tissue[idx] !== EMPTY) return false;
      placeCell(world, plant, idx, LEAF);
      return true;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const idx = leaves[(Math.random() * leaves.length) | 0];
      const lx = idx % W;
      const ly = (idx / W) | 0;
      const r = Math.random();
      let di, dj;
      if (r < 0.26) { di = 0; dj = -1; }
      else if (r < 0.50) { di = -1; dj = 0; }
      else if (r < 0.74) { di = 1; dj = 0; }
      else if (r < 0.85) { di = -1; dj = -1; }
      else if (r < 0.96) { di = 1; dj = -1; }
      else { di = 0; dj = 1; }
      const nx = lx + di;
      const ny = ly + dj;
      if (nx < 0 || nx >= W || ny < 0 || ny >= GROUND_Y) continue;
      if (Math.abs(nx - plant.baseX) > g.maxCrownR) continue;
      const topY = plant.trunkTopY;
      if (topY - ny > g.crownHeight) continue;
      if (ny > topY + 1) continue;
      const nidx = ny * W + nx;
      if (world.tissue[nidx] !== EMPTY) continue;
      placeCell(world, plant, nidx, LEAF);
      return true;
    }
    return false;
  }

  function tryGrow(plant, world) {
    if (plant.energy < GROW_COST) return false;
    const g = plant.genes;

    // Bootstrap: if eligible but leafless, prioritise a leaf so seedlings
    // can start photosynthesising before the seed reserve runs out.
    if (plant.leafCells.length === 0 && plant.trunkCells.length >= g.leafStartTrunk) {
      if (growLeaf(plant, world)) {
        plant.energy -= GROW_COST;
        return true;
      }
    }

    const opts = [];
    if (plant.trunkCells.length < g.maxTrunk) opts.push({ fn: growTrunk, w: g.wTrunk });
    if (plant.rootCells.length < g.maxRoot) opts.push({ fn: growRoot, w: g.wRoot });
    if (plant.trunkCells.length >= g.leafStartTrunk && plant.leafCells.length < g.maxLeaf) {
      opts.push({ fn: growLeaf, w: g.wLeaf });
    }
    if (opts.length === 0) return false;
    let total = 0;
    for (let i = 0; i < opts.length; i++) total += opts[i].w;
    let r = Math.random() * total;
    let chosen = opts[opts.length - 1].fn;
    for (let i = 0; i < opts.length; i++) {
      if (r < opts[i].w) { chosen = opts[i].fn; break; }
      r -= opts[i].w;
    }
    const ok = chosen(plant, world);
    if (ok) plant.energy -= GROW_COST;
    return ok;
  }

  function computeLightField(world, params) {
    const light = world.light;
    const tissue = world.tissue;
    const leafAbs = params.leafAbs;
    const stemAbs = params.leafAbs * 0.25;
    for (let x = 0; x < W; x++) {
      let L = 1;
      for (let y = 0; y < GROUND_Y; y++) {
        const i = y * W + x;
        light[i] = L;
        const t = tissue[i];
        if (t === LEAF) L *= 1 - leafAbs;
        else if (t === TRUNK) L *= 1 - stemAbs;
      }
    }
  }

  function tickOne(world, params) {
    const maintScale = params.maint;
    const fertility = params.soilFertility;

    const toKill = [];
    for (const p of world.plants.values()) {
      const g = p.genes;

      let leafIncome = 0;
      for (let k = 0; k < p.leafCells.length; k++) {
        const L = world.light[p.leafCells[k]];
        leafIncome += Math.pow(L, 1 - g.shadeTol);
      }
      leafIncome *= LEAF_EFF;

      const rootIncome = p.rootCells.length * ROOT_EFF * fertility;

      let acquired;
      if (p.leafCells.length === 0) acquired = rootIncome * 0.2;
      else if (p.rootCells.length === 0) acquired = leafIncome * 0.2;
      else acquired = Math.min(leafIncome, rootIncome);

      const maint = p.cells.length * MAINT_PER_CELL * maintScale;
      p.energy += acquired - maint;

      for (let i = 0; i < MAX_GROW_ATTEMPTS_PER_TICK; i++) {
        if (p.energy < GROW_COST) break;
        if (!tryGrow(p, world)) break;
      }

      if (p.age >= g.maturityAge && p.energy > g.seedCost + 1) {
        if (Math.random() < g.seedRate * params.seedScale) {
          const dx = ((Math.random() * 2 - 1) * g.dispersalRadius) | 0;
          const nx = p.baseX + dx;
          if (nx >= 1 && nx < W - 1) {
            const baby = spawnSeedling(world, p.species, nx, mutateGenes(g));
            if (baby) p.energy -= g.seedCost;
          }
        }
      }

      p.age++;
      if (p.energy < 0) p.starveCount++;
      else p.starveCount = 0;

      if (p.age >= g.maxAge) toKill.push(p);
      else if (p.starveCount > STARVE_TICKS) toKill.push(p);
      else if (p.age > DEATH_IF_NO_LEAF_AFTER && p.leafCells.length === 0) toKill.push(p);
    }

    for (let i = 0; i < toKill.length; i++) killPlant(world, toKill[i]);

    world.tick++;
    computeLightField(world, params);
  }

  function renderBuffer(world, params) {
    const n = N;
    const data32 = world.data32;
    const tissue = world.tissue;
    const plantId = world.plantId;
    const light = world.light;
    const plants = world.plants;
    let soilIdx = (Math.min(1, params.soilFertility) * 255) | 0;
    if (soilIdx < 0) soilIdx = 0; else if (soilIdx > 255) soilIdx = 255;
    const soilColor = SOIL_TABLE[soilIdx];

    for (let i = 0; i < n; i++) {
      const t = tissue[i];
      if (t !== EMPTY) {
        const p = plants.get(plantId[i]);
        if (p) {
          const g = p.genes;
          data32[i] = t === LEAF ? g.leafPacked : t === TRUNK ? g.trunkPacked : g.rootPacked;
          continue;
        }
      }
      const y = (i / W) | 0;
      if (y < GROUND_Y) {
        const L = light[i];
        let li = (L * 255) | 0;
        if (li < 0) li = 0; else if (li > 255) li = 255;
        data32[i] = SKY_TABLE[li];
      } else {
        data32[i] = soilColor;
      }
    }
    world.buffer.ctx.putImageData(world.imgData, 0, 0);
  }

  function randomX() {
    return 2 + ((Math.random() * (W - 4)) | 0);
  }

  const PRESETS = [
    {
      name: 'Mixed stand',
      initPlants: (world) => {
        for (let i = 0; i < 80; i++) {
          const r = Math.random();
          const sp = r < 0.5 ? 0 : r < 0.82 ? 1 : 2;
          spawnSeedling(world, sp, randomX());
        }
      },
    },
    {
      name: 'Grass monoculture',
      initPlants: (world) => {
        for (let i = 0; i < 160; i++) spawnSeedling(world, 0, randomX());
      },
    },
    {
      name: 'Old-growth',
      initPlants: (world) => {
        for (let i = 0; i < 7; i++) {
          spawnMature(world, 2, randomX(), 40 + ((Math.random() * 30) | 0));
        }
        for (let i = 0; i < 20; i++) spawnSeedling(world, 1, randomX());
        for (let i = 0; i < 40; i++) spawnSeedling(world, 0, randomX());
      },
    },
    {
      name: 'Poor soil',
      params: { soilFertility: 0.4 },
      initPlants: (world) => {
        for (let i = 0; i < 80; i++) {
          const r = Math.random();
          const sp = r < 0.5 ? 0 : r < 0.82 ? 1 : 2;
          spawnSeedling(world, sp, randomX());
        }
      },
    },
  ];

  const APPROACH = {
    id: 'forest',
    name: 'Forest',
    presets: PRESETS,
    params: [
      { key: 'leafAbs', label: 'shade', min: 0.1, max: 0.95, step: 0.05, default: 0.5, fmt: (v) => v.toFixed(2) },
      { key: 'soilFertility', label: 'fert', min: 0.1, max: 2, step: 0.05, default: 1, fmt: (v) => v.toFixed(2) },
      { key: 'maint', label: 'maint', min: 0.3, max: 3, step: 0.1, default: 1, fmt: (v) => v.toFixed(1) },
      { key: 'seedScale', label: 'seed', min: 0, max: 3, step: 0.1, default: 1, fmt: (v) => v.toFixed(1) },
    ],

    init(world, preset, params) {
      world.plantId = new Int32Array(N);
      world.tissue = new Uint8Array(N);
      world.light = new Float32Array(N);
      world.plants = new Map();
      world.nextPlantId = 1;
      world.tick = 0;
      world.stepAccum = 0;
      world.buffer = makeBuffer(W, H);
      world.imgData = world.buffer.ctx.createImageData(W, H);
      world.data32 = new Uint32Array(world.imgData.data.buffer);
      world.rawBbox = {
        minX: -W / 2, maxX: W / 2,
        minY: -(H - GROUND_Y), maxY: GROUND_Y,
      };
      preset.initPlants(world);
      computeLightField(world, params);
      renderBuffer(world, params);
    },

    step(world, dt, params, speed) {
      world.stepAccum += dt * speed * 0.08;
      let budget = Math.floor(world.stepAccum);
      if (budget <= 0) return;
      if (budget > 10) budget = 10;
      world.stepAccum -= budget;
      for (let i = 0; i < budget; i++) tickOne(world, params);
      renderBuffer(world, params);
    },

    draw(ctx, project, world) {
      const tl = project(-W / 2, GROUND_Y);
      const br = project(W / 2, -(H - GROUND_Y));
      const prev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(world.buffer.canvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.imageSmoothingEnabled = prev;
    },

    bbox(world) { return world.rawBbox; },

    status(world) {
      const counts = [0, 0, 0];
      let cells = 0;
      for (const p of world.plants.values()) {
        counts[p.species]++;
        cells += p.cells.length;
      }
      return `yr=${world.tick} grass=${counts[0]} shrub=${counts[1]} tree=${counts[2]} cells=${cells}`;
    },
  };

  (window.APPROACHES = window.APPROACHES || []).push(APPROACH);
})();
