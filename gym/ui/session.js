/* ACTIVE SESSION screen — the live workout view.

   Layout (top to bottom):
     • Topbar: split tag (tap → workout overview) · elapsed timer
     • Exercise header: name + idx · prev/next
     • Pill row: equipment hint + LAST summary
     • Sets table: warmups, logged working sets, and one command card
       (steppers for weight/reps) for the next set
     • Primary action: LOG SET (green), or SKIP REST · countdown (white)
       while rest is running, or NEXT EXERCISE / REVIEW WORKOUT once
       all planned sets are logged
     • (Active workout list reached by tapping the split name) — see workout.js

   Command-card pattern is the design's "sweaty-thumb" anchor: large
   tabular numerals with 48×48 stepper buttons. Editing a previously
   logged set still opens a sheet (rare path; keep the table tidy).

   Defaults for new set: copy the last set in this entry, or fall back to
   the most recent working set from history, or all-zeros. Pre-fills
   weight/reps so users only need to nudge between sets. */

import { getActiveSession, startSession,
         addEntry, removeEntry, addSet, updateSet, deleteSet,
         startRest, clearRest, getRestState, exerciseLabel,
         startHold, pauseHold, resumeHold, endHoldWork, endHoldRest, clearHold,
         adjustHoldTarget, adjustHoldRest, getHoldState } from '../data/sessions.js';
import { listExercises, getExercise } from '../data/exercises.js';
import { getDb } from '../data/storage.js';
import { lastWorkingSet, lastSetSummary, sessionPRMarks, sessionSplitTag } from '../data/derived.js';
import { openSheet, go } from '../app.js';
import { el, html, pill, formatDuration, formatDurationPad, playChime,
         vibrate, setKeepScreenAwake, ensureNotificationPermission, notify } from './shared.js';

const DEFAULT_WORKING_SETS = 3;

// Persistent UI state (survives storage-driven re-renders within a session).
let currentEntryIdx = 0;       // which exercise we're viewing
let draftWeight = null;        // command card weight (kg)
let draftReps = null;          // command card reps
let draftIsWarmup = false;
let draftPerSide = false;
let extraPlannedSets = 0;      // each ADD SET tap bumps the planned count by 1
let restInterval = null;
let lastRestRemaining = null;

// DOM refs into the currently-rendered command card. refreshCard() patches
// these in place rather than calling renderSession(), so adjusting a
// stepper or toggling warmup doesn't redraw the topbar, banner, header,
// pills row, or logged-set rows. Repopulated on every full renderSession;
// stale refs from a previous render are simply overwritten when the new
// card mounts (and refreshCard's handlers can only fire from the live
// card, so there's no window for them to touch detached nodes).
let cmdCardHeaderEl = null;
let cmdCardWeightInput = null;
let cmdCardRepsInput = null;
let cmdCardWarmupPill = null;
let cmdCardPerSidePill = null;
let upcomingRowsContainer = null;
let primaryActionContainer = null;


export function startSessionFlow(exerciseIds = []) {
  // Reset BEFORE startSession — the mutate it does triggers a synchronous
  // rerender, which runs commandCard and initialises draftReps from
  // history. If we reset afterwards, draftReps gets clobbered back to
  // null while the rendered stepper still shows the seeded value, and
  // the next LOG SET click fails the "reps must be > 0" guard.
  currentEntryIdx = 0;
  resetDraft();
  startSession(exerciseIds);
  go('record');
}

/** Set the active session's "current entry" pointer. Called from the
    workout-overview screen so tapping a plan row jumps to that exercise
    when the user returns to #record. Resets the command-card draft
    since the previous exercise's prefilled weight/reps don't apply. */
export function setCurrentEntryIdx(idx) {
  currentEntryIdx = idx;
  resetDraft();
  timedDraft.entryIndex = null;
}

function resetDraft() {
  draftWeight = null;
  draftReps = null;
  draftIsWarmup = false;
  draftPerSide = false;
  extraPlannedSets = 0;
}


export function renderSession(container) {
  container.replaceChildren();
  const session = getActiveSession();
  if (!session) { go('record'); return; }

  // Normalise current entry index in case entries were removed.
  if (session.entries.length === 0) {
    currentEntryIdx = 0;
  } else if (currentEntryIdx >= session.entries.length) {
    currentEntryIdx = session.entries.length - 1;
  }

  container.append(topbar(session));

  const body = el('div', 'body-pad');

  if (session.entries.length === 0) {
    body.append(emptyState());
    body.append(addExerciseBtn());
    container.append(body);
    startRestTicker();
    return;
  }

  const entry = session.entries[currentEntryIdx];
  const ex = getExercise(entry.exerciseId);
  body.append(exerciseHeader(session, entry));
  body.append(exercisePills(entry));

  if (ex?.isTimed) {
    // Timed/isometric branch — ring + config + start/pause/skip flow
    body.append(timedView(session, entry));
  } else {
    body.append(setsTable(session, entry));
    body.append(addSetButton());
    body.append(primaryAction(session, entry));
  }

  container.append(body);
  startRestTicker();
}


/* ── Topbar ──────────────────────────────────────────────────────── */

function topbar(session) {
  const bar = el('div', 'topbar with-meta');
  const meta = el('div', 'topbar-meta');

  // Split (tap to open workout overview)
  const splitBtn = document.createElement('button');
  splitBtn.style.background = 'none';
  splitBtn.style.border = 'none';
  splitBtn.style.color = 'var(--ink)';
  splitBtn.style.fontFamily = 'inherit';
  splitBtn.style.fontSize = 'var(--t-xs)';
  splitBtn.style.letterSpacing = '0.10em';
  splitBtn.style.textTransform = 'uppercase';
  splitBtn.style.fontWeight = '700';
  splitBtn.style.padding = '0';
  splitBtn.style.cursor = 'pointer';
  splitBtn.innerHTML = `${sessionSplitTag(session)} <span class="muted" style="font-weight: 400; margin-left: 4px;">▾</span>`;
  splitBtn.addEventListener('click', () => go('workout'));
  meta.append(splitBtn);

  meta.append(el('span', null, formatElapsed(session.startedAt) + ' ELAPSED'));
  bar.append(meta);
  return bar;
}

function formatElapsed(startedAt) {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  return formatDurationPad(sec);
}


