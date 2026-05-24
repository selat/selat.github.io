/* LIBRARY screen — browse, search, filter, add, and edit exercises.
   Also hosts EXERCISE DETAIL (sub-route #exercise/<id>): tag row, stat
   grid, 16-week e1RM chart, and a per-session history log. */

import { listExercises, getExercise, upsertCustomExercise, patchSeededExercise, resetSeededExercise, deleteCustomExercise } from '../data/exercises.js';
import { MUSCLES, REGIONS } from '../data/muscles.js';
import { exerciseHistory, lastSetSummary, bestE1RM, sessionVolume, epley } from '../data/derived.js';
import { listSessions } from '../data/sessions.js';
import { openSheet, go } from '../app.js';
import { el, html, divider, pill, formatWeight, formatShortDate, statCell } from './shared.js';

let searchText = '';
let activeRegion = null;


export function renderLibrary(container) {
  container.replaceChildren();

  // Topbar
  const tb = el('div', 'topbar');
  const main = el('div', 'topbar-main');
  main.append(html('h1', 'title', 'LIBRARY'));
  const right = el('span', 'topbar-sub');
  right.textContent = listExercises().length + ' EXERCISES';
  main.append(right);
  tb.append(main);
  container.append(tb);

  const body = el('div', 'body-pad');

  // Search
  const searchWrap = el('div', 'lib-search');
  const searchIcon = el('span', 'lib-search-icon', '⌕');
  searchWrap.append(searchIcon);
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'search…';
  search.value = searchText;
  search.addEventListener('input', () => { searchText = search.value; refresh(); });
  searchWrap.append(search);
  body.append(searchWrap);

  // Filter chips
  const filters = el('div', 'lib-filters');
  filters.append(filterChip('ALL', null));
  for (const [rid, info] of Object.entries(REGIONS)) {
    filters.append(filterChip(info.label.toUpperCase(), rid));
  }
  body.append(filters);

  // List container
  const list = el('div', 'lib-list section-mt');
  list.style.marginTop = '14px';
  body.append(list);

  // Add custom
  const addBtn = el('button', 'btn-add section-mt');
  addBtn.style.marginTop = '12px';
  addBtn.textContent = '+ CREATE CUSTOM EXERCISE';
  addBtn.addEventListener('click', () => openExerciseEditor(null));
  body.append(addBtn);

  container.append(body);

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
      list.append(html('div', 'lib-empty', 'NO EXERCISES MATCH'));
      return;
    }
    filtered.forEach((ex, i) => list.append(libRow(ex, i)));
  }

  function filterChip(label, regionId) {
    const chip = el('button', 'pill toggle' + (activeRegion === regionId ? ' on' : ''));
    chip.type = 'button';
    chip.textContent = label;
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
  const row = el('button', 'lib-row');
  row.type = 'button';
  const head = el('div', 'lib-row-head');
  const name = el('div', 'lib-row-name');
  name.innerHTML = `<span class="num">${String(i + 1).padStart(2, '0')} ·</span> ${ex.name}`;
  head.append(name);
  const e1rm = bestE1RM(ex.id);
  head.append(el('span', 'lib-row-e1rm', e1rm > 0 ? `${Math.round(e1rm)}kg` : '—'));
  row.append(head);

  const tags = el('div', 'lib-row-tags');
  const primary = ex.muscles.primary[0];
  if (primary) tags.append(pill(primary.toUpperCase().replace(/-/g, ' '), 'default'));
  if (ex.bilateral) tags.append(pill('PER ARM', 'soft'));
  if (ex.custom) tags.append(pill('CUSTOM', 'soft'));
  const last = lastSetSummary(ex.id);
  if (last) {
    const lastSpan = el('span', 'lib-row-last', 'LAST · ' + last.toUpperCase());
    tags.append(lastSpan);
  }
  row.append(tags);

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
    } : {
      name: '', bilateral: false, isTimed: false,
      muscles: { primary: [], secondary: [] },
      defaultRest: 120, defaultWarmupSets: 0, defaultTargetSec: 60,
    };

    const root = document.createElement('div');
    root.append(html('h2', 'eyebrow', isNew ? 'NEW EXERCISE' : 'EDIT EXERCISE'));

    // Name
    const nameLabel = html('div', 'eyebrow', 'NAME');
    nameLabel.style.marginTop = '12px';
    root.append(nameLabel);
    const nameInput = document.createElement('input');
    nameInput.className = 'input';
    nameInput.value = draft.name;
    nameInput.placeholder = 'e.g. Cable Pullover';
    nameInput.style.marginTop = '4px';
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; });
    root.append(nameInput);

    // Per-side toggle
    root.append(toggleRow('PER-SIDE WEIGHT', 'Dumbbells, single-arm machines etc.', draft.bilateral,
      (v) => { draft.bilateral = v; }));

    // Isometric / timed toggle
    root.append(toggleRow('ISOMETRIC · TIMED', 'Held for time (plank, hang). Logger uses a countdown ring instead of weight/reps.', draft.isTimed,
      (v) => { draft.isTimed = v; }));

    // Primary muscles
    root.append(muscleSelector('PRIMARY MUSCLES', draft.muscles.primary, (next) => { draft.muscles.primary = next; }));
    root.append(muscleSelector('SECONDARY MUSCLES', draft.muscles.secondary, (next) => { draft.muscles.secondary = next; }));

    // Rest + warmup (+ target hold for timed)
    const defaults = el('div', 'grid-2');
    defaults.style.gap = '10px';
    defaults.style.marginTop = '12px';
    defaults.append(numField('REST (SEC)', draft.defaultRest, (v) => { draft.defaultRest = v; }, 15));
    if (draft.isTimed) {
      defaults.append(numField('TARGET HOLD (SEC)', draft.defaultTargetSec, (v) => { draft.defaultTargetSec = v; }, 15));
    } else {
      defaults.append(numField('WARMUP SETS', draft.defaultWarmupSets, (v) => { draft.defaultWarmupSets = v; }, 1));
    }
    root.append(defaults);

    const actions = el('div', 'settings-actions section-mt');
    actions.style.marginTop = '16px';
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
        defaultTargetSec: draft.defaultTargetSec,
      });
    });
    actions.append(save);
    root.append(actions);
    return root;
  });
}

