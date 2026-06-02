/* Read-only computed views over the raw session log.

   Nothing here mutates the DB. These helpers translate the storage shape
   into the shapes the screens want: weekly aggregates, per-session
   summaries (split tag, volume, PR count), per-exercise history rows
   with PR detection.

   PR rule: a working set is a PR if its Epley-estimated 1RM exceeds the
   max e1RM of every prior working set for the same exercise. Detection
   is computed on read (no persisted flag) so editing history
   automatically reflects in PR marks. */

import { getDb } from './storage.js';
import { getExercise } from './exercises.js';
import { MUSCLES } from './muscles.js';

export function epley(weight, reps) {
  if (reps <= 0) return 0;
  if (reps === 1) return weight;
  return weight * (1 + reps / 30);
}

/** Adjusted volume for one working set — counts both sides if perSide.
    Timed (isometric) sets contribute zero to "tonnage" since they're
    held-for-time, not load×reps. We could expose a separate "seconds
    held" aggregate if needed, but it doesn't blend with weight totals. */
export function setVolume(set) {
  if (set.isWarmup) return 0;
  if (set.seconds != null) return 0;
  return set.weight * set.reps * (set.perSide ? 2 : 1);
}

export function workingSets(session) {
  let n = 0;
  for (const e of session.entries) {
    for (const s of e.sets) if (!s.isWarmup) n++;
  }
  return n;
}

export function sessionVolume(session) {
  let v = 0;
  for (const e of session.entries) {
    for (const s of e.sets) v += setVolume(s);
  }
  return v;
}

export function sessionDurationSec(session) {
  if (!session.endedAt) return 0;
  return Math.round((session.endedAt - session.startedAt) / 1000);
}

/** Derive a coarse split tag from the session's primary-muscle distribution.
    Used in History rows and template names. Returns one of:
    PUSH, PULL, LEGS, CORE, FULL, MIXED, EMPTY. */
export function sessionSplitTag(session) {
  const regionScore = { push: 0, pull: 0, legs: 0, core: 0 };
  for (const e of session.entries) {
    const ex = getExercise(e.exerciseId);
    if (!ex) continue;
    const workingSetCount = e.sets.filter((s) => !s.isWarmup).length;
    if (workingSetCount === 0) continue;
    for (const m of ex.muscles.primary) {
      const r = MUSCLES[m]?.region;
      if (r in regionScore) regionScore[r] += workingSetCount;
    }
  }
  const entries = Object.entries(regionScore).filter(([, v]) => v > 0);
  if (entries.length === 0) return 'CUSTOM';
  entries.sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  const second = entries[1];
  // Single dominant region (more than 2× the next) → label it directly.
  if (!second || top[1] >= second[1] * 2) {
    return { push: 'PUSH', pull: 'PULL', legs: 'LEGS', core: 'CORE' }[top[0]];
  }
  // Two roughly balanced regions → MIXED/FULL.
  return entries.length >= 3 ? 'FULL' : 'MIXED';
}

/** Comma-joined human-readable list of primary muscles hit in this session,
    e.g. "Back · Biceps · Rear Delts". Order = working-set volume desc. */
export function sessionMusclesLabel(session) {
  const muscleScore = new Map();
  for (const e of session.entries) {
    const ex = getExercise(e.exerciseId);
    if (!ex) continue;
    const ws = e.sets.filter((s) => !s.isWarmup).length;
    if (ws === 0) continue;
    for (const m of ex.muscles.primary) {
      muscleScore.set(m, (muscleScore.get(m) || 0) + ws);
    }
  }
  const sorted = [...muscleScore.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 3).map(([m]) => MUSCLES[m]?.label ?? m);
  return top.join(' · ') || '(empty)';
}


/* ── PR detection ─────────────────────────────────────────────────── */

/** Builds an index: { exerciseId: [{ ts, bestE1RMSoFar }, ...] } ordered by ts.
    Used as backing for isPR(set, exerciseId, ts). */