/* ── REST countdown (inlined into the primary action) ──────────────
   The bottom action button doubles as the rest indicator: while rest
   is running it renders as a white SKIP REST · countdown (see
   buildPrimaryActionInto). This ticker updates the countdown text and
   auto-clears the rest state at 0 so the green LOG SET returns
   instantly — the chime/vibrate/notify is the "ready" cue. */

function startRestTicker() {
  if (restInterval) clearInterval(restInterval);
  restInterval = setInterval(() => {
    tickRestCountdown();
    tickHoldTextAndTransitions();
    const hasRing = !!document.getElementById('ring-count');
    if (!hasRing && !getRestState() && !getHoldState()) {
      stopRestTicker();
    }
  }, 250);
  // Ring animation runs on rAF for sub-second smoothness — separate loop
  // from the 250 ms tick that handles text + state-machine transitions.
  startRingAnimation();
}

function stopRestTicker() {
  if (restInterval) clearInterval(restInterval);
  restInterval = null;
  lastRestRemaining = null;
  lastHoldRemaining = null;
  lastHoldPhase = null;
  stopRingAnimation();
}

function tickRestCountdown() {
  const rest = getRestState();
  if (!rest) return;
  if (rest.remainingSec > 0) {
    const count = document.getElementById('rest-count');
    if (count) count.textContent = formatDuration(rest.remainingSec);
    lastRestRemaining = rest.remainingSec;
    return;
  }
  if (lastRestRemaining === 0) return;
  playChime();
  vibrate([200, 100, 200]);
  notify('Rest done', exerciseLabel(rest.exerciseId));
  setKeepScreenAwake(false);
  lastRestRemaining = 0;
  // Drop rest state so the primary action re-renders as green LOG SET
  // (or stays as green NEXT EXERCISE if the plan is already done).
  clearRest();
}

let lastHoldRemaining = null;
let lastHoldPhase = null;

/* Text + state-machine tick (250 ms). Updates the center countdown text
   (which only changes once per second, so 250 ms is plenty) and fires
   the auto-transition when the timer hits zero. Ring offset is NOT
   touched here — rAF handles that for smooth sub-second motion. */
function tickHoldTextAndTransitions() {
  const countEl = document.getElementById('ring-count');
  if (!countEl) return;
  const hold = getHoldState();
  if (!hold) return;

  // Auto-transition on hit-zero (use a small epsilon since remainingSec
  // is now a float — could be 0.003 etc. before the next animation frame).
  if (hold.remainingSec <= 0.05 && !hold.paused) {
    if (hold.phase === 'work' && lastHoldRemaining !== 0) {
      playChime();
      lastHoldRemaining = 0;
      const session = getActiveSession();
      if (session) {
        const entry = session.entries[hold.entryIndex];
        if (entry) finishCurrentWorkHold(entry);
      }
      return;
    }
    if (hold.phase === 'rest' && lastHoldRemaining !== 0) {
      playChime();
      lastHoldRemaining = 0;
      endHoldRest();
      return;
    }
  }

  countEl.textContent = formatHold(hold.remainingSec);
  lastHoldRemaining = hold.remainingSec;
  lastHoldPhase = hold.phase;
}


/* Ring animation — rAF loop that writes a sub-second stroke-dashoffset
   every frame. Stops itself when the ring element disappears or there's
   no active hold. */
let ringRafId = null;

function startRingAnimation() {
  if (ringRafId != null) cancelAnimationFrame(ringRafId);
  function frame() {
    const ringEl = document.getElementById('ring-progress');
    if (!ringEl) { ringRafId = null; return; }
    const hold = getHoldState();
    if (!hold) { ringRafId = null; return; }
    const pct = hold.totalSec > 0 ? 1 - hold.remainingSec / hold.totalSec : 0;
    ringEl.setAttribute('stroke-dashoffset', String(RING_C * (1 - pct)));
    ringRafId = requestAnimationFrame(frame);
  }
  ringRafId = requestAnimationFrame(frame);
}

function stopRingAnimation() {
  if (ringRafId != null) cancelAnimationFrame(ringRafId);
  ringRafId = null;
}


/* ── Exercise header (name, idx, prev/next) ──────────────────────── */

function exerciseHeader(session, entry) {
  const ex = getExercise(entry.exerciseId);
  const head = el('div', 'row-baseline section-mt');
  head.style.marginTop = '12px';
  const left = el('div');
  const eyebrow = el('div', 'eyebrow');
  const idx = currentEntryIdx + 1;
  const total = session.entries.length;
  const region = ex?.muscles.primary[0]
    ? (ex.muscles.primary[0].toUpperCase().replace(/-/g, ' '))
    : '';
  eyebrow.textContent = `EX ${idx} / ${total}${region ? ' · ' + region : ''}`;
  left.append(eyebrow);
  const title = el('h2', 'title');
  title.style.marginTop = '2px';
  title.textContent = exerciseLabel(entry.exerciseId);
  left.append(title);
  head.append(left);

  if (total > 1) {
    const nav = el('div');
    nav.style.display = 'flex';
    nav.style.gap = '6px';
    const prev = navBtn('‹', () => {
      currentEntryIdx = (currentEntryIdx - 1 + total) % total;
      resetDraft();
      rerenderFull();
    });
    const next = navBtn('›', () => {
      currentEntryIdx = (currentEntryIdx + 1) % total;
      resetDraft();
      rerenderFull();
    });
    nav.append(prev, next);
    head.append(nav);
  }
  return head;
}

function navBtn(glyph, onClick) {
  const b = document.createElement('button');
  b.className = 'btn-icon';
  b.style.width = '40px';
  b.style.height = '40px';
  b.textContent = glyph;
  b.style.fontSize = 'var(--t-lg)';
  b.addEventListener('click', onClick);
  return b;
}


/* ── Pills row ────────────────────────────────────────────────────── */

function exercisePills(entry) {
  const ex = getExercise(entry.exerciseId);
  const row = el('div');
  row.style.display = 'flex';
  row.style.gap = '6px';
  row.style.marginTop = '6px';
  row.style.flexWrap = 'wrap';
  if (ex) {
    const isCompound = (ex.muscles.primary.length + (ex.muscles.secondary?.length || 0)) >= 3;
    if (isCompound) row.append(pill('COMPOUND'));
    if (ex.bilateral) row.append(pill('PER ARM', 'filled'));
  }
  const last = lastSetSummary(entry.exerciseId);
  if (last) row.append(pill('LAST · ' + last.toUpperCase(), 'soft'));
  return row;
}


/* ── Sets table ──────────────────────────────────────────────────── */

