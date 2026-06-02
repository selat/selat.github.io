/* LIBRARY screen — browse, search, filter, add, and edit exercises.
   Also hosts EXERCISE DETAIL (sub-route #exercise/<id>): tag row, stat
   grid, 16-week e1RM chart, and a per-session history log.

   Screen/sheet/row markup lives in #tpl-library, #tpl-lib-row,
   #tpl-exercise-editor, #tpl-exercise-detail, #tpl-chart-card, etc. in
   index.html; these functions clone + fill them. */

import { listExercises, getExercise, upsertCustomExercise, patchSeededExercise, resetSeededExercise, deleteCustomExercise } from '../data/exercises.js';
import { MUSCLES, REGIONS } from '../data/muscles.js';
import { exerciseHistory, lastSetSummary, bestE1RM, sessionVolume, epley } from '../data/derived.js';
import { listSessions } from '../data/sessions.js';
import { openSheet, go } from '../app.js';
import { el, pill, formatShortDate, statCell } from './shared.js';

let searchText = '';
let activeRegion = null;


export function renderLibrary(container) {
  container.replaceChildren();

  // Markup lives in #tpl-library (multi-child fragment) in index.html.
  const frag = document.getElementById('tpl-library').content.cloneNode(true);

  frag.querySelector('[data-field="count"]').textContent = listExercises().length + ' EXERCISES';

  const search = frag.querySelector('[data-field="search"]');
  search.value = searchText;
  search.addEventListener('input', () => { searchText = search.value; refresh(); });

  const filters = frag.querySelector('[data-field="filters"]');
  filters.append(filterChip('ALL', null));
  for (const [rid, info] of Object.entries(REGIONS)) {
    filters.append(filterChip(info.label.toUpperCase(), rid));
  }

  const list = frag.querySelector('[data-field="list"]');

  frag.querySelector('[data-act="add"]').addEventListener('click', () => openExerciseEditor(null));

  container.append(frag);

  function refresh() {
    const q = searchText.trim().toLowerCase();
    const all = listExercises();
    const filtered = all.filter((ex) => {
      if (activeRegion) {
        const regions = new Set();
        for (const m of ex.muscles.primary) regions.add(MUSCLES[m]?.region);
        if (!regions.has(activeRegion)) return false;
      }
      if (q && !ex.name.toLowerCase().includes(q)) return false;
      return true;
    });
    list.replaceChildren();
    if (filtered.length === 0) {
      list.append(el('div', 'lib-empty', 'NO EXERCISES MATCH'));
      return;
    }
    filtered.forEach((ex, i) => list.append(libRow(ex, i)));
  }

  function filterChip(label, regionId) {
    const chip = document.getElementById('tpl-toggle-pill')
      .content.firstElementChild.cloneNode(true);
    chip.textContent = label;
    if (activeRegion === regionId) chip.classList.add('on');
    chip.addEventListener('click', () => {
      activeRegion = regionId;
      for (const c of filters.children) c.classList.remove('on');
      chip.classList.add('on');
      refresh();
    });
    return chip;
  }

  refresh();
}


function libRow(ex, i) {
  const row = document.getElementById('tpl-lib-row')
    .content.firstElementChild.cloneNode(true);
  row.querySelector('.num').textContent = `${String(i + 1).padStart(2, '0')} ·`;
  row.querySelector('.lib-row-exname').textContent = ex.name;
  const e1rm = bestE1RM(ex.id);
  row.querySelector('.lib-row-e1rm').textContent = e1rm > 0 ? `${Math.round(e1rm)}kg` : '—';

  const tags = row.querySelector('.lib-row-tags');
  const primary = ex.muscles.primary[0];
  if (primary) tags.append(pill(primary.toUpperCase().replace(/-/g, ' '), 'default'));
  if (ex.bilateral) tags.append(pill('PER ARM', 'soft'));
  if (ex.custom) tags.append(pill('CUSTOM', 'soft'));
  const last = lastSetSummary(ex.id);
  if (last) tags.append(el('span', 'lib-row-last', 'LAST · ' + last.toUpperCase()));

  row.addEventListener('click', () => go('exercise/' + ex.id));
  return row;
}