function toggleRow(label, hint, initial, onChange) {
  const row = el('div', 'settings-row');
  const lbl = el('div', 'settings-row-label');
  lbl.innerHTML = `<strong>${label}</strong>` + (hint ? `<small>${hint}</small>` : '');
  row.append(lbl);
  const sw = document.createElement('label');
  sw.className = 'switch';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = initial;
  sw.append(cb, el('span', 'switch-track'), el('span', 'switch-thumb'));
  cb.addEventListener('change', () => onChange(cb.checked));
  row.append(sw);
  return row;
}

function muscleSelector(label, selected, onChange) {
  const wrap = el('div');
  wrap.style.marginTop = '12px';
  wrap.append(html('div', 'eyebrow', label));
  const sel = new Set(selected);
  for (const [rid, info] of Object.entries(REGIONS)) {
    const muscles = Object.entries(MUSCLES).filter(([, m]) => m.region === rid);
    if (!muscles.length) continue;
    const region = el('div');
    region.style.marginTop = '8px';
    region.append(html('div', 'eyebrow dim', info.label.toUpperCase()));
    const grid = el('div');
    grid.style.display = 'flex';
    grid.style.flexWrap = 'wrap';
    grid.style.gap = '4px';
    grid.style.marginTop = '4px';
    for (const [mid, m] of muscles) {
      const c = el('button', 'pill toggle' + (sel.has(mid) ? ' on' : ''));
      c.type = 'button';
      c.textContent = m.label.toUpperCase();
      c.addEventListener('click', () => {
        if (sel.has(mid)) { sel.delete(mid); c.classList.remove('on'); }
        else { sel.add(mid); c.classList.add('on'); }
        onChange([...sel]);
      });
      grid.append(c);
    }
    region.append(grid);
    wrap.append(region);
  }
  return wrap;
}

function numField(label, value, onChange, step) {
  const wrap = el('div');
  wrap.append(html('div', 'eyebrow', label));
  const input = document.createElement('input');
  input.className = 'input input-center';
  input.type = 'number';
  input.inputMode = 'numeric';
  input.step = String(step);
  input.min = '0';
  input.value = String(value);
  input.style.marginTop = '6px';
  input.addEventListener('change', () => {
    const v = parseInt(input.value, 10);
    onChange(isFinite(v) ? Math.max(0, v) : 0);
  });
  wrap.append(input);
  return wrap;
}


/* ── EXERCISE DETAIL (#exercise/<id>) ────────────────────────────── */

