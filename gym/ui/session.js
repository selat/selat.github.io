/* ACTIVE SESSION screen — the live workout view.

   Layout (top to bottom):
     • Topbar: split tag (tap → workout overview) · elapsed timer
     • Banner: REST timer (mid-set) OR DONE summary (just logged)
     • Exercise header: name + idx · prev/next
     • Pill row: equipment hint + LAST summary
     • Sets table: warmups, logged working sets, and one command card
       (steppers for weight/reps) for the next set
     • LOG SET primary action
     • (Active workout list reached by tapping the split name) — see workout.js

   Command-card pattern is the design's "sweaty-thumb" anchor: large
   tabular numerals with 48×48 stepper buttons. Editing a previously
   logged set still opens a sheet (rare path; keep the table tidy).

   Defaults for new set: copy the last set in this entry, or fall back to
   the most recent working set from history, or all-zeros. Pre-fills
   weight/reps so users only need to nudge between sets. */

import { getActiveSession, startSession, endActiveSession, abandonActiveSession,
         addEntry, removeEntry, addSet, updateSet, deleteSet,
         startRest, clearRest, getRestState, exerciseLabel,
         startHold, pauseHold, resumeHold, endHoldWork, endHoldRest, clearHold,
         adjustHoldTarget, adjustHoldRest, getHoldState } from '../data/sessions.js';
import { listExercises, getExercise } from '../data/exercises.js';
import { getDb } from '../data/storage.js';
import { lastWorkingSet, lastSetSummary, sessionPRMarks, sessionSplitTag } from '../data/derived.js';
import { openSheet, go } from '../app.js';
import { el, html, pill, formatDuration, formatDurationPad, playChime } from './shared.js';

const DEFAULT_WORKING_SETS = 3;

// Persistent UI state (survives storage-driven re-renders within a session).
let currentEntryIdx = 0;       // which exercise we're viewing
let draftWeight = null;        // command card weight (kg)
let draftReps = null;          // command card reps
let draftIsWarmup = false;
let draftPerSide = false;
let restInterval = null;
let lastRestRemaining = null;


export function startSessionFlow(exerciseIds = []) {
  startSession(exerciseIds);
  currentEntryIdx = 0;
  resetDraft();
  go('record');
}

function resetDraft() {
  draftWeight = null;
  draftReps = null;
  draftIsWarmup = false;
  draftPerSide = false;
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

  // Top banner — REST timer or DONE summary
  const rest = getRestState();
  if (rest) container.append(restBanner(rest));

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
    body.append(primaryAction(session, entry));
  }

  // Add-exercise affordance
  body.append(addExerciseBtn());

  // Footer: abandon / finish
  body.append(footerActions(session));

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


/* ── REST / DONE banner ──────────────────────────────────────────── */

function restBanner(rest) {
  const done = rest.remainingSec <= 0;
  const bar = el('div', 'session-top ' + (done ? 'done' : 'rest'));
  bar.id = 'rest-banner';
  bar.append(html('span', 'session-top-label', done ? 'READY' : 'REST'));
  const v = el('span', 'session-top-value tnum');
  v.id = 'rest-count';
  v.textContent = done ? '✓' : formatDuration(rest.remainingSec);
  bar.append(v);
  const skip = el('button', 'session-top-aside');
  skip.textContent = done ? 'DISMISS ×' : 'SKIP ▶';
  skip.addEventListener('click', () => clearRest());
  bar.append(skip);
  return bar;
}

