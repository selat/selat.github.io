/* BODY screen — recovery dashboard with front + back anatomical
   diagrams colored by per-muscle recovery, plus a "most fatigued" bar
   list. Diagrams come from assets/body-front.svg + body-back.svg
   (auto-traced from the reference image); each muscle is one or more
   <path class="muscle-X"> we recolor at render time. */

import { muscleStatus } from '../data/recovery.js';
import { MUSCLES, MUSCLE_IDS } from '../data/muscles.js';
import { statCell } from './shared.js';

// Map design body-diagram region id → list of MUSCLE_IDS in our model.
// `traps` and `back` are split because the back-view SVG traces them as
// separate paths (upper trap diamond vs erector spinae block).
const DIAGRAM_REGIONS = {
  chest:    ['chest'],
  back:     ['upper-back', 'lower-back'],
  traps:    ['traps'],
  lats:     ['lats'],
  delts:    ['front-delts', 'side-delts', 'rear-delts'],
  biceps:   ['biceps'],
  triceps:  ['triceps'],
  core:     ['abs', 'obliques'],
  quads:    ['quads'],
  hams:     ['hamstrings'],
  glutes:   ['glutes'],
  calves:   ['calves'],
  forearm:  ['forearms'],
};

// Cached fetch — both views are static assets, fetched once per session.
const svgCache = {};
function loadBodySVG(view) {
  if (!svgCache[view]) {
    svgCache[view] = fetch(`./assets/body-${view}.svg`).then((r) => r.text());
  }
  return svgCache[view];
}

function paintMuscles(svg, regionRec) {
  if (!svg) return;
  const body = svg.querySelector('#body');
  if (body) body.style.fill = 'var(--line)';
  for (const [key, value] of Object.entries(regionRec)) {
    const fill = recoveryHex(value);
    svg.querySelectorAll('.muscle-' + key).forEach((p) => { p.style.fill = fill; });
  }
}

async function renderBodyDiagram(container, view, regionRec) {
  container.innerHTML = await loadBodySVG(view);
  paintMuscles(container.querySelector('svg'), regionRec);
}


export function renderBody(container) {
  container.replaceChildren();

  // Markup lives in #tpl-body in index.html (multi-child fragment); we
  // query/fill/wire before appending.
  const frag = document.getElementById('tpl-body').content.cloneNode(true);

  const status = muscleStatus();

  // Aggregate cell scores for diagram regions.
  const regionRec = {};
  for (const [r, mids] of Object.entries(DIAGRAM_REGIONS)) {
    const scores = mids.map((m) => status[m]?.recovery ?? 1);
    regionRec[r] = scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  // Summary stats
  const wholeBody = Object.values(status).reduce((a, b) => a + b.recovery, 0) / MUSCLE_IDS.length;
  const ready = MUSCLE_IDS.filter((m) => status[m].recovery >= 0.8).length;
  const fatigued = MUSCLE_IDS.filter((m) => status[m].recovery < 0.4).length;

  const summary = frag.querySelector('[data-field="summary"]');
  summary.append(statCell({ label: 'WHOLE BODY', value: String(Math.round(wholeBody * 100)), unit: '%' }));
  summary.append(statCell({ label: 'READY', value: String(ready), sub: 'OF ' + MUSCLE_IDS.length + ' GROUPS' }));
  summary.append(statCell({ label: 'FATIGUED', value: String(fatigued), sub: '< 40%' }));

  // Body diagrams — fetched from /assets, painted with regionRec colors.
  // (Async paint resolves after append; the queried nodes stay valid.)
  renderBodyDiagram(frag.querySelector('[data-field="front"]'), 'front', regionRec);
  renderBodyDiagram(frag.querySelector('[data-field="back"]'), 'back', regionRec);

  // Most fatigued bars
  const sorted = MUSCLE_IDS.map((m) => ({ id: m, ...status[m], label: MUSCLES[m].label }))
    .sort((a, b) => a.recovery - b.recovery);
  const bars = frag.querySelector('[data-field="bars"]');
  for (const m of sorted.slice(0, 6)) {
    bars.append(barRow(m));
  }

  container.append(frag);
}


function barRow(m) {
  const row = document.getElementById('tpl-body-bar-row')
    .content.firstElementChild.cloneNode(true);
  row.querySelector('.lbl').textContent = m.label.toUpperCase();
  const fill = row.querySelector('.recovery-bar-fill');
  fill.style.width = (m.recovery * 100) + '%';
  fill.style.background = recoveryHex(m.recovery);
  row.querySelector('.pct').textContent = Math.round(m.recovery * 100) + '%';
  return row;
}

// Gray when fresh → red when sore. soreness = 1 - recovery, interpolated
// in OKLCH: chroma ramps 0 → 0.22 and hue stays at 25° (red).
function recoveryHex(r) {
  const s = Math.max(0, Math.min(1, 1 - r));
  const L = 0.55 + s * 0.08;
  const C = s * 0.22;
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} 25)`;
}