/* ── Exercise editor sheet ───────────────────────────────────────── */

function openExerciseEditor(existing) {
  openSheet((close) => {
    const isNew = !existing;
    const isCustom = existing?.custom ?? true;
    const draft = existing ? {
      id: existing.id,
      name: existing.name,
      bilateral: !!existing.bilateral,
      isTimed: !!existing.isTimed,
      muscles: { primary: [...existing.muscles.primary], secondary: [...(existing.muscles.secondary || [])] },
      defaultRest: existing.defaultRest ?? 120,
      defaultWarmupSets: existing.defaultWarmupSets ?? 0,
      defaultTargetSec: existing.defaultTargetSec ?? 60,
      equipmentWeight: existing.equipmentWeight ?? 0,
    } : {
      name: '', bilateral: false, isTimed: false,
      muscles: { primary: [], secondary: [] },
      defaultRest: 120, defaultWarmupSets: 0, defaultTargetSec: 60, equipmentWeight: 0,
    };

    const root = document.getElementById('tpl-exercise-editor')
      .content.firstElementChild.cloneNode(true);
    root.querySelector('[data-field="title"]').textContent = isNew ? 'NEW EXERCISE' : 'EDIT EXERCISE';

    // Name
    const nameInput = root.querySelector('[data-field="name"]');
    nameInput.value = draft.name;
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; });

    // Per-side + isometric/timed toggles
    const toggles = root.querySelector('[data-field="toggles"]');
    toggles.append(toggleRow('PER-SIDE WEIGHT', 'Dumbbells, single-arm machines etc.', draft.bilateral,
      (v) => { draft.bilateral = v; }));
    toggles.append(toggleRow('ISOMETRIC · TIMED', 'Held for time (plank, hang). Logger uses a countdown ring instead of weight/reps.', draft.isTimed,
      (v) => { draft.isTimed = v; }));

    // Primary / secondary muscles
    root.querySelector('[data-field="primary"]').replaceWith(
      muscleSelector('PRIMARY MUSCLES', draft.muscles.primary, (next) => { draft.muscles.primary = next; }));
    root.querySelector('[data-field="secondary"]').replaceWith(
      muscleSelector('SECONDARY MUSCLES', draft.muscles.secondary, (next) => { draft.muscles.secondary = next; }));

    // Rest + warmup + bar weight (or target hold for timed).
    // Bar weight only meaningfully drives the warmup ramp on barbell lifts
    // — 0 (default) means "no bar", which the session-time logic treats as
    // a pure-percentage ramp.
    const defaults = root.querySelector('[data-field="defaults"]');
    defaults.classList.add(draft.isTimed ? 'grid-2' : 'grid-3');
    defaults.append(numField('REST (SEC)', draft.defaultRest, (v) => { draft.defaultRest = v; }, 15));
    if (draft.isTimed) {
      defaults.append(numField('TARGET HOLD (SEC)', draft.defaultTargetSec, (v) => { draft.defaultTargetSec = v; }, 15));
    } else {
      defaults.append(numField('WARMUP SETS', draft.defaultWarmupSets, (v) => { draft.defaultWarmupSets = v; }, 1));
      defaults.append(numField('BAR (KG)', draft.equipmentWeight, (v) => { draft.equipmentWeight = v; }, 2.5, true));
    }

    // Actions: optional RESET (seeded) / DELETE (custom), then ADD/SAVE.
    const actions = root.querySelector('[data-field="actions"]');
    if (existing && !existing.custom) {
      const reset = el('button', 'btn-secondary');
      reset.textContent = 'RESET';
      reset.addEventListener('click', () => {
        if (!confirm('Reset this exercise to its built-in defaults?')) return;
        close(); resetSeededExercise(existing.id);
      });
      actions.append(reset);
    }
    if (existing && existing.custom) {
      const del = el('button', 'btn-secondary danger');
      del.textContent = 'DELETE';
      del.addEventListener('click', () => {
        if (!confirm('Delete "' + existing.name + '"?')) return;
        close(); deleteCustomExercise(existing.id);
      });
      actions.append(del);
    }
    const save = el('button', 'btn-primary');
    save.textContent = isNew ? 'ADD' : 'SAVE';
    save.addEventListener('click', () => {
      if (!draft.name.trim()) { alert('Name is required.'); return; }
      if (draft.muscles.primary.length === 0) { alert('Pick at least one primary muscle.'); return; }
      draft.name = draft.name.trim();
      close();
      if (isNew || isCustom) upsertCustomExercise(draft);
      else patchSeededExercise(existing.id, {
        name: draft.name, bilateral: draft.bilateral, isTimed: draft.isTimed, muscles: draft.muscles,
        defaultRest: draft.defaultRest, defaultWarmupSets: draft.defaultWarmupSets,
        defaultTargetSec: draft.defaultTargetSec, equipmentWeight: draft.equipmentWeight,
      });
    });
    actions.append(save);
    return root;
  });
}

