/* CURRENT WORKOUT screen — overview of all exercises in the active
   session. Reached from the active session by tapping the split tag in
   the topbar. Each row tap jumps back to that exercise in the active
   session view. Includes a + ADD EXERCISE entry and a FINISH WORKOUT
   primary action at the bottom. */

import { getActiveSession, endActiveSession, abandonActiveSession, exerciseLabel } from '../data/sessions.js';
import { sessionSplitTag } from '../data/derived.js';
import { go } from '../app.js';
import { el, formatDurationPad } from './shared.js';
import { openExercisePicker, setCurrentEntryIdx } from './session.js';
import { addEntry } from '../data/sessions.js';

export function renderWorkout(container) {
  container.replaceChildren();
  const session = getActiveSession();
  if (!session) { go('record'); return; }

  // Markup lives in #tpl-workout in index.html. It's a multi-child fragment
  // (topbar, progress, divider, plan, footer) that mounts as direct children
  // of the screen — we query/fill/wire before appending.
  const frag = document.getElementById('tpl-workout').content.cloneNode(true);

  const total = session.entries.length;
  const doneCount = session.entries.filter(entryDone).length;
  const pct = total ? doneCount / total : 0;

  // Top bar — close + workout name + elapsed
  frag.querySelector('[data-act="close"]').addEventListener('click', () => go('record'));
  frag.querySelector('[data-field="split"]').textContent = sessionSplitTag(session);
  frag.querySelector('[data-field="elapsed"]').textContent =
    formatDurationPad(Math.floor((Date.now() - session.startedAt) / 1000));

  // Progress strip
  frag.querySelector('[data-field="count"]').textContent = `${doneCount} / ${total}`;
  frag.querySelector('[data-field="split2"]').textContent = sessionSplitTag(session);
  frag.querySelector('[data-field="fill"]').style.width = (pct * 100) + '%';
  const bar = frag.querySelector('[data-field="bar"]');
  for (let i = 1; i < total; i++) {
    const tick = el('div', 'progress-strip-tick');
    tick.style.left = ((i / total) * 100) + '%';
    bar.append(tick);
  }

  // Plan rows — inserted before the ADD EXERCISE row already in the template
  const plan = frag.querySelector('[data-field="plan"]');
  const addWrap = plan.querySelector('.workout-add');
  session.entries.forEach((entry, idx) => {
    plan.insertBefore(planRow(entry, idx, doneCount), addWrap);
  });
  frag.querySelector('[data-act="add"]').addEventListener('click', () =>
    openExercisePicker((exId) => { addEntry(exId); }));

  // Finish / abandon workout
  frag.querySelector('[data-act="finish"]').addEventListener('click', () => {
    if (!confirm('Finish this workout?')) return;
    endActiveSession();
    go('home');
  });
  frag.querySelector('[data-act="abandon"]').addEventListener('click', () => {
    const hasLogged = session.entries.some((e) => e.sets.length > 0);
    if (hasLogged && !confirm('Abandon this session? Logged sets will be discarded.')) return;
    abandonActiveSession();
    go('home');
  });

  container.append(frag);
}

function entryDone(entry) {
  return entry.sets.some((s) => !s.isWarmup);
}

function planRow(entry, idx, doneCount) {
  // State: done if at least one working set logged, current if it's the
  // next entry without working sets, else upcoming.
  let state = 'upcoming';
  if (entryDone(entry)) state = 'done';
  else if (!hasDoneBefore(idx)) state = 'current';

  const row = document.getElementById('tpl-plan-row')
    .content.firstElementChild.cloneNode(true);
  row.classList.add(state);
  row.querySelector('.plan-row-marker').textContent =
    state === 'done' ? '✓' : state === 'current' ? '▶' : '○';
  row.querySelector('.plan-row-name').textContent = exerciseLabel(entry.exerciseId);
  row.querySelector('.plan-row-result').textContent = formatEntryResult(entry, state);

  row.addEventListener('click', () => {
    setCurrentEntryIdx(idx);
    go('record');
  });

  return row;

  function hasDoneBefore(idx) {
    for (let i = 0; i < idx; i++) {
      if (entryDone(getActiveSession().entries[i])) return true;
    }
    return false;
  }
}

function formatEntryResult(entry, state) {
  const working = entry.sets.filter((s) => !s.isWarmup);
  if (working.length === 0) {
    return state === 'current' ? 'IN PROGRESS' : 'NOT STARTED';
  }
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
