/* Session operations layer.

   A session is one workout: { id, startedAt, endedAt, entries[] }. An
   entry is one exercise within that session: { exerciseId, sets[] }.
   A set is one logged effort: { weight, reps, rpe, notes, isWarmup,
   perSide, completedAt }.

   Only one session can be active at a time. Active state is tracked by
   db.activeSessionId pointing into the sessions array.

   Rest timer state lives on the active session as { restStartedAt,
   restDuration, restExerciseId } — store-the-end-timestamp pattern so
   the countdown survives the JS timer being frozen when the PWA is
   backgrounded. */

import { getDb, mutate } from './storage.js';
import { getExercise } from './exercises.js';

export function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}


/* ── Read ─────────────────────────────────────────────────────────── */

export function listSessions() {
  return [...getDb().sessions].sort((a, b) => b.startedAt - a.startedAt);
}

export function getSession(id) {
  return getDb().sessions.find((s) => s.id === id) ?? null;
}

export function getActiveSession() {
  const db = getDb();
  if (!db.activeSessionId) return null;
  return db.sessions.find((s) => s.id === db.activeSessionId) ?? null;
}


/* ── Session lifecycle ────────────────────────────────────────────── */

export function startSession(initialExerciseIds = []) {
  const id = uid();
  mutate((db) => {
    db.sessions.push({
      id,
      startedAt: Date.now(),
      endedAt: null,
      entries: initialExerciseIds.map((exerciseId) => ({ exerciseId, sets: [] })),
    });
    db.activeSessionId = id;
  });
  return id;
}

export function endActiveSession() {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s) return;
    // Trim empty entries (added by mistake) before sealing the session.
    s.entries = s.entries.filter((e) => e.sets.length > 0);
    s.endedAt = Date.now();
    // Drop any in-flight rest timer.
    delete s.restStartedAt;
    delete s.restDuration;
    delete s.restExerciseId;
    db.activeSessionId = null;
  });
}

export function abandonActiveSession() {
  mutate((db) => {
    const id = db.activeSessionId;
    if (!id) return;
    db.sessions = db.sessions.filter((s) => s.id !== id);
    db.activeSessionId = null;
  });
}

export function deleteSession(id) {
  mutate((db) => {
    db.sessions = db.sessions.filter((s) => s.id !== id);
    if (db.activeSessionId === id) db.activeSessionId = null;
  });
}


/* ── Entries (per-exercise containers within a session) ───────────── */

export function addEntry(exerciseId) {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s) throw new Error('No active session');
    // If the last entry is for the same exercise and has no sets yet,
    // reuse it — covers the common "tapped + then changed my mind" path.
    const last = s.entries[s.entries.length - 1];
    if (last && last.exerciseId === exerciseId && last.sets.length === 0) return;
    s.entries.push({ exerciseId, sets: [] });
  });
}

export function removeEntry(entryIndex) {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s) return;
    s.entries.splice(entryIndex, 1);
  });
}


/* ── Sets ─────────────────────────────────────────────────────────── */

export function addSet(entryIndex, set) {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s) throw new Error('No active session');
    const e = s.entries[entryIndex];
    if (!e) throw new Error('Bad entry index');
    e.sets.push({
      weight: 0, reps: 0, rpe: null, notes: '',
      isWarmup: false, perSide: false,
      ...set,
      completedAt: Date.now(),
    });
  });
}

export function updateSet(entryIndex, setIndex, patch) {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s) return;
    const e = s.entries[entryIndex];
    if (!e) return;
    const set = e.sets[setIndex];
    if (!set) return;
    Object.assign(set, patch);
  });
}

export function deleteSet(entryIndex, setIndex) {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s) return;
    const e = s.entries[entryIndex];
    if (!e) return;
    e.sets.splice(setIndex, 1);
  });
}


/* ── Rest timer ───────────────────────────────────────────────────── */

export function startRest(exerciseId, duration) {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s) return;
    s.restStartedAt = Date.now();
    s.restDuration = duration;
    s.restExerciseId = exerciseId;
  });
}

export function clearRest() {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s) return;
    delete s.restStartedAt;
    delete s.restDuration;
    delete s.restExerciseId;
  });
}

/** Returns { remainingSec, totalSec, exerciseId } or null if no timer running. */
export function getRestState() {
  const s = getActiveSession();
  if (!s || !s.restStartedAt) return null;
  const elapsedMs = Date.now() - s.restStartedAt;
  const remainingSec = Math.max(0, Math.ceil(s.restDuration - elapsedMs / 1000));
  return {
    remainingSec,
    totalSec: s.restDuration,
    exerciseId: s.restExerciseId,
  };
}


