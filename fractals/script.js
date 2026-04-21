(() => {
  const canvas = document.getElementById('main');
  const coordsEl = document.getElementById('coords');
  const zoomInfoEl = document.getElementById('zoomInfo');
  const iterInfoEl = document.getElementById('iterInfo');
  const fractalSelect = document.getElementById('fractal');
  const presetSelect = document.getElementById('preset');
  const paletteSelect = document.getElementById('palette');
  const iterSlider = document.getElementById('iter');
  const iterLabel = document.getElementById('iterLabel');
  const paramSliders = document.getElementById('paramSliders');
  const resetBtn = document.getElementById('reset');

  const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: false })
          || canvas.getContext('experimental-webgl');
  if (!gl) {
    document.body.innerHTML = '<div style="color:#ccc;padding:24px;font-family:monospace">WebGL is not available in this browser.</div>';
    return;
  }

  const PALETTES = { fire: 0, ice: 1, rainbow: 2, electric: 3, grayscale: 4 };

  const VERT = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;

  const FRAG_TEMPLATE = (fractalGlsl) => `
    precision highp float;

    uniform vec2 u_resolution;
    uniform vec2 u_center;
    uniform float u_scale;
    uniform int u_maxIter;
    uniform int u_palette;
    uniform vec4 u_params;

    ${fractalGlsl}

    vec3 palette(float t) {
      t = clamp(t, 0.0, 1.0);
      if (u_palette == 0) {
        return vec3(pow(t, 0.4), pow(t, 1.3), pow(t, 3.0));
      } else if (u_palette == 1) {
        return vec3(pow(t, 3.0), pow(t, 1.4), pow(t, 0.5));
      } else if (u_palette == 2) {
        float a = t * 6.2831853;
        return 0.5 + 0.5 * vec3(cos(a), cos(a + 2.094), cos(a + 4.188));
      } else if (u_palette == 3) {
        float a = t * 6.2831853;
        return vec3(
          0.5 + 0.5 * sin(a * 2.0 + 1.0),
          0.4 + 0.4 * sin(a * 3.0),
          0.6 + 0.4 * cos(a)
        );
      } else {
        return vec3(t);
      }
    }

    void main() {
      vec2 pixel = gl_FragCoord.xy - 0.5 * u_resolution;
      vec2 uv = u_center + pixel / u_resolution.y * 2.0 * u_scale;

      vec2 z, c;
      fractal_init(uv, z, c);

      float smooth_i = -1.0;
      int last = 0;
      for (int i = 0; i < 2000; i++) {
        if (i >= u_maxIter) break;
        z = fractal_step(z, c);
        last = i;
        float m2 = dot(z, z);
        if (m2 > 256.0) {
          float log_zn = 0.5 * log(m2);
          float nu = log(log_zn / 0.6931472) / 0.6931472;
          smooth_i = float(i) + 1.0 - nu;
          break;
        }
      }

      if (smooth_i < 0.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      } else {
        float t = smooth_i / float(u_maxIter);
        t = pow(t, 0.35);
        t = fract(t * 3.0);
        gl_FragColor = vec4(palette(t), 1.0);
      }
    }
  `;

  function compileShader(src, type) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const err = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile failed: ' + err);
    }
    return s;
  }

  function buildProgram(fractalGlsl) {
    const vs = compileShader(VERT, gl.VERTEX_SHADER);
    const fs = compileShader(FRAG_TEMPLATE(fractalGlsl), gl.FRAGMENT_SHADER);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const err = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('Program link failed: ' + err);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return p;
  }

  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW);

  let program = null;
  let uniforms = {};
  let currentFractalId = null;

  function useFractal(id) {
    const def = FRACTALS.find(f => f.id === id);
    if (!def) return;
    if (program) gl.deleteProgram(program);
    program = buildProgram(def.glsl);
    gl.useProgram(program);
    uniforms = {
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      center: gl.getUniformLocation(program, 'u_center'),
      scale: gl.getUniformLocation(program, 'u_scale'),
      maxIter: gl.getUniformLocation(program, 'u_maxIter'),
      palette: gl.getUniformLocation(program, 'u_palette'),
      params: gl.getUniformLocation(program, 'u_params'),
    };
    const posLoc = gl.getAttribLocation(program, 'a_pos');
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    currentFractalId = id;
  }

  const state = {
    fractalId: 'mandelbrot',
    cx: -0.5,
    cy: 0,
    zoom: 0.45,
    iter: 256,
    palette: 'rainbow',
    params: [0, 0, 0, 0],
  };

  function currentFractal() {
    return FRACTALS.find(f => f.id === state.fractalId);
  }

  function applyView(v) {
    state.cx = v.cx;
    state.cy = v.cy;
    state.zoom = v.zoom;
  }

  function rebuildPresets() {
    const def = currentFractal();
    presetSelect.innerHTML = '';
    (def.presets || []).forEach((p, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = p.name;
      presetSelect.appendChild(opt);
    });
  }

  function rebuildParamSliders() {
    const def = currentFractal();
    paramSliders.innerHTML = '';
    (def.params || []).forEach((p) => {
      const wrap = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = p.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(p.min);
      input.max = String(p.max);
      input.step = String(p.step);
      input.value = String(state.params[p.index] ?? p.default);
      const val = document.createElement('span');
      val.className = 'paramVal';
      val.textContent = parseFloat(input.value).toFixed(3);
      input.addEventListener('input', () => {
        state.params[p.index] = parseFloat(input.value);
        val.textContent = parseFloat(input.value).toFixed(3);
        scheduleUrlSave();
        requestDraw();
      });
      wrap.appendChild(name);
      wrap.appendChild(input);
      wrap.appendChild(val);
      paramSliders.appendChild(wrap);
    });
  }

  function switchFractal(id, opts = {}) {
    const def = FRACTALS.find(f => f.id === id);
    if (!def) return;
    state.fractalId = id;
    fractalSelect.value = id;

    // Seed params from defaults (unless caller supplied them)
    const freshParams = [0, 0, 0, 0];
    (def.params || []).forEach(p => { freshParams[p.index] = p.default; });
    if (opts.params) {
      for (let i = 0; i < 4; i++) if (opts.params[i] !== undefined) freshParams[i] = opts.params[i];
    }
    state.params = freshParams;

    if (opts.view) {
      applyView(opts.view);
    } else {
      applyView(def.defaultView);
    }

    useFractal(id);
    rebuildPresets();
    rebuildParamSliders();
    requestDraw();
  }

  // ---------- rendering ----------
  let needsDraw = true;
  function requestDraw() { needsDraw = true; }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      requestDraw();
    }
  }

  function draw() {
    if (!needsDraw) return;
    needsDraw = false;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform2f(uniforms.center, state.cx, state.cy);
    gl.uniform1f(uniforms.scale, 1.0 / state.zoom);
    gl.uniform1i(uniforms.maxIter, Math.round(state.iter));
    gl.uniform1i(uniforms.palette, PALETTES[state.palette] ?? 2);
    gl.uniform4f(uniforms.params, state.params[0], state.params[1], state.params[2], state.params[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    updateHud();
  }

  function loop() {
    draw();
    requestAnimationFrame(loop);
  }

  function updateHud() {
    coordsEl.textContent = `c = ${state.cx.toExponential(6)} ${state.cy >= 0 ? '+' : '−'} ${Math.abs(state.cy).toExponential(6)}i`;
    zoomInfoEl.textContent = `zoom ${formatZoom(state.zoom)}`;
    iterInfoEl.textContent = `iter ${Math.round(state.iter)}`;
    iterLabel.textContent = String(Math.round(state.iter));
  }

  function formatZoom(z) {
    if (z < 1000) return z.toFixed(2) + '×';
    return z.toExponential(2) + '×';
  }

  // ---------- pixel <-> complex ----------
  function pixelToComplex(px, py) {
    const rect = canvas.getBoundingClientRect();
    const x = (px - rect.left) * (canvas.width / rect.width);
    const y = (py - rect.top) * (canvas.height / rect.height);
    // gl_FragCoord y is bottom-up; the same formula (y - H/2) then divided by H works if we mirror.
    const dx = (x - canvas.width / 2) / canvas.height * 2.0 / state.zoom;
    const dy = -(y - canvas.height / 2) / canvas.height * 2.0 / state.zoom;
    return { re: state.cx + dx, im: state.cy + dy };
  }

  // ---------- interaction ----------
  let dragging = false;
  let dragStart = null;
  let dragStartCenter = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.shiftKey && state.fractalId === 'mandelbrot') {
      const p = pixelToComplex(e.clientX, e.clientY);
      switchFractal('julia', { params: [p.re, p.im] });
      scheduleUrlSave();
      return;
    }
    dragging = true;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
    dragStart = { x: e.clientX, y: e.clientY };
    dragStartCenter = { cx: state.cx, cy: state.cy };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    const dxPx = (e.clientX - dragStart.x);
    const dyPx = (e.clientY - dragStart.y);
    const dxC = -dxPx / rect.height * 2.0 / state.zoom;
    const dyC =  dyPx / rect.height * 2.0 / state.zoom;
    state.cx = dragStartCenter.cx + dxC;
    state.cy = dragStartCenter.cy + dyC;
    requestDraw();
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('dragging');
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    scheduleUrlSave();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = pixelToComplex(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0015);
    state.zoom *= factor;
    // keep the complex point under the cursor fixed
    const p2 = pixelToComplex(e.clientX, e.clientY);
    state.cx += p.re - p2.re;
    state.cy += p.im - p2.im;
    autoAdjustIter();
    scheduleUrlSave();
    requestDraw();
  }, { passive: false });

  // pinch-zoom
  const activePointers = new Map();
  let pinchState = null;

  canvas.addEventListener('pointerdown', (e) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) {
      dragging = false;
      canvas.classList.remove('dragging');
      const pts = [...activePointers.values()];
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchState = { midX, midY, dist, anchor: pixelToComplex(midX, midY), zoom: state.zoom };
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinchState && activePointers.size === 2) {
      const pts = [...activePointers.values()];
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      state.zoom = pinchState.zoom * (dist / pinchState.dist);
      // re-anchor under current midpoint
      const now = pixelToComplex(midX, midY);
      state.cx += pinchState.anchor.re - now.re;
      state.cy += pinchState.anchor.im - now.im;
      autoAdjustIter();
      requestDraw();
    }
  });

  function clearPointer(e) {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchState = null;
  }
  canvas.addEventListener('pointerup', clearPointer);
  canvas.addEventListener('pointercancel', clearPointer);

  function autoAdjustIter() {
    // suggest more iterations as user zooms in, but let manual override stick
    if (userSetIter) return;
    const suggested = Math.max(128, Math.min(1500, Math.round(128 + 80 * Math.log10(Math.max(1, state.zoom)))));
    state.iter = suggested;
    iterSlider.value = String(suggested);
  }

  // ---------- controls ----------
  FRACTALS.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name;
    fractalSelect.appendChild(opt);
  });

  fractalSelect.addEventListener('change', () => {
    switchFractal(fractalSelect.value);
    scheduleUrlSave();
  });

  presetSelect.addEventListener('change', () => {
    const def = currentFractal();
    const p = (def.presets || [])[parseInt(presetSelect.value, 10)];
    if (!p) return;
    applyView({ cx: p.cx, cy: p.cy, zoom: p.zoom });
    if (p.params) {
      for (let i = 0; i < 4; i++) if (p.params[i] !== undefined) state.params[i] = p.params[i];
      rebuildParamSliders();
    }
    autoAdjustIter();
    scheduleUrlSave();
    requestDraw();
  });

  paletteSelect.addEventListener('change', () => {
    state.palette = paletteSelect.value;
    scheduleUrlSave();
    requestDraw();
  });

  let userSetIter = false;
  iterSlider.addEventListener('input', () => {
    state.iter = parseInt(iterSlider.value, 10);
    userSetIter = true;
    scheduleUrlSave();
    requestDraw();
  });

  resetBtn.addEventListener('click', () => {
    const def = currentFractal();
    applyView(def.defaultView);
    userSetIter = false;
    autoAdjustIter();
    iterSlider.value = String(state.iter);
    // also reset params to their defaults
    const freshParams = [0, 0, 0, 0];
    (def.params || []).forEach(p => { freshParams[p.index] = p.default; });
    state.params = freshParams;
    rebuildParamSliders();
    scheduleUrlSave();
    requestDraw();
  });

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.key === 'r' || e.key === 'R') resetBtn.click();
  });

  // ---------- URL hash persistence ----------
  let saveTimer = null;
  function scheduleUrlSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToUrl, 200);
  }
  function saveToUrl() {
    const def = currentFractal();
    const parts = [
      `f=${state.fractalId}`,
      `cx=${state.cx}`,
      `cy=${state.cy}`,
      `z=${state.zoom}`,
      `i=${Math.round(state.iter)}`,
      `pal=${state.palette}`,
    ];
    if (def.params && def.params.length) {
      const p = def.params.map(pp => state.params[pp.index]).join(',');
      parts.push(`p=${p}`);
    }
    history.replaceState(null, '', '#' + parts.join('&'));
  }

  function loadFromUrl() {
    const hash = location.hash.replace(/^#/, '');
    if (!hash) return false;
    const kv = Object.fromEntries(hash.split('&').map(s => s.split('=')));
    const id = kv.f;
    const def = FRACTALS.find(f => f.id === id);
    if (!def) return false;

    const params = [0, 0, 0, 0];
    (def.params || []).forEach(p => { params[p.index] = p.default; });
    if (kv.p) {
      const vals = kv.p.split(',').map(parseFloat);
      (def.params || []).forEach((p, i) => { if (!isNaN(vals[i])) params[p.index] = vals[i]; });
    }

    const view = {
      cx: parseFloat(kv.cx ?? def.defaultView.cx),
      cy: parseFloat(kv.cy ?? def.defaultView.cy),
      zoom: parseFloat(kv.z ?? def.defaultView.zoom),
    };

    switchFractal(id, { view, params });

    if (kv.i) {
      state.iter = parseInt(kv.i, 10);
      userSetIter = true;
      iterSlider.value = String(state.iter);
    }
    if (kv.pal && PALETTES[kv.pal] !== undefined) {
      state.palette = kv.pal;
      paletteSelect.value = kv.pal;
    }
    requestDraw();
    return true;
  }

  // ---------- init ----------
  window.addEventListener('resize', () => { resize(); });
  resize();

  if (!loadFromUrl()) {
    switchFractal(state.fractalId);
  }
  requestAnimationFrame(loop);
})();