function toggleRow(label, hint, initial, onChange) {
  const row = document.getElementById('tpl-toggle-row')
    .content.firstElementChild.cloneNode(true);
  row.querySelector('[data-field="label"]').textContent = label;
  const small = row.querySelector('[data-field="hint"]');
  if (hint) small.textContent = hint; else small.remove();
  const cb = row.querySelector('[data-field="cb"]');
  cb.checked = initial;
  cb.addEventListener('change', () => onChange(cb.checked));
  return row;
}

function muscleSelector(label, selected, onChange) {
  const wrap = document.getElementById('tpl-muscle-selector')
    .content.firstElementChild.cloneNode(true);
  wrap.querySelector('[data-field="label"]').textContent = label;
  const sel = new Set(selected);
  for (const [rid, info] of Object.entries(REGIONS)) {
    const muscles = Object.entries(MUSCLES).filter(([, m]) => m.region === rid);
    if (!muscles.length) continue;
    const region = document.getElementById('tpl-muscle-region')
      .content.firstElementChild.cloneNode(true);
    region.querySelector('[data-field="region-label"]').textContent = info.label.toUpperCase();
    const grid = region.querySelector('[data-field="pills"]');
    for (const [mid, m] of muscles) {
      const c = document.getElementById('tpl-toggle-pill')
        .content.firstElementChild.cloneNode(true);
      c.textContent = m.label.toUpperCase();
      if (sel.has(mid)) c.classList.add('on');
      c.addEventListener('click', () => {
        if (sel.has(mid)) { sel.delete(mid); c.classList.remove('on'); }
        else { sel.add(mid); c.classList.add('on'); }
        onChange([...sel]);
      });
      grid.append(c);
    }
    wrap.append(region);
  }
  return wrap;
}

function numField(label, value, onChange, step, decimal = false) {
  const wrap = document.getElementById('tpl-num-field')
    .content.firstElementChild.cloneNode(true);
  wrap.querySelector('[data-field="label"]').textContent = label;
  const input = wrap.querySelector('[data-field="input"]');
  input.inputMode = decimal ? 'decimal' : 'numeric';
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('change', () => {
    const v = decimal ? parseFloat(input.value) : parseInt(input.value, 10);
    onChange(isFinite(v) ? Math.max(0, v) : 0);
  });
  return wrap;
}


/* ── EXERCISE DETAIL (#exercise/<id>) ────────────────────────────── */