function buildExerciseRunningMaxes() {
  const db = getDb();
  // Collect every working set, group by exercise, sort by completedAt.
  // Timed sets are excluded — PR-by-e1RM doesn't apply to isometric holds.
  const byExercise = new Map();
  for (const s of db.sessions) {
    for (const e of s.entries) {
      for (const set of e.sets) {
        if (set.isWarmup) continue;
        if (set.seconds != null) continue;
        const ts = set.completedAt || s.startedAt;
        const arr = byExercise.get(e.exerciseId) || [];
        arr.push({ ts, e1rm: epley(set.weight, set.reps) });
        byExercise.set(e.exerciseId, arr);
      }
    }
  }
  // Sort each list and compute running max-before-this.
  const index = new Map();
  for (const [exId, list] of byExercise) {
    list.sort((a, b) => a.ts - b.ts);
    let runMax = 0;
    const out = [];
    for (const item of list) {
      out.push({ ts: item.ts, e1rm: item.e1rm, prevMax: runMax });
      if (item.e1rm > runMax) runMax = item.e1rm;
    }
    index.set(exId, out);
  }
  return index;
}

let _prIndex = null;
let _prIndexDirtyAt = 0;

function prIndex() {
  // Trivial cache invalidation: rebuild any time the sessions array
  // identity changes (mutate creates a new sessions array? No, it
  // mutates in place — but we just rebuild every call. Cheap enough
  // for the data sizes this app sees.)
  return buildExerciseRunningMaxes();
}

/** Is this specific working set a PR by e1RM at the time it was logged? */
export function isPRSet(set, exerciseId) {
  if (set.isWarmup) return false;
  const ts = set.completedAt;
  const idx = prIndex().get(exerciseId);
  if (!idx) return false;
  const e1rm = epley(set.weight, set.reps);
  // Find the entry for this set (ts match) — if none, fall back to "is this a new high?"
  const entry = idx.find((x) => x.ts === ts && Math.abs(x.e1rm - e1rm) < 1e-6);
  if (entry) return e1rm > entry.prevMax;
  return false;
}

/** Number of PR working sets in a session, across all exercises. */
export function sessionPRCount(session) {
  let n = 0;
  for (const e of session.entries) {
    for (const set of e.sets) {
      if (isPRSet(set, e.exerciseId)) n++;
    }
  }
  return n;
}

/** Per-exercise PR marks: parallel to entries[i].sets, true where PR. */
export function sessionPRMarks(session) {
  return session.entries.map((e) =>
    e.sets.map((set) => isPRSet(set, e.exerciseId))
  );
}


/* ── Weekly aggregates ────────────────────────────────────────────── */

export function startOfWeek(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  // Treat Monday as week start so weekend lifts aggregate with the week.
  const dayOfWeek = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayOfWeek);
  return d.getTime();
}

/** Last N weeks: returns ascending list of { weekStart, sessions, volume, prs, durationSec }. */
export function lastNWeeks(n, now = Date.now()) {
  const db = getDb();
  const buckets = new Map();
  const thisWeek = startOfWeek(now);
  const WEEK = 7 * 86400000;
  for (let i = n - 1; i >= 0; i--) {
    const wk = thisWeek - i * WEEK;
    buckets.set(wk, { weekStart: wk, sessions: 0, volume: 0, prs: 0, durationSec: 0, sets: 0 });
  }
  for (const s of db.sessions) {
    if (!s.endedAt) continue;
    const wk = startOfWeek(s.startedAt);
    const bucket = buckets.get(wk);
    if (!bucket) continue;
    bucket.sessions += 1;
    bucket.volume += sessionVolume(s);
    bucket.prs += sessionPRCount(s);
    bucket.durationSec += sessionDurationSec(s);
    bucket.sets += workingSets(s);
  }
  return [...buckets.values()];
}


/* ── Per-exercise history ─────────────────────────────────────────── */

/** Returns chronological [{ sessionId, ts, sets, topWeight, topReps, e1rm, isPR, isTimed, topSeconds }]
    for one exercise. `sets` is a printable string like "4×5 @ 80kg"
    or "3 × 60s" for timed exercises. Timed sets don't get e1RM / PR. */
