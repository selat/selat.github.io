/* CURRENT WORKOUT screen — overview of all exercises in the active
   session. Reached from the active session by tapping the split tag in
   the topbar. Each row tap jumps back to that exercise in the active
   session view. Includes a + ADD EXERCISE entry and a FINISH WORKOUT
   primary action at the bottom. */

import { getActiveSession, endActiveSession, exerciseLabel } from '../data/sessions.js';
import { sessionSplitTag } from '../data/derived.js';
import { go } from '../app.js';
import { el, html, divider, formatDurationPad } from './shared.js';
import { openExercisePicker } from './session.js';
import { addEntry } from '../data/sessions.js';

export function renderWorkout(container) {
  container.replaceChildren();
  const session = getActiveSession();
  if (!session) { go('record'); return; }

  // Top bar — close + workout name + elapsed
  const tb = el('div', 'topbar');
  tb.style.display = 'flex';
  tb.style.alignItems = 'center';
  tb.style.gap = '12px';
  tb.style.padding = '8px 14px 10px';

  const close = el('button', 'btn-icon');
  close.textContent = '×';
  close.style.fontSize = 'var(--t-lg)';
  close.setAttribute('aria-label', 'back to active exercise');
  close.addEventListener('click', () => go('record'));
  tb.append(close);

  const titleBox = el('div');
  titleBox.style.flex = '1';
  titleBox.style.lineHeight = '1.15';
  titleBox.append(html('div', 'eyebrow', 'CURRENT WORKOUT'));
  titleBox.append(html('div', 'title', sessionSplitTag(session)));
  tb.append(titleBox);

  const elapsedBox = el('div');
  elapsedBox.style.textAlign = 'right';
  elapsedBox.style.lineHeight = '1.15';
  elapsedBox.append(html('div', 'eyebrow', 'ELAPSED'));
  const elapsed = el('div', 'tnum');
  elapsed.style.fontSize = 'var(--t-md)';
  elapsed.style.fontWeight = '700';
  elapsed.textContent = formatDurationPad(Math.floor((Date.now() - session.startedAt) / 1000));
  elapsedBox.append(elapsed);
  tb.append(elapsedBox);

  container.append(tb);

  // Progress strip
  const total = session.entries.length;
  const doneCount = session.entries.filter(entryDone).length;
  const pct = total ? doneCount / total : 0;
  const progress = el('div');
  progress.style.padding = '12px 16px 10px';
  const progressLabel = el('div', 'row-baseline');
  progressLabel.style.fontSize = 'var(--t-xs)';
  progressLabel.style.letterSpacing = '0.1em';
  progressLabel.style.color = 'var(--ink-soft)';
  progressLabel.style.textTransform = 'uppercase';
  progressLabel.append(html('span', null, `<strong style="color:var(--ink);font-weight:700">${doneCount} / ${total}</strong> EXERCISES`));
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

  // + ADD EXERCISE
  const addRow = el('button', 'plan-row');
  addRow.type = 'button';
  addRow.style.border = '1px dashed var(--line)';
  addRow.style.margin = '12px 16px';
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
  plan.append(addRow);

  container.append(plan);

  // Finish workout
  const footer = el('div');
  footer.style.padding = '10px 16px 12px';
  footer.style.borderTop = '1px solid var(--line)';
  footer.style.background = 'var(--bg)';
  const finish = el('button', 'btn-primary');
  finish.innerHTML = '<span>FINISH WORKOUT</span><span>→</span>';
  finish.addEventListener('click', () => {
    if (!confirm('Finish this workout?')) return;
    endActiveSession();
    go('home');
  });
  footer.append(finish);
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

  const text = el('div');
  text.style.minWidth = '0';
  const head = el('div');
  head.style.display = 'flex';
  head.style.alignItems = 'baseline';
  head.style.gap = '6px';
  head.append(html('span', null,
    `<span class="idx">${String(idx + 1).padStart(2, '0')}</span><span class="bold" style="font-size: var(--t-md);">${exerciseLabel(entry.exerciseId)}</span>`));
  text.append(head);
  text.append(html('div', 'plan-row-result', formatEntryResult(entry, state)));
  row.append(text);

  row.append(html('span', 'plan-row-chev', '›'));

  row.addEventListener('click', () => go('record')); // active session shows whichever entry is selected; will jump there

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
