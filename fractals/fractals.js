// Each fractal plugs into a shared shader template by defining:
//   void fractal_init(vec2 uv, out vec2 z, out vec2 c);
//   vec2 fractal_step(vec2 z, vec2 c);
// Optional `params` become sliders wired to u_params.x/y/z/w.
// Optional `presets` populate the preset dropdown when this fractal is active.

const FRACTALS = [
  {
    id: 'mandelbrot',
    name: 'Mandelbrot',
    defaultView: { cx: -0.5, cy: 0, zoom: 0.45 },
    presets: [
      { name: 'Default',          cx: -0.5,          cy: 0,             zoom: 0.45 },
      { name: 'Seahorse Valley',  cx: -0.7453,       cy: 0.1127,        zoom: 250 },
      { name: 'Elephant Valley',  cx: 0.2549,        cy: 0,             zoom: 120 },
      { name: 'Mini Mandelbrot',  cx: -1.7499,       cy: 0,             zoom: 800 },
      { name: 'Spiral',           cx: -0.761574,     cy: -0.0847596,    zoom: 1200 },
      { name: 'Triple Spiral',    cx: -0.088,        cy:  0.654,        zoom: 150 },
    ],
    params: [],
    glsl: `
      void fractal_init(vec2 uv, out vec2 z, out vec2 c) { z = vec2(0.0); c = uv; }
      vec2 fractal_step(vec2 z, vec2 c) {
        return vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
      }
    `,
  },

  {
    id: 'julia',
    name: 'Julia',
    defaultView: { cx: 0, cy: 0, zoom: 0.5 },
    presets: [
      { name: 'Dendrite',      cx: 0, cy: 0, zoom: 0.5, params: [ 0,      1 ] },
      { name: 'Douady Rabbit', cx: 0, cy: 0, zoom: 0.5, params: [-0.123, 0.745 ] },
      { name: 'San Marco',     cx: 0, cy: 0, zoom: 0.5, params: [-0.75,   0 ] },
      { name: 'Siegel Disk',   cx: 0, cy: 0, zoom: 0.5, params: [-0.391, -0.587 ] },
      { name: 'Spiral',        cx: 0, cy: 0, zoom: 0.5, params: [-0.8,    0.156 ] },
      { name: 'Lightning',     cx: 0, cy: 0, zoom: 0.5, params: [ 0.285,  0.01 ] },
    ],
    params: [
      { index: 0, label: 'cₓ', min: -2, max: 2, step: 0.001, default: -0.8 },
      { index: 1, label: 'cᵧ', min: -2, max: 2, step: 0.001, default: 0.156 },
    ],
    glsl: `
      void fractal_init(vec2 uv, out vec2 z, out vec2 c) { z = uv; c = u_params.xy; }
      vec2 fractal_step(vec2 z, vec2 c) {
        return vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
      }
    `,
  },

  {
    id: 'burningship',
    name: 'Burning Ship',
    defaultView: { cx: -0.5, cy: -0.5, zoom: 0.45 },
    presets: [
      { name: 'Default',   cx: -0.5,    cy: -0.5,    zoom: 0.45 },
      { name: 'The Ship',  cx: -1.7615, cy: -0.0287, zoom: 250 },
      { name: 'Mini Ship', cx: -1.941,  cy: -0.0015, zoom: 900 },
    ],
    params: [],
    glsl: `
      void fractal_init(vec2 uv, out vec2 z, out vec2 c) { z = vec2(0.0); c = uv; }
      vec2 fractal_step(vec2 z, vec2 c) {
        vec2 a = vec2(abs(z.x), abs(z.y));
        return vec2(a.x*a.x - a.y*a.y, 2.0*a.x*a.y) + c;
      }
    `,
  },

  {
    id: 'tricorn',
    name: 'Tricorn',
    defaultView: { cx: 0, cy: 0, zoom: 0.45 },
    presets: [
      { name: 'Default', cx: 0, cy: 0, zoom: 0.45 },
    ],
    params: [],
    glsl: `
      void fractal_init(vec2 uv, out vec2 z, out vec2 c) { z = vec2(0.0); c = uv; }
      vec2 fractal_step(vec2 z, vec2 c) {
        return vec2(z.x*z.x - z.y*z.y, -2.0*z.x*z.y) + c;
      }
    `,
  },

  {
    id: 'multibrot3',
    name: 'Multibrot (z³+c)',
    defaultView: { cx: 0, cy: 0, zoom: 0.55 },
    presets: [
      { name: 'Default', cx: 0, cy: 0, zoom: 0.55 },
    ],
    params: [],
    glsl: `
      void fractal_init(vec2 uv, out vec2 z, out vec2 c) { z = vec2(0.0); c = uv; }
      vec2 fractal_step(vec2 z, vec2 c) {
        // (a+bi)^3 = a^3 - 3ab^2 + (3a^2 b - b^3)i
        float a = z.x, b = z.y;
        return vec2(a*a*a - 3.0*a*b*b, 3.0*a*a*b - b*b*b) + c;
      }
    `,
  },
];
