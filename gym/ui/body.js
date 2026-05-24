/* BODY screen — recovery dashboard with front + back anatomical
   diagrams colored by per-muscle recovery, plus a "most fatigued" bar
   list. Map the recovery.js per-muscle scores to the design's coarser
   muscle regions for the body diagram (e.g. design's "delts" is the
   average of front/side/rear delts in our model). */

import { muscleStatus } from '../data/recovery.js';
import { MUSCLES, MUSCLE_IDS } from '../data/muscles.js';
import { el, html, divider, statCell } from './shared.js';

// Map design body-diagram region id → list of MUSCLE_IDS in our model.
const DIAGRAM_REGIONS = {
  chest:    ['chest'],
  back:     ['upper-back', 'lower-back', 'traps'],
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

  // Body diagrams
  const grid = el('div', 'body-grid section-mt');
  grid.style.marginTop = '12px';
  const frontSide = el('div', 'body-grid-side');
  frontSide.append(html('span', 'label', 'FRONT'));
  const frontDiagram = el('div', 'diagram');
  frontDiagram.innerHTML = bodySVG('front', regionRec);
  frontSide.append(frontDiagram);
  grid.append(frontSide);

  const backSide = el('div', 'body-grid-side');
  backSide.append(html('span', 'label', 'BACK'));
  const backDiagram = el('div', 'diagram');
  backDiagram.innerHTML = bodySVG('back', regionRec);
  backSide.append(backDiagram);
  grid.append(backSide);
  body.append(grid);

  // Legend
  const legend = el('div', 'recovery-legend');
  legend.append(html('span', null, '<span class="swatch" style="background: oklch(0.65 0.22 25)"></span> &lt;40 FATIGUED'));
  legend.append(html('span', null, '<span class="swatch" style="background: oklch(0.78 0.15 75)"></span> 40-80 RECOVERING'));
  legend.append(html('span', null, '<span class="swatch" style="background: oklch(0.85 0.18 142)"></span> &ge;80 READY'));
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

function recoveryHex(r) {
  if (r >= 0.8) return 'oklch(0.85 0.18 142)';
  if (r >= 0.4) return 'oklch(0.78 0.15 75)';
  return 'oklch(0.65 0.22 25)';
}


/* ── Body SVG ─────────────────────────────────────────────────────
   Coordinate space 100×200. Polygon paths lifted from the design;
   colors come from the regionRec map. The path data is intentionally
   wireframe-blocky — matches the design's "schematic / MUSCLE.GROUPS"
   aesthetic. */

function bodySVG(view, rec) {
  const c = (id) => recoveryHex(rec[id] ?? 1);
  const outline = `
    <g fill="none" stroke="var(--line)" stroke-width="0.6">
      <ellipse cx="50" cy="14" rx="8" ry="9"/>
      <path d="M46 22 L46 27 L54 27 L54 22"/>
      <path d="M30 30 Q28 32 27 38 L26 50 L29 70 L32 90 L34 102 L40 105 L44 108 L42 138 L42 168 L44 196 L48 198 L50 198"/>
      <path d="M70 30 Q72 32 73 38 L74 50 L71 70 L68 90 L66 102 L60 105 L56 108 L58 138 L58 168 L56 196 L52 198 L50 198"/>
      <path d="M27 38 L20 50 L17 72 L16 90 L18 108 L22 125 L24 138"/>
      <path d="M73 38 L80 50 L83 72 L84 90 L82 108 L78 125 L76 138"/>
    </g>
  `;

  if (view === 'front') {
    return `
      <svg viewBox="0 0 100 200" width="100%" height="100%" style="display:block;">
        ${outline}
        <g stroke="var(--ink)" stroke-width="0.5" stroke-opacity="0.4">
          <path d="M32 34 L48 34 L49 49 L33 49 Z" fill="${c('chest')}"/>
          <path d="M52 34 L68 34 L67 49 L51 49 Z" fill="${c('chest')}"/>
          <path d="M27 32 L33 31 L34 44 L26 42 Z" fill="${c('delts')}"/>
          <path d="M73 32 L67 31 L66 44 L74 42 Z" fill="${c('delts')}"/>
          <path d="M20 44 L26 44 L27 60 L21 62 Z" fill="${c('biceps')}"/>
          <path d="M80 44 L74 44 L73 60 L79 62 Z" fill="${c('biceps')}"/>
          <path d="M19 64 L24 64 L25 80 L20 82 Z" fill="${c('forearm')}"/>
          <path d="M81 64 L76 64 L75 80 L80 82 Z" fill="${c('forearm')}"/>
          <path d="M40 52 L60 52 L58 74 L42 74 Z" fill="${c('core')}"/>
          <path d="M34 52 L39 52 L40 74 L35 73 Z" fill="${c('core')}" opacity="0.75"/>
          <path d="M66 52 L61 52 L60 74 L65 73 Z" fill="${c('core')}" opacity="0.75"/>
          <path d="M39 110 L49 110 L48 142 L41 142 Z" fill="${c('quads')}"/>
          <path d="M61 110 L51 110 L52 142 L59 142 Z" fill="${c('quads')}"/>
          <path d="M40 162 L48 162 L47 184 L42 184 Z" fill="${c('calves')}"/>
          <path d="M60 162 L52 162 L53 184 L58 184 Z" fill="${c('calves')}"/>
        </g>
        <line x1="50" y1="30" x2="50" y2="105" stroke="var(--line)" stroke-width="0.3" stroke-dasharray="1 1.5" opacity="0.5"/>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 100 200" width="100%" height="100%" style="display:block;">
      ${outline}
      <g stroke="var(--ink)" stroke-width="0.5" stroke-opacity="0.4">
        <path d="M40 28 L50 26 L60 28 L58 38 L50 36 L42 38 Z" fill="${c('back')}"/>
        <path d="M32 40 L42 42 L41 64 L31 60 Z" fill="${c('lats')}"/>
        <path d="M68 40 L58 42 L59 64 L69 60 Z" fill="${c('lats')}"/>
        <path d="M42 42 L58 42 L57 64 L43 64 Z" fill="${c('back')}"/>
        <path d="M40 66 L60 66 L58 80 L42 80 Z" fill="${c('back')}" opacity="0.85"/>
        <path d="M27 32 L33 31 L34 44 L26 42 Z" fill="${c('delts')}"/>
        <path d="M73 32 L67 31 L66 44 L74 42 Z" fill="${c('delts')}"/>
        <path d="M20 44 L26 44 L27 60 L21 62 Z" fill="${c('triceps')}"/>
        <path d="M80 44 L74 44 L73 60 L79 62 Z" fill="${c('triceps')}"/>
        <path d="M19 64 L24 64 L25 80 L20 82 Z" fill="${c('forearm')}"/>
        <path d="M81 64 L76 64 L75 80 L80 82 Z" fill="${c('forearm')}"/>
        <path d="M38 84 L50 82 L62 84 L60 106 L50 108 L40 106 Z" fill="${c('glutes')}"/>
        <path d="M39 110 L49 110 L48 142 L41 142 Z" fill="${c('hams')}"/>
        <path d="M61 110 L51 110 L52 142 L59 142 Z" fill="${c('hams')}"/>
        <path d="M40 148 L48 148 L48 182 L42 182 Z" fill="${c('calves')}"/>
        <path d="M60 148 L52 148 L52 182 L58 182 Z" fill="${c('calves')}"/>
      </g>
    </svg>
  `;
}
