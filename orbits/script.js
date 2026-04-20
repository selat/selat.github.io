(() => {
  const AU = 1.495978707e11;
  const G = 6.6743e-11;
  const DAY = 86400;
  const YEAR = 365.25 * DAY;
  const SOFTENING = 1e7;
  const MSUN = 1.989e30;

  const canvas = document.getElementById('main');
  const ctx = canvas.getContext('2d');
  const sideCanvas = document.getElementById('side');
  const sideCtx = sideCanvas.getContext('2d');
  const coordsEl = document.getElementById('coords');
  const playPauseBtn = document.getElementById('playPause');
  const resetBtn = document.getElementById('reset');
  const speedSlider = document.getElementById('speed');
  const speedLabel = document.getElementById('speedLabel');
  const presetSelect = document.getElementById('preset');

  const camera = { x: 0, y: 0, scale: 1 };

  const SIDE_CSS_W = 260;
  const SIDE_CSS_H = 110;

  // Body at perihelion, orbit inclined about the x-axis. Sun (central mass) assumed at origin.
  function planet(name, { a, e, iDeg, mass, color, radiusPx }) {
    const r = a * (1 - e);
    const v = Math.sqrt(G * MSUN * (1 + e) / r);
    const i = iDeg * Math.PI / 180;
    return {
      name,
      pos: { x: r, y: 0, z: 0 },
      vel: { x: 0, y: v * Math.cos(i), z: v * Math.sin(i) },
      mass, color, radiusPx,
    };
  }

  function sun() {
    return {
      name: 'Sun',
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      mass: MSUN,
      color: '#ffcf6b',
      radiusPx: 10,
    };
  }

  function binaryPair(m1, m2, a, e, color1, color2, radius1, radius2, name1, name2) {
    const M = m1 + m2;
    const r = a * (1 - e);
    const vRel = Math.sqrt(G * M * (1 + e) / r);
    const r1 = (m2 / M) * r;
    const r2 = (m1 / M) * r;
    const v1 = (m2 / M) * vRel;
    const v2 = (m1 / M) * vRel;
    return [
      { name: name1, pos: { x: -r1, y: 0, z: 0 }, vel: { x: 0, y: -v1, z: 0 }, mass: m1, color: color1, radiusPx: radius1 },
      { name: name2, pos: { x:  r2, y: 0, z: 0 }, vel: { x: 0, y:  v2, z: 0 }, mass: m2, color: color2, radiusPx: radius2 },
    ];
  }

  const PRESETS = {
    sunEarth: {
      label: 'Sun + Earth',
      viewRadius: 2.5 * AU,
      bodies: () => [
        sun(),
        planet('Earth', { a: 1 * AU, e: 0.0167, iDeg: 0, mass: 5.972e24, color: '#6bb6ff', radiusPx: 4 }),
      ],
    },
    earthMoon: {
      label: 'Earth + Moon',
      viewRadius: 5e8,
      bodies: () => [
        { name: 'Earth', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, mass: 5.972e24, color: '#6bb6ff', radiusPx: 8 },
        { name: 'Moon',  pos: { x: 3.844e8, y: 0, z: 0 }, vel: { x: 0, y: 1022, z: 0 }, mass: 7.342e22, color: '#cccccc', radiusPx: 4 },
      ],
    },
    solarSystem: {
      label: 'Solar system',
      viewRadius: 32 * AU,
      bodies: () => [
        sun(),
        planet('Mercury', { a: 0.387 * AU, e: 0.2056, iDeg: 7.00, mass: 3.301e23, color: '#9a9a9a', radiusPx: 2 }),
        planet('Venus',   { a: 0.723 * AU, e: 0.0068, iDeg: 3.39, mass: 4.867e24, color: '#e6c88c', radiusPx: 3 }),
        planet('Earth',   { a: 1.000 * AU, e: 0.0167, iDeg: 0.00, mass: 5.972e24, color: '#6bb6ff', radiusPx: 3 }),
        planet('Mars',    { a: 1.524 * AU, e: 0.0934, iDeg: 1.85, mass: 6.417e23, color: '#ff8050', radiusPx: 3 }),
        planet('Jupiter', { a: 5.203 * AU, e: 0.0489, iDeg: 1.30, mass: 1.898e27, color: '#d8b48a', radiusPx: 6 }),
        planet('Saturn',  { a: 9.537 * AU, e: 0.0565, iDeg: 2.49, mass: 5.683e26, color: '#e8d69a', radiusPx: 5 }),
        planet('Uranus',  { a:19.191 * AU, e: 0.0457, iDeg: 0.77, mass: 8.681e25, color: '#a0e0d0', radiusPx: 4 }),
        planet('Neptune', { a:30.069 * AU, e: 0.0113, iDeg: 1.77, mass: 1.024e26, color: '#5080e0', radiusPx: 4 }),
      ],
    },
    alphaCentauri: {
      label: 'Alpha Centauri A/B',
      viewRadius: 20 * AU,
      bodies: () => binaryPair(
        1.079 * MSUN, 0.909 * MSUN, 23.52 * AU, 0.5179,
        '#ffdd80', '#ff9060', 8, 7, 'A', 'B',
      ),
    },
    figure8: {
      label: 'Figure-8 (3-body)',
      viewRadius: 1.8 * AU,
      bodies: () => {
        // Chenciner-Montgomery 2000: equal-mass choreography on figure-8 path.
        const M = 1e28;
        const L = AU;
        const V = Math.sqrt(G * M / L);
        return [
          { name: 'A', pos: { x:  0.97000436 * L, y: -0.24308753 * L, z: 0 },
            vel: { x:  0.46620368 * V, y:  0.43236573 * V, z: 0 },
            mass: M, color: '#ff6b8e', radiusPx: 5 },
          { name: 'B', pos: { x: -0.97000436 * L, y:  0.24308753 * L, z: 0 },
            vel: { x:  0.46620368 * V, y:  0.43236573 * V, z: 0 },
            mass: M, color: '#6bff8e', radiusPx: 5 },
          { name: 'C', pos: { x: 0, y: 0, z: 0 },
            vel: { x: -0.93240737 * V, y: -0.86473146 * V, z: 0 },
            mass: M, color: '#6b8eff', radiusPx: 5 },
        ];
      },
    },
    pythagorean: {
      label: 'Pythagorean (3-4-5)',
      viewRadius: 6 * AU,
      bodies: () => [
        { name: '3', pos: { x:  1 * AU, y:  3 * AU, z: 0 }, vel: { x: 0, y: 0, z: 0 }, mass: 3 * MSUN, color: '#ff8060', radiusPx: 6 },
        { name: '4', pos: { x: -2 * AU, y: -1 * AU, z: 0 }, vel: { x: 0, y: 0, z: 0 }, mass: 4 * MSUN, color: '#60ff80', radiusPx: 7 },
        { name: '5', pos: { x:  1 * AU, y: -1 * AU, z: 0 }, vel: { x: 0, y: 0, z: 0 }, mass: 5 * MSUN, color: '#6080ff', radiusPx: 8 },
      ],
    },
    trojans: {
      label: 'Sun + Jupiter + Trojans',
      viewRadius: 7 * AU,
      bodies: () => {
        const aJ = 5.2 * AU;
        const vJ = Math.sqrt(G * MSUN / aJ);
        const out = [
          sun(),
          { name: 'Jupiter', pos: { x: aJ, y: 0, z: 0 }, vel: { x: 0, y: vJ, z: 0 }, mass: 1.898e27, color: '#d8b48a', radiusPx: 6 },
        ];
        for (const [label, angDeg, col] of [['L4', 60, '#a0ffa0'], ['L5', -60, '#ffa0a0']]) {
          for (let k = 0; k < 4; k++) {
            const offset = (k - 1.5) * 2.5;
            const ang = (angDeg + offset) * Math.PI / 180;
            const r = aJ * (1 + (k - 1.5) * 0.01);
            out.push({
              name: `${label}-${k}`,
              pos: { x: r * Math.cos(ang), y: r * Math.sin(ang), z: 0 },
              vel: { x: -vJ * Math.sin(ang), y: vJ * Math.cos(ang), z: 0 },
              mass: 1e18,
              color: col,
              radiusPx: 2,
            });
          }
        }
        return out;
      },
    },
    inclined: {
      label: 'Inclined triple',
      viewRadius: 10 * AU,
      bodies: () => [
        sun(),
        planet('Inner',  { a: 0.8 * AU, e: 0.0,  iDeg:  0, mass: 1e25, color: '#6bb6ff', radiusPx: 3 }),
        planet('Tilted', { a: 2.5 * AU, e: 0.2,  iDeg: 55, mass: 1e25, color: '#ff80a0', radiusPx: 3 }),
        planet('Outer',  { a: 6.0 * AU, e: 0.35, iDeg: 25, mass: 1e25, color: '#a0ff80', radiusPx: 3 }),
      ],
    },
    random: {
      label: 'Random cluster',
      viewRadius: 5 * AU,
      bodies: () => {
        const core = {
          name: 'Core',
          pos: { x: 0, y: 0, z: 0 },
          vel: { x: 0, y: 0, z: 0 },
          mass: 1e30,
          color: '#ffcf6b',
          radiusPx: 8,
        };
        const out = [core];
        const N = 25;
        for (let i = 0; i < N; i++) {
          const r = (0.5 + Math.random() * 2.5) * AU;
          const theta = Math.random() * 2 * Math.PI;
          const zFrac = (Math.random() - 0.5) * 0.3;
          const x = r * Math.cos(theta);
          const y = r * Math.sin(theta);
          const z = r * zFrac;
          const vC = Math.sqrt(G * core.mass / r);
          const vmag = vC * (0.7 + Math.random() * 0.5);
          out.push({
            name: `b${i}`,
            pos: { x, y, z },
            vel: {
              x: -vmag * Math.sin(theta),
              y:  vmag * Math.cos(theta),
              z:  vmag * (Math.random() - 0.5) * 0.25,
            },
            mass: 1e24 * Math.pow(10, Math.random() * 2),
            color: `hsl(${Math.floor(Math.random() * 360)}, 70%, 72%)`,
            radiusPx: 2,
          });
        }
        return out;
      },
    },
  };

  let bodies = [];
  let currentPreset = 'solarSystem';

  function centerOnCom() {
    let M = 0, cx = 0, cy = 0, cz = 0, px = 0, py = 0, pz = 0;
    for (const b of bodies) {
      M += b.mass;
      cx += b.mass * b.pos.x; cy += b.mass * b.pos.y; cz += b.mass * b.pos.z;
      px += b.mass * b.vel.x; py += b.mass * b.vel.y; pz += b.mass * b.vel.z;
    }
    cx /= M; cy /= M; cz /= M;
    const vx = px / M, vy = py / M, vz = pz / M;
    for (const b of bodies) {
      b.pos.x -= cx; b.pos.y -= cy; b.pos.z -= cz;
      b.vel.x -= vx; b.vel.y -= vy; b.vel.z -= vz;
    }
  }

  function loadPreset(key) {
    const preset = PRESETS[key];
    if (!preset) return;
    currentPreset = key;
    const source = preset.bodies();
    bodies = source.map((b) => ({
      name: b.name,
      pos: { ...b.pos },
      vel: { ...b.vel },
      acc: { x: 0, y: 0, z: 0 },
      mass: b.mass,
      color: b.color,
      radiusPx: b.radiusPx,
      trail: [],
    }));
    centerOnCom();
    computeAccelerations();
    sim.t = 0;
    camera.x = 0;
    camera.y = 0;
    camera.scale = (window.innerWidth / 2) / preset.viewRadius;
  }

  const sim = {
    t: 0,
    dt: 3600,
    substeps: 45,
    playing: true,
    trailMax: 600,
  };

  let lastFrameTime = performance.now();
  let smoothedFps = 60;

  function speedFromSlider(v) {
    return Math.max(1, Math.round(Math.exp(Math.log(1000) * v)));
  }

  function formatRate(substepsPerFrame) {
    const daysPerSec = (substepsPerFrame * sim.dt * 60) / DAY;
    if (daysPerSec < 1) return `${daysPerSec.toFixed(2)} d/s`;
    if (daysPerSec < 365) return `${daysPerSec.toFixed(1)} d/s`;
    return `${(daysPerSec / 365.25).toFixed(2)} yr/s`;
  }

  function computeAccelerations() {
    for (const b of bodies) {
      b.acc.x = 0; b.acc.y = 0; b.acc.z = 0;
    }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const dz = b.pos.z - a.pos.z;
        const r2 = dx * dx + dy * dy + dz * dz + SOFTENING * SOFTENING;
        const invR = 1 / Math.sqrt(r2);
        const invR3 = invR * invR * invR;
        const k = G * invR3;
        a.acc.x += k * b.mass * dx;
        a.acc.y += k * b.mass * dy;
        a.acc.z += k * b.mass * dz;
        b.acc.x -= k * a.mass * dx;
        b.acc.y -= k * a.mass * dy;
        b.acc.z -= k * a.mass * dz;
      }
    }
  }

  function step(dt) {
    const halfDt = 0.5 * dt;
    for (const b of bodies) {
      b.vel.x += b.acc.x * halfDt;
      b.vel.y += b.acc.y * halfDt;
      b.vel.z += b.acc.z * halfDt;
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.pos.z += b.vel.z * dt;
    }
    computeAccelerations();
    for (const b of bodies) {
      b.vel.x += b.acc.x * halfDt;
      b.vel.y += b.acc.y * halfDt;
      b.vel.z += b.acc.z * halfDt;
    }
    sim.t += dt;
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    sideCanvas.width = Math.floor(SIDE_CSS_W * dpr);
    sideCanvas.height = Math.floor(SIDE_CSS_H * dpr);
    sideCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  function projectMain(wh, wv) {
    return {
      x: (wh - camera.x) * camera.scale + window.innerWidth / 2,
      y: (camera.y - wv) * camera.scale + window.innerHeight / 2,
    };
  }

  function projectSide(wh, wv) {
    return {
      x: (wh - camera.x) * camera.scale + SIDE_CSS_W / 2,
      y: -wv * camera.scale + SIDE_CSS_H / 2,
    };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - window.innerWidth / 2) / camera.scale + camera.x,
      y: camera.y - (sy - window.innerHeight / 2) / camera.scale,
    };
  }

  let dragging = null;
  let pendingBody = null;
  let colorCycle = 0;
  const NEW_COLORS = ['#d070ff', '#ff5090', '#80ff90', '#ffef70', '#70e0ff', '#ffaa50'];
  const NEW_BODY_MASS = 1e23;
  const VELOCITY_TIME_BASE = YEAR;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.shiftKey) {
      const w = screenToWorld(e.clientX, e.clientY);
      pendingBody = { start: w, end: w };
    } else {
      dragging = { sx: e.clientX, sy: e.clientY, cx: camera.x, cy: camera.y };
      canvas.classList.add('dragging');
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      camera.x = dragging.cx - (e.clientX - dragging.sx) / camera.scale;
      camera.y = dragging.cy + (e.clientY - dragging.sy) / camera.scale;
    } else if (pendingBody) {
      pendingBody.end = screenToWorld(e.clientX, e.clientY);
    }
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
  });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = null;
      canvas.classList.remove('dragging');
    }
    if (pendingBody) {
      const { start, end } = pendingBody;
      const color = NEW_COLORS[colorCycle++ % NEW_COLORS.length];
      bodies.push({
        name: 'body',
        pos: { x: start.x, y: start.y, z: 0 },
        vel: {
          x: (end.x - start.x) / VELOCITY_TIME_BASE,
          y: (end.y - start.y) / VELOCITY_TIME_BASE,
          z: 0,
        },
        acc: { x: 0, y: 0, z: 0 },
        mass: NEW_BODY_MASS,
        color,
        radiusPx: 3,
        trail: [],
      });
      computeAccelerations();
      pendingBody = null;
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.001);
    const before = screenToWorld(e.clientX, e.clientY);
    camera.scale *= factor;
    const after = screenToWorld(e.clientX, e.clientY);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
  }, { passive: false });

  const lastMouse = { x: 0, y: 0 };

  function setPlaying(p) {
    sim.playing = p;
    playPauseBtn.textContent = p ? '⏸' : '▶';
  }

  playPauseBtn.addEventListener('click', () => setPlaying(!sim.playing));
  resetBtn.addEventListener('click', () => loadPreset(currentPreset));
  presetSelect.addEventListener('change', () => loadPreset(presetSelect.value));
  speedSlider.addEventListener('input', () => {
    sim.substeps = speedFromSlider(parseFloat(speedSlider.value));
    speedLabel.textContent = formatRate(sim.substeps);
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      setPlaying(!sim.playing);
    }
  });

  function updateHud() {
    const w = screenToWorld(lastMouse.x, lastMouse.y);
    const years = sim.t / YEAR;
    let extra = '';
    if (pendingBody) {
      const dx = pendingBody.end.x - pendingBody.start.x;
      const dy = pendingBody.end.y - pendingBody.start.y;
      const vkms = Math.hypot(dx, dy) / VELOCITY_TIME_BASE / 1000;
      extra = `  v=${vkms.toFixed(1)} km/s  n=${bodies.length}`;
    } else {
      extra = `  n=${bodies.length}`;
    }
    coordsEl.textContent =
      `t=${years.toFixed(3)} yr  ` +
      `fps=${smoothedFps.toFixed(0)}  ` +
      `x=${(w.x / AU).toFixed(3)} AU  ` +
      `y=${(w.y / AU).toFixed(3)} AU  ` +
      `zoom=${camera.scale.toExponential(2)}` + extra;
  }

  function drawPending() {
    if (!pendingBody) return;
    const s = projectMain(pendingBody.start.x, pendingBody.start.y);
    const e = projectMain(pendingBody.end.x, pendingBody.end.y);
    ctx.strokeStyle = '#fff';
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
    ctx.stroke();
    if (Math.hypot(e.x - s.x, e.y - s.y) > 2) {
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
      const ang = Math.atan2(e.y - s.y, e.x - s.x);
      const ah = 6;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(e.x - ah * Math.cos(ang - 0.4), e.y - ah * Math.sin(ang - 0.4));
      ctx.lineTo(e.x - ah * Math.cos(ang + 0.4), e.y - ah * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function pushTrails() {
    for (const b of bodies) {
      b.trail.push(b.pos.x, b.pos.y, b.pos.z);
      const maxLen = sim.trailMax * 3;
      if (b.trail.length > maxLen) {
        b.trail.splice(0, b.trail.length - maxLen);
      }
    }
  }

  function drawScene(targetCtx, w, h, project, hIdx, vIdx) {
    targetCtx.fillStyle = '#000';
    targetCtx.fillRect(0, 0, w, h);

    if (vIdx === 2) {
      targetCtx.strokeStyle = '#222';
      targetCtx.lineWidth = 1;
      targetCtx.beginPath();
      targetCtx.moveTo(0, h / 2);
      targetCtx.lineTo(w, h / 2);
      targetCtx.stroke();
    }

    for (const b of bodies) {
      const t = b.trail;
      if (t.length < 6) continue;
      targetCtx.strokeStyle = b.color;
      targetCtx.globalAlpha = 0.55;
      targetCtx.lineWidth = 1;
      targetCtx.beginPath();
      const s0 = project(t[hIdx], t[vIdx]);
      targetCtx.moveTo(s0.x, s0.y);
      for (let i = 3; i < t.length; i += 3) {
        const s = project(t[i + hIdx], t[i + vIdx]);
        targetCtx.lineTo(s.x, s.y);
      }
      targetCtx.stroke();
    }
    targetCtx.globalAlpha = 1;

    for (const b of bodies) {
      const comps = [b.pos.x, b.pos.y, b.pos.z];
      const s = project(comps[hIdx], comps[vIdx]);
      targetCtx.beginPath();
      targetCtx.arc(s.x, s.y, b.radiusPx, 0, Math.PI * 2);
      targetCtx.fillStyle = b.color;
      targetCtx.fill();
    }
  }

  function render() {
    const now = performance.now();
    const dtMs = now - lastFrameTime;
    lastFrameTime = now;
    if (dtMs > 0) smoothedFps = smoothedFps * 0.9 + (1000 / dtMs) * 0.1;

    if (sim.playing) {
      for (let i = 0; i < sim.substeps; i++) step(sim.dt);
      pushTrails();
    }

    drawScene(ctx, window.innerWidth, window.innerHeight, projectMain, 0, 1);
    drawScene(sideCtx, SIDE_CSS_W, SIDE_CSS_H, projectSide, 0, 2);
    drawPending();

    updateHud();
    requestAnimationFrame(render);
  }

  presetSelect.value = currentPreset;
  loadPreset(currentPreset);
  sim.substeps = speedFromSlider(parseFloat(speedSlider.value));
  speedLabel.textContent = formatRate(sim.substeps);
  requestAnimationFrame(render);
})();