/* ── Isometric hold timer ────────────────────────────────────────
   Used for timed exercises (plank etc.). State lives on the session so
   it survives PWA backgrounding — readers compute remaining time from
   the stored startedAt timestamp.

   Phases:
     work — counting down from targetSec, user is holding
     rest — counting down from restSec, user is resting between sets
   The timer object also stores pausedRemainingSec so a pause snapshot
   survives reloads. The state machine is driven by the UI — sessions.js
   just provides primitives. */

export function startHold(entryIndex, targetSec, restSec) {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s) return;
    s.holdTimer = {
      entryIndex,
      phase: 'work',
      startedAt: Date.now(),
      targetSec,
      restSec,
      paused: false,
      pausedRemainingSec: null,
    };
  });
}

export function pauseHold() {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s?.holdTimer || s.holdTimer.paused) return;
    const t = s.holdTimer;
    const totalSec = t.phase === 'work' ? t.targetSec : t.restSec;
    const elapsed = (Date.now() - t.startedAt) / 1000;
    t.paused = true;
    t.pausedRemainingSec = Math.max(0, totalSec - elapsed);
  });
}

export function resumeHold() {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s?.holdTimer || !s.holdTimer.paused) return;
    const t = s.holdTimer;
    const totalSec = t.phase === 'work' ? t.targetSec : t.restSec;
    // Rebase startedAt so remaining = pausedRemainingSec when we tick again.
    t.startedAt = Date.now() - (totalSec - t.pausedRemainingSec) * 1000;
    t.paused = false;
    t.pausedRemainingSec = null;
  });
}

export function adjustHoldTarget(deltaSec) {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s?.holdTimer) return;
    s.holdTimer.targetSec = Math.max(10, Math.min(600, s.holdTimer.targetSec + deltaSec));
  });
}

export function adjustHoldRest(deltaSec) {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s?.holdTimer) return;
    s.holdTimer.restSec = Math.max(15, Math.min(600, s.holdTimer.restSec + deltaSec));
  });
}

/** Transition work → rest after the user finishes a hold (target reached
    or "END ✓" early). Returns the actual seconds held so the UI can log
    a set with it. */
export function endHoldWork() {
  let actualSec = 0;
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s?.holdTimer || s.holdTimer.phase !== 'work') return;
    const t = s.holdTimer;
    if (t.paused) {
      actualSec = Math.round(t.targetSec - t.pausedRemainingSec);
    } else {
      actualSec = Math.min(t.targetSec, Math.round((Date.now() - t.startedAt) / 1000));
    }
    t.phase = 'rest';
    t.startedAt = Date.now();
    t.paused = false;
    t.pausedRemainingSec = null;
  });
  return actualSec;
}

/** End the rest phase (skip rest or auto-tick to zero). Clears the timer
    so the next work hold is a fresh start. */
export function endHoldRest() {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s?.holdTimer) return;
    delete s.holdTimer;
  });
}

export function clearHold() {
  mutate((db) => {
    const s = db.sessions.find((x) => x.id === db.activeSessionId);
    if (!s) return;
    delete s.holdTimer;
  });
}

/** Returns { entryIndex, phase, remainingSec, totalSec, paused } or null.
    `remainingSec` is precise (sub-second). Callers that need an integer
    display should round/ceil themselves — keeping precision here lets
    the timer ring animate smoothly via rAF. */
export function getHoldState() {
  const s = getActiveSession();
  if (!s?.holdTimer) return null;
  const t = s.holdTimer;
  const totalSec = t.phase === 'work' ? t.targetSec : t.restSec;
  let remainingSec;
  if (t.paused) {
    remainingSec = t.pausedRemainingSec;
  } else {
    const elapsedSec = (Date.now() - t.startedAt) / 1000;
    remainingSec = Math.max(0, totalSec - elapsedSec);
  }
  return {
    entryIndex: t.entryIndex,
    phase: t.phase,
    remainingSec,
    totalSec,
    paused: t.paused,
    targetSec: t.targetSec,
    restSec: t.restSec,
  };
}


/* ── Convenience: find the last working set for an exercise ─────── */

/** Look back through history (and the active session) for the most recent
    working set of this exercise. Returns the set object or null. */
export function lastWorkingSet(exerciseId) {
  const db = getDb();
  const all = [...db.sessions].sort((a, b) => b.startedAt - a.startedAt);
  for (const s of all) {
    for (let i = s.entries.length - 1; i >= 0; i--) {
      const e = s.entries[i];
      if (e.exerciseId !== exerciseId) continue;
      for (let j = e.sets.length - 1; j >= 0; j--) {
        if (!e.sets[j].isWarmup) return e.sets[j];
      }
    }
  }
  return null;
}

/** Look up an exercise label, falling back to the stored ID for orphaned
    references (e.g. deleted custom exercise still referenced by a session). */
export function exerciseLabel(exerciseId) {
  return getExercise(exerciseId)?.name ?? exerciseId;
}