export function exerciseHistory(exerciseId) {
  const db = getDb();
  const idx = prIndex().get(exerciseId) || [];
  const out = [];
  for (const s of db.sessions) {
    if (!s.endedAt) continue;
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId) continue;
      const working = e.sets.filter((set) => !set.isWarmup);
      if (working.length === 0) continue;

      // Timed: track longest hold as the "top" — no e1RM/PR.
      if (working[0].seconds != null) {
        const longest = working.reduce((a, b) => (b.seconds > a.seconds ? b : a), working[0]);
        const same = working.every((set) => set.seconds === working[0].seconds);
        const summary = same
          ? `${working.length} × ${working[0].seconds}s`
          : `${working.length} sets · top ${longest.seconds}s`;
        out.push({ sessionId: s.id, ts: s.startedAt, sets: summary, e1rm: 0, isPR: false, isTimed: true, topSeconds: longest.seconds });
        continue;
      }

      const topByE1rm = working.reduce((a, b) =>
        epley(b.weight, b.reps) > epley(a.weight, a.reps) ? b : a, working[0]);
      const e1rm = epley(topByE1rm.weight, topByE1rm.reps);
      const ts = topByE1rm.completedAt || s.startedAt;
      const prevMax = idx.find((x) => x.ts === ts)?.prevMax ?? 0;
      const isPR = e1rm > prevMax;
      const sameWeight = working.every((set) => set.weight === working[0].weight && set.reps === working[0].reps);
      const summary = sameWeight
        ? `${working.length} × ${working[0].reps} @ ${working[0].weight}kg`
        : `${working.length} sets · top ${topByE1rm.weight}×${topByE1rm.reps}`;
      out.push({ sessionId: s.id, ts: s.startedAt, sets: summary, e1rm, isPR, isTimed: false, topWeight: topByE1rm.weight, topReps: topByE1rm.reps });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}


/* ── Last set lookups (for prefilling the logger) ────────────────── */

/** Most recent working set for an exercise, across all sessions. */
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

/** "LAST · 4×5 @ 80kg" or "3×60s" style summary for exercise rows. */
export function lastSetSummary(exerciseId) {
  const db = getDb();
  for (const s of [...db.sessions].sort((a, b) => b.startedAt - a.startedAt)) {
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId) continue;
      const working = e.sets.filter((set) => !set.isWarmup);
      if (working.length === 0) continue;
      // Timed sets: "3×60s" (assumes consistent target — if not, show top).
      if (working[0].seconds != null) {
        const same = working.every((set) => set.seconds === working[0].seconds);
        if (same) return `${working.length}×${working[0].seconds}s`;
        const longest = working.reduce((a, b) => (b.seconds > a.seconds ? b : a), working[0]);
        return `${working.length} sets · top ${longest.seconds}s`;
      }
      const sameWeight = working.every((set) => set.weight === working[0].weight && set.reps === working[0].reps);
      if (sameWeight) return `${working.length}×${working[0].reps} @ ${working[0].weight}kg`;
      const top = working.reduce((a, b) => (b.weight > a.weight ? b : a), working[0]);
      return `${working.length} sets · top ${top.weight}×${top.reps}`;
    }
  }
  return null;
}

/** Best estimated 1RM ever recorded for an exercise (working sets only).
    Returns 0 for exercises with only timed sets. */
export function bestE1RM(exerciseId) {
  const db = getDb();
  let best = 0;
  for (const s of db.sessions) {
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId) continue;
      for (const set of e.sets) {
        if (set.isWarmup) continue;
        if (set.seconds != null) continue;
        const v = epley(set.weight, set.reps);
        if (v > best) best = v;
      }
    }
  }
  return best;
}

/** Longest hold ever recorded for a timed exercise. */
export function bestHoldSec(exerciseId) {
  const db = getDb();
  let best = 0;
  for (const s of db.sessions) {
    for (const e of s.entries) {
      if (e.exerciseId !== exerciseId) continue;
      for (const set of e.sets) {
        if (set.isWarmup) continue;
        if (set.seconds == null) continue;
        if (set.seconds > best) best = set.seconds;
      }
    }
  }
  return best;
}
