/* HISTORY screen — pure timeline list of past sessions grouped by
   month with sticky headers. Aggregate strip on top shows last-4-weeks
   sessions/volume/PR.

   Past session detail: full-screen render reached by `#session/<id>`,
   shows split tag + completed date + duration, a per-exercise plan-row
   list, and REPEAT / DELETE actions. Mirrors the workout overview but
   in read-only mode. */

import { listSessions, getSession, deleteSession, exerciseLabel, startSession } from '../data/sessions.js';
import { sessionMusclesLabel, sessionSplitTag, sessionVolume, sessionDurationSec, sessionPRCount, lastNWeeks } from '../data/derived.js';
import { el, html, divider, formatWeight, formatTrainTime, formatShortDate, formatMonth, formatDurationPad } from './shared.js';
import { go } from '../app.js';


export function renderHistory(container) {
  container.replaceChildren();

  // Topbar
  const tb = el('div', 'topbar');
  const main = el('div', 'topbar-main');
  main.append(html('h1', 'title', 'HISTORY'));
  main.append(html('span', 'topbar-sub', 'PAST SESSIONS'));
  tb.append(main);
  container.append(tb);

  const sessions = listSessions().filter((s) => s.endedAt != null);

  // Aggregate strip — last 4 weeks
  container.append(aggregateStrip());

  if (sessions.length === 0) {
    const empty = el('div', 'lib-empty');
    empty.style.padding = '4rem 1rem';
    empty.textContent = 'NO SESSIONS YET';
    container.append(empty);
    return;
  }

  // Group by month
  const grouped = [];
  for (const s of sessions) {
    const m = formatMonth(s.startedAt);
    const last = grouped[grouped.length - 1];
    if (last && last.month === m) last.items.push(s);
    else grouped.push({ month: m, items: [s] });
  }

  const list = el('div');
  list.style.flex = '1';
  list.style.overflow = 'auto';

  grouped.forEach((g, gi) => {
    const monthHeader = el('div', 'history-month-header' + (gi === 0 ? ' first' : ''));
    monthHeader.append(html('span', null, `── ${g.month}`));
    monthHeader.append(html('span', 'dim', `${g.items.length} SESSIONS`));
    list.append(monthHeader);

    const wrap = el('div');
    wrap.style.padding = '0 16px';
    for (const s of g.items) wrap.append(sessionRow(s));
    list.append(wrap);
  });

  container.append(list);
}


function aggregateStrip() {
  const weeks = lastNWeeks(4);
  let sessions = 0, vol = 0, durationSec = 0;
  for (const w of weeks) { sessions += w.sessions; vol += w.volume; durationSec += w.durationSec; }

  const wrap = el('div', 'body-pad');
  wrap.append(divider('LAST 4 WEEKS'));
  const grid = el('div', 'stat-grid cols-3');
  grid.append(statCellShort('VOLUME', formatKilo(vol), 'kg'));
  grid.append(statCellShort('SESSIONS', String(sessions)));
  grid.append(statCellShort('TRAIN TIME', Math.round(durationSec / 3600) + 'h'));
  wrap.append(grid);
  return wrap;
}

function statCellShort(label, value, unit) {
  const cell = el('div', 'stat-cell');
  const inner = el('div', 'stat stat-md');
  inner.append(el('span', 'stat-label', label));
  const row = el('div');
  row.style.display = 'flex';
  row.style.alignItems = 'baseline';
  row.style.gap = '3px';
  row.append(el('span', 'stat-value', value));
  if (unit) row.append(el('span', 'stat-unit', unit));
  inner.append(row);
  cell.append(inner);
  return cell;
}

function formatKilo(v) {
  if (v >= 10000) return (v / 1000).toFixed(1) + 'K';
  if (v >= 1000)  return (v / 1000).toFixed(2) + 'K';
  return Math.round(v).toLocaleString();
}


/* ── Session row (also used on Home, duplicated for variation here) ── */

function sessionRow(s) {
  const row = el('button', 'session-row');
  row.type = 'button';
  row.append(el('div', 'session-row-date', formatShortDate(s.startedAt)));
  const main = el('div', 'session-row-main');
  main.append(el('span', 'session-row-muscles', sessionMusclesLabel(s)));
  main.append(el('span', 'session-row-chevron', '›'));
  row.append(main);
  const meta = el('div', 'session-row-meta');
  meta.append(el('span', null, formatWeight(sessionVolume(s))));
  meta.append(el('span', 'sep', '·'));
  meta.append(el('span', null, formatTrainTime(sessionDurationSec(s))));
  const prs = sessionPRCount(s);
  if (prs > 0) {
    meta.append(el('span', 'sep', '·'));
    meta.append(el('span', 'pr', `+${prs} PR`));
  }
  row.append(meta);
  row.addEventListener('click', () => go('session/' + s.id));
  return row;
}