export function renderExerciseDetail(container, id) {
  container.replaceChildren();
  const ex = getExercise(id);
  if (!ex) { go('library'); return; }

  const history = exerciseHistory(id);
  const e1rm = bestE1RM(id);

  // Markup lives in #tpl-exercise-detail (multi-child fragment) in index.html.
  const frag = document.getElementById('tpl-exercise-detail').content.cloneNode(true);

  frag.querySelector('[data-act="back"]').addEventListener('click', () => go('library'));
  frag.querySelector('[data-act="edit"]').addEventListener('click', () => openExerciseEditor(ex));
  frag.querySelector('[data-field="name"]').textContent = ex.name;
  frag.querySelector('[data-field="hist"]').textContent = `${history.length}W HIST`;

  // Tag row
  const tagRow = frag.querySelector('[data-field="tags"]');
  for (const m of ex.muscles.primary.slice(0, 2)) {
    tagRow.append(pill(MUSCLES[m]?.label.toUpperCase() || m));
  }
  if (ex.bilateral) tagRow.append(pill('PER ARM', 'soft'));
  if (ex.custom) tagRow.append(pill('CUSTOM', 'soft'));

  // Stat grid
  const grid = frag.querySelector('[data-field="stats"]');
  const best = history.length > 0 ? history.reduce((a, b) => a.e1rm > b.e1rm ? a : b) : null;
  const first = history[0];
  const recent = history[history.length - 1];
  const improvement = (recent && first) ? recent.e1rm - first.e1rm : 0;
  const weeksSpan = (recent && first) ? Math.round((recent.ts - first.ts) / (7 * 86400000)) : 0;

  grid.append(statCell({
    label: 'EST 1RM',
    value: e1rm > 0 ? String(Math.round(e1rm)) : '—',
    unit: e1rm > 0 ? 'kg' : null,
    sub: improvement > 0 ? `↑ ${Math.round(improvement)}kg / ${weeksSpan}w` : null,
  }));
  grid.append(statCell({
    label: 'BEST SET',
    value: best ? `${best.topWeight}×${best.topReps}` : '—',
    sub: best ? formatShortDate(best.ts) + (best.isPR ? ' · PR' : '') : null,
  }));
  grid.append(statCell({
    label: '8W VOL',
    value: formatKilo(eightWeekVolume(id)),
    unit: 'kg',
  }));
  grid.append(statCell({
    label: 'SESSIONS',
    value: String(history.length),
    sub: recent ? 'LAST · ' + daysAgo(recent.ts) : null,
  }));

  // Chart
  frag.querySelector('[data-field="chart"]').replaceWith(chartCard(history));

  // History log
  const log = frag.querySelector('[data-field="log"]');
  if (history.length === 0) {
    log.append(el('div', 'lib-empty', 'NO SESSIONS YET'));
  } else {
    for (const h of [...history].reverse().slice(0, 12)) log.append(historyLogRow(h));
  }

  container.append(frag);
}

function eightWeekVolume(exerciseId) {
  const cutoff = Date.now() - 8 * 7 * 86400000;
  const db = listSessions();
  let v = 0;
  for (const s of db) {
    if (s.startedAt < cutoff) continue;
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId) continue;
      for (const set of e.sets) {
        if (set.isWarmup) continue;
        v += set.weight * set.reps * (set.perSide ? 2 : 1);
      }
    }
  }
  return v;
}

function daysAgo(ts) {
  const d = Math.round((Date.now() - ts) / 86400000);
  if (d === 0) return 'TODAY';
  if (d === 1) return '1D';
  return d + 'D';
}

function formatKilo(v) {
  if (v >= 10000) return (v / 1000).toFixed(1) + 'K';
  if (v >= 1000)  return (v / 1000).toFixed(2) + 'K';
  return Math.round(v).toLocaleString();
}


/* ── e1RM chart card (last 16w) ──────────────────────────────────── */