function setsTable(session, entry) {
  const wrap = el('div', 'sets-table section-mt');
  wrap.style.marginTop = '12px';

  const head = el('div', 'sets-head');
  head.append(el('span', null, 'SET'));
  head.append(el('span', null, 'KG'));
  head.append(el('span', null, 'REPS'));
  head.append(el('span', null, ''));
  wrap.append(head);

  // Logged sets — warmups first, then working
  const prMarks = sessionPRMarks(session)[currentEntryIdx] || [];
  let workingNum = 0;
  entry.sets.forEach((set, i) => {
    const isWarmup = set.isWarmup;
    if (!isWarmup) workingNum++;
    const row = el('div', 'sets-row' + (isWarmup ? ' warmup' : ''));
    row.append(el('span', 'num', isWarmup ? 'W' + warmupIndex(entry, i) : String(workingNum)));
    row.append(el('span', null, formatNumber(set.weight) + (set.perSide ? ' ×2' : '')));
    row.append(el('span', null, String(set.reps)));
    const tail = el('span', 'check');
    tail.textContent = prMarks[i] ? '★' : '✓';
    if (prMarks[i]) tail.style.color = 'var(--accent)';
    row.append(tail);
    row.addEventListener('click', () => openSetEditor(currentEntryIdx, i));
    wrap.append(row);
  });

  // Once all planned working sets are logged, hide the command card and
  // the upcoming-rows preview. Each tap of ADD SET bumps the effective
  // plan up by one, which both un-hides the card and grows this preview.
  const workingDone = entry.sets.filter((s) => !s.isWarmup).length;
  const plannedDone = workingDone >= effectivePlannedCount(entry.exerciseId);
  const showCard = !plannedDone;

  if (showCard) {
    wrap.append(commandCard(entry));

    // Upcoming planned-but-not-yet-logged working sets, wrapped in their
    // own container so refreshCard() can rebuild just this subtree when
    // the draft changes (the count and per-row text depend on draft state).
    const upcoming = el('div');
    upcomingRowsContainer = upcoming;
    buildUpcomingRows(upcoming, entry);
    wrap.append(upcoming);
  } else {
    cmdCardHeaderEl = null;
    cmdCardWeightInput = null;
    cmdCardRepsInput = null;
    cmdCardWarmupPill = null;
    cmdCardPerSidePill = null;
    upcomingRowsContainer = null;
  }

  return wrap;
}

function buildUpcomingRows(container, entry) {
  // The command card already occupies one slot (warmup or working); show
  // the remainder beneath it. Each upcoming row previews its own slot's
  // default — warmups follow the ramp, working rows mirror the working
  // baseline (or the just-nudged draft once we're past the warmups).
  const ex = getExercise(entry.exerciseId);
  const plannedWarmups = ex?.defaultWarmupSets ?? 0;
  const loggedWarmups = entry.sets.filter((s) => s.isWarmup).length;
  const plannedWorking = effectivePlannedCount(entry.exerciseId);
  const workingDone = entry.sets.filter((s) => !s.isWarmup).length;
  const bar = ex?.equipmentWeight ?? 0;
  const workingRef = lastWorkingSet(entry.exerciseId);

  // Upcoming warmups — only previewed while the card itself is on a warmup.
  // Toggling WARMUP off means the user is skipping the remaining warmups,
  // so we don't show ghost rows for sets they won't log.
  const remainingWarmups = draftIsWarmup
    ? Math.max(0, plannedWarmups - loggedWarmups - 1)
    : 0;
  if (remainingWarmups > 0) {
    const ramp = warmupRamp(plannedWarmups, bar > 0);
    const W = workingRef?.weight ?? 0;
    for (let i = 0; i < remainingWarmups; i++) {
      const idx = Math.min(loggedWarmups + 1 + i, ramp.length - 1);
      const step = ramp[idx];
      const w = Math.max(bar, roundToStep(step.rel * W, 2.5));
      const wNum = loggedWarmups + 2 + i;
      container.append(upcomingRow('W' + wNum, w, step.reps));
    }
  }

  const upcomingWorking = Math.max(0, plannedWorking - workingDone - (draftIsWarmup ? 0 : 1));
  // While on a warmup, working previews mirror the historical baseline
  // (not the warmup weight). Once on a working set, mirror the draft
  // so the user's nudges propagate down the table.
  const previewWeight = draftIsWarmup ? (workingRef?.weight ?? 0) : draftWeight;
  const previewReps   = draftIsWarmup ? (workingRef?.reps   ?? 8) : draftReps;
  for (let i = 0; i < upcomingWorking; i++) {
    const setNum = workingDone + (draftIsWarmup ? 1 : 2) + i;
    container.append(upcomingRow(String(setNum), previewWeight, previewReps));
  }
}

function upcomingRow(numLabel, weight, reps) {
  const row = el('div', 'sets-row upcoming');
  row.append(el('span', 'num', numLabel));
  row.append(el('span', null, formatNumber(weight) + (draftPerSide ? ' ×2' : '')));
  row.append(el('span', null, String(reps)));
  row.append(el('span', 'check', '○'));
  return row;
}

function plannedWorkingSetCount(exerciseId) {
  const db = getDb();
  const activeId = db.activeSessionId;
  const past = db.sessions.filter((s) => s.id !== activeId);
  for (const s of past.sort((a, b) => b.startedAt - a.startedAt)) {
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId) continue;
      const cnt = e.sets.filter((set) => !set.isWarmup).length;
      if (cnt > 0) return cnt;
    }
  }
  return DEFAULT_WORKING_SETS;
}

// Effective plan = historical baseline + any ADD SET bumps this session.
function effectivePlannedCount(exerciseId) {
  return plannedWorkingSetCount(exerciseId) + extraPlannedSets;
}

function warmupIndex(entry, atIndex) {
  let n = 0;
  for (let i = 0; i <= atIndex; i++) if (entry.sets[i].isWarmup) n++;
  return n;
}

function formatNumber(v) {
  if (v == null) return '—';
  return v % 1 === 0 ? String(v) : v.toFixed(1);
}


/* ── Warmup ramp + per-slot default draft ────────────────────────────
   Ramp tables follow the table from the README discussion: barbell lifts
   start at the empty bar with descending reps as the load climbs; dumbbell
   and machine ramps use pure percentages since there's no bar to anchor
   the first set. Reps drop with load to keep warmups as prep, not work. */