export function renderExerciseDetail(container, id) {
  container.replaceChildren();
  const ex = getExercise(id);
  if (!ex) { go('library'); return; }

  const history = exerciseHistory(id);
  const e1rm = bestE1RM(id);

  // Topbar
  const tb = el('div', 'topbar');
  tb.classList.add('with-meta');
  const meta = el('div', 'topbar-meta');
  const back = document.createElement('button');
  back.style.background = 'none';
  back.style.border = 'none';
  back.style.color = 'var(--ink-soft)';
  back.style.fontFamily = 'inherit';
  back.style.fontSize = 'var(--t-xs)';
  back.style.letterSpacing = '0.12em';
  back.style.textTransform = 'uppercase';
  back.style.fontWeight = '700';
  back.style.padding = '0';
  back.style.cursor = 'pointer';
  back.textContent = '‹ LIBRARY';
  back.addEventListener('click', () => go('library'));
  meta.append(back);
  const editBtn = document.createElement('button');
  editBtn.style.background = 'none';
  editBtn.style.border = 'none';
  editBtn.style.color = 'var(--ink-soft)';
  editBtn.style.fontFamily = 'inherit';
  editBtn.style.fontSize = 'var(--t-xs)';
  editBtn.style.letterSpacing = '0.12em';
  editBtn.style.textTransform = 'uppercase';
  editBtn.style.fontWeight = '700';
  editBtn.style.padding = '0';
  editBtn.style.cursor = 'pointer';
  editBtn.textContent = 'EDIT';
  editBtn.addEventListener('click', () => openExerciseEditor(ex));
  meta.append(editBtn);
  tb.append(meta);

  const main = el('div', 'topbar-main');
  main.append(html('h1', 'title', ex.name));
  main.append(html('span', 'topbar-sub', `${history.length}W HIST`));
  tb.append(main);
  container.append(tb);

  const body = el('div', 'body-pad');

  // Tag row
  const tagRow = el('div');
  tagRow.style.display = 'flex';
  tagRow.style.gap = '6px';
  tagRow.style.flexWrap = 'wrap';
  for (const m of ex.muscles.primary.slice(0, 2)) {
    tagRow.append(pill(MUSCLES[m]?.label.toUpperCase() || m));
  }
  if (ex.bilateral) tagRow.append(pill('PER ARM', 'soft'));
  if (ex.custom) tagRow.append(pill('CUSTOM', 'soft'));
  body.append(tagRow);

  // Stat grid
  const grid = el('div', 'stat-grid cols-2 two-rows section-mt');
  grid.style.marginTop = '12px';
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
  body.append(grid);

  // Chart
  body.append(divider('EST. 1RM · LAST 16W'));
  body.append(chartCard(history));

  // History log
  body.append(divider('HISTORY · LOG'));
  if (history.length === 0) {
    body.append(html('div', 'lib-empty', 'NO SESSIONS YET'));
  } else {
    for (const h of [...history].reverse().slice(0, 12)) body.append(historyLogRow(h));
  }

  container.append(body);
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
  const card = el('div', 'chart-card section-mt');
  card.style.marginTop = '12px';

  // Last 16 weeks of data; if fewer points, just plot them.
  const cutoff = Date.now() - 16 * 7 * 86400000;
  const points = history.filter((h) => h.ts >= cutoff).map((h) => ({ ts: h.ts, e1rm: h.e1rm }));
  if (points.length === 0) {
    card.append(html('div', 'lib-empty', 'NO DATA IN THE LAST 16 WEEKS'));
    return card;
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

  // NOW callout
  const now = el('div', 'now-callout');
  now.textContent = `NOW · ${Math.round(points[points.length - 1].e1rm)} kg`;
  card.append(now);

  // Y-axis
  const yAxis = el('div', 'y-axis');
  yAxis.append(el('span', null, String(Math.round(maxV))));
  yAxis.append(el('span', null, String(midV)));
  yAxis.append(el('span', null, String(Math.round(minV))));
  card.append(yAxis);

  // SVG
  const svgWrap = el('div');
  svgWrap.style.marginTop = '12px';
  svgWrap.innerHTML = `
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
  card.append(svgWrap);

  // X-axis
  const xAxis = el('div', 'x-axis');
  xAxis.append(el('span', null, '−16W'));
  xAxis.append(el('span', null, '−8W'));
  xAxis.append(el('span', null, 'NOW'));
  card.append(xAxis);

  return card;
}


function historyLogRow(h) {
  const row = el('div', 'detail-log-row');
  row.append(el('span', 'date', formatShortDate(h.ts)));
  row.append(el('span', 'sets', h.sets));
  row.append(el('span', 'e1rm', `e1RM ${Math.round(h.e1rm)}`));
  if (h.isPR) row.append(html('span', 'pr', '★ PR'));
  else row.append(html('span', 'pr empty', '—'));
  return row;
}
