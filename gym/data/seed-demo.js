/* ⚠️  TEMPORARY — demo-data seeder.

   Generates 6 months of realistic-looking training history (3 sessions
   per week, rotating PUSH / PULL / LEGS) so every screen — Home calendar
   dots, History list, Trends/Detail charts, Body recovery map, PR
   markers — has something to render right after install.

   Auto-runs from app.js when db.sessions is empty AND no _demoSeeded
   marker is set. After seeding, the marker is set so reloads don't
   re-seed. A wipe from Settings clears the marker too, so users can
   easily get fresh demo data again.

   Remove the call site in app.js (and this file) once real usage starts. */

import { mutate, getDb } from './storage.js';
import { getExercise } from './exercises.js';

const SPLITS = {
  PUSH: ['barbell-bench-press', 'overhead-press', 'incline-dumbbell-press', 'lateral-raise', 'tricep-pushdown'],
  PULL: ['deadlift', 'pull-up', 'barbell-row', 'face-pull', 'barbell-curl'],
  LEGS: ['back-squat', 'romanian-deadlift', 'leg-press', 'leg-curl', 'standing-calf-raise', 'plank'],
};

// Baseline working-set load (kg) and rep target per exercise. End-of-cycle
// weight = baseline * (1 + PROGRESSION).
const BASELINE = {
  'barbell-bench-press':      { weight: 60,  reps: 5 },
  'overhead-press':           { weight: 35,  reps: 5 },
  'incline-dumbbell-press':   { weight: 22,  reps: 8 },
  'lateral-raise':            { weight: 8,   reps: 12 },
  'tricep-pushdown':          { weight: 20,  reps: 12 },
  'deadlift':                 { weight: 100, reps: 5 },
  'pull-up':                  { weight: 0,   reps: 8 },
  'barbell-row':              { weight: 55,  reps: 6 },
  'face-pull':                { weight: 15,  reps: 15 },
  'barbell-curl':             { weight: 25,  reps: 10 },
  'back-squat':               { weight: 70,  reps: 5 },
  'romanian-deadlift':        { weight: 80,  reps: 8 },
  'leg-press':                { weight: 120, reps: 10 },
  'leg-curl':                 { weight: 30,  reps: 12 },
  'standing-calf-raise':      { weight: 40,  reps: 15 },
  'plank':                    { seconds: 30 },  // timed exercise
};

const PROGRESSION = 0.30;   // 30% gain over the 6-month window
const WEEKS = 26;           // 6 months
const SESSIONS_PER_WEEK = 3;  // Mon/Wed/Fri
const SESSION_HOUR = 18;    // 6 PM
const SESSION_DURATION_MIN = 55;