function warmupRamp(totalWarmups, hasBar) {
  if (totalWarmups <= 0) return [];
  if (totalWarmups === 1) return [{ rel: 0.6, reps: 8 }];
  const barTable = {
    2: [[0, 5], [0.65, 5]],
    3: [[0, 5], [0.5, 5], [0.75, 3]],
    4: [[0, 5], [0.4, 5], [0.65, 3], [0.85, 2]],
  };
  const pctTable = {
    2: [[0.5, 8], [0.75, 5]],
    3: [[0.4, 8], [0.6, 5], [0.8, 3]],
    4: [[0.4, 8], [0.55, 5], [0.7, 3], [0.85, 2]],
  };
  const table = hasBar ? barTable : pctTable;
  const arr = table[totalWarmups] ?? table[4];
  return arr.map(([rel, reps]) => ({ rel, reps }));
}

function roundToStep(v, step) {
  return Math.round(v / step) * step;
}

/* Default draft for the NEXT slot of an entry. Warmup until either the
   planned warmup count is logged or any working set is logged (so toggling
   WARMUP back on mid-session and logging an extra warmup doesn't loop us
   back into "warmup mode" — the user opted out, we trust it). */
function defaultDraftForNextSlot(entry, ex) {
  const totalWarmups = ex?.defaultWarmupSets ?? 0;
  const loggedWarmups = entry.sets.filter((s) => s.isWarmup).length;
  const workingLogged = entry.sets.filter((s) => !s.isWarmup).length;
  const nextIsWarmup = workingLogged === 0 && loggedWarmups < totalWarmups;
  const bar = ex?.equipmentWeight ?? 0;

  if (nextIsWarmup) {
    const ramp = warmupRamp(totalWarmups, bar > 0);
    const step = ramp[Math.min(loggedWarmups, ramp.length - 1)];
    const workingRef = lastWorkingSet(entry.exerciseId);
    const W = workingRef?.weight ?? 0;
    const weight = Math.max(bar, roundToStep(step.rel * W, 2.5));
    return { weight, reps: step.reps, isWarmup: true, perSide: !!ex?.bilateral };
  }

  const lastInEntry = [...entry.sets].reverse().find((s) => !s.isWarmup);
  const ref = lastInEntry ?? lastWorkingSet(entry.exerciseId);
  return {
    weight: ref?.weight ?? 0,
    reps: ref?.reps ?? 8,
    isWarmup: false,
    perSide: !!(ref?.perSide ?? ex?.bilateral),
  };
}


/* ── Command card (next set steppers) ────────────────────────────── */

function commandCard(entry) {
  const ex = getExercise(entry.exerciseId);
  const workingCount = entry.sets.filter((s) => !s.isWarmup).length;
  const loggedWarmups = entry.sets.filter((s) => s.isWarmup).length;
  const setNum = workingCount + 1;
  const warmupNum = loggedWarmups + 1;

  // Initialise draft if needed.
  if (draftWeight === null || draftReps === null) {
    const d = defaultDraftForNextSlot(entry, ex);
    draftWeight = d.weight;
    draftReps = d.reps;
    draftIsWarmup = d.isWarmup;
    draftPerSide = d.perSide;
  }

  const card = el('div', 'command-card');

  const head = el('div', 'command-card-head');
  cmdCardHeaderEl = html('span', null,
    draftIsWarmup ? `▶ WARMUP ${warmupNum} · NOW` : `▶ SET ${setNum} · NOW`);
  head.append(cmdCardHeaderEl);
  card.append(head);

  const steppers = el('div', 'command-card-steppers');
  const weightStepper = stepperBlock('KG', draftWeight,
    (delta) => { draftWeight = Math.max(0, +(draftWeight + delta).toFixed(2)); refreshCard(); },
    (raw) => { const v = parseFloat(raw); draftWeight = isFinite(v) ? Math.max(0, v) : 0; },
    2.5);
  cmdCardWeightInput = weightStepper.querySelector('input');
  steppers.append(weightStepper);

  const repsStepper = stepperBlock('REPS', draftReps,
    (delta) => { draftReps = Math.max(0, draftReps + delta); refreshCard(); },
    (raw) => { const v = parseInt(raw, 10); draftReps = isFinite(v) ? Math.max(0, v) : 0; },
    1);
  cmdCardRepsInput = repsStepper.querySelector('input');
  steppers.append(repsStepper);
  card.append(steppers);

  // Warmup + per-side toggles (mini)
  const toggles = el('div');
  toggles.style.display = 'flex';
  toggles.style.gap = '6px';
  toggles.style.flexWrap = 'wrap';
  toggles.style.marginTop = '2px';
  cmdCardWarmupPill = togglePill('WARMUP', draftIsWarmup, () => {
    draftIsWarmup = !draftIsWarmup;
    refreshCard();
  });
  toggles.append(cmdCardWarmupPill);
  cmdCardPerSidePill = null;
  if (ex?.bilateral || draftPerSide) {
    cmdCardPerSidePill = togglePill('PER SIDE', draftPerSide, () => {
      draftPerSide = !draftPerSide;
      refreshCard();
    });
    toggles.append(cmdCardPerSidePill);
  }
  card.append(toggles);

  return card;
}

function stepperBlock(label, value, onStep, onType, step) {
  const wrap = el('div', 'command-card-stepper');
  wrap.append(el('span', 'command-card-stepper-label', label));
  const row = el('div', 'command-card-stepper-row');
  const minus = el('button', 'btn-step inverse');
  minus.textContent = '−';
  minus.setAttribute('aria-label', 'decrease ' + label);
  minus.addEventListener('click', () => onStep(-step));
  row.append(minus);
  const input = document.createElement('input');
  input.className = 'command-card-stepper-value';
  input.type = 'number';
  input.inputMode = step === 1 ? 'numeric' : 'decimal';
  input.step = String(step);
  input.value = formatNumber(value);
  input.addEventListener('focus', () => input.select());
  input.addEventListener('input', () => onType(input.value));
  row.append(input);
  const plus = el('button', 'btn-step inverse');
  plus.textContent = '+';
  plus.setAttribute('aria-label', 'increase ' + label);
  plus.addEventListener('click', () => onStep(step));
  row.append(plus);
  wrap.append(row);
  return wrap;
}

