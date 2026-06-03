/* HISTORY screen — pure timeline list of past sessions grouped by
   month with sticky headers. Aggregate strip on top shows last-4-weeks
   sessions/volume/PR.

   Past session detail: full-screen render reached by `#session/<id>`,
   shows split tag + completed date + duration, a per-exercise plan-row
   list, and REPEAT / DELETE actions. Mirrors the workout overview but
   in read-only mode. */

import { listSessions, getSession, deleteSession, exerciseLabel, startSession } from '../data/sessions.js';
import { sessionMusclesLabel, sessionSplitTag, sessionVolume, sessionDurationSec, sessionPRCount, lastNWeeks } from '../data/derived.js';
import { el, statCell, formatWeight, formatTrainTime, formatShortDate, formatMonth, formatDurationPad, formatKilo } from './shared.js';
import { go } from '../app.js';


export function renderHistory(container) {
  container.replaceChildren();

  // Markup lives in #tpl-history (multi-child fragment) in index.html.
  const frag = document.getElementById('tpl-history').content.cloneNode(true);

  const sessions = listSessions().filter((s) => s.endedAt != null);

  // Aggregate strip — last 4 weeks
  fillAggregate(frag.querySelector('[data-field="agg"]'));

  const list = frag.querySelector('[data-field="list"]');

  if (sessions.length === 0) {
    list.append(el('div', 'lib-empty history-empty', 'NO SESSIONS YET'));
    container.append(frag);
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

  grouped.forEach((g, gi) => {
    const header = document.getElementById('tpl-history-month')
      .content.firstElementChild.cloneNode(true);
    if (gi === 0) header.classList.add('first');
    header.querySelector('.history-month-name').textContent = `── ${g.month}`;
    header.querySelector('.history-month-count').textContent = `${g.items.length} SESSIONS`;
    list.append(header);

    const wrap = el('div', 'history-group');
    for (const s of g.items) wrap.append(sessionRow(s));
    list.append(wrap);
  });

  container.append(frag);
}


function fillAggregate(grid) {
  const weeks = lastNWeeks(4);
  let sessions = 0, vol = 0, durationSec = 0;
  for (const w of weeks) { sessions += w.sessions; vol += w.volume; durationSec += w.durationSec; }

  grid.append(statCell({ label: 'VOLUME', value: formatKilo(vol), unit: 'kg', size: 'md' }));
  grid.append(statCell({ label: 'SESSIONS', value: String(sessions), size: 'md' }));
  grid.append(statCell({ label: 'TRAIN TIME', value: Math.round(durationSec / 3600) + 'h', size: 'md' }));
}


/* ── Session row (also used on Home, duplicated for variation here) ── */

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


/* ── Past session detail (sub-route #session/<id>) ──────────────── */

export function renderPastSession(container, id) {
  container.replaceChildren();
  const session = getSession(id);
  if (!session) { go('history'); return; }

  // Markup lives in #tpl-past-session (multi-child fragment) in index.html.
  const frag = document.getElementById('tpl-past-session').content.cloneNode(true);

  // Top bar — close + workout name + completed date + duration
  frag.querySelector('[data-act="close"]').addEventListener('click', () => go('history'));
  const completedLabel = 'COMPLETED · ' + new Date(session.startedAt).toLocaleDateString([], {
    weekday: 'short', day: 'numeric', month: 'short',
  }).toUpperCase();
  frag.querySelector('[data-field="completed"]').textContent = completedLabel;
  frag.querySelector('[data-field="split"]').textContent = sessionSplitTag(session);
  frag.querySelector('[data-field="dur"]').textContent = formatDurationPad(sessionDurationSec(session));

  // Progress strip — all complete
  const total = session.entries.length;
  frag.querySelector('[data-field="complete"]').textContent = `${total} / ${total} COMPLETE`;
  const prs = sessionPRCount(session);
  frag.querySelector('[data-field="dvol"]').textContent = formatWeight(sessionVolume(session));
  if (prs > 0) {
    frag.querySelector('[data-field="dpr"]').textContent = `+${prs} PR`;
  } else {
    frag.querySelector('[data-field="dprsep"]').remove();
    frag.querySelector('[data-field="dpr"]').remove();
  }

  // Per-exercise rows (reuse the active-session plan-row template)
  const plan = frag.querySelector('[data-field="plan"]');
  session.entries.forEach((entry) => plan.append(pastEntryRow(entry)));

  // Repeat / Delete footer
  frag.querySelector('[data-act="repeat"]').addEventListener('click', () => {
    const exerciseIds = session.entries.map((e) => e.exerciseId);
    startSession(exerciseIds);
    go('record');
  });
  frag.querySelector('[data-act="delete"]').addEventListener('click', () => {
    if (!confirm('Delete this session permanently?')) return;
    deleteSession(session.id);
    go('history');
  });

  container.append(frag);
}

function pastEntryRow(entry) {
  const working = entry.sets.filter((s) => !s.isWarmup);
  const row = document.getElementById('tpl-plan-row')
    .content.firstElementChild.cloneNode(true);
  row.classList.add('done');
  row.querySelector('.plan-row-marker').textContent = '✓';
  row.querySelector('.plan-row-name').textContent = exerciseLabel(entry.exerciseId);
  row.querySelector('.plan-row-result').textContent = formatResult(working);
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
