/* HOME screen — week/month calendar header, this-week stats strip,
   "TODAY · SUGGESTED" inverse CTA, recent sessions list. */

import { getDb } from '../data/storage.js';
import { listSessions } from '../data/sessions.js';
import { suggestWorkout } from '../data/templates.js';
import { sessionMusclesLabel, sessionSplitTag, sessionVolume, sessionDurationSec, sessionPRCount, lastNWeeks } from '../data/derived.js';
import { openSettings } from './settings.js';
import { el, html, divider, formatWeight, formatTrainTime, formatShortDate } from './shared.js';
import { startSessionFlow } from './session.js';
import { go } from '../app.js';

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const DAY_LETTERS = ['M','T','W','T','F','S','S'];

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

  container.append(calendarHeader(today, dayMap, () => renderHome(container)));
  container.append(thisWeekSection());
  container.append(todayCtaSection());
  container.append(recentSection(sessions));
}


/* ── Calendar header ─────────────────────────────────────────────── */

function calendarHeader(today, dayMap, rerender) {
  const wrap = el('div', 'cal-header');

  // Nav row: ‹ MAY 2026 ›  ·  WK 21 / settings / expand
  const nav = el('div', 'cal-nav');
  const left = el('div', 'cal-nav-left');
  const prev = el('button', 'cal-arrow');
  prev.textContent = '‹';
  prev.setAttribute('aria-label', 'previous');
  prev.addEventListener('click', () => {
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
  const label = el('span', 'cal-month-label');
  label.textContent = `${MONTHS[cursor.m]} ${cursor.y}`;
  const next = el('button', 'cal-arrow');
  next.textContent = '›';
  next.setAttribute('aria-label', 'next');
  next.addEventListener('click', () => {
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
  left.append(prev, label, next);

  const right = el('div', 'cal-nav-right');
  const wkLabel = el('span', 'cal-wk');
  wkLabel.textContent = `WK ${isoWeek(cursor)}`;
  right.append(wkLabel);
  const toggle = el('button', 'cal-toggle');
  toggle.textContent = expanded ? '▴ WEEK' : '▾ MONTH';
  toggle.addEventListener('click', () => { expanded = !expanded; rerender(); });
  right.append(toggle);
  const settingsBtn = el('button', 'cal-toggle');
  settingsBtn.textContent = '☰';
  settingsBtn.setAttribute('aria-label', 'settings');
  settingsBtn.addEventListener('click', () => openSettings());
  right.append(settingsBtn);

  nav.append(left, right);
  wrap.append(nav);

  // Day letters
  const letters = el('div', 'cal-day-letters');
  for (const l of DAY_LETTERS) letters.append(el('span', null, l));
  wrap.append(letters);

  // Calendar grid
  if (expanded) {
    const cells = getMonth(cursor);
    for (let row = 0; row < 6; row++) {
      const rowCells = cells.slice(row * 7, row * 7 + 7);
      const isCurrentWeek = rowCells.some((c) => isToday(c, today));
      const rowEl = el('div', 'cal-month-row' + (isCurrentWeek ? ' current-week' : ''));
      for (const c of rowCells) rowEl.append(dayCell(c, today, dayMap, true));
      wrap.append(rowEl);
    }
  } else {
    const week = el('div', 'cal-week');
    for (const c of getWeek(cursor)) week.append(dayCell(c, today, dayMap, false));
    wrap.append(week);
  }
  return wrap;
}

function dayCell(day, today, dayMap, compact) {
  const future = isFuture(day, today);
  const isT = isToday(day, today);
  const session = dayMap.get(key(day.y, day.m, day.d));
  const wrap = el('div', 'cal-day' + (compact ? ' compact' : '')
    + (day.dim ? ' dim' : '')
    + (future ? ' future' : '')
    + (isT ? ' today' : ''));
  wrap.append(el('span', 'cal-day-num', String(day.d)));
  const dot = el('span', 'cal-day-dot' + (isT ? ' today' : session && !future ? ' session' : ' empty'));
  wrap.append(dot);
  return wrap;
}


/* ── This-week stats ─────────────────────────────────────────────── */

function thisWeekSection() {
  const wrap = el('div', 'body-pad');
  wrap.append(divider('THIS WEEK'));
  const weeks = lastNWeeks(1);
  const w = weeks[weeks.length - 1];
  const grid = el('div', 'stat-grid cols-3');
  grid.append(statCellShort('VOLUME', formatKilo(w.volume), 'kg'));
  grid.append(statCellShort('SESSIONS', String(w.sessions)));
  grid.append(statCellShort('TRAIN TIME', formatTrainTime(w.durationSec)));
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


/* ── Today CTA ──────────────────────────────────────────────────── */

function todayCtaSection() {
  const wrap = el('div', 'body-pad');
  const suggestion = suggestWorkout();
  if (!suggestion.exerciseIds || suggestion.exerciseIds.length === 0) {
    const empty = el('div', 'today-cta empty');
    empty.innerHTML = `<span class="eyebrow">TODAY · REST</span>
      <p style="margin: 6px 0 0; font-size: var(--t-md);">${suggestion.description}</p>`;
    wrap.append(empty);
    return wrap;
  }

  const cta = el('div', 'today-cta');
  // Header
  const head = el('div', 'row-baseline');
  head.append(html('span', 'eyebrow', 'TODAY · SUGGESTED'));
  head.append(html('span', 'eyebrow', estimateMinutes(suggestion) + ' MIN'));
  cta.append(head);

  // Title + start
  const titleRow = el('div', 'row-between');
  titleRow.append(html('span', 'today-cta-title', suggestion.name));
  const startBtn = el('button', 'today-cta-start');
  startBtn.textContent = 'START ▶';
  startBtn.addEventListener('click', () => startSessionFlow(suggestion.exerciseIds));
  titleRow.append(startBtn);
  cta.append(titleRow);

  // Why-this-plan (recovery hints)
  cta.append(whyLine(suggestion));

  wrap.append(cta);
  return wrap;
}

function whyLine(suggestion) {
  const line = el('div', 'today-cta-why');
  // Show up to 3 recovered muscles by name from the suggestion's exercises.
  if (suggestion.freshRegions && suggestion.freshRegions.length > 0) {
    const labels = suggestion.freshRegions.map((r) => r.toUpperCase()).join(' · ');
    line.innerHTML = `Targets <span class="good">${labels}</span>`;
  } else if (suggestion.description) {
    line.textContent = suggestion.description;
  }
  return line;
}

function estimateMinutes(suggestion) {
  // Rough: 8 min per exercise; round to nearest 5.
  const n = suggestion.exerciseIds.length;
  return String(Math.round(n * 8 / 5) * 5);
}


/* ── Recent sessions ─────────────────────────────────────────────── */

function recentSection(sessions) {
  const wrap = el('div', 'body-pad section-mt');
  wrap.append(divider('RECENT SESSIONS', String(sessions.length)));
  const recent = sessions.slice(0, 3);
  if (recent.length === 0) {
    wrap.append(html('div', 'lib-empty', 'NO SESSIONS YET'));
    return wrap;
  }
  for (const s of recent) wrap.append(sessionRow(s));
  return wrap;
}

function sessionRow(s) {
  const row = el('button', 'session-row');
  row.type = 'button';
  row.append(el('div', 'session-row-date', formatShortDate(s.startedAt)));
  const main = el('div', 'session-row-main');
  main.append(el('span', 'session-row-muscles', sessionMusclesLabel(s)));
  main.append(el('span', 'session-row-chevron', '›'));
  row.append(main);
  const meta = el('div', 'session-row-meta');
  meta.append(el('span', null, `${formatWeight(sessionVolume(s))} ${''}`));
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