function togglePill(label, on, onToggle) {
  const c = el('button', 'pill toggle');
  c.type = 'button';
  c.textContent = label;
  c.style.borderColor = 'rgba(255,255,255,0.30)';
  c.style.color = 'var(--bg)';
  applyToggleState(c, on);
  // onToggle is responsible for flipping the underlying state and calling
  // refreshCard — the click handler doesn't capture `on`, so the pill
  // can be re-skinned in place by refreshCard without needing rebuild.
  c.addEventListener('click', () => onToggle());
  return c;
}

function applyToggleState(c, on) {
  c.classList.toggle('on', on);
  c.style.opacity = on ? '1' : '0.6';
  c.style.background = on ? 'rgba(232,240,230,0.85)' : 'transparent';
}

/* Localised update for a draft change (stepper +/-, warmup/per-side
   toggle). Patches only the parts of the screen that depend on draft
   state — the card header, stepper input values, toggle pill skins, the
   upcoming-rows preview, and the primary action — leaving the topbar,
   rest banner, exercise header, pills row, and logged-set rows untouched. */
function refreshCard() {
  if (!cmdCardHeaderEl) return;
  const session = getActiveSession();
  if (!session) return;
  const entry = session.entries[currentEntryIdx];
  if (!entry) return;

  const workingCount = entry.sets.filter((s) => !s.isWarmup).length;
  const loggedWarmups = entry.sets.filter((s) => s.isWarmup).length;
  const setNum = workingCount + 1;
  const warmupNum = loggedWarmups + 1;
  cmdCardHeaderEl.textContent = draftIsWarmup ? `▶ WARMUP ${warmupNum} · NOW` : `▶ SET ${setNum} · NOW`;

  // Don't clobber an in-progress edit if the user is typing into a stepper.
  if (cmdCardWeightInput && document.activeElement !== cmdCardWeightInput) {
    cmdCardWeightInput.value = formatNumber(draftWeight);
  }
  if (cmdCardRepsInput && document.activeElement !== cmdCardRepsInput) {
    cmdCardRepsInput.value = formatNumber(draftReps);
  }

  if (cmdCardWarmupPill) applyToggleState(cmdCardWarmupPill, draftIsWarmup);
  if (cmdCardPerSidePill) applyToggleState(cmdCardPerSidePill, draftPerSide);

  if (upcomingRowsContainer) {
    upcomingRowsContainer.replaceChildren();
    buildUpcomingRows(upcomingRowsContainer, entry);
  }

  if (primaryActionContainer) {
    primaryActionContainer.replaceChildren();
    buildPrimaryActionInto(primaryActionContainer, session, entry);
  }
}

/* Full re-render fallback for structural changes that refreshCard can't
   handle in place — entry navigation, adding/removing entries, etc.
   Storage mutations already trigger this via the subscribe path; this
   helper is for click handlers that change UI state without mutating. */
function rerenderFull() {
  const screen = document.getElementById('screen');
  if (screen) renderSession(screen);
}


/* ── Primary action (LOG SET / NEXT EXERCISE / FINISH) ──────────── */

function primaryAction(session, entry) {
  const wrap = el('div', 'section-mt');
  wrap.style.marginTop = '10px';
  primaryActionContainer = wrap;
  buildPrimaryActionInto(wrap, session, entry);
  return wrap;
}

function buildPrimaryActionInto(wrap, session, entry) {
  const total = session.entries.length;
  const isLast = currentEntryIdx === total - 1;
  const workingDone = entry.sets.filter((s) => !s.isWarmup).length;
  const plannedDone = !draftIsWarmup && workingDone >= effectivePlannedCount(entry.exerciseId);

  // Once all planned working sets are logged, swap LOG SET for the
  // primary advance action (NEXT EXERCISE, or REVIEW WORKOUT on the
  // last one). The ADD SET affordance lives in its own slot above us.
  if (plannedDone) {
    const advance = el('button', 'btn-primary');
    advance.style.justifyContent = 'space-between';
    if (isLast) {
      advance.innerHTML = '<span>REVIEW WORKOUT</span><span>→</span>';
      advance.addEventListener('click', () => go('workout'));
    } else {
      advance.innerHTML = '<span>NEXT EXERCISE</span><span>→</span>';
      advance.addEventListener('click', () => {
        currentEntryIdx++;
        resetDraft();
        rerenderFull();
      });
    }
    wrap.append(advance);
    return;
  }

  // Mid-rest: swap LOG SET for a white SKIP REST button with the live
  // countdown. Prevents tap-logging a working set before the rest is
  // over, and frees the vertical space the old top banner used. The
  // tick driver updates `#rest-count` in place; reaching 0 auto-clears
  // rest, which re-renders this button as the green LOG SET below.
  const rest = getRestState();
  if (rest && rest.remainingSec > 0) {
    const skip = el('button', 'btn-primary');
    skip.style.justifyContent = 'space-between';
    skip.style.background = 'var(--ink)';
    skip.style.color = 'var(--bg)';
    skip.innerHTML = `<span>SKIP REST</span><span class="tnum" id="rest-count" style="font-weight:800; letter-spacing:-0.02em;">${formatDuration(rest.remainingSec)}</span>`;
    skip.addEventListener('click', () => { clearRest(); setKeepScreenAwake(false); });
    wrap.append(skip);
    return;
  }

  const btn = el('button', 'btn-primary');
  btn.style.justifyContent = 'space-between';
  btn.innerHTML = `<span>LOG SET</span><span style="font-weight:700; opacity:0.5;">${draftIsWarmup ? 'W' : '↵'}</span>`;
  btn.addEventListener('click', () => {
    if (draftReps <= 0) { alert('Reps must be > 0'); return; }
    const ex = getExercise(entry.exerciseId);
    const newSet = {
      weight: draftWeight,
      reps: draftReps,
      isWarmup: draftIsWarmup,
      perSide: draftPerSide,
    };

    // Compute the draft for the slot AFTER this one BEFORE addSet so the
    // post-mutate re-render reads the new state. The slot may shift type:
    // warmup → next warmup (ramp), last warmup → first working set, or
    // working → working (mirrors the just-logged values).
    const postEntry = { ...entry, sets: [...entry.sets, newSet] };
    const next = defaultDraftForNextSlot(postEntry, ex);
    draftWeight = next.weight;
    draftReps = next.reps;
    draftIsWarmup = next.isWarmup;
    draftPerSide = next.perSide;

    addSet(currentEntryIdx, newSet);

    if (!newSet.isWarmup) {
      const dur = ex?.defaultRest ?? getDb().settings.defaultRest;
      startRest(entry.exerciseId, dur);
      setKeepScreenAwake(true);
      ensureNotificationPermission();
    }
  });
  wrap.append(btn);
}