/* ── Past session detail (sub-route #session/<id>) ──────────────── */

export function renderPastSession(container, id) {
  container.replaceChildren();
  const session = getSession(id);
  if (!session) { go('history'); return; }

  // Top bar — close + workout name + completed date + duration
  const tb = el('div', 'topbar detail-topbar');

  const close = el('button', 'btn-icon lg');
  close.textContent = '×';
  close.setAttribute('aria-label', 'back to history');
  close.addEventListener('click', () => go('history'));
  tb.append(close);

  const titleBox = el('div', 'detail-topbar-title');
  const completedLabel = 'COMPLETED · ' + new Date(session.startedAt).toLocaleDateString([], {
    weekday: 'short', day: 'numeric', month: 'short',
  }).toUpperCase();
  titleBox.append(html('div', 'eyebrow', completedLabel));
  titleBox.append(html('div', 'title', sessionSplitTag(session)));
  tb.append(titleBox);

  const right = el('div', 'detail-topbar-right');
  right.append(html('div', 'eyebrow', 'DURATION'));
  const dur = el('div', 'tnum detail-topbar-value');
  dur.textContent = formatDurationPad(sessionDurationSec(session));
  right.append(dur);
  tb.append(right);
  container.append(tb);

  // Progress strip — all complete
  const total = session.entries.length;
  const prog = el('div', 'detail-progress');
  const lbl = el('div', 'row-baseline detail-progress-label');
  lbl.append(html('span', null, `<strong>${total} / ${total} COMPLETE</strong>`));
  const prs = sessionPRCount(session);
  lbl.append(html('span', null,
    `${formatWeight(sessionVolume(session))}` + (prs ? ` · <span class="pr">+${prs} PR</span>` : '')));
  prog.append(lbl);
  const bar = el('div', 'progress-strip');
  const fill = el('div', 'progress-strip-fill');
  fill.style.width = '100%';
  bar.append(fill);
  prog.append(bar);
  container.append(prog);

  container.append(divider('PLAN'));

  // Per-exercise rows
  const planList = el('div');
  planList.style.flex = '1';
  session.entries.forEach((entry, idx) => {
    planList.append(pastEntryRow(entry, idx));
  });
  container.append(planList);

  // Repeat / Delete footer
  const footer = el('div', 'detail-footer');

  const repeat = el('button', 'btn-primary');
  repeat.innerHTML = '<span>↻ REPEAT WORKOUT</span><span>→</span>';
  repeat.addEventListener('click', () => {
    const exerciseIds = session.entries.map((e) => e.exerciseId);
    startSession(exerciseIds);
    go('record');
  });
  footer.append(repeat);

  const del = el('button', 'btn-secondary danger block');
  del.textContent = '⌫ DELETE WORKOUT';
  del.addEventListener('click', () => {
    if (!confirm('Delete this session permanently?')) return;
    deleteSession(session.id);
    go('history');
  });
  footer.append(del);

  container.append(footer);
}

function pastEntryRow(entry, idx) {
  const working = entry.sets.filter((s) => !s.isWarmup);
  const row = el('div', 'plan-row done');
  const marker = el('span', 'plan-row-marker');
  marker.textContent = '✓';
  row.append(marker);

  const text = el('div', 'plan-row-text');
  text.append(html('span', 'plan-row-name', exerciseLabel(entry.exerciseId)));
  text.append(html('div', 'plan-row-result', formatResult(working)));
  row.append(text);

  row.append(html('span', 'plan-row-chev', '›'));
  return row;
}

function formatResult(working) {
  if (working.length === 0) return '—';
  // Timed sets: "3 × 60s" or "3 sets · top 75s".
  if (working[0].seconds != null) {
    const same = working.every((s) => s.seconds === working[0].seconds);
    if (same) return `${working.length} × ${working[0].seconds}s`;
    const longest = working.reduce((a, b) => (b.seconds > a.seconds ? b : a), working[0]);
    return `${working.length} sets · top ${longest.seconds}s`;
  }
  const same = working.every((s) => s.weight === working[0].weight && s.reps === working[0].reps);
  if (same) return `${working.length} × ${working[0].reps} @ ${working[0].weight}kg`;
  const top = working.reduce((a, b) => (b.weight > a.weight ? b : a), working[0]);
  return `${working.length} sets · top ${top.weight}×${top.reps}`;
}
