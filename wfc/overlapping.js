// Overlapping Wave Function Collapse. Instead of authored tiles with explicit
// sockets, learn from a small sample image: slide an NxN window, collect all
// unique patterns with frequencies (optional rotations/reflections); two
// patterns are compatible as d-neighbours if their overlapping pixels agree.
// Solver is min-entropy observe + AC-3 propagation, same as tiled, but with
// Uint32Array bitsets since pattern counts can run into the hundreds.

(function () {
  const FLASH_DURATION = 0.7;

  // ---------- Uint32Array bitset helpers ----------

  function bsCreate(nBits) { return new Uint32Array(Math.ceil(nBits / 32) || 1); }

  function bsFillAll(a, nBits) {
    const last = a.length - 1;
    for (let i = 0; i < last; i++) a[i] = 0xffffffff >>> 0;
    const rem = nBits - last * 32;
    a[last] = rem >= 32 ? (0xffffffff >>> 0) : (rem > 0 ? (((1 << rem) - 1) >>> 0) : 0);
  }

  function bsClear(a) { a.fill(0); }
  function bsSet(a, bit) { a[bit >>> 5] |= (1 << (bit & 31)); }

  function bsFirstBit(a) {
    for (let i = 0; i < a.length; i++) {
      if (a[i]) {
        const low = a[i] & -a[i];
        return i * 32 + (31 - Math.clz32(low));
      }
    }
    return -1;
  }

  // ---------- Sample parsing (string rows → indexed pixel grid) ----------

  function parseSample(palette, rows) {
    const H = rows.length;
    const W = rows[0].length;
    const chars = Object.keys(palette);
    const idxByChar = {};
    const rgb = [];
    for (let i = 0; i < chars.length; i++) {
      idxByChar[chars[i]] = i;
      rgb.push(palette[chars[i]]);
    }
    const data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ch = rows[y][x];
        const v = idxByChar[ch];
        if (v === undefined) throw new Error(`parseSample: char ${JSON.stringify(ch)} at (${x},${y}) not in palette`);
        data[y * W + x] = v;
      }
    }
    return { width: W, height: H, data, palette: rgb };
  }

  // ---------- Pattern extraction ----------

  function rotatePattern(p, N) {
    const q = new Uint8Array(N * N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++)
        q[j * N + i] = p[(N - 1 - i) * N + j];
    return q;
  }

  function flipPattern(p, N) {
    const q = new Uint8Array(N * N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++)
        q[j * N + i] = p[j * N + (N - 1 - i)];
    return q;
  }

  function patternKey(p) {
    let s = '';
    for (let i = 0; i < p.length; i++) s += String.fromCharCode(p[i]);
    return s;
  }

  function extractPatterns(sample, N, symmetry) {
    const W = sample.width, H = sample.height;
    const data = sample.data;
    const patterns = [];
    const weights = [];
    const idxByKey = new Map();

    const addVariants = (p) => {
      const vs = [p];
      if (symmetry >= 4) {
        const r1 = rotatePattern(p, N);
        const r2 = rotatePattern(r1, N);
        const r3 = rotatePattern(r2, N);
        vs.push(r1, r2, r3);
      }
      if (symmetry >= 8) {
        const f = flipPattern(p, N);
        const fr1 = rotatePattern(f, N);
        const fr2 = rotatePattern(fr1, N);
        const fr3 = rotatePattern(fr2, N);
        vs.push(f, fr1, fr2, fr3);
      }
      for (const v of vs) {
        const k = patternKey(v);
        const existing = idxByKey.get(k);
        if (existing !== undefined) weights[existing]++;
        else {
          idxByKey.set(k, patterns.length);
          patterns.push(v);
          weights.push(1);
        }
      }
    };

    for (let y = 0; y + N <= H; y++) {
      for (let x = 0; x + N <= W; x++) {
        const p = new Uint8Array(N * N);
        for (let j = 0; j < N; j++)
          for (let i = 0; i < N; i++)
            p[j * N + i] = data[(y + j) * W + (x + i)];
        addVariants(p);
      }
    }
    return { patterns, weights };
  }

  // ---------- Adjacency ----------

  // p and q overlap if q is at offset (dx, dy) from p and every pixel shared
  // by both patterns matches.
  function patternsCompatible(p, q, dx, dy, N) {
    const xmin = Math.max(0, dx);
    const xmax = Math.min(N, N + dx);
    const ymin = Math.max(0, dy);
    const ymax = Math.min(N, N + dy);
    for (let y = ymin; y < ymax; y++) {
      for (let x = xmin; x < xmax; x++) {
        if (p[y * N + x] !== q[(y - dy) * N + (x - dx)]) return false;
      }
    }
    return true;
  }

  // direction indices: 0=N, 1=E, 2=S, 3=W
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  function buildAdjacency(patterns, N) {
    const P = patterns.length;
    const bslen = Math.ceil(P / 32) || 1;
    const allowed = [new Array(P), new Array(P), new Array(P), new Array(P)];
    for (let d = 0; d < 4; d++) {
      for (let p = 0; p < P; p++) allowed[d][p] = new Uint32Array(bslen);
    }
    for (let p = 0; p < P; p++) {
      for (let q = 0; q < P; q++) {
        for (let d = 0; d < 4; d++) {
          if (patternsCompatible(patterns[p], patterns[q], DIRS[d][0], DIRS[d][1], N)) {
            bsSet(allowed[d][p], q);
          }
        }
      }
    }
    return { allowed, bslen };
  }

  // Pattern extraction + adjacency are expensive; memoize across the
  // gridSize slider which otherwise re-runs init on every change.
  let cache = null;
  function getPatterns(preset, N, symmetry) {
    if (cache && cache.preset === preset && cache.N === N && cache.symmetry === symmetry) {
      return cache.result;
    }
    const { patterns, weights } = extractPatterns(preset.sample, N, symmetry);
    const { allowed, bslen } = buildAdjacency(patterns, N);
    const result = { patterns, weights, allowed, bslen };
    cache = { preset, N, symmetry, result };
    return result;
  }

  // ---------- World + solver ----------
  //
  // Propagation uses Gumin's counter scheme: compat[cell][p][d] is the number
  // of patterns in cell's d-neighbour that are still compatible with p. When a
  // pattern q is removed from cell m, we iterate p in allowed[d][q] and
  // decrement compat[m_d][p][opp(d)]; if the count hits 0, pattern p has no
  // remaining support from that direction and must itself be removed. This is
  // O(|allowed[d][q]|) per removal — far cheaper than re-OR-ing all allowed
  // masks per cell update, which is what a naive propagator would do.

  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];

  function computePopCounts(allowed, P, bslen) {
    const pc = new Uint16Array(4 * P);
    for (let d = 0; d < 4; d++) {
      for (let p = 0; p < P; p++) {
        const a = allowed[d][p];
        let cnt = 0;
        for (let k = 0; k < bslen; k++) {
          let n = a[k];
          while (n) { n &= n - 1; cnt++; }
        }
        pc[d * P + p] = cnt;
      }
    }
    return pc;
  }

  function seedCompat(compat, G, P, popCounts) {
    compat.fill(0);
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const cellIdx = y * G + x;
        const base = cellIdx * P * 4;
        for (let p = 0; p < P; p++) {
          const pbase = base + p * 4;
          for (let d = 0; d < 4; d++) {
            const nx = x + DX[d], ny = y + DY[d];
            if (nx >= 0 && nx < G && ny >= 0 && ny < G) {
              compat[pbase + d] = popCounts[d * P + p];
            }
            // out-of-bounds: leave 0; never touched because only in-bounds
            // neighbours trigger decrements.
          }
        }
      }
    }
  }

  function initWorld(world, preset, params) {
    const N = Math.max(2, Math.min(3, params.patternN | 0));
    const symRaw = params.symmetry | 0;
    const symmetry = symRaw >= 8 ? 8 : symRaw >= 4 ? 4 : 1;
    const { patterns, weights, allowed, bslen } = getPatterns(preset, N, symmetry);
    const P = patterns.length;

    const G = params.gridSize | 0;
    const total = G * G;
    const fullMask = bsCreate(P);
    bsFillAll(fullMask, P);
    const logWeights = new Float64Array(P);
    let sumWAll = 0, sumWlogWAll = 0;
    for (let i = 0; i < P; i++) {
      logWeights[i] = Math.log(weights[i]);
      sumWAll += weights[i];
      sumWlogWAll += weights[i] * logWeights[i];
    }

    const cells = new Array(total);
    for (let i = 0; i < total; i++) {
      cells[i] = {
        mask: new Uint32Array(fullMask),
        count: P,
        collapsed: -1,
        sumW: sumWAll,
        sumWlogW: sumWlogWAll,
        noise: Math.random() * 1e-4,
      };
    }

    const popCounts = computePopCounts(allowed, P, bslen);
    const compat = new Uint16Array(total * P * 4);
    seedCompat(compat, G, P, popCounts);

    world.N = N;
    world.G = G;
    world.patterns = patterns;
    world.weights = weights;
    world.logWeights = logWeights;
    world.allowed = allowed;
    world.bslen = bslen;
    world.nPatterns = P;
    world.fullMask = fullMask;
    world.palette = preset.sample.palette;
    world.topLefts = new Uint8Array(P);
    for (let i = 0; i < P; i++) world.topLefts[i] = patterns[i][0];
    world.cells = cells;
    world.compat = compat;
    world.popCounts = popCounts;
    world.rmCells = [];
    world.rmPats = [];
    world.collapsedCount = 0;
    world.contradictions = 0;
    world.contradicted = false;
    world.contradictionIdx = -1;
    world.done = false;
    world.stepAccum = 0;
    world.flashTimer = 0;
    world.offCanvas = null;
    world.imgData = null;
    world.sumWAll = sumWAll;
    world.sumWlogWAll = sumWlogWAll;

    initialSweep(world);
  }

  function resetCells(world) {
    const G = world.G;
    const P = world.nPatterns;
    const total = G * G;
    for (let i = 0; i < total; i++) {
      const c = world.cells[i];
      c.mask.set(world.fullMask);
      c.count = P;
      c.collapsed = -1;
      c.sumW = world.sumWAll;
      c.sumWlogW = world.sumWlogWAll;
      c.noise = Math.random() * 1e-4;
    }
    seedCompat(world.compat, G, P, world.popCounts);
    world.rmCells.length = 0;
    world.rmPats.length = 0;
    world.collapsedCount = 0;
    world.contradicted = false;
    world.contradictionIdx = -1;
    world.done = false;
    world.stepAccum = 0;
    initialSweep(world);
  }

  // Remove pattern p from the given cell, updating entropy sums and enqueuing
  // for propagation. Idempotent — returns immediately if p is already gone.
  function removeAndEnqueue(world, cellIdx, p) {
    const c = world.cells[cellIdx];
    const word = p >>> 5;
    const bit = 1 << (p & 31);
    if ((c.mask[word] & bit) === 0) return;
    c.mask[word] &= ~bit;
    c.count--;
    const w = world.weights[p];
    c.sumW -= w;
    c.sumWlogW -= w * world.logWeights[p];
    if (c.count === 0 && !world.contradicted) {
      world.contradicted = true;
      world.contradictionIdx = cellIdx;
    }
    world.rmCells.push(cellIdx);
    world.rmPats.push(p);
  }

  function propagate(world) {
    const G = world.G;
    const P = world.nPatterns;
    const cells = world.cells;
    const allowed = world.allowed;
    const compat = world.compat;
    const rmCells = world.rmCells;
    const rmPats = world.rmPats;

    while (rmCells.length > 0) {
      if (world.contradicted) return;
      const q = rmPats.pop();
      const cellIdx = rmCells.pop();
      const cx = cellIdx % G;
      const cy = (cellIdx / G) | 0;

      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || nx >= G || ny < 0 || ny >= G) continue;
        const nIdx = ny * G + nx;
        const nc = cells[nIdx];
        if (nc.count === 0) continue;
        const oppD = (d + 2) & 3;
        const adj = allowed[d][q];
        const nbase = nIdx * P * 4;

        // For each pattern p in allowed[d][q]: losing q as a potential
        // d-neighbour means the nIdx cell loses one support for p coming from
        // direction oppD (i.e., from our cell).
        for (let k = 0; k < adj.length; k++) {
          let word = adj[k];
          const base = k * 32;
          while (word) {
            const low = word & -word;
            const p = base + (31 - Math.clz32(low));
            word ^= low;
            const ci = nbase + p * 4 + oppD;
            if (compat[ci] > 0) {
              compat[ci]--;
              if (compat[ci] === 0) {
                removeAndEnqueue(world, nIdx, p);
                if (world.contradicted) return;
                if (nc.collapsed < 0 && nc.count === 1) {
                  nc.collapsed = bsFirstBit(nc.mask);
                  world.collapsedCount++;
                }
              }
            }
          }
        }
      }
    }
  }

  // Some patterns may have no valid neighbour in some direction (e.g.,
  // patterns at sample boundaries). They'd cause immediate contradictions if
  // chosen, so prune them up-front at every cell whose relevant direction is
  // in-bounds.
  function initialSweep(world) {
    const G = world.G, P = world.nPatterns;
    const compat = world.compat;
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const cellIdx = y * G + x;
        const base = cellIdx * P * 4;
        for (let p = 0; p < P; p++) {
          for (let d = 0; d < 4; d++) {
            const nx = x + DX[d], ny = y + DY[d];
            if (nx < 0 || nx >= G || ny < 0 || ny >= G) continue;
            if (compat[base + p * 4 + d] === 0) {
              removeAndEnqueue(world, cellIdx, p);
              break;
            }
          }
        }
      }
    }
    propagate(world);
  }

  function collapseAt(world, idx) {
    const c = world.cells[idx];
    if (c.collapsed >= 0 || c.count === 0) return;
    const weights = world.weights;
    let r = Math.random() * c.sumW;
    let chosen = -1;
    const mask = c.mask;
    for (let k = 0; k < mask.length && chosen < 0; k++) {
      let word = mask[k];
      const base = k * 32;
      while (word) {
        const low = word & -word;
        const t = base + (31 - Math.clz32(low));
        r -= weights[t];
        if (r <= 0) { chosen = t; break; }
        word ^= low;
      }
    }
    if (chosen < 0) chosen = bsFirstBit(mask);

    // Remove every pattern other than `chosen`; propagation is invoked once
    // after all are enqueued so the cascade can process them as a batch.
    for (let k = 0; k < mask.length; k++) {
      let word = mask[k];
      const base = k * 32;
      while (word) {
        const low = word & -word;
        const t = base + (31 - Math.clz32(low));
        if (t !== chosen) removeAndEnqueue(world, idx, t);
        word ^= low;
      }
    }
    c.collapsed = chosen;
    world.collapsedCount++;
    propagate(world);
  }

  function observe(world) {
    const cells = world.cells;
    let best = -1, bestH = Infinity;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (c.collapsed >= 0) continue;
      if (c.count === 0) {
        world.contradicted = true;
        world.contradictionIdx = i;
        return false;
      }
      if (c.count === 1) {
        c.collapsed = bsFirstBit(c.mask);
        world.collapsedCount++;
        continue;
      }
      // Shannon entropy from maintained sums; per-cell noise breaks ties.
      const H = Math.log(c.sumW) - c.sumWlogW / c.sumW + c.noise;
      if (H < bestH) { bestH = H; best = i; }
    }

    if (best < 0) { world.done = true; return false; }
    collapseAt(world, best);
    return !world.contradicted;
  }

  // ---------- Samples ----------

  const BRICKS = parseSample(
    { '.': [30, 22, 20], 'r': [170, 70, 45], 'h': [200, 110, 80] },
    [
      'rrrhrrrrhrrrrhrr',
      'rrrhrrrrhrrrrhrr',
      '................',
      'rhrrrrhrrrrhrrrr',
      'rhrrrrhrrrrhrrrr',
      '................',
      'rrrhrrrrhrrrrhrr',
      'rrrhrrrrhrrrrhrr',
      '................',
      'rhrrrrhrrrrhrrrr',
      'rhrrrrhrrrrhrrrr',
      '................',
    ],
  );

  const FLOWERS = parseSample(
    {
      '.': [42, 72, 40],
      ',': [62, 96, 52],
      'r': [200, 70, 70],
      'y': [220, 200, 90],
      'w': [230, 230, 220],
      'p': [210, 130, 180],
    },
    [
      '..,..,..,...',
      '.,.r.,..,y..',
      '....,..,.,..',
      '.,..,...,...',
      '..w.,...,...',
      '...,.,r...,.',
      ',...,......p',
      '..,..,.,....',
      '...y.,...,..',
      '.,.....,....',
      '...,..w.....',
      '..,.,..,..,.',
    ],
  );

  const MAZE = parseSample(
    { '#': [26, 30, 38], '.': [210, 200, 170] },
    [
      '#############',
      '#...........#',
      '#.##.###.##.#',
      '#.#.....#...#',
      '#...###.#.###',
      '#.###...#...#',
      '#.....###.#.#',
      '#.###.....#.#',
      '#...#.###.#.#',
      '###.#.#...#.#',
      '#...#.#.###.#',
      '#.###.......#',
      '#############',
    ],
  );

  const WEAVE = parseSample(
    { '.': [28, 22, 40], 'a': [210, 140, 80], 'b': [90, 70, 180] },
    [
      '..aa..aa..aa',
      '..aa..aa..aa',
      'bb..bb..bb..',
      'bb..bb..bb..',
      '..aa..aa..aa',
      '..aa..aa..aa',
      'bb..bb..bb..',
      'bb..bb..bb..',
      '..aa..aa..aa',
      '..aa..aa..aa',
    ],
  );

  const PRESETS = [
    { name: 'Bricks',  sample: BRICKS,  params: { patternN: 3, symmetry: 1 } },
    { name: 'Flowers', sample: FLOWERS, params: { patternN: 3, symmetry: 4 } },
    { name: 'Maze',    sample: MAZE,    params: { patternN: 3, symmetry: 4 } },
    { name: 'Weave',   sample: WEAVE,   params: { patternN: 3, symmetry: 4 } },
  ];

  // ---------- Rendering ----------

  function drawWorld(ctx, project, world) {
    if (!world.cells) return;
    const G = world.G;
    const palette = world.palette;
    const topLefts = world.topLefts;
    const weights = world.weights;
    const P = world.nPatterns;

    // Offscreen pixel buffer — one pixel per cell.
    if (!world.offCanvas) {
      world.offCanvas = document.createElement('canvas');
      world.offCanvas.width = G;
      world.offCanvas.height = G;
    }
    const octx = world.offCanvas.getContext('2d');
    if (!world.imgData) world.imgData = octx.createImageData(G, G);
    const data = world.imgData.data;

    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const c = world.cells[y * G + x];
        const off = (y * G + x) * 4;
        if (c.collapsed >= 0) {
          const col = palette[topLefts[c.collapsed]];
          data[off] = col[0];
          data[off + 1] = col[1];
          data[off + 2] = col[2];
          data[off + 3] = 255;
        } else if (c.count === 0) {
          data[off] = 240; data[off + 1] = 70; data[off + 2] = 70; data[off + 3] = 255;
        } else {
          // weighted average of possible top-left colors
          let r = 0, g = 0, b = 0, ww = 0;
          const mask = c.mask;
          for (let k = 0; k < mask.length; k++) {
            let word = mask[k];
            const base = k * 32;
            while (word) {
              const low = word & -word;
              const t = base + (31 - Math.clz32(low));
              const wi = weights[t];
              const col = palette[topLefts[t]];
              r += col[0] * wi;
              g += col[1] * wi;
              b += col[2] * wi;
              ww += wi;
              word ^= low;
            }
          }
          if (ww > 0) {
            data[off] = r / ww;
            data[off + 1] = g / ww;
            data[off + 2] = b / ww;
            data[off + 3] = 255;
          }
        }
      }
    }
    octx.putImageData(world.imgData, 0, 0);

    const tl = project(0, 0);
    const br = project(G, -G);
    const w = br.x - tl.x;
    const h = br.y - tl.y;
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(world.offCanvas, tl.x, tl.y, w, h);
    ctx.imageSmoothingEnabled = prev;

    // Contradiction flash
    if (world.flashTimer > 0 && world.contradictionIdx >= 0) {
      const k = world.flashTimer / FLASH_DURATION;
      ctx.fillStyle = `rgba(220, 70, 70, ${0.12 * k})`;
      ctx.fillRect(tl.x, tl.y, w, h);
      const ix = world.contradictionIdx % G;
      const iy = (world.contradictionIdx / G) | 0;
      const sx = w / G;
      const sy = h / G;
      ctx.fillStyle = `rgba(240, 80, 80, ${0.85 * k})`;
      ctx.fillRect(tl.x + ix * sx, tl.y + iy * sy, sx, sy);
    }
  }

  // ---------- Approach ----------

  const APPROACH = {
    id: 'overlapping',
    name: 'Overlapping WFC',
    presets: PRESETS,
    params: [
      { key: 'gridSize', label: 'grid', min: 16, max: 56, step: 2, default: 36, fmt: (v) => `${v | 0}×${v | 0}` },
      { key: 'patternN', label: 'N',    min: 2,  max: 3,  step: 1, default: 3, fmt: (v) => `${v | 0}` },
      { key: 'symmetry', label: 'sym',  min: 1,  max: 8,  step: 1, default: 4, fmt: (v) => {
        const n = v | 0;
        if (n >= 8) return '8';
        if (n >= 4) return '4';
        return '1';
      } },
    ],

    init(world, preset, params) { initWorld(world, preset, params); },

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
      if (budget > 200) budget = 200; // overlapping is heavier per-observe than tiled
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
      const G = world.G;
      const col = Math.floor(wx);
      const row = Math.floor(-wy);
      if (col < 0 || col >= G || row < 0 || row >= G) return;
      const idx = row * G + col;
      if (world.cells[idx].collapsed >= 0) return;
      collapseAt(world, idx);
      if (world.contradicted) {
        world.contradictions++;
        world.flashTimer = FLASH_DURATION;
      }
      if (world.collapsedCount >= G * G && !world.contradicted) world.done = true;
    },

    draw(ctx, project, world) { drawWorld(ctx, project, world); },

    bbox(world) {
      if (!world.G) return null;
      return { minX: 0, maxX: world.G, minY: -world.G, maxY: 0 };
    },

    status(world) {
      const total = world.G * world.G;
      let suffix = '';
      if (world.flashTimer > 0) suffix = ' ✗';
      else if (world.done) suffix = ' ✓';
      const ctra = world.contradictions ? `  contra=${world.contradictions}` : '';
      return `cells=${world.collapsedCount}/${total}  P=${world.nPatterns}${ctra}${suffix}`;
    },
  };

  (window.APPROACHES = window.APPROACHES || []).push(APPROACH);
})();