function addSetButton() {
  const btn = el('button', 'btn-add');
  btn.style.marginTop = '10px';
  btn.textContent = '+ ADD SET';
  btn.addEventListener('click', () => {
    // Bump the effective plan by one — grows the upcoming-rows preview
    // during the planned flow, and un-hides the card past plannedDone.
    extraPlannedSets++;
    rerenderFull();
  });
  return btn;
}

function addExerciseBtn() {
  const btn = el('button', 'btn-add section-mt');
  btn.style.marginTop = '14px';
  btn.textContent = '+ ADD EXERCISE';
  btn.addEventListener('click', () => openExercisePicker((exId) => {
    // addEntry's mutate triggers a renderSession via subscribe, but using
    // the OLD currentEntryIdx — we need a second render to jump to the new
    // entry after we update the index below.
    addEntry(exId);
    const session = getActiveSession();
    if (session) currentEntryIdx = session.entries.length - 1;
    resetDraft();
    rerenderFull();
  }));
  return btn;
}

/* ── Empty state ─────────────────────────────────────────────────── */

function emptyState() {
  const empty = el('div', 'lib-empty');
  empty.innerHTML = `EMPTY SESSION<br><span class="muted" style="font-size: var(--t-xs);">Add your first exercise to begin.</span>`;
  return empty;
}


/* ── Exercise picker sheet ───────────────────────────────────────── */

export function openExercisePicker(onPick) {
  openSheet((close) => {
    // Skeleton + per-row markup live in #tpl-exercise-picker /
    // #tpl-exercise-row in index.html; clone and populate here.
    const root = document.getElementById('tpl-exercise-picker')
      .content.firstElementChild.cloneNode(true);
    const search = root.querySelector('.exercise-picker-search');
    const list = root.querySelector('.exercise-picker-list');
    const rowTpl = document.getElementById('tpl-exercise-row');

    const all = listExercises();
    function refresh() {
      const q = search.value.trim().toLowerCase();
      const filtered = q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;
      list.replaceChildren();
      filtered.forEach((ex, i) => {
        const row = rowTpl.content.firstElementChild.cloneNode(true);
        row.querySelector('.num').textContent = `${String(i + 1).padStart(2, '0')} ·`;
        row.querySelector('.exercise-name').textContent = ex.name;
        const tags = row.querySelector('.lib-row-tags');
        const primary = ex.muscles.primary[0];
        if (primary) tags.append(pill(primary.toUpperCase().replace(/-/g, ' '), 'default'));
        if (ex.bilateral) tags.append(pill('PER ARM', 'soft'));
        row.addEventListener('click', () => { close(); onPick(ex.id); });
        list.append(row);
      });
      if (filtered.length === 0) list.append(html('div', 'lib-empty', 'NO MATCHES'));
    }
    search.addEventListener('input', refresh);
    refresh();
    setTimeout(() => search.focus(), 0);
    return root;
  });
}


/* ════════════════════════════════════════════════════════════════════
   Timed / isometric branch — used when entry.exerciseId is a timed
   exercise (plank etc.). Replaces the reps command card with:
     • a 220px countdown ring (live ticking)
     • a sets table with TARGET / ACTUAL columns
     • TARGET HOLD / REST BETWEEN config rows with 48×48 steppers
     • a single primary action that changes shape with the phase:
         READY → ▶ START SET
         WORK  → ❚❚ PAUSE HOLD  · END ✓
         REST  → ▶ SKIP REST
         DONE  → NEXT EXERCISE →
   Timer state lives on session.holdTimer (see sessions.js) so it
   survives PWA backgrounding. Auto-transitions (work → rest on hit,
   rest → next ready on hit) are driven by the rest ticker. */

function timedView(session, entry) {
  const ex = getExercise(entry.exerciseId);
  const hold = getHoldState();
  const holdHere = hold && hold.entryIndex === currentEntryIdx ? hold : null;

  const working = entry.sets.filter((s) => !s.isWarmup);
  const setsDone = working.length;
  const plannedSets = effectivePlannedCount(entry.exerciseId);
  const isDone = setsDone >= plannedSets && !holdHere;

  // Decide the active target seconds for "what's about to / currently happen".
  let activeTargetSec, activeRestSec;
  if (holdHere) {
    activeTargetSec = holdHere.targetSec;
    activeRestSec   = holdHere.restSec;
  } else if (working.length > 0) {
    activeTargetSec = working[working.length - 1].seconds ?? ex.defaultTargetSec ?? 60;
    activeRestSec   = ex.defaultRest ?? 60;
  } else {
    activeTargetSec = ex.defaultTargetSec ?? 60;
    activeRestSec   = ex.defaultRest ?? 60;
  }

  const wrap = el('div', 'section-mt');
  wrap.style.marginTop = '8px';

  // Ring
  wrap.append(timerRing(holdHere, activeTargetSec, isDone));

  // Sets table — compact, TARGET / ACTUAL columns
  wrap.append(timedSetsTable(entry, working, holdHere, activeTargetSec, plannedSets));

  // Config rows: TARGET HOLD + REST BETWEEN (only meaningful when no
  // timer running, but show always so the user knows the values).
  wrap.append(configRows(activeTargetSec, activeRestSec, holdHere));

  // Extend the plan mid-session (matches the non-timed ADD SET affordance).
  wrap.append(addSetButton());

  // Main action(s)
  wrap.append(timedAction(entry, holdHere, isDone, activeTargetSec, activeRestSec));

  return wrap;
}


/* ── Countdown ring ─────────────────────────────────────────────── */

const RING_SIZE = 220;
const RING_R = 96;
const RING_C = 2 * Math.PI * RING_R;

