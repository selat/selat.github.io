/* HOME screen — week/month calendar header, this-week stats strip,
   "TODAY · SUGGESTED" inverse CTA, recent sessions list. */

import { getDb } from '../data/storage.js';
import { listSessions } from '../data/sessions.js';
import { suggestWorkout } from '../data/templates.js';
import { sessionMusclesLabel, sessionSplitTag, sessionVolume, sessionDurationSec, sessionPRCount, lastNWeeks } from '../data/derived.js';
import { openSettings } from './settings.js';
import { el, statCell, formatWeight, formatTrainTime, formatShortDate } from './shared.js';
import { startSessionFlow } from './session.js';
import { go } from '../app.js';

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

let cursor = null;       // { y, m, d }
let expanded = false;    // false = week view, true = month view

function todayCal() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
}

function key(y, m, d) { return `${y}-${m}-${d}`; }

function isFuture(c, today) {
  if (c.y !== today.y) return c.y > today.y;
  if (c.m !== today.m) return c.m > today.m;
  return c.d > today.d;
}
function isToday(c, today) {
  return c.y === today.y && c.m === today.m && c.d === today.d;
}
function getWeek(c) {
  const jsDay = new Date(c.y, c.m, c.d).getDay();
  const mondayOffset = (jsDay + 6) % 7;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(c.y, c.m, c.d - mondayOffset + i);
    days.push({ y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate(), dim: dt.getMonth() !== c.m });
  }
  return days;
}
function getMonth(c) {
  const firstWeekday = (new Date(c.y, c.m, 1).getDay() + 6) % 7;
  const dim = new Date(c.y, c.m + 1, 0).getDate();
  const cells = [];
  for (let i = firstWeekday - 1; i >= 0; i--) {
    const dt = new Date(c.y, c.m, -i);
    cells.push({ y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate(), dim: true });
  }
  for (let i = 1; i <= dim; i++) {
    cells.push({ y: c.y, m: c.m, d: i, dim: false });
  }
  while (cells.length < 42) {
    const last = cells[cells.length - 1];
    const dt = new Date(last.y, last.m, last.d + 1);
    cells.push({ y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate(), dim: true });
  }
  return cells;
}
function isoWeek(c) {
  const dt = new Date(c.y, c.m, c.d);
  const target = new Date(dt.valueOf());
  const dayNr = (dt.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  return 1 + Math.ceil((firstThursday - target) / 604800000);
}


export function renderHome(container) {
  container.replaceChildren();
  const today = todayCal();
  if (!cursor) cursor = today;

  // Build a session-by-day map for calendar dots.
  const sessions = listSessions().filter((s) => s.endedAt);
  const dayMap = new Map();
  for (const s of sessions) {
    const d = new Date(s.startedAt);
    dayMap.set(key(d.getFullYear(), d.getMonth(), d.getDate()), s);
  }

  // Markup lives in #tpl-home (multi-child fragment) in index.html.
  const frag = document.getElementById('tpl-home').content.cloneNode(true);

  frag.querySelector('[data-field="cal"]').replaceWith(
    calendarHeader(today, dayMap, () => renderHome(container)));

  fillThisWeek(frag.querySelector('[data-field="week"]'));

  frag.querySelector('[data-field="today"]').append(todayCta());

  frag.querySelector('[data-field="recent-count"]').textContent = String(sessions.length);
  fillRecent(frag.querySelector('[data-field="recent"]'), sessions);

  container.append(frag);
}


/* ── Calendar header ─────────────────────────────────────────────── */

function calendarHeader(today, dayMap, rerender) {
  const wrap = document.getElementById('tpl-cal-header')
    .content.firstElementChild.cloneNode(true);

  wrap.querySelector('[data-field="label"]').textContent = `${MONTHS[cursor.m]} ${cursor.y}`;
  wrap.querySelector('[data-field="wk"]').textContent = `WK ${isoWeek(cursor)}`;
  wrap.querySelector('[data-act="toggle"]').textContent = expanded ? '▴ WEEK' : '▾ MONTH';

  wrap.querySelector('[data-act="prev"]').addEventListener('click', () => {
    if (expanded) {
      const nm = cursor.m - 1;
      const ny = cursor.y + Math.floor(nm / 12);
      cursor = { y: ny, m: ((nm % 12) + 12) % 12, d: 1 };
    } else {
      const dt = new Date(cursor.y, cursor.m, cursor.d - 7);
      cursor = { y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate() };
    }
    rerender();
  });
  wrap.querySelector('[data-act="next"]').addEventListener('click', () => {
    if (expanded) {
      const nm = cursor.m + 1;
      const ny = cursor.y + Math.floor(nm / 12);
      cursor = { y: ny, m: ((nm % 12) + 12) % 12, d: 1 };
    } else {
      const dt = new Date(cursor.y, cursor.m, cursor.d + 7);
      cursor = { y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate() };
    }
    rerender();
  });
  wrap.querySelector('[data-act="toggle"]').addEventListener('click', () => { expanded = !expanded; rerender(); });
  wrap.querySelector('[data-act="settings"]').addEventListener('click', () => openSettings());

  // Calendar grid
  const grid = wrap.querySelector('[data-field="grid"]');
  if (expanded) {
    const cells = getMonth(cursor);
    for (let row = 0; row < 6; row++) {
      const rowCells = cells.slice(row * 7, row * 7 + 7);
      const isCurrentWeek = rowCells.some((c) => isToday(c, today));
      const rowEl = el('div', 'cal-month-row' + (isCurrentWeek ? ' current-week' : ''));
      for (const c of rowCells) rowEl.append(dayCell(c, today, dayMap, true));
      grid.append(rowEl);
    }
  } else {
    const week = el('div', 'cal-week');
    for (const c of getWeek(cursor)) week.append(dayCell(c, today, dayMap, false));
    grid.append(week);
  }
  return wrap;
}

function dayCell(day, today, dayMap, compact) {
  const future = isFuture(day, today);
  const isT = isToday(day, today);
  const session = dayMap.get(key(day.y, day.m, day.d));
  const wrap = document.getElementById('tpl-cal-day')
    .content.firstElementChild.cloneNode(true);
  if (compact) wrap.classList.add('compact');
  if (day.dim) wrap.classList.add('dim');
  if (future) wrap.classList.add('future');
  if (isT) wrap.classList.add('today');
  wrap.querySelector('.cal-day-num').textContent = String(day.d);
  wrap.querySelector('.cal-day-dot').classList.add(
    isT ? 'today' : session && !future ? 'session' : 'empty');
  return wrap;
}


/* ── This-week stats ─────────────────────────────────────────────── */

function fillThisWeek(grid) {
  const weeks = lastNWeeks(1);
  const w = weeks[weeks.length - 1];
  grid.append(statCell({ label: 'VOLUME', value: formatKilo(w.volume), unit: 'kg', size: 'md' }));
  grid.append(statCell({ label: 'SESSIONS', value: String(w.sessions), size: 'md' }));
  grid.append(statCell({ label: 'TRAIN TIME', value: formatTrainTime(w.durationSec), size: 'md' }));
}

function formatKilo(v) {
  if (v >= 10000) return (v / 1000).toFixed(1) + 'K';
  if (v >= 1000)  return (v / 1000).toFixed(2) + 'K';
  return Math.round(v).toLocaleString();
}


/* ── Today CTA ──────────────────────────────────────────────────── */

function todayCta() {
  const suggestion = suggestWorkout();
  if (!suggestion.exerciseIds || suggestion.exerciseIds.length === 0) {
    const rest = document.getElementById('tpl-today-rest')
      .content.firstElementChild.cloneNode(true);
    rest.querySelector('[data-field="desc"]').textContent = suggestion.description;
    return rest;
  }

  const cta = document.getElementById('tpl-today-cta')
    .content.firstElementChild.cloneNode(true);
  cta.querySelector('[data-field="mins"]').textContent = estimateMinutes(suggestion) + ' MIN';
  cta.querySelector('[data-field="title"]').textContent = suggestion.name;
  cta.querySelector('[data-act="start"]').addEventListener('click', () => startSessionFlow(suggestion.exerciseIds));
  fillWhy(cta.querySelector('[data-field="why"]'), suggestion);
  return cta;
}

function fillWhy(line, suggestion) {
  // Show up to 3 recovered muscles by name from the suggestion's exercises.
  if (suggestion.freshRegions && suggestion.freshRegions.length > 0) {
    const labels = suggestion.freshRegions.map((r) => r.toUpperCase()).join(' · ');
    line.append(document.createTextNode('Targets '));
    line.append(el('span', 'good', labels));
  } else if (suggestion.description) {
    line.textContent = suggestion.description;
  }
}

function estimateMinutes(suggestion) {
  // Rough: 8 min per exercise; round to nearest 5.
  const n = suggestion.exerciseIds.length;
  return String(Math.round(n * 8 / 5) * 5);
}


/* ── Recent sessions ─────────────────────────────────────────────── */

function fillRecent(box, sessions) {
  const recent = sessions.slice(0, 3);
  if (recent.length === 0) {
    box.append(el('div', 'lib-empty', 'NO SESSIONS YET'));
    return;
  }
  for (const s of recent) box.append(sessionRow(s));
}

// Reuses #tpl-session-row (shared with the history timeline).
function sessionRow(s) {
  const row = document.getElementById('tpl-session-row')
    .content.firstElementChild.cloneNode(true);
  row.querySelector('.session-row-date').textContent = formatShortDate(s.startedAt);
  row.querySelector('.session-row-muscles').textContent = sessionMusclesLabel(s);
  row.querySelector('[data-field="vol"]').textContent = formatWeight(sessionVolume(s));
  row.querySelector('[data-field="time"]').textContent = formatTrainTime(sessionDurationSec(s));
  const prs = sessionPRCount(s);
  if (prs > 0) {
    row.querySelector('[data-field="pr"]').textContent = `+${prs} PR`;
  } else {
    row.querySelector('[data-field="prsep"]').remove();
    row.querySelector('[data-field="pr"]').remove();
  }
  row.addEventListener('click', () => go('session/' + s.id));
  return row;
}
