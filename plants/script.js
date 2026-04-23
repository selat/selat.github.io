(() => {
  const canvas = document.getElementById('main');
  const ctx = canvas.getContext('2d');
  const infoEl = document.getElementById('info');
  const approachSelect = document.getElementById('approach');
  const presetSelect = document.getElementById('preset');
  const playPauseBtn = document.getElementById('playPause');
  const resetBtn = document.getElementById('reset');
  const speedSlider = document.getElementById('speed');
  const speedLabel = document.getElementById('speedLabel');
  const paramSlidersEl = document.getElementById('paramSliders');

  const APPROACHES = window.APPROACHES || [];
  if (!APPROACHES.length) {
    infoEl.textContent = 'no approaches registered';
    return;
  }

  const camera = { x: 0, y: 0, scale: 1 };
  const sim = { playing: true, speed: 1, t: 0 };

  let currentApproach = null;
  let currentPreset = null;
  let params = {};
  let world = {};
  let smoothedFps = 60;
  let lastFrameTime = performance.now();
  const lastMouse = { x: 0, y: 0 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', () => { resize(); fitView(); });

  function project(wx, wy) {
    return {
      x: (wx - camera.x) * camera.scale + window.innerWidth / 2,
      y: (camera.y - wy) * camera.scale + window.innerHeight / 2,
    };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - window.innerWidth / 2) / camera.scale + camera.x,
      y: camera.y - (sy - window.innerHeight / 2) / camera.scale,
    };
  }

  function fitView() {
    const bb = currentApproach.bbox ? currentApproach.bbox(world) : null;
    if (!bb) return;
    const w = Math.max(1, bb.maxX - bb.minX);
    const h = Math.max(1, bb.maxY - bb.minY);
    camera.x = (bb.minX + bb.maxX) / 2;
    camera.y = (bb.minY + bb.maxY) / 2;
    const pad = 1.15;
    const sx = window.innerWidth / (w * pad);
    const sy = window.innerHeight / (h * pad);
    camera.scale = Math.min(sx, sy);
  }

  function populateApproachDropdown() {
    approachSelect.innerHTML = '';
    for (const a of APPROACHES) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name;
      approachSelect.appendChild(opt);
    }
  }

  function populatePresetDropdown() {
    presetSelect.innerHTML = '';
    for (const p of currentApproach.presets) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      presetSelect.appendChild(opt);
    }
  }

  function buildParamSliders() {
    paramSlidersEl.innerHTML = '';
    const defs = currentApproach.params || [];
    for (const pp of defs) {
      const lab = document.createElement('label');
      lab.className = 'param';
      const name = document.createElement('span');
      name.textContent = pp.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = pp.min;
      input.max = pp.max;
      input.step = pp.step;
      input.value = params[pp.key];
      const val = document.createElement('span');
      val.className = 'val';
      const fmt = pp.fmt || ((v) => String(v));
      val.textContent = fmt(params[pp.key]);
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        params[pp.key] = v;
        val.textContent = fmt(v);
        world = {};
        currentApproach.init(world, currentPreset, params);
        fitView();
      });
      lab.appendChild(name);
      lab.appendChild(input);
      lab.appendChild(val);
      paramSlidersEl.appendChild(lab);
    }
  }

  function selectApproach(id) {
    const a = APPROACHES.find((x) => x.id === id);
    if (!a) return;
    currentApproach = a;
    approachSelect.value = id;
    populatePresetDropdown();
    selectPreset(a.presets[0].name);
  }

  function selectPreset(name) {
    const p = currentApproach.presets.find((x) => x.name === name);
    if (!p) return;
    currentPreset = p;
    presetSelect.value = name;
    params = {};
    for (const pp of currentApproach.params || []) params[pp.key] = pp.default;
    if (p.params) Object.assign(params, p.params);
    buildParamSliders();
    world = {};
    currentApproach.init(world, currentPreset, params);
    fitView();
  }

  function setPlaying(p) {
    sim.playing = p;
    playPauseBtn.textContent = p ? '⏸' : '▶';
  }

  function speedFromSlider(v) {
    return Math.exp(Math.log(5000) * v);
  }

  function formatSpeed(s) {
    if (s < 10) return s.toFixed(1) + '/s';
    if (s < 1000) return Math.round(s) + '/s';
    return (s / 1000).toFixed(1) + 'k/s';
  }

  approachSelect.addEventListener('change', () => selectApproach(approachSelect.value));
  presetSelect.addEventListener('change', () => selectPreset(presetSelect.value));
  playPauseBtn.addEventListener('click', () => setPlaying(!sim.playing));
  resetBtn.addEventListener('click', () => {
    world = {};
    currentApproach.init(world, currentPreset, params);
    fitView();
  });
  speedSlider.addEventListener('input', () => {
    sim.speed = speedFromSlider(parseFloat(speedSlider.value));
    speedLabel.textContent = formatSpeed(sim.speed);
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      setPlaying(!sim.playing);
    }
  });

  // Pan/zoom/pinch — ported from orbits/script.js.
  let panState = null;
  const pointers = new Map();
  let pinchState = null;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    if (e.pointerType === 'mouse') {
      panState = { lastX: e.clientX, lastY: e.clientY };
      canvas.classList.add('dragging');
      return;
    }
    if (pointers.size === 1) {
      panState = { lastX: e.clientX, lastY: e.clientY };
    } else if (pointers.size === 2) {
      panState = null;
      const pts = [...pointers.values()];
      pinchState = {
        lastDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        lastMidX: (pts[0].x + pts[1].x) / 2,
        lastMidY: (pts[0].y + pts[1].y) / 2,
      };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    }
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;

    if (e.pointerType === 'mouse') {
      if (panState) {
        const dx = e.clientX - panState.lastX;
        const dy = e.clientY - panState.lastY;
        camera.x -= dx / camera.scale;
        camera.y += dy / camera.scale;
        panState.lastX = e.clientX;
        panState.lastY = e.clientY;
      }
      return;
    }

    if (pointers.size === 1 && panState) {
      const dx = e.clientX - panState.lastX;
      const dy = e.clientY - panState.lastY;
      camera.x -= dx / camera.scale;
      camera.y += dy / camera.scale;
      panState.lastX = e.clientX;
      panState.lastY = e.clientY;
    } else if (pointers.size === 2 && pinchState) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;

      if (pinchState.lastDist > 0) {
        const factor = dist / pinchState.lastDist;
        const before = screenToWorld(midX, midY);
        camera.scale *= factor;
        const after = screenToWorld(midX, midY);
        camera.x += before.x - after.x;
        camera.y += before.y - after.y;
      }

      const dx = midX - pinchState.lastMidX;
      const dy = midY - pinchState.lastMidY;
      camera.x -= dx / camera.scale;
      camera.y += dy / camera.scale;

      pinchState.lastDist = dist;
      pinchState.lastMidX = midX;
      pinchState.lastMidY = midY;
    }
  });

  function endPointer(e) {
    const entry = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);

    if (!entry || entry.type === 'mouse') {
      if (panState) {
        panState = null;
        canvas.classList.remove('dragging');
      }
      return;
    }

    if (pointers.size === 0) {
      panState = null;
      pinchState = null;
    } else if (pointers.size === 1) {
      pinchState = null;
      const remaining = [...pointers.values()][0];
      panState = { lastX: remaining.x, lastY: remaining.y };
    }
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.001);
    const before = screenToWorld(e.clientX, e.clientY);
    camera.scale *= factor;
    const after = screenToWorld(e.clientX, e.clientY);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
  }, { passive: false });

  function updateHud() {
    let extra = '';
    if (currentApproach.status) extra = '  ' + currentApproach.status(world);
    infoEl.textContent =
      `t=${sim.t.toFixed(1)}s  fps=${smoothedFps.toFixed(0)}  zoom=${camera.scale.toExponential(2)}${extra}`;
  }

  function render() {
    const now = performance.now();
    const dtMs = now - lastFrameTime;
    lastFrameTime = now;
    if (dtMs > 0) smoothedFps = smoothedFps * 0.9 + (1000 / dtMs) * 0.1;
    const dt = Math.min(dtMs / 1000, 0.1);

    if (sim.playing) {
      sim.t += dt;
      currentApproach.step(world, dt, params, sim.speed);
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    currentApproach.draw(ctx, project, world, params);
    updateHud();
    requestAnimationFrame(render);
  }

  populateApproachDropdown();
  selectApproach(APPROACHES[0].id);
  sim.speed = speedFromSlider(parseFloat(speedSlider.value));
  speedLabel.textContent = formatSpeed(sim.speed);
  requestAnimationFrame(render);
})();