function startRestTicker() {
  if (restInterval) clearInterval(restInterval);
  restInterval = setInterval(() => {
    // Tick the rest banner if one is mounted.
    tickRestBanner();
    // Tick the hold timer text + auto-transitions if one is mounted.
    tickHoldTextAndTransitions();
    // Stop the ticker if nothing on screen needs it AND no underlying state.
    const hasBanner = !!document.getElementById('rest-banner');
    const hasRing   = !!document.getElementById('ring-count');
    if (!hasBanner && !hasRing && !getRestState() && !getHoldState()) {
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

function tickRestBanner() {
  const banner = document.getElementById('rest-banner');
  if (!banner) return;
  const rest = getRestState();
  if (!rest) return;
  const count = document.getElementById('rest-count');
  if (!count) return;
  if (rest.remainingSec > 0) {
    count.textContent = formatDuration(rest.remainingSec);
    lastRestRemaining = rest.remainingSec;
  } else {
    if (lastRestRemaining !== 0) {
      playChime();
      banner.classList.remove('rest');
      banner.classList.add('done');
      count.textContent = '✓';
      const aside = banner.querySelector('.session-top-aside');
      if (aside) aside.textContent = 'DISMISS ×';
      const label = banner.querySelector('.session-top-label');
      if (label) label.textContent = 'READY';
      lastRestRemaining = 0;
    }
  }
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
    });
    const next = navBtn('›', () => {
      currentEntryIdx = (currentEntryIdx + 1) % total;
      resetDraft();
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

  // Command card for next set
  wrap.append(commandCard(entry));
  return wrap;
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


/* ── Command card (next set steppers) ────────────────────────────── */

function commandCard(entry) {
  const ex = getExercise(entry.exerciseId);
  const workingCount = entry.sets.filter((s) => !s.isWarmup).length;
  const setNum = workingCount + 1;

  // Initialise draft if needed.
  if (draftWeight === null || draftReps === null) {
    const last = entry.sets[entry.sets.length - 1] ?? lastWorkingSet(entry.exerciseId);
    draftWeight = last?.weight ?? 0;
    draftReps   = last?.reps   ?? 8;
    draftIsWarmup = workingCount < 0 ? false : entry.sets.length < (ex?.defaultWarmupSets ?? 0);
    draftPerSide = !!(last?.perSide ?? ex?.bilateral);
  }

  const card = el('div', 'command-card');

  const head = el('div', 'command-card-head');
  head.append(html('span', null,
    draftIsWarmup ? `▶ WARMUP · NOW` : `▶ SET ${setNum} · NOW`));
  const targetLabel = lastSetSummary(entry.exerciseId);
  head.append(html('span', 'target', targetLabel ? `LAST · ${targetLabel.toUpperCase()}` : 'NEW EXERCISE'));
  card.append(head);

  const steppers = el('div', 'command-card-steppers');
  steppers.append(stepperBlock('KG', draftWeight,
    (delta) => { draftWeight = Math.max(0, +(draftWeight + delta).toFixed(2)); refreshCard(); },
    (raw) => { const v = parseFloat(raw); draftWeight = isFinite(v) ? Math.max(0, v) : 0; },
    2.5));
  steppers.append(stepperBlock('REPS', draftReps,
    (delta) => { draftReps = Math.max(0, draftReps + delta); refreshCard(); },
    (raw) => { const v = parseInt(raw, 10); draftReps = isFinite(v) ? Math.max(0, v) : 0; },
    1));
  card.append(steppers);

  // Warmup + per-side toggles (mini)
  const toggles = el('div');
  toggles.style.display = 'flex';
  toggles.style.gap = '6px';
  toggles.style.flexWrap = 'wrap';
  toggles.style.marginTop = '2px';
  toggles.append(togglePill('WARMUP', draftIsWarmup, (v) => { draftIsWarmup = v; refreshCard(); }));
  if (ex?.bilateral || draftPerSide) {
    toggles.append(togglePill('PER SIDE', draftPerSide, (v) => { draftPerSide = v; refreshCard(); }));
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

function togglePill(label, on, onChange) {
  const c = el('button', 'pill toggle' + (on ? ' on' : ''));
  c.type = 'button';
  c.textContent = label;
  c.style.opacity = on ? '1' : '0.6';
  c.style.background = on ? 'rgba(232,240,230,0.85)' : 'transparent';
  c.style.color = on ? 'var(--bg)' : 'var(--bg)';
  c.style.borderColor = 'rgba(255,255,255,0.30)';
  c.addEventListener('click', () => onChange(!on));
  return c;
}

function refreshCard() {
  // Trigger a screen re-render so the table redraws and the input rerenders.
  // We do a local rerender by triggering subscribe via a no-op mutate — but
  // simpler: just re-call renderSession with the current container.
  const screen = document.getElementById('screen');
  if (screen) renderSession(screen);
}


/* ── Primary action (LOG SET / NEXT EXERCISE / FINISH) ──────────── */

function primaryAction(session, entry) {
  const wrap = el('div', 'section-mt');
  wrap.style.marginTop = '10px';

  const total = session.entries.length;
  const isLast = currentEntryIdx === total - 1;

  const btn = el('button', 'btn-primary');
  btn.style.justifyContent = 'space-between';
  btn.innerHTML = `<span>LOG SET</span><span style="font-weight:700; opacity:0.5;">${draftIsWarmup ? 'W' : '↵'}</span>`;
  btn.addEventListener('click', () => {
    if (draftReps <= 0) { alert('Reps must be > 0'); return; }
    const wasWarmup = draftIsWarmup;
    const wasWeight = draftWeight;
    const wasReps = draftReps;
    const wasPerSide = draftPerSide;

    // Update draft state BEFORE addSet so the post-mutate rerender sees
    // the new state. Auto-flip out of warmup once enough warmups logged.
    const ex = getExercise(entry.exerciseId);
    const totalWarmupsAfter = entry.sets.filter((s) => s.isWarmup).length + (wasWarmup ? 1 : 0);
    if (wasWarmup && totalWarmupsAfter >= (ex?.defaultWarmupSets ?? 0)) {
      draftIsWarmup = false;
    }

    addSet(currentEntryIdx, {
      weight: wasWeight,
      reps: wasReps,
      isWarmup: wasWarmup,
      perSide: wasPerSide,
    });

    // Auto rest for working sets.
    if (!wasWarmup) {
      const dur = ex?.defaultRest ?? getDb().settings.defaultRest;
      startRest(entry.exerciseId, dur);
    }
    // After logging a working set, do NOT auto-reset draftWeight/reps —
    // user typically does the same load again. They can nudge between sets.
  });
  wrap.append(btn);

  // Secondary: advance to next exercise (only after at least one working set).
  if (!isLast) {
    const nextBtn = el('button', 'btn-secondary');
    nextBtn.style.width = '100%';
    nextBtn.style.marginTop = '6px';
    nextBtn.textContent = 'NEXT EXERCISE →';
    nextBtn.addEventListener('click', () => {
      currentEntryIdx++;
      resetDraft();
      refreshCard();
    });
    wrap.append(nextBtn);
  }
  return wrap;
}

function addExerciseBtn() {
  const btn = el('button', 'btn-add section-mt');
  btn.style.marginTop = '14px';
  btn.textContent = '+ ADD EXERCISE';
  btn.addEventListener('click', () => openExercisePicker((exId) => {
    addEntry(exId);
    // Jump to the newly added entry.
    const session = getActiveSession();
    if (session) currentEntryIdx = session.entries.length - 1;
    resetDraft();
  }));
  return btn;
}

function footerActions(session) {
  const wrap = el('div', 'section-mt');
  wrap.style.marginTop = '16px';
  wrap.style.display = 'flex';
  wrap.style.gap = '6px';
  const abandon = el('button', 'btn-secondary danger');
  abandon.style.flex = '1';
  abandon.textContent = 'ABANDON';
  abandon.addEventListener('click', () => {
    if (session.entries.some((e) => e.sets.length > 0)) {
      if (!confirm('Abandon this session? Logged sets will be discarded.')) return;
    }
    abandonActiveSession();
    resetDraft();
  });
  wrap.append(abandon);
  const finish = el('button', 'btn-primary');
  finish.style.flex = '2';
  finish.innerHTML = '<span>FINISH WORKOUT</span><span>→</span>';
  finish.addEventListener('click', () => {
    if (!confirm('Finish this workout? You can review it in History.')) return;
    endActiveSession();
    resetDraft();
    go('home');
  });
  wrap.append(finish);
  return wrap;
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
    const root = document.createElement('div');
    root.append(html('h2', 'eyebrow', 'PICK EXERCISE'));
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'input';
    search.placeholder = 'search…';
    search.style.marginTop = '10px';
    root.append(search);

    const list = el('div', 'lib-list section-mt');
    list.style.marginTop = '12px';
    root.append(list);

    const all = listExercises();
    function refresh() {
      const q = search.value.trim().toLowerCase();
      const filtered = q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;
      list.replaceChildren();
      filtered.forEach((ex, i) => {
        const row = el('button', 'lib-row');
        row.type = 'button';
        const head = el('div', 'lib-row-head');
        const name = el('div', 'lib-row-name');
        name.innerHTML = `<span class="num">${String(i + 1).padStart(2, '0')} ·</span> ${ex.name}`;
        head.append(name);
        row.append(head);
        const tags = el('div', 'lib-row-tags');
        const primary = ex.muscles.primary[0];
        if (primary) tags.append(pill(primary.toUpperCase().replace(/-/g, ' '), 'default'));
        if (ex.bilateral) tags.append(pill('PER ARM', 'soft'));
        row.append(tags);
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

const TIMED_TARGET_SETS = 3;

function timedView(session, entry) {
  const ex = getExercise(entry.exerciseId);
  const hold = getHoldState();
  const holdHere = hold && hold.entryIndex === currentEntryIdx ? hold : null;

  const working = entry.sets.filter((s) => !s.isWarmup);
  const setsDone = working.length;
  const totalSets = Math.max(TIMED_TARGET_SETS, setsDone + (holdHere ? 1 : 0));
  const isDone = setsDone >= TIMED_TARGET_SETS && !holdHere;

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
  wrap.append(timedSetsTable(entry, working, holdHere, activeTargetSec));

  // Config rows: TARGET HOLD + REST BETWEEN (only meaningful when no
  // timer running, but show always so the user knows the values).
  wrap.append(configRows(activeTargetSec, activeRestSec, holdHere));

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

function timedSetsTable(entry, working, hold, activeTargetSec) {
  const wrap = el('div', 'sets-table');
  wrap.style.marginTop = '6px';

  const head = el('div', 'sets-head');
  head.append(el('span', null, 'SET'));
  head.append(el('span', null, 'TARGET'));
  head.append(el('span', null, 'ACTUAL'));
  head.append(el('span', null, ''));
  wrap.append(head);

  const totalRows = Math.max(TIMED_TARGET_SETS, working.length + (hold ? 1 : 0));
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
  const wrap = el('div', 'sets-table');
  wrap.style.marginTop = '8px';
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';

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
  const row = el('div');
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.gap = '12px';
  row.style.padding = '10px 12px';
  row.style.borderBottom = '1px solid var(--line-soft)';

  const lbl = el('span', 'eyebrow');
  lbl.style.minWidth = '96px';
  lbl.textContent = label;
  row.append(lbl);

  const stepperRow = el('div');
  stepperRow.style.flex = '1';
  stepperRow.style.display = 'flex';
  stepperRow.style.alignItems = 'center';
  stepperRow.style.gap = '8px';

  const minus = el('button', 'btn-step');
  minus.textContent = '−';
  minus.setAttribute('aria-label', 'decrease ' + label);
  minus.addEventListener('click', () => onStep(-15));
  stepperRow.append(minus);

  const valueEl = el('span', 'tnum');
  valueEl.style.flex = '1';
  valueEl.style.textAlign = 'center';
  valueEl.style.fontSize = 'var(--t-lg)';
  valueEl.style.fontWeight = '700';
  valueEl.style.letterSpacing = '-0.02em';
  valueEl.textContent = value + 's';
  stepperRow.append(valueEl);

  const plus = el('button', 'btn-step');
  plus.textContent = '+';
  plus.setAttribute('aria-label', 'increase ' + label);
  plus.addEventListener('click', () => onStep(15));
  stepperRow.append(plus);

  row.append(stepperRow);
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
    const next = el('button', 'btn-primary');
    next.innerHTML = '<span>NEXT EXERCISE</span><span>→</span>';
    next.addEventListener('click', () => {
      // Same nav behaviour as the reps branch's NEXT EXERCISE.
      const session = getActiveSession();
      if (!session) return;
      if (currentEntryIdx < session.entries.length - 1) {
        currentEntryIdx++;
        resetDraft();
        timedDraft.entryIndex = null;
      }
    });
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
  const draft = { ...set };

  openSheet((close) => {
    const root = document.createElement('div');
    root.append(html('h2', 'eyebrow', 'EDIT SET'));
    const sub = el('div', 'muted');
    sub.style.fontSize = 'var(--t-xs)';
    sub.style.marginBottom = '10px';
    sub.textContent = exerciseLabel(entry.exerciseId).toUpperCase();
    root.append(sub);

    const grid = el('div', 'grid-2 section-mt');
    grid.style.gap = '10px';
    grid.append(numFieldSheet('WEIGHT (KG)', draft.weight, (v) => { draft.weight = v; }, '2.5'));
    grid.append(numFieldSheet('REPS', draft.reps, (v) => { draft.reps = v; }, '1'));
    root.append(grid);

    const opts = el('div', 'section-mt');
    opts.style.marginTop = '12px';
    opts.style.display = 'flex';
    opts.style.flexDirection = 'column';
    opts.append(toggleRow('Warmup', 'Excluded from charts and recovery.', draft.isWarmup,
      (v) => { draft.isWarmup = v; }));
    opts.append(toggleRow('Per-side weight', 'Volume counts both sides.', draft.perSide,
      (v) => { draft.perSide = v; }));
    root.append(opts);

    const actions = el('div', 'settings-actions section-mt');
    actions.style.marginTop = '16px';
    const del = el('button', 'btn-secondary danger');
    del.textContent = 'DELETE';
    del.addEventListener('click', () => {
      close();
      deleteSet(entryIndex, setIndex);
    });
    actions.append(del);
    const save = el('button', 'btn-primary');
    save.textContent = 'SAVE';
    save.addEventListener('click', () => {
      close();
      updateSet(entryIndex, setIndex, draft);
    });
    actions.append(save);
    root.append(actions);
    return root;
  });
}

function numFieldSheet(label, value, onChange, step) {
  const wrap = el('div');
  wrap.append(el('div', 'eyebrow', label));
  const input = document.createElement('input');
  input.className = 'input input-lg input-center';
  input.type = 'number';
  input.inputMode = step === '1' ? 'numeric' : 'decimal';
  input.step = step;
  input.min = '0';
  input.value = String(value);
  input.style.marginTop = '6px';
  input.addEventListener('focus', () => input.select());
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    onChange(isFinite(v) ? v : 0);
  });
  wrap.append(input);
  return wrap;
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
