/* CURRENT WORKOUT screen — overview of all exercises in the active
   session. Reached from the active session by tapping the split tag in
   the topbar. Each row tap jumps back to that exercise in the active
   session view. Includes a + ADD EXERCISE entry and a FINISH WORKOUT
   primary action at the bottom. */

import { getActiveSession, endActiveSession, abandonActiveSession, exerciseLabel } from '../data/sessions.js';
import { sessionSplitTag } from '../data/derived.js';
import { go } from '../app.js';
import { el, html, divider, formatDurationPad } from './shared.js';
import { openExercisePicker, setCurrentEntryIdx } from './session.js';
import { addEntry } from '../data/sessions.js';

export function renderWorkout(container) {
  container.replaceChildren();
  const session = getActiveSession();
  if (!session) { go('record'); return; }

  // Top bar — close + workout name + elapsed
  const tb = el('div', 'topbar detail-topbar');

  const close = el('button', 'btn-icon lg');
  close.textContent = '×';
  close.setAttribute('aria-label', 'back to active exercise');
  close.addEventListener('click', () => go('record'));
  tb.append(close);

  const titleBox = el('div', 'detail-topbar-title');
  titleBox.append(html('div', 'eyebrow', 'CURRENT WORKOUT'));
  titleBox.append(html('div', 'title', sessionSplitTag(session)));
  tb.append(titleBox);

  const elapsedBox = el('div', 'detail-topbar-right');
  elapsedBox.append(html('div', 'eyebrow', 'ELAPSED'));
  const elapsed = el('div', 'tnum detail-topbar-value');
  elapsed.textContent = formatDurationPad(Math.floor((Date.now() - session.startedAt) / 1000));
  elapsedBox.append(elapsed);
  tb.append(elapsedBox);

  container.append(tb);

  // Progress strip
  const total = session.entries.length;
  const doneCount = session.entries.filter(entryDone).length;
  const pct = total ? doneCount / total : 0;
  const progress = el('div', 'detail-progress');
  const progressLabel = el('div', 'row-baseline detail-progress-label');
  progressLabel.append(html('span', null, `<strong>${doneCount} / ${total}</strong> EXERCISES`));
  progressLabel.append(html('span', null, sessionSplitTag(session)));
  progress.append(progressLabel);

  const bar = el('div', 'progress-strip');
  const fill = el('div', 'progress-strip-fill');
  fill.style.width = (pct * 100) + '%';
  bar.append(fill);
  for (let i = 1; i < total; i++) {
    const tick = el('div', 'progress-strip-tick');
    tick.style.left = ((i / total) * 100) + '%';
    bar.append(tick);
  }
  progress.append(bar);
  container.append(progress);

  // Divider + plan
  container.append(planHeader());

  const plan = el('div');
  plan.style.flex = '1';
  session.entries.forEach((entry, idx) => {
    plan.append(planRow(entry, idx, doneCount));
  });

  // + ADD EXERCISE — wrapped in a padded container so the button (which
  // shrinks to content-width as a grid-display <button>) can use
  // width: 100% to fill, while the wrapper provides breathing room
  // around the dashed border.
  const addWrap = el('div');
  addWrap.style.padding = '12px 16px';
  const addRow = el('button', 'plan-row');
  addRow.type = 'button';
  addRow.style.border = '1px dashed var(--line)';
  addRow.style.width = '100%';
  addRow.style.gridTemplateColumns = '24px 1fr 14px';
  const plus = el('span', 'plan-row-marker');
  plus.textContent = '+';
  plus.style.color = 'var(--ink-soft)';
  addRow.append(plus);
  const addLabel = el('div');
  addLabel.append(html('div', null, '<strong style="font-size: var(--t-sm); letter-spacing: 0.08em; text-transform: uppercase;">ADD EXERCISE</strong>'));
  addLabel.append(html('div', 'muted', 'Pick from library'));
  addLabel.lastChild.style.fontSize = 'var(--t-xs)';
  addLabel.lastChild.style.marginTop = '2px';
  addRow.append(addLabel);
  addRow.append(html('span', 'plan-row-chev', '›'));
  addRow.addEventListener('click', () => openExercisePicker((exId) => {
    addEntry(exId);
  }));
  addWrap.append(addRow);
  plan.append(addWrap);

  container.append(plan);

  // Finish / abandon workout
  const footer = el('div', 'detail-footer');

  const finish = el('button', 'btn-primary');
  finish.innerHTML = '<span>FINISH WORKOUT</span><span>→</span>';
  finish.addEventListener('click', () => {
    if (!confirm('Finish this workout?')) return;
    endActiveSession();
    go('home');
  });
  footer.append(finish);

  const abandon = el('button', 'btn-secondary danger block');
  abandon.textContent = '⌫ ABANDON WORKOUT';
  abandon.addEventListener('click', () => {
    const hasLogged = session.entries.some((e) => e.sets.length > 0);
    if (hasLogged && !confirm('Abandon this session? Logged sets will be discarded.')) return;
    abandonActiveSession();
    go('home');
  });
  footer.append(abandon);

  container.append(footer);
}

function planHeader() {
  return divider('PLAN');
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
  const row = el('div', 'plan-row ' + state);

  const marker = el('span', 'plan-row-marker');
  marker.textContent = state === 'done' ? '✓' : state === 'current' ? '▶' : '○';
  row.append(marker);

  const text = el('div', 'plan-row-text');
  text.append(html('span', 'plan-row-name', exerciseLabel(entry.exerciseId)));
  text.append(html('div', 'plan-row-result', formatEntryResult(entry, state)));
  row.append(text);

  row.append(html('span', 'plan-row-chev', '›'));

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
