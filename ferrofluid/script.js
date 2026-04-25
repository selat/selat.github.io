(async () => {
  const canvas = document.getElementById('main');
  const scoreEl = document.getElementById('score');
  const perfEl = document.getElementById('perf');
  const resetBtn = document.getElementById('reset');
  const countSlider = document.getElementById('count');
  const countLabel = document.getElementById('countLabel');

  function fail(msg) {
    document.body.innerHTML =
      `<div style="color:#ccc;padding:24px;font-family:monospace">${msg}</div>`;
  }

  if (!navigator.gpu) {
    fail('WebGPU is not available in this browser. Try recent Chrome, Edge, Safari 18+, or Firefox 121+.');
    return;
  }
  let adapter, device;
  let canTimestamp = false;
  try {
    adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no adapter');
    const requiredFeatures = [];
    if (adapter.features.has('timestamp-query')) {
      requiredFeatures.push('timestamp-query');
      canTimestamp = true;
    }
    device = await adapter.requestDevice({ requiredFeatures });
  } catch (e) {
    fail('Failed to initialize WebGPU: ' + e.message);
    return;
  }
  device.lost.then((info) => console.warn('WebGPU device lost:', info.message));

  const ctx = canvas.getContext('webgpu');
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: presentationFormat, alphaMode: 'opaque' });

  // ---------- Tunables ----------
  const MAX_N = 30000;
  let N = 8000;
  countSlider.min = '500';
  countSlider.max = String(MAX_N);
  countSlider.step = '500';
  countSlider.value = String(N);
  countLabel.textContent = String(N);

  const GRAVITY = 1500;
  const DAMP_PER_SEC = 1.6;
  const TIME_SCALE = 0.5;         // physics-only slow-mo; gameplay/perf use wall dt
  const SPLAT_BASE = 14;          // CSS px
  const TARGET_RADIUS_CSS = 64;
  const TARGET_FILL_TIME = 0.7;
  const TARGET_PARTICLE_THRESHOLD = 90;

  // SPH (Smoothed Particle Hydrodynamics)
  const SPH_H = 16;            // smoothing radius in canvas pixels (also cell size)
  const MAX_CELLS = 1 << 20;   // safety cap on cell count (~1M, 4MB cellHead buffer)

  const MAX_OBSTACLES = 0;
  const MAX_REPELLERS = 0;
  const obstacles = [];   // { x, y, r } in canvas px
  const repellers = [];

  // ---------- State ----------
  let dpr = 1;
  let target = null;
  let score = 0;
  scoreEl.textContent = '0';

  let magnetActive = false;
  let magnetX = 0, magnetY = 0;

  let lastTargetCount = 0;
  let readbackBusy = false;

  function targetRadiusPx() { return TARGET_RADIUS_CSS * dpr; }

  function setPointer(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const sy = canvas.height / r.height;
    magnetX = (clientX - r.left) * sx;
    magnetY = (clientY - r.top) * sy;
  }
  canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    magnetActive = true;
    setPointer(e.clientX, e.clientY);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  canvas.addEventListener('pointermove', e => {
    if (magnetActive) setPointer(e.clientX, e.clientY);
  });
  const release = () => { magnetActive = false; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', release);

  function newTarget() {
    const tr = targetRadiusPx();
    const margin = tr + 50 * dpr;
    const pad = 12 * dpr;
    for (let attempt = 0; attempt < 80; attempt++) {
      const x = margin + Math.random() * (canvas.width - 2 * margin);
      const y = margin + Math.random() * (canvas.height * 0.55 - margin);
      let ok = true;
      for (const o of obstacles) {
        const dx = x - o.x, dy = y - o.y;
        if (dx * dx + dy * dy < (o.r + tr + pad) * (o.r + tr + pad)) { ok = false; break; }
      }
      if (ok) for (const r of repellers) {
        const dx = x - r.x, dy = y - r.y;
        const minD = r.r * 0.8 + tr;
        if (dx * dx + dy * dy < minD * minD) { ok = false; break; }
      }
      if (ok) { target = { x, y, fill: 0 }; return; }
    }
    target = { x: canvas.width * 0.5, y: canvas.height * 0.3, fill: 0 };
  }

  function generateScene() {
    obstacles.length = 0;
    repellers.length = 0;
    const w = canvas.width, h = canvas.height;
    const spawnZone = { x: w * 0.5, y: h * 0.35, r: 240 * dpr };

    function tryPlace(arr, minR_css, maxR_css) {
      for (let attempt = 0; attempt < 60; attempt++) {
        const r = (minR_css + Math.random() * (maxR_css - minR_css)) * dpr;
        const m = r + 24 * dpr;
        const x = m + Math.random() * (w - 2 * m);
        const y = m + Math.random() * (h - 2 * m);
        if (Math.hypot(x - spawnZone.x, y - spawnZone.y) < spawnZone.r + r) continue;
        let bad = false;
        for (const o of obstacles) {
          if (Math.hypot(x - o.x, y - o.y) < o.r + r + 18 * dpr) { bad = true; break; }
        }
        if (!bad) for (const o of repellers) {
          if (Math.hypot(x - o.x, y - o.y) < o.r + r + 18 * dpr) { bad = true; break; }
        }
        if (!bad) { arr.push({ x, y, r }); return; }
      }
    }

    const numObs = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < numObs; i++) tryPlace(obstacles, 32, 70);
    const numRep = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < numRep; i++) tryPlace(repellers, 70, 110);
  }

  function resetParticles() {
    const arr = new Float32Array(MAX_N * 4);
    const cx = canvas.width * 0.5, cy = canvas.height * 0.35;
    const spread = 240 * dpr;
    for (let i = 0; i < MAX_N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * spread;
      arr[4 * i]     = cx + Math.cos(a) * r;
      arr[4 * i + 1] = cy + Math.sin(a) * r;
      arr[4 * i + 2] = 0;
      arr[4 * i + 3] = 0;
    }
    device.queue.writeBuffer(particleBuffer, 0, arr);
  }

  resetBtn.addEventListener('click', () => {
    generateScene();
    resetParticles();
    score = 0;
    scoreEl.textContent = '0';
    newTarget();
  });
  countSlider.addEventListener('input', () => {
    N = parseInt(countSlider.value, 10);
    countLabel.textContent = String(N);
  });

  // ---------- Buffers ----------
  // Particle: vec4<f32> per particle (xy=pos, zw=vel)
  const PARTICLE_STRIDE = 16;
  const particleBuffer = device.createBuffer({
    size: MAX_N * PARTICLE_STRIDE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // Scene UBO — see Scene struct in WGSL below.
  // 5 head vec4 + 6 obstacles + 3 repellers + 1 grid = 15 vec4 = 240 B.
  const SCENE_BYTES = 240;
  const sceneCPU = new Float32Array(SCENE_BYTES / 4);
  const sceneBuffer = device.createBuffer({
    size: SCENE_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Splat params: canvasW, canvasH, pointSize, _pad
  const splatParamsCPU = new Float32Array(4);
  const splatParamsBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Target counter (atomic u32)
  const targetCounterBuffer = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  // Readback buffer (mapped to CPU)
  const readbackBuffer = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  // SPH: per-particle density + pressure (vec2<f32>)
  const densityBuffer = device.createBuffer({
    size: MAX_N * 8,
    usage: GPUBufferUsage.STORAGE,
  });
  // SPH: linked-list next pointer per particle (u32). Encoded as i+1; 0 = end.
  const particleNextBuffer = device.createBuffer({
    size: MAX_N * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  // SPH: cellHead recreated on resize. Sentinel 0 = empty cell; particle index encoded as i+1.
  let cellHeadBuffer = null;
  let gridCellsX = 0, gridCellsY = 0, gridNumCells = 0;

  // Timestamp queries — 6 slots: { compute begin/end, splat begin/end, composite begin/end }
  // GPU time per frame ≈ slot[5] - slot[0]. Hardware-cheap; gated readback.
  const TS_COUNT = 6;
  let querySet = null, queryResolveBuf = null, queryReadBuf = null;
  let queryBusy = false;
  if (canTimestamp) {
    querySet = device.createQuerySet({ type: 'timestamp', count: TS_COUNT });
    queryResolveBuf = device.createBuffer({
      size: TS_COUNT * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    queryReadBuf = device.createBuffer({
      size: TS_COUNT * 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  // Perf ring buffers — fixed-size, no allocations in hot path.
  const SAMPLE_N = 60;
  const intervalsRing = new Float32Array(SAMPLE_N);
  const cpuRing = new Float32Array(SAMPLE_N);
  const gpuRing = new Float32Array(SAMPLE_N);
  let cpuIdx = 0, cpuCount = 0;
  let gpuIdx = 0, gpuCount = 0;
  let lastUiUpdate = 0;
  function ringAvg(a, n) {
    if (n === 0) return 0;
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i];
    return s / n;
  }
  function updatePerfUi(now) {
    if (now - lastUiUpdate < 250) return;
    lastUiUpdate = now;
    const avgInt = ringAvg(intervalsRing, cpuCount);
    const fps = avgInt > 0 ? 1000 / avgInt : 0;
    const cpu = ringAvg(cpuRing, cpuCount);
    if (canTimestamp && gpuCount > 0) {
      const gpu = ringAvg(gpuRing, gpuCount);
      perfEl.textContent = `${fps.toFixed(0)} fps · cpu ${cpu.toFixed(2)} · gpu ${gpu.toFixed(2)} ms`;
    } else {
      perfEl.textContent = `${fps.toFixed(0)} fps · cpu ${cpu.toFixed(2)} ms`;
    }
  }

  const linearSampler = device.createSampler({
    magFilter: 'linear', minFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
  });

  // ---------- WGSL ----------
  const SCENE_WGSL = `
  struct Scene {
    resolution: vec4<f32>,    // xy=res, z=time, w=_
    magnet: vec4<f32>,        // xy=pos, z=active(0/1), w=_
    physics: vec4<f32>,       // x=gravity, y=damp_per_sec, z=dt, w=_
    goal: vec4<f32>,          // xy=pos, z=radius, w=fillNorm(0..1)
    counts: vec4<f32>,        // x=numObs, y=numRep, z=N, w=_
    obstacles: array<vec4<f32>, 6>,  // xyz = x,y,r
    repellers: array<vec4<f32>, 3>,
    grid: vec4<f32>,          // x=cellsX, y=cellsY, z=H, w=invH
  };
  `;

  // SPH kernel + grid helpers (poly6, spiky gradient mag, viscosity laplacian, cell hashing).
  // H is both the smoothing radius and the grid cell size.
  const SPH_WGSL = `
  const PI: f32 = 3.14159265359;
  const H: f32 = ${SPH_H.toFixed(1)};
  const H2: f32 = H * H;
  // Precomputed kernel constants (2D Müller 2003 forms).
  const POLY6_K: f32 = 4.0  / (PI * H2 * H2 * H2 * H2);   // 4/(pi h^8)
  const SPIKY_GRAD_K: f32 = 30.0 / (PI * H2 * H2 * H);    // 30/(pi h^5)  (magnitude)
  const VISC_LAP_K: f32   = 40.0 / (PI * H2 * H2);        // 40/(pi h^4)
  const MASS: f32 = 1.0;
  const REST_DENSITY: f32 = 0.015;
  const STIFFNESS: f32 = 8000;
  const VISCOSITY: f32 = 3;
  const XSPH_RATE: f32 = 1.0;       // 1/sec; per-frame XSPH = XSPH_RATE * dt (was ε=0.04 at dt=16ms)

  fn poly6(r2: f32) -> f32 {
    if (r2 >= H2) { return 0.0; }
    let x = H2 - r2;
    return POLY6_K * x * x * x;
  }
  fn cellOf(p: vec2<f32>, invH: f32) -> vec2<i32> {
    return vec2<i32>(floor(p * invH));
  }
  fn cellIdx(cx: i32, cy: i32, cellsX: i32) -> u32 {
    return u32(cy) * u32(cellsX) + u32(cx);
  }
  `;

  // Pass 1: bin particles into the spatial-hash grid.
  // cellHead encodes the head particle index as i+1 (sentinel 0 = empty).
  // particleNext[i] is set to the previous head value, forming a per-cell linked list.
  const binWGSL = SCENE_WGSL + SPH_WGSL + `
  @group(0) @binding(0) var<storage, read> particles: array<vec4<f32>>;
  @group(0) @binding(1) var<uniform> scene: Scene;
  @group(0) @binding(2) var<storage, read_write> cellHead: array<atomic<u32>>;
  @group(0) @binding(3) var<storage, read_write> particleNext: array<u32>;

  @compute @workgroup_size(64)
  fn cs_bin(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    let N = u32(scene.counts.z);
    if (i >= N) { return; }

    let pos = particles[i].xy;
    let cellsX = i32(scene.grid.x);
    let cellsY = i32(scene.grid.y);
    let c = cellOf(pos, scene.grid.w);
    let cx = clamp(c.x, 0, cellsX - 1);
    let cy = clamp(c.y, 0, cellsY - 1);
    let ci = cellIdx(cx, cy, cellsX);

    let prev = atomicExchange(&cellHead[ci], i + 1u);
    particleNext[i] = prev;
  }
  `;

  // Pass 2: compute density + pressure for each particle from its 3x3 cell neighborhood.
  const densityWGSL = SCENE_WGSL + SPH_WGSL + `
  @group(0) @binding(0) var<storage, read> particles: array<vec4<f32>>;
  @group(0) @binding(1) var<uniform> scene: Scene;
  @group(0) @binding(2) var<storage, read> cellHead: array<u32>;
  @group(0) @binding(3) var<storage, read> particleNext: array<u32>;
  @group(0) @binding(4) var<storage, read_write> densityArr: array<vec2<f32>>;

  @compute @workgroup_size(64)
  fn cs_density(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    let N = u32(scene.counts.z);
    if (i >= N) { return; }

    let pi = particles[i].xy;
    let cellsX = i32(scene.grid.x);
    let cellsY = i32(scene.grid.y);
    let c = cellOf(pi, scene.grid.w);

    var density: f32 = 0.0;
    for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
      for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
        let cx = c.x + dx;
        let cy = c.y + dy;
        if (cx < 0 || cy < 0 || cx >= cellsX || cy >= cellsY) { continue; }
        var nextEnc = cellHead[cellIdx(cx, cy, cellsX)];
        // Bound iterations — defensive; in practice cell occupancy is small.
        for (var k: u32 = 0u; k < 256u; k = k + 1u) {
          if (nextEnc == 0u) { break; }
          let j = nextEnc - 1u;
          let pj = particles[j].xy;
          let r = pi - pj;
          density = density + MASS * poly6(dot(r, r));
          nextEnc = particleNext[j];
        }
      }
    }
    let pressure = max(0.0, STIFFNESS * (density - REST_DENSITY));
    densityArr[i] = vec2<f32>(density, pressure);
  }
  `;

  // Pass 3: SPH forces + external forces (gravity, magnet, repellers, walls), integration, obstacles, goal counting.
  const simWGSL = SCENE_WGSL + SPH_WGSL + `
  @group(0) @binding(0) var<storage, read_write> particles: array<vec4<f32>>;
  @group(0) @binding(1) var<uniform> scene: Scene;
  @group(0) @binding(2) var<storage, read_write> targetCount: atomic<u32>;
  @group(0) @binding(3) var<storage, read> densityArr: array<vec2<f32>>;
  @group(0) @binding(4) var<storage, read> cellHead: array<u32>;
  @group(0) @binding(5) var<storage, read> particleNext: array<u32>;

  const MAGNET_PEAK:  f32 = 10000.0;   // px/s² at the magnet center
  const MAGNET_RANGE: f32 = 700.0;    // px reach; zero force beyond this
  const REPEL_K: f32 = 6.0e8;
  const REPEL_SOFT: f32 = 4500.0;
  const MAX_SPEED: f32 = 3500.0;
  const WALL_K: f32 = 9000.0;

  @compute @workgroup_size(64)
  fn cs_sim(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    let N = u32(scene.counts.z);
    if (i >= N) { return; }

    var p = particles[i];
    var pos = p.xy;
    var vel = p.zw;
    let di = densityArr[i];
    let densityI = max(di.x, REST_DENSITY * 0.1);  // floor to avoid div-by-zero
    let pressureI = di.y;

    let dt = scene.physics.z;
    let gravity = scene.physics.x;
    let dampPerSec = scene.physics.y;

    var acc = vec2<f32>(0.0, gravity);

    // SPH neighbor pass: pressure (spiky gradient) + viscosity (laplacian).
    let cellsX = i32(scene.grid.x);
    let cellsY = i32(scene.grid.y);
    let c = cellOf(pos, scene.grid.w);
    var pressureForce = vec2<f32>(0.0);
    var viscForce = vec2<f32>(0.0);
    var xsphSum = vec2<f32>(0.0);   // XSPH velocity smoothing accumulator
    for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
      for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
        let cx = c.x + dx;
        let cy = c.y + dy;
        if (cx < 0 || cy < 0 || cx >= cellsX || cy >= cellsY) { continue; }
        var nextEnc = cellHead[cellIdx(cx, cy, cellsX)];
        for (var k: u32 = 0u; k < 256u; k = k + 1u) {
          if (nextEnc == 0u) { break; }
          let j = nextEnc - 1u;
          if (j != i) {
            let pj4 = particles[j];
            let pj = pj4.xy;
            let vj = pj4.zw;
            let rv = pos - pj;
            let r2 = dot(rv, rv);
            let r = sqrt(r2);
            if (r < H && r > 1e-4) {
              let dj = densityArr[j];
              let densityJ = max(dj.x, REST_DENSITY * 0.1);
              let pressureJ = dj.y;
              let dir = rv / r;
              // Pressure: a_i = (1/ρi) Σ m (pi+pj)/(2 ρj) * |∇W| * (i←j)
              let pmag = SPIKY_GRAD_K * (H - r) * (H - r);
              let pcoef = MASS * (pressureI + pressureJ) * 0.5 / (densityI * densityJ);
              pressureForce = pressureForce + pcoef * pmag * dir;
              // Viscosity: smooths velocity differences.
              let vlap = VISC_LAP_K * (H - r);
              let vcoef = VISCOSITY * MASS * vlap / (densityI * densityJ);
              viscForce = viscForce + vcoef * (vj - vel);
              // XSPH: kernel-weighted neighbor velocity blend (anti-jitter).
              xsphSum = xsphSum + (MASS / densityJ) * (vj - vel) * poly6(r2);
            }
          }
          nextEnc = particleNext[j];
        }
      }
    }
    acc = acc + pressureForce + viscForce;

    if (scene.magnet.z > 0.5) {
      let d = scene.magnet.xy - pos;
      let dist = length(d);
      if (dist < MAGNET_RANGE) {
        let dir = d / max(dist, 1.0);
        let falloff = 1.0 - dist / MAGNET_RANGE;
        acc = acc + dir * MAGNET_PEAK * falloff;
      }
    }

    let nR = i32(scene.counts.y);
    for (var ri: i32 = 0; ri < nR; ri = ri + 1) {
      let r = scene.repellers[ri];
      let d = pos - r.xy;
      let d2 = dot(d, d) + REPEL_SOFT;
      let inv = REPEL_K / (d2 * sqrt(d2));
      acc = acc + d * inv;
    }

    let res = scene.resolution.xy;
    if (pos.x < 0.0)            { acc.x = acc.x - pos.x * WALL_K; }
    else if (pos.x > res.x)     { acc.x = acc.x + (res.x - pos.x) * WALL_K; }
    if (pos.y < 0.0)            { acc.y = acc.y - pos.y * WALL_K; }
    else if (pos.y > res.y)     { acc.y = acc.y + (res.y - pos.y) * WALL_K; }

    let damp = exp(-dampPerSec * dt);
    vel = (vel + acc * dt) * damp;
    vel = vel + XSPH_RATE * dt * xsphSum; // post-integration smoothing (dt-scaled)

    let sp = length(vel);
    if (sp > MAX_SPEED) { vel = vel * (MAX_SPEED / sp); }

    pos = pos + vel * dt;

    let nO = i32(scene.counts.x);
    for (var oi: i32 = 0; oi < nO; oi = oi + 1) {
      let o = scene.obstacles[oi];
      let d = pos - o.xy;
      let d2 = dot(d, d);
      let r2 = o.z * o.z;
      if (d2 < r2) {
        let dlen = max(sqrt(d2), 1e-4);
        let n = d / dlen;
        pos = o.xy + n * o.z;
        let vn = dot(vel, n);
        if (vn < 0.0) {
          vel = vel - vn * n;
        }
      }
    }

    particles[i] = vec4<f32>(pos, vel);

    let dT = pos - scene.goal.xy;
    if (dot(dT, dT) < scene.goal.z * scene.goal.z) {
      atomicAdd(&targetCount, 1u);
    }
  }
  `;

  const splatWGSL = `
  struct SplatParams {
    canvasRes: vec2<f32>,
    pointSize: f32,
    _pad: f32,
  };

  @group(0) @binding(0) var<storage, read> particles: array<vec4<f32>>;
  @group(0) @binding(1) var<uniform> params: SplatParams;

  struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
  };

  @vertex
  fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
    let p = particles[ii];
    let center = p.xy;

    // Triangle-strip corners: 0=(-1,-1), 1=(1,-1), 2=(-1,1), 3=(1,1)
    let cx = f32(vi & 1u) * 2.0 - 1.0;
    let cy = f32((vi >> 1u) & 1u) * 2.0 - 1.0;
    let corner = vec2<f32>(cx, cy);

    let half = params.pointSize * 0.5;
    let worldPx = center + corner * half;

    let ndc = vec2<f32>(
      (worldPx.x / params.canvasRes.x) * 2.0 - 1.0,
      1.0 - (worldPx.y / params.canvasRes.y) * 2.0
    );

    var out: VSOut;
    out.pos = vec4<f32>(ndc, 0.0, 1.0);
    out.uv = corner * 0.5 + 0.5;
    return out;
  }

  @fragment
  fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let d = in.uv - vec2<f32>(0.5);
    let r2 = dot(d, d) * 4.0;
    if (r2 > 1.0) { discard; }
    let density = exp(-r2 * 4.5) * 0.16;
    return vec4<f32>(density, 0.0, 0.0, 1.0);
  }
  `;

  const compositeWGSL = SCENE_WGSL + `
  @group(0) @binding(0) var<uniform> scene: Scene;
  @group(0) @binding(1) var density: texture_2d<f32>;
  @group(0) @binding(2) var samp: sampler;

  struct VSOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
  };

  @vertex
  fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
    // Covering triangle: NDC vertices (-1,-1), (3,-1), (-1,3); uvs map (0,1), (2,1), (0,-1)
    // so uv.y matches top-left-origin texture sampling and canvas-px coords (y down).
    let positions = array<vec2<f32>, 3>(
      vec2<f32>(-1.0, -1.0),
      vec2<f32>( 3.0, -1.0),
      vec2<f32>(-1.0,  3.0)
    );
    let uvs = array<vec2<f32>, 3>(
      vec2<f32>(0.0, 1.0),
      vec2<f32>(2.0, 1.0),
      vec2<f32>(0.0, -1.0)
    );
    var out: VSOut;
    out.pos = vec4<f32>(positions[vi], 0.0, 1.0);
    out.uv = uvs[vi];
    return out;
  }

  @fragment
  fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
    let res = scene.resolution.xy;
    let time = scene.resolution.z;
    let fragPx = in.uv * res;

    let d = textureSample(density, samp, in.uv).r;
    let texSize = vec2<f32>(textureDimensions(density));
    let stepUv = 1.0 / texSize;
    let dxr = textureSample(density, samp, in.uv + vec2<f32>(stepUv.x, 0.0)).r
            - textureSample(density, samp, in.uv - vec2<f32>(stepUv.x, 0.0)).r;
    let dyr = textureSample(density, samp, in.uv + vec2<f32>(0.0, stepUv.y)).r
            - textureSample(density, samp, in.uv - vec2<f32>(0.0, stepUv.y)).r;
    let grad = vec2<f32>(dxr, dyr);

    // Concentric ripples emanating from the magnet — gentle surface disturbance
    let rel = fragPx - scene.magnet.xy;
    let magDist = length(rel);
    var ripple = sin(magDist * 0.10 - time * 3.5) * 0.5 + 0.5;
    ripple = ripple * exp(-magDist / 280.0) * scene.magnet.z;

    let threshold = 0.42 - ripple * 0.06;
    let surface = smoothstep(threshold - 0.045, threshold + 0.045, d);

    // Background — deep ocean, slight lighter band toward the top (light from above)
    let depthGrad = mix(0.55, 1.15, 1.0 - in.uv.y);
    let vign = 1.0 - 0.40 * length(in.uv - vec2<f32>(0.5));
    var bg = vec3<f32>(0.018, 0.045, 0.085) * vign * depthGrad;

    let nR = i32(scene.counts.y);
    for (var i: i32 = 0; i < nR; i = i + 1) {
      let R = scene.repellers[i];
      let rd = length(fragPx - R.xy);
      let t = rd / R.z;
      let glow = exp(-t * t * 1.6) * 0.42;
      let rr = fragPx - R.xy;
      let th = atan2(rr.y, rr.x);
      let lines = (sin(th * 16.0 - time * 1.2) * 0.5 + 0.5) * exp(-t * t * 4.0) * 0.18;
      bg = bg + (glow + lines) * vec3<f32>(0.95, 0.30, 0.20);
    }

    // Water palette: deep teal -> cyan -> bright cyan-white foam
    let deep = vec3<f32>(0.03, 0.18, 0.32);
    let mid  = vec3<f32>(0.18, 0.55, 0.72);
    let hi   = vec3<f32>(0.78, 0.95, 1.0);
    var body = mix(deep, mid, smoothstep(0.45, 0.75, d));
    body = mix(body, hi, smoothstep(0.78, 1.15, d));

    // Subsurface tint near the iso-line
    let edge = smoothstep(0.30, 0.45, d) * (1.0 - smoothstep(0.45, 0.62, d));
    body = body + edge * vec3<f32>(0.20, 0.55, 0.78);

    // Specular off the surface — bright pin-prick highlights
    let spec = clamp(dot(normalize(grad + vec2<f32>(1e-4)), normalize(vec2<f32>(-0.6, -1.0))), 0.0, 1.0);
    body = body + pow(spec, 8.0) * surface * 0.55 * vec3<f32>(0.92, 0.98, 1.0);

    var col = mix(bg, body, surface);

    // Obstacles — opaque on top
    let nO = i32(scene.counts.x);
    for (var i: i32 = 0; i < nO; i = i + 1) {
      let O = scene.obstacles[i];
      let rel2 = fragPx - O.xy;
      let od = length(rel2) - O.z;
      let mask = 1.0 - smoothstep(-1.5, 1.5, od);
      let nrm = rel2 / max(length(rel2), 1e-4);
      let lit = clamp(dot(nrm, normalize(vec2<f32>(-0.6, -1.0))), 0.0, 1.0);
      let obsCol = vec3<f32>(0.13, 0.12, 0.17) + lit * vec3<f32>(0.18, 0.20, 0.30);
      col = mix(col, obsCol, mask);
      let rim = exp(-max(od, 0.0) / 2.2) * (1.0 - mask) * 0.55;
      col = col + rim * vec3<f32>(0.40, 0.42, 0.55);
    }

    // Repeller boundary rings on top
    for (var i: i32 = 0; i < nR; i = i + 1) {
      let R = scene.repellers[i];
      let rd = length(fragPx - R.xy);
      let ringW = 1.5;
      let ring = smoothstep(R.z - ringW * 1.5, R.z - ringW * 0.5, rd) -
                 smoothstep(R.z - ringW * 0.5, R.z + ringW, rd);
      col = col + ring * 0.55 * vec3<f32>(1.0, 0.45, 0.40);
    }

    // Target ring
    let toT = fragPx - scene.goal.xy;
    let tr = length(toT);
    let ringInner = scene.goal.z - 2.5;
    let ringOuter = scene.goal.z;
    let ring = smoothstep(ringInner - 1.5, ringInner, tr) - smoothstep(ringOuter, ringOuter + 1.5, tr);
    let ringColor = mix(vec3<f32>(0.45, 0.55, 0.75), vec3<f32>(0.55, 1.0, 0.78), scene.goal.w);
    col = mix(col, ringColor, ring * 0.85);

    let innerNorm = clamp(tr / scene.goal.z, 0.0, 1.0);
    let innerGlow = (1.0 - innerNorm) * scene.goal.w;
    col = col + innerGlow * 0.18 * vec3<f32>(0.35, 0.85, 0.65);

    return vec4<f32>(col, 1.0);
  }
  `;

  // ---------- Pipelines ----------
  const binModule = device.createShaderModule({ code: binWGSL });
  const densityModule = device.createShaderModule({ code: densityWGSL });
  const simModule = device.createShaderModule({ code: simWGSL });
  const splatModule = device.createShaderModule({ code: splatWGSL });
  const compositeModule = device.createShaderModule({ code: compositeWGSL });

  const binPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: binModule, entryPoint: 'cs_bin' },
  });
  const densityPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: densityModule, entryPoint: 'cs_density' },
  });
  const simPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: simModule, entryPoint: 'cs_sim' },
  });

  const DENSITY_FORMAT = 'r8unorm';
  const splatPipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: splatModule, entryPoint: 'vs_main' },
    fragment: {
      module: splatModule, entryPoint: 'fs_main',
      targets: [{
        format: DENSITY_FORMAT,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        },
        writeMask: GPUColorWrite.RED,
      }],
    },
    primitive: { topology: 'triangle-strip' },
  });

  const compositePipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: compositeModule, entryPoint: 'vs_main' },
    fragment: {
      module: compositeModule, entryPoint: 'fs_main',
      targets: [{ format: presentationFormat }],
    },
    primitive: { topology: 'triangle-list' },
  });

  const splatBindGroup = device.createBindGroup({
    layout: splatPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: splatParamsBuffer } },
    ],
  });

  // Compute bind groups depend on cellHead — recreated on resize via setupGrid().
  let binBindGroup = null, densityBindGroup = null, simBindGroup = null;
  function makeComputeBindGroups() {
    binBindGroup = device.createBindGroup({
      layout: binPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: particleBuffer } },
        { binding: 1, resource: { buffer: sceneBuffer } },
        { binding: 2, resource: { buffer: cellHeadBuffer } },
        { binding: 3, resource: { buffer: particleNextBuffer } },
      ],
    });
    densityBindGroup = device.createBindGroup({
      layout: densityPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: particleBuffer } },
        { binding: 1, resource: { buffer: sceneBuffer } },
        { binding: 2, resource: { buffer: cellHeadBuffer } },
        { binding: 3, resource: { buffer: particleNextBuffer } },
        { binding: 4, resource: { buffer: densityBuffer } },
      ],
    });
    simBindGroup = device.createBindGroup({
      layout: simPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: particleBuffer } },
        { binding: 1, resource: { buffer: sceneBuffer } },
        { binding: 2, resource: { buffer: targetCounterBuffer } },
        { binding: 3, resource: { buffer: densityBuffer } },
        { binding: 4, resource: { buffer: cellHeadBuffer } },
        { binding: 5, resource: { buffer: particleNextBuffer } },
      ],
    });
  }

  function setupGrid(canvasW, canvasH) {
    gridCellsX = Math.max(1, Math.ceil(canvasW / SPH_H));
    gridCellsY = Math.max(1, Math.ceil(canvasH / SPH_H));
    gridNumCells = Math.min(MAX_CELLS, gridCellsX * gridCellsY);
    if (cellHeadBuffer) cellHeadBuffer.destroy();
    cellHeadBuffer = device.createBuffer({
      size: gridNumCells * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    makeComputeBindGroups();
  }

  // Density texture + composite bind group recreated on resize
  let densityTex, densityView, compositeBindGroup;
  function setupDensityTexture(w, h) {
    if (densityTex) densityTex.destroy();
    densityTex = device.createTexture({
      size: [w, h],
      format: DENSITY_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    densityView = densityTex.createView();
    compositeBindGroup = device.createBindGroup({
      layout: compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: sceneBuffer } },
        { binding: 1, resource: densityView },
        { binding: 2, resource: linearSampler },
      ],
    });
  }

  // ---------- Resize ----------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(window.innerWidth * dpr));
    const h = Math.max(1, Math.floor(window.innerHeight * dpr));
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    setupDensityTexture(Math.max(1, w >> 1), Math.max(1, h >> 1));
    setupGrid(w, h);
    generateScene();
    newTarget();
  }
  window.addEventListener('resize', resize);

  // ---------- Frame ----------
  let last = performance.now();
  const ZERO_U32 = new Uint32Array([0]);

  function packScene(timeSec, dt) {
    // resolution
    sceneCPU[0] = canvas.width;  sceneCPU[1] = canvas.height; sceneCPU[2] = timeSec; sceneCPU[3] = 0;
    // magnet
    sceneCPU[4] = magnetX;       sceneCPU[5] = magnetY;       sceneCPU[6] = magnetActive ? 1 : 0; sceneCPU[7] = 0;
    // physics
    sceneCPU[8] = GRAVITY;       sceneCPU[9] = DAMP_PER_SEC;  sceneCPU[10] = dt * TIME_SCALE; sceneCPU[11] = 0;
    // target
    sceneCPU[12] = target ? target.x : 0;
    sceneCPU[13] = target ? target.y : 0;
    sceneCPU[14] = targetRadiusPx();
    sceneCPU[15] = target ? Math.min(1, target.fill / TARGET_FILL_TIME) : 0;
    // counts
    sceneCPU[16] = obstacles.length;
    sceneCPU[17] = repellers.length;
    sceneCPU[18] = N;
    sceneCPU[19] = 0;
    // obstacles (offset 20, 6 vec4)
    for (let i = 0; i < MAX_OBSTACLES; i++) {
      const o = obstacles[i];
      const off = 20 + i * 4;
      sceneCPU[off]     = o ? o.x : 0;
      sceneCPU[off + 1] = o ? o.y : 0;
      sceneCPU[off + 2] = o ? o.r : 0;
      sceneCPU[off + 3] = 0;
    }
    // repellers (offset 44, 3 vec4)
    for (let i = 0; i < MAX_REPELLERS; i++) {
      const r = repellers[i];
      const off = 44 + i * 4;
      sceneCPU[off]     = r ? r.x : 0;
      sceneCPU[off + 1] = r ? r.y : 0;
      sceneCPU[off + 2] = r ? r.r : 0;
      sceneCPU[off + 3] = 0;
    }
    // grid (offset 56, 1 vec4)
    sceneCPU[56] = gridCellsX;
    sceneCPU[57] = gridCellsY;
    sceneCPU[58] = SPH_H;
    sceneCPU[59] = 1.0 / SPH_H;
    device.queue.writeBuffer(sceneBuffer, 0, sceneCPU);
  }

  function frame(t) {
    const interval = t - last;
    const dt = Math.min(0.033, interval / 1000);
    last = t;

    const cpuT0 = performance.now();

    packScene(t * 0.001, dt);

    splatParamsCPU[0] = canvas.width;
    splatParamsCPU[1] = canvas.height;
    splatParamsCPU[2] = SPLAT_BASE * dpr;
    splatParamsCPU[3] = 0;
    device.queue.writeBuffer(splatParamsBuffer, 0, splatParamsCPU);

    // Reset target counter for this frame
    device.queue.writeBuffer(targetCounterBuffer, 0, ZERO_U32);

    const encoder = device.createCommandEncoder();
    // Clear cellHead to sentinel (0) — particle indices are stored as i+1.
    encoder.clearBuffer(cellHeadBuffer, 0, gridNumCells * 4);

    const partWG = Math.ceil(N / 64);

    // SPH bin pass
    {
      const desc = {};
      if (canTimestamp) desc.timestampWrites = { querySet, beginningOfPassWriteIndex: 0 };
      const pass = encoder.beginComputePass(desc);
      pass.setPipeline(binPipeline);
      pass.setBindGroup(0, binBindGroup);
      pass.dispatchWorkgroups(partWG);
      pass.end();
    }

    // SPH density pass
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(densityPipeline);
      pass.setBindGroup(0, densityBindGroup);
      pass.dispatchWorkgroups(partWG);
      pass.end();
    }

    // SPH sim pass (forces + integration)
    {
      const desc = {};
      if (canTimestamp) desc.timestampWrites = { querySet, endOfPassWriteIndex: 1 };
      const pass = encoder.beginComputePass(desc);
      pass.setPipeline(simPipeline);
      pass.setBindGroup(0, simBindGroup);
      pass.dispatchWorkgroups(partWG);
      pass.end();
    }

    // Splat → density texture
    {
      const desc = {
        colorAttachments: [{
          view: densityView,
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        }],
      };
      if (canTimestamp) desc.timestampWrites = { querySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 };
      const pass = encoder.beginRenderPass(desc);
      pass.setPipeline(splatPipeline);
      pass.setBindGroup(0, splatBindGroup);
      pass.draw(4, N); // 4 verts × N instances
      pass.end();
    }

    // Composite → swap chain
    {
      const desc = {
        colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        }],
      };
      if (canTimestamp) desc.timestampWrites = { querySet, beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 };
      const pass = encoder.beginRenderPass(desc);
      pass.setPipeline(compositePipeline);
      pass.setBindGroup(0, compositeBindGroup);
      pass.draw(3, 1);
      pass.end();
    }

    // Snapshot target count for game logic (gated by mapAsync state)
    if (!readbackBusy) {
      encoder.copyBufferToBuffer(targetCounterBuffer, 0, readbackBuffer, 0, 4);
    }

    // Resolve timestamps and queue readback (gated)
    if (canTimestamp) {
      encoder.resolveQuerySet(querySet, 0, TS_COUNT, queryResolveBuf, 0);
      if (!queryBusy) {
        encoder.copyBufferToBuffer(queryResolveBuf, 0, queryReadBuf, 0, TS_COUNT * 8);
      }
    }

    device.queue.submit([encoder.finish()]);

    if (!readbackBusy) {
      readbackBusy = true;
      readbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
        lastTargetCount = new Uint32Array(readbackBuffer.getMappedRange().slice(0))[0];
        readbackBuffer.unmap();
        readbackBusy = false;
      }).catch(() => { readbackBusy = false; });
    }

    if (canTimestamp && !queryBusy) {
      queryBusy = true;
      queryReadBuf.mapAsync(GPUMapMode.READ).then(() => {
        const ts = new BigUint64Array(queryReadBuf.getMappedRange().slice(0));
        // Total GPU = end-of-composite − beginning-of-compute (nanoseconds)
        const ns = Number(ts[5] - ts[0]);
        if (ns > 0 && ns < 5e8) { // sanity (< 500ms)
          gpuRing[gpuIdx] = ns / 1e6;
          gpuIdx = (gpuIdx + 1) % SAMPLE_N;
          if (gpuCount < SAMPLE_N) gpuCount++;
        }
        queryReadBuf.unmap();
        queryBusy = false;
      }).catch(() => { queryBusy = false; });
    }

    // Game logic — uses last available count
    if (target) {
      if (lastTargetCount >= TARGET_PARTICLE_THRESHOLD) {
        target.fill += dt;
        if (target.fill >= TARGET_FILL_TIME) {
          score++;
          scoreEl.textContent = String(score);
          newTarget();
        }
      } else {
        target.fill = Math.max(0, target.fill - dt * 0.6);
      }
    }

    // Perf sampling — record after all per-frame CPU work
    const cpuMs = performance.now() - cpuT0;
    intervalsRing[cpuIdx] = interval > 0 ? interval : 16.67;
    cpuRing[cpuIdx] = cpuMs;
    cpuIdx = (cpuIdx + 1) % SAMPLE_N;
    if (cpuCount < SAMPLE_N) cpuCount++;
    updatePerfUi(t);

    requestAnimationFrame(frame);
  }

  // ---------- Boot ----------
  resize();
  resetParticles();
  requestAnimationFrame(frame);
})();