/** Deterministic PRNG so re-seeds produce identical history (easier to
    eyeball regressions across reloads). Seed is fixed. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}


export function installDemoData() {
  // Skip if a marker is set or data already exists.
  const db = getDb();
  if (db._demoSeeded) return false;
  if (db.sessions && db.sessions.length > 0) return false;

  const rng = makeRng(20260524);
  const sessions = [];

  const now = new Date();
  now.setHours(SESSION_HOUR, 0, 0, 0);

  // Find this week's Monday as the anchor for the rolling rotation.
  const anchor = new Date(now);
  anchor.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7));

  // Generate WEEKS * SESSIONS_PER_WEEK sessions, going backwards.
  // i = 0 is the most recent Monday this week; older sessions go further back.
  const splitOrder = ['PUSH', 'PULL', 'LEGS'];

  for (let w = WEEKS - 1; w >= 0; w--) {
    for (let dayIdx = 0; dayIdx < SESSIONS_PER_WEEK; dayIdx++) {
      const dayOffset = [0, 2, 4][dayIdx]; // Mon, Wed, Fri
      const date = new Date(anchor);
      date.setDate(anchor.getDate() - w * 7 + dayOffset);
      // Skip future sessions (last week may be partly future).
      if (date.getTime() > now.getTime()) continue;

      // Progress factor 0..1 — 0 = oldest session, 1 = newest.
      const totalSessions = WEEKS * SESSIONS_PER_WEEK;
      const sessionsBack = (WEEKS - 1 - w) * SESSIONS_PER_WEEK + dayIdx;
      const progress = sessionsBack / Math.max(1, totalSessions - 1);

      const split = splitOrder[(w * SESSIONS_PER_WEEK + dayIdx) % 3];
      const startedAt = date.getTime();
      const endedAt = startedAt + SESSION_DURATION_MIN * 60_000;

      const entries = SPLITS[split]
        .map((exId) => buildEntry(exId, progress, startedAt, rng))
        .filter(Boolean);

      sessions.push({
        id: `demo-${date.toISOString().slice(0, 10)}-${split.toLowerCase()}`,
        startedAt,
        endedAt,
        entries,
      });
    }
  }

  mutate((db) => {
    db.sessions = sessions;
    db._demoSeeded = true;
  });

  console.log(`[demo] Seeded ${sessions.length} sessions across the last ${WEEKS} weeks.`);
  return true;
}


function buildEntry(exerciseId, progress, sessionStart, rng) {
  const ex = getExercise(exerciseId);
  if (!ex) return null;
  const base = BASELINE[exerciseId];
  if (!base) return null;

  const sets = [];
  let cursor = sessionStart + 3 * 60_000; // first set 3 minutes in

  // Timed exercises (plank): warmup-less, 3 working sets.
  if (ex.isTimed) {
    const targetSec = Math.round(
      base.seconds * (1 + PROGRESSION * progress) + (rng() - 0.5) * 10
    );
    for (let i = 0; i < 3; i++) {
      // Sometimes hold a bit longer than target, sometimes a bit shorter.
      const jitter = (rng() - 0.4) * 8;
      const seconds = Math.max(10, Math.round(targetSec + jitter));
      sets.push({
        weight: 0, reps: 0,
        seconds, targetSeconds: targetSec,
        rpe: null, notes: '', isWarmup: false, perSide: !!ex.bilateral,
        completedAt: cursor,
      });
      cursor += (seconds + (ex.defaultRest ?? 60)) * 1000;
    }
    return { exerciseId, sets };
  }

  // Reps exercises.
  const progressedWeight = base.weight * (1 + PROGRESSION * progress);
  const sessionJitter = (rng() - 0.4) * 2.5;
  const workingWeight = Math.max(0, roundToStep(progressedWeight + sessionJitter, 2.5));

  // Warmups: 50%, 70%, 85% of working weight.
  const warmupRatios = [0.5, 0.7, 0.85].slice(0, ex.defaultWarmupSets || 0);
  for (const ratio of warmupRatios) {
    const w = Math.max(0, roundToStep(workingWeight * ratio, 2.5));
    const r = Math.max(3, Math.min(10, Math.round(base.reps * 1.5)));
    sets.push({
      weight: w, reps: r, rpe: null, notes: '',
      isWarmup: true, perSide: !!ex.bilateral,
      completedAt: cursor,
    });
    cursor += 90_000; // 90s between warmups
  }

  // 4 working sets at the target weight, occasional missed rep.
  for (let i = 0; i < 4; i++) {
    const missed = rng() < 0.10;        // 10% chance of missing reps
    const reps = missed ? Math.max(1, base.reps - 1 - Math.floor(rng() * 2)) : base.reps;
    sets.push({
      weight: workingWeight,
      reps,
      rpe: i >= 2 && rng() < 0.6 ? Math.min(10, 7 + Math.floor(rng() * 4) / 2) : null,
      notes: '',
      isWarmup: false,
      perSide: !!ex.bilateral,
      completedAt: cursor,
    });
    cursor += ((ex.defaultRest ?? 120) + 30) * 1000; // rest + set time
  }

  return { exerciseId, sets };
}