function timerRing(hold, fallbackTargetSec, isDone) {
  const wrap = el('div');
  wrap.style.display = 'flex';
  wrap.style.justifyContent = 'center';
  wrap.style.alignItems = 'center';
  wrap.style.position = 'relative';
  wrap.style.height = RING_SIZE + 'px';
  wrap.style.margin = '8px 0';

  const phase = isDone ? 'done' : hold?.phase ?? 'ready';
  const totalSec = hold?.totalSec ?? fallbackTargetSec;
  const remainingSec = hold?.remainingSec ?? totalSec;
  const pct = totalSec > 0 ? 1 - remainingSec / totalSec : 0;
  const ringColor =
    phase === 'rest' ? 'var(--ink)' :
    phase === 'done' ? 'var(--ink-soft)' :
    'var(--accent)';

  // Tick marks
  let ticks = '';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const major = i % 5 === 0;
    const r1 = RING_R + 12;
    const r2 = RING_R + (major ? 18 : 15);
    const x1 = (RING_SIZE / 2) + Math.cos(a) * r1;
    const y1 = (RING_SIZE / 2) + Math.sin(a) * r1;
    const x2 = (RING_SIZE / 2) + Math.cos(a) * r2;
    const y2 = (RING_SIZE / 2) + Math.sin(a) * r2;
    ticks += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"
      stroke="${major ? 'var(--ink-soft)' : 'var(--line-soft)'}"
      stroke-width="${major ? 1 : 0.5}" />`;
  }

  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEl.setAttribute('width', String(RING_SIZE));
  svgEl.setAttribute('height', String(RING_SIZE));
  svgEl.setAttribute('viewBox', `0 0 ${RING_SIZE} ${RING_SIZE}`);
  svgEl.innerHTML = `
    ${ticks}
    <circle cx="${RING_SIZE/2}" cy="${RING_SIZE/2}" r="${RING_R}"
      fill="none" stroke="var(--line)" stroke-width="2"/>
    <circle id="ring-progress" cx="${RING_SIZE/2}" cy="${RING_SIZE/2}" r="${RING_R}"
      fill="none" stroke="${ringColor}" stroke-width="3"
      stroke-dasharray="${RING_C}"
      stroke-dashoffset="${RING_C * (1 - pct)}"
      transform="rotate(-90 ${RING_SIZE/2} ${RING_SIZE/2})"
      style="transition: stroke 0.2s;"/>
  `;
  wrap.append(svgEl);

  // Center readout
  const center = el('div');
  center.style.position = 'absolute';
  center.style.inset = '0';
  center.style.display = 'flex';
  center.style.flexDirection = 'column';
  center.style.alignItems = 'center';
  center.style.justifyContent = 'center';
  center.style.gap = '2px';

  const phaseLbl = el('div');
  phaseLbl.id = 'ring-phase';
  phaseLbl.style.fontSize = 'var(--t-xs)';
  phaseLbl.style.letterSpacing = '0.18em';
  phaseLbl.style.fontWeight = '700';
  phaseLbl.style.textTransform = 'uppercase';
  phaseLbl.style.color = ringColor;
  phaseLbl.style.textShadow = (!hold?.paused && phase !== 'done' && phase !== 'ready') ? `0 0 6px ${ringColor}` : 'none';
  phaseLbl.textContent =
    phase === 'work' ? (hold?.paused ? 'HOLD · PAUSED' : 'HOLD') :
    phase === 'rest' ? 'REST' :
    phase === 'done' ? 'COMPLETE' : 'READY';
  center.append(phaseLbl);

  const big = el('div');
  big.id = 'ring-count';
  big.style.fontSize = 'var(--t-2xl)';
  big.style.fontWeight = '800';
  big.style.letterSpacing = '-0.05em';
  big.style.fontVariantNumeric = 'tabular-nums';
  big.style.lineHeight = '1';
  big.style.color = 'var(--ink)';
  big.textContent = formatHold(remainingSec);
  center.append(big);

  const sub = el('div');
  sub.id = 'ring-sub';
  sub.style.fontSize = 'var(--t-xs)';
  sub.style.color = 'var(--ink-soft)';
  sub.style.letterSpacing = '0.1em';
  sub.style.textTransform = 'uppercase';
  sub.textContent =
    phase === 'work' ? `OF ${formatHold(totalSec)} TARGET` :
    phase === 'rest' ? `OF ${formatHold(totalSec)} REST` :
    phase === 'done' ? 'ALL SETS LOGGED' : `TARGET · ${formatHold(totalSec)}`;
  center.append(sub);

  wrap.append(center);
  return wrap;
}

function formatHold(sec) {
  // Ceil so we show "00:01" through the entire final second and "00:00"
  // only when truly elapsed — standard stopwatch behaviour.
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}


/* ── Timed sets table ───────────────────────────────────────────── */

function timedSetsTable(entry, working, hold, activeTargetSec, plannedSets) {
  const wrap = el('div', 'sets-table');
  wrap.style.marginTop = '6px';

  const head = el('div', 'sets-head');
  head.append(el('span', null, 'SET'));
  head.append(el('span', null, 'TARGET'));
  head.append(el('span', null, 'ACTUAL'));
  head.append(el('span', null, ''));
  wrap.append(head);

  const totalRows = Math.max(plannedSets, working.length + (hold ? 1 : 0));
  for (let i = 0; i < totalRows; i++) {
    const done = working[i];
    const isCurrent = !done && hold && i === working.length;
    const row = el('div', 'sets-row' + (isCurrent ? '' : done ? '' : ' upcoming'));
    if (isCurrent) {
      row.style.background = 'var(--ink)';
      row.style.color = 'var(--bg)';
    }
    const num = el('span', 'num');
    num.textContent = (isCurrent ? '▶ ' : '') + String(i + 1);
    row.append(num);
    const target = el('span', null);
    target.textContent = (done?.targetSeconds ?? activeTargetSec) + 's';
    row.append(target);
    const actual = el('span', null);
    if (done) {
      actual.textContent = done.seconds + 's';
    } else if (isCurrent) {
      const live = hold.phase === 'work' ? (hold.totalSec - hold.remainingSec) : hold.totalSec;
      actual.textContent = Math.max(0, Math.round(live)) + 's';
    } else {
      actual.textContent = '—';
    }
    row.append(actual);
    const mark = el('span', 'check');
    mark.textContent = done ? '✓' : isCurrent ? '·' : '○';
    row.append(mark);
    wrap.append(row);
  }
  return wrap;
}


/* ── Config rows (TARGET HOLD, REST BETWEEN) ────────────────────── */

function configRows(targetSec, restSec, hold) {
  const wrap = el('div', 'sets-table config-rows');

  wrap.append(configRow('TARGET HOLD', targetSec, (delta) => {
    // If no active timer, just nudge the default for the next start.
    if (hold) {
      adjustHoldTarget(delta);
    } else {
      // Persist into the exercise's defaultTargetSec for this entry's session.
      // Easiest: stash on the active session as a per-entry override.
      stashTimedOverride('targetSec', Math.max(10, Math.min(600, targetSec + delta)));
    }
  }));
  wrap.append(configRow('REST BETWEEN', restSec, (delta) => {
    if (hold) adjustHoldRest(delta);
    else stashTimedOverride('restSec', Math.max(15, Math.min(600, restSec + delta)));
  }));
  return wrap;
}

function configRow(label, value, onStep) {
  // Markup lives in #tpl-config-row in index.html; clone + wire here.
  const row = document.getElementById('tpl-config-row')
    .content.firstElementChild.cloneNode(true);
  row.querySelector('.config-row-label').textContent = label;
  row.querySelector('.config-row-value').textContent = value + 's';

  const minus = row.querySelector('[data-act="minus"]');
  const plus = row.querySelector('[data-act="plus"]');
  minus.setAttribute('aria-label', 'decrease ' + label);
  plus.setAttribute('aria-label', 'increase ' + label);
  minus.addEventListener('click', () => onStep(-15));
  plus.addEventListener('click', () => onStep(15));
  return row;
}

// Per-session, per-entry overrides for the timed defaults — live only
// for the duration of the active session (resets on next start).
const timedDraft = { targetSec: null, restSec: null, entryIndex: null };
function stashTimedOverride(field, value) {
  if (timedDraft.entryIndex !== currentEntryIdx) {
    timedDraft.entryIndex = currentEntryIdx;
    timedDraft.targetSec = null;
    timedDraft.restSec = null;
  }
  timedDraft[field] = value;
  // Trigger a re-render so the stepper value reflects the new state.
  const screen = document.getElementById('screen');
  if (screen) renderSession(screen);
}


/* ── Timed primary action ───────────────────────────────────────── */

function timedAction(entry, hold, isDone, targetSec, restSec) {
  const wrap = el('div', 'section-mt');
  wrap.style.marginTop = '10px';
  wrap.style.display = 'flex';
  wrap.style.gap = '6px';

  if (isDone) {
    const session = getActiveSession();
    const isLast = session && currentEntryIdx >= session.entries.length - 1;
    const next = el('button', 'btn-primary');
    if (isLast) {
      next.innerHTML = '<span>REVIEW WORKOUT</span><span>→</span>';
      next.addEventListener('click', () => go('workout'));
    } else {
      next.innerHTML = '<span>NEXT EXERCISE</span><span>→</span>';
      next.addEventListener('click', () => {
        currentEntryIdx++;
        resetDraft();
        timedDraft.entryIndex = null;
        rerenderFull();
      });
    }
    wrap.append(next);
    return wrap;
  }

  if (!hold) {
    // READY — start work
    const start = el('button', 'btn-primary');
    start.innerHTML = '<span>▶ START SET</span><span>' + targetSec + 's</span>';
    start.addEventListener('click', () => {
      // Use draft override if set, else the active target.
      const t = (timedDraft.entryIndex === currentEntryIdx && timedDraft.targetSec != null) ? timedDraft.targetSec : targetSec;
      const r = (timedDraft.entryIndex === currentEntryIdx && timedDraft.restSec != null) ? timedDraft.restSec : restSec;
      startHold(currentEntryIdx, t, r);
    });
    wrap.append(start);
    return wrap;
  }

  if (hold.phase === 'work') {
    const main = el('button', 'btn-primary');
    if (hold.paused) {
      main.innerHTML = `<span>▶ RESUME</span><span>${formatHold(hold.remainingSec)}</span>`;
      main.addEventListener('click', () => resumeHold());
    } else {
      main.innerHTML = `<span>❚❚ PAUSE HOLD</span><span>${formatHold(hold.remainingSec)}</span>`;
      main.addEventListener('click', () => pauseHold());
    }
    main.style.flex = '1';
    wrap.append(main);

    const endBtn = el('button', 'btn-secondary');
    endBtn.textContent = 'END ✓';
    endBtn.addEventListener('click', () => finishCurrentWorkHold(entry));
    wrap.append(endBtn);
    return wrap;
  }

  // REST phase
  const skip = el('button', 'btn-primary');
  skip.style.background = 'var(--ink)';
  skip.style.color = 'var(--bg)';
  skip.innerHTML = `<span>▶ SKIP REST</span><span>${formatHold(hold.remainingSec)}</span>`;
  skip.addEventListener('click', () => endHoldRest());
  wrap.append(skip);
  return wrap;
}


/* ── End the current work hold (early or on timer hitting zero) ── */

function finishCurrentWorkHold(entry) {
  // Snapshot timer state before mutate so we can log with the right value.
  const hold = getHoldState();
  if (!hold || hold.phase !== 'work') return;
  const actual = endHoldWork(); // transitions to 'rest', returns actual seconds
  addSet(currentEntryIdx, {
    weight: 0,
    reps: 0,
    seconds: actual,
    targetSeconds: hold.totalSec,
    isWarmup: false,
    perSide: !!getExercise(entry.exerciseId)?.bilateral,
  });
}


/* ── Edit logged set sheet (rare path) ───────────────────────────── */

function openSetEditor(entryIndex, setIndex) {
  const session = getActiveSession();
  if (!session) return;
  const entry = session.entries[entryIndex];
  const set = entry?.sets[setIndex];
  if (!set) return;
  openSheet((close) => {
    // Markup lives in the #tpl-set-editor <template> in index.html; we
    // clone it and populate the dynamic bits here. Values are read back
    // on save via [name] selectors rather than tracked per-keystroke.
    const root = document.getElementById('tpl-set-editor')
      .content.firstElementChild.cloneNode(true);
    const field = (name) => root.querySelector(`[name="${name}"]`);

    root.querySelector('.set-editor-sub').textContent =
      exerciseLabel(entry.exerciseId).toUpperCase();
    field('weight').value = set.weight;
    field('reps').value = set.reps;
    field('isWarmup').checked = set.isWarmup;
    field('perSide').checked = set.perSide;

    root.querySelectorAll('input[type="number"]').forEach((inp) =>
      inp.addEventListener('focus', () => inp.select()));

    root.querySelector('[data-act="delete"]').addEventListener('click', () => {
      close();
      deleteSet(entryIndex, setIndex);
    });
    root.querySelector('[data-act="save"]').addEventListener('click', () => {
      const num = (name) => { const v = parseFloat(field(name).value); return isFinite(v) ? v : 0; };
      close();
      updateSet(entryIndex, setIndex, {
        ...set,
        weight: num('weight'),
        reps: num('reps'),
        isWarmup: field('isWarmup').checked,
        perSide: field('perSide').checked,
      });
    });
    return root;
  });
}
