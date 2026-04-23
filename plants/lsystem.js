// L-system approach: derive a string from axiom + production rules,
// then interpret it as turtle graphics. Growth is animated by revealing
// segments over time.

(function () {
  const MAX_STRING_LEN = 300000;

  function derive(axiom, rules, iterations) {
    let s = axiom;
    for (let i = 0; i < iterations; i++) {
      let next = '';
      for (let k = 0; k < s.length; k++) {
        const c = s[k];
        next += rules[c] !== undefined ? rules[c] : c;
      }
      s = next;
      if (s.length > MAX_STRING_LEN) break;
    }
    return s;
  }

  // Turtle interprets the derived string. '+' turns right (clockwise on screen),
  // '-' turns left. '[' and ']' push/pop position+heading+depth.
  function buildSegments(str, angleDeg, stepLen) {
    const segments = [];
    const leaves = [];
    const angleRad = (angleDeg * Math.PI) / 180;
    let x = 0, y = 0, theta = Math.PI / 2; // start heading up (+y)
    let depth = 0;
    const stack = [];
    let minX = 0, maxX = 0, minY = 0, maxY = 0;

    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === 'F' || c === 'G') {
        const nx = x + Math.cos(theta) * stepLen;
        const ny = y + Math.sin(theta) * stepLen;
        segments.push({ x1: x, y1: y, x2: nx, y2: ny, depth });
        x = nx; y = ny;
        if (x < minX) minX = x; else if (x > maxX) maxX = x;
        if (y < minY) minY = y; else if (y > maxY) maxY = y;
      } else if (c === 'f') {
        x += Math.cos(theta) * stepLen;
        y += Math.sin(theta) * stepLen;
      } else if (c === '+') {
        theta -= angleRad;
      } else if (c === '-') {
        theta += angleRad;
      } else if (c === '[') {
        stack.push({ x, y, theta, depth });
        depth++;
      } else if (c === ']') {
        const s = stack.pop();
        if (s) { x = s.x; y = s.y; theta = s.theta; depth = s.depth; }
      } else if (c === 'L') {
        leaves.push({ x, y, depth, afterSegment: segments.length });
      }
    }
    return { segments, leaves, bbox: { minX, maxX, minY, maxY } };
  }

  function indexByDepth(segments) {
    const by = [];
    for (let i = 0; i < segments.length; i++) {
      const d = segments[i].depth;
      if (!by[d]) by[d] = [];
      by[d].push(i);
    }
    return by;
  }

  const TRUNK = [120, 78, 42];
  const MID = [150, 140, 60];
  const LEAF = [110, 200, 90];

  function mixChannel(a, b, t) { return Math.round(a + (b - a) * t); }
  function colorAtDepth(d, maxDepth) {
    const t = maxDepth > 0 ? d / maxDepth : 0;
    let r, g, b;
    if (t < 0.5) {
      const u = t * 2;
      r = mixChannel(TRUNK[0], MID[0], u);
      g = mixChannel(TRUNK[1], MID[1], u);
      b = mixChannel(TRUNK[2], MID[2], u);
    } else {
      const u = (t - 0.5) * 2;
      r = mixChannel(MID[0], LEAF[0], u);
      g = mixChannel(MID[1], LEAF[1], u);
      b = mixChannel(MID[2], LEAF[2], u);
    }
    return `rgb(${r},${g},${b})`;
  }

  // Classic plant L-systems from Prusinkiewicz & Lindenmayer,
  // "The Algorithmic Beauty of Plants" (Fig. 1.24).
  const PRESETS = [
    {
      name: 'Plant A',
      axiom: 'F',
      rules: { F: 'F[+F]F[-F]F' },
      params: { angle: 25.7, iterations: 5, step: 3 },
    },
    {
      name: 'Plant B',
      axiom: 'F',
      rules: { F: 'F[+F]F[-F][F]' },
      params: { angle: 20, iterations: 5, step: 3 },
    },
    {
      name: 'Weed',
      axiom: 'F',
      rules: { F: 'FF-[-F+F+F]+[+F-F-F]' },
      params: { angle: 22.5, iterations: 4, step: 2 },
    },
    {
      name: 'Bushy tree',
      axiom: 'X',
      rules: { X: 'F[+X]F[-X]+X', F: 'FF' },
      params: { angle: 20, iterations: 6, step: 1.5 },
    },
    {
      name: 'Leafy tree',
      axiom: 'X',
      rules: { X: 'F[+X][-X]FX', F: 'FF' },
      params: { angle: 25.7, iterations: 6, step: 1.5 },
    },
    {
      name: 'Fractal plant',
      axiom: 'X',
      rules: { X: 'F-[[X]+X]+F[+FX]-X', F: 'FF' },
      params: { angle: 22.5, iterations: 5, step: 2 },
    },
  ];

  const APPROACH = {
    id: 'lsystem',
    name: 'L-system',
    presets: PRESETS,
    params: [
      { key: 'angle', label: 'angle', min: 5, max: 90, step: 0.5, default: 25, fmt: (v) => v.toFixed(1) + '°' },
      { key: 'iterations', label: 'iter', min: 1, max: 7, step: 1, default: 5, fmt: (v) => String(v) },
      { key: 'step', label: 'step', min: 0.5, max: 8, step: 0.1, default: 3, fmt: (v) => v.toFixed(1) },
    ],

    init(world, preset, params) {
      const str = derive(preset.axiom, preset.rules, params.iterations | 0);
      const built = buildSegments(str, params.angle, params.step);
      world.segments = built.segments;
      world.leaves = built.leaves;
      world.rawBbox = built.bbox;
      world.byDepth = indexByDepth(built.segments);
      world.maxDepth = built.segments.reduce((m, s) => (s.depth > m ? s.depth : m), 0);
      world.total = built.segments.length;
      world.reveal = 0;
    },

    step(world, dt, _params, speed) {
      if (world.reveal < world.total) {
        world.reveal = Math.min(world.total, world.reveal + speed * dt);
      }
    },

    draw(ctx, project, world) {
      const segs = world.segments;
      const byDepth = world.byDepth;
      const maxDepth = world.maxDepth;
      const reveal = world.reveal;
      const tipIdx = Math.floor(reveal);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (let d = 0; d <= maxDepth; d++) {
        const group = byDepth[d];
        if (!group) continue;
        ctx.strokeStyle = colorAtDepth(d, maxDepth);
        ctx.lineWidth = Math.max(0.7, (maxDepth - d + 1) * 0.6);
        ctx.beginPath();
        for (let k = 0; k < group.length; k++) {
          const i = group[k];
          if (i > tipIdx) break;
          const s = segs[i];
          let x2 = s.x2, y2 = s.y2;
          if (i === tipIdx && i < segs.length) {
            const frac = reveal - i;
            if (frac <= 0) continue;
            x2 = s.x1 + (s.x2 - s.x1) * frac;
            y2 = s.y1 + (s.y2 - s.y1) * frac;
          }
          const p1 = project(s.x1, s.y1);
          const p2 = project(x2, y2);
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();
      }

      if (world.leaves.length) {
        ctx.fillStyle = '#d04f78';
        for (let i = 0; i < world.leaves.length; i++) {
          const lf = world.leaves[i];
          if (lf.afterSegment > reveal) continue;
          const p = project(lf.x, lf.y);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },

    bbox(world) { return world.rawBbox; },

    status(world) {
      return `segs=${Math.floor(world.reveal)}/${world.total}`;
    },
  };

  (window.APPROACHES = window.APPROACHES || []).push(APPROACH);
})();