function chartCard(history) {
  // Last 16 weeks of data; if fewer points, just plot them.
  const cutoff = Date.now() - 16 * 7 * 86400000;
  const points = history.filter((h) => h.ts >= cutoff).map((h) => ({ ts: h.ts, e1rm: h.e1rm }));
  if (points.length === 0) {
    const empty = el('div', 'chart-card chart-card-spaced');
    empty.append(el('div', 'lib-empty', 'NO DATA IN THE LAST 16 WEEKS'));
    return empty;
  }

  const W = 358, H = 110, pad = 4;
  const maxV = Math.max(...points.map((p) => p.e1rm));
  const minV = Math.min(...points.map((p) => p.e1rm));
  const midV = Math.round((maxV + minV) / 2);
  const range = (maxV - minV) || 1;
  const tMin = points[0].ts;
  const tMax = points[points.length - 1].ts;
  const tRange = (tMax - tMin) || 1;
  const x = (ts) => points.length === 1 ? W / 2 : ((ts - tMin) / tRange) * W;
  const y = (v) => H - pad - ((v - minV) / range) * (H - pad * 2);
  const ptsXY = points.map((p) => [x(p.ts), y(p.e1rm)]);
  const path = ptsXY.map(([X, Y], i) => `${i === 0 ? 'M' : 'L'} ${X.toFixed(1)} ${Y.toFixed(1)}`).join(' ');
  const areaPath = `${path} L ${ptsXY[ptsXY.length - 1][0]} ${H} L ${ptsXY[0][0]} ${H} Z`;
  const last = ptsXY[ptsXY.length - 1];

  const card = document.getElementById('tpl-chart-card')
    .content.firstElementChild.cloneNode(true);
  card.querySelector('[data-field="now"]').textContent = `NOW · ${Math.round(points[points.length - 1].e1rm)} kg`;
  card.querySelector('[data-field="ymax"]').textContent = String(Math.round(maxV));
  card.querySelector('[data-field="ymid"]').textContent = String(midV);
  card.querySelector('[data-field="ymin"]').textContent = String(Math.round(minV));

  // SVG geometry is fully computed (numbers only) — kept as innerHTML.
  card.querySelector('[data-field="svg"]').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="grad-detail" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="oklch(0.85 0.18 142)" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="oklch(0.85 0.18 142)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="0" y1="${pad}" x2="${W}" y2="${pad}" stroke="var(--line-soft)" stroke-width="0.6" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>
      <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="var(--line-soft)" stroke-width="0.6" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>
      <line x1="0" y1="${H - pad}" x2="${W}" y2="${H - pad}" stroke="var(--line-soft)" stroke-width="0.6" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>
      <path d="${areaPath}" fill="url(#grad-detail)"/>
      <path d="${path}" stroke="oklch(0.85 0.18 142)" stroke-width="1.5" fill="none" vector-effect="non-scaling-stroke"/>
      ${ptsXY.slice(0, -1).map(([X, Y]) => `<circle cx="${X}" cy="${Y}" r="1.3" fill="var(--ink)"/>`).join('')}
      <line x1="${last[0]}" y1="0" x2="${last[0]}" y2="${H}" stroke="oklch(0.85 0.18 142)" stroke-width="0.6" stroke-dasharray="2 2" opacity="0.55" vector-effect="non-scaling-stroke"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="5" fill="none" stroke="oklch(0.85 0.18 142)" stroke-width="0.8" opacity="0.45"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="oklch(0.85 0.18 142)"/>
    </svg>
  `;
  return card;
}


function historyLogRow(h) {
  const row = document.getElementById('tpl-history-log-row')
    .content.firstElementChild.cloneNode(true);
  row.querySelector('[data-field="date"]').textContent = formatShortDate(h.ts);
  row.querySelector('[data-field="sets"]').textContent = h.sets;
  row.querySelector('[data-field="e1rm"]').textContent = `e1RM ${Math.round(h.e1rm)}`;
  const pr = row.querySelector('[data-field="pr"]');
  if (h.isPR) { pr.className = 'pr'; pr.textContent = '★ PR'; }
  else { pr.className = 'pr empty'; pr.textContent = '—'; }
  return row;
}
