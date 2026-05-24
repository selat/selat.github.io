/* BODY screen — recovery dashboard with front + back anatomical
   diagrams colored by per-muscle recovery, plus a "most fatigued" bar
   list. Diagrams come from assets/body-front.svg + body-back.svg
   (auto-traced from the reference image); each muscle is one or more
   <path class="muscle-X"> we recolor at render time. */

import { muscleStatus } from '../data/recovery.js';
import { MUSCLES, MUSCLE_IDS } from '../data/muscles.js';
import { el, html, divider, statCell } from './shared.js';

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

  const tb = el('div', 'topbar');
  tb.append(html('h1', 'title', 'RECOVERY MAP'));
  container.append(tb);

  const body = el('div', 'body-pad');

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

  const summary = el('div', 'stat-grid cols-3');
  summary.append(statCell({ label: 'WHOLE BODY', value: String(Math.round(wholeBody * 100)), unit: '%' }));
  summary.append(statCell({ label: 'READY', value: String(ready), sub: 'OF ' + MUSCLE_IDS.length + ' GROUPS' }));
  summary.append(statCell({ label: 'FATIGUED', value: String(fatigued), sub: '< 40%' }));
  body.append(summary);

  // Body diagrams — fetched from /assets, painted with regionRec colors.
  const grid = el('div', 'body-grid section-mt');
  grid.style.marginTop = '12px';
  const frontSide = el('div', 'body-grid-side');
  frontSide.append(html('span', 'label', 'FRONT'));
  const frontDiagram = el('div', 'diagram');
  frontSide.append(frontDiagram);
  grid.append(frontSide);

  const backSide = el('div', 'body-grid-side');
  backSide.append(html('span', 'label', 'BACK'));
  const backDiagram = el('div', 'diagram');
  backSide.append(backDiagram);
  grid.append(backSide);
  body.append(grid);
  renderBodyDiagram(frontDiagram, 'front', regionRec);
  renderBodyDiagram(backDiagram, 'back', regionRec);

  // Legend — gradient from fresh (gray) to sore (red)
  const legend = el('div', 'recovery-legend');
  legend.innerHTML = `
    <span class="lbl">FRESH</span>
    <span class="gradient-bar"></span>
    <span class="lbl">SORE</span>
  `;
  body.append(legend);

  // Most fatigued bars
  body.append(divider('MOST FATIGUED'));
  const sorted = MUSCLE_IDS.map((m) => ({ id: m, ...status[m], label: MUSCLES[m].label }))
    .sort((a, b) => a.recovery - b.recovery);
  const bars = el('div', 'recovery-bars');
  for (const m of sorted.slice(0, 6)) {
    bars.append(barRow(m));
  }
  body.append(bars);

  container.append(body);
}


function barRow(m) {
  const row = el('div', 'recovery-bar-row');
  row.append(html('span', 'lbl', m.label.toUpperCase()));
  const bar = el('div', 'recovery-bar');
  const fill = el('div', 'recovery-bar-fill');
  fill.style.width = (m.recovery * 100) + '%';
  fill.style.background = recoveryHex(m.recovery);
  bar.append(fill);
  row.append(bar);
  row.append(html('span', 'pct', Math.round(m.recovery * 100) + '%'));
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


