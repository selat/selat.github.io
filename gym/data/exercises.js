/* Seeded exercise library.

   Each entry:
     id        — stable slug, used as foreign key from sessions and templates
     name      — display name
     bilateral — true if weight is naturally tracked per limb (DB press,
                 single-arm row). When a set on a bilateral exercise has
                 perSide=true, weight is the load on one limb and volume
                 counts both sides.
     muscles   — { primary: [muscleId,...], secondary: [muscleId,...] }
     defaultRest — recommended rest in seconds (compound vs isolation)
     defaultWarmupSets — number of warmup sets the logger pre-fills
     equipmentWeight — empty-bar weight (kg) for barbell lifts; 20 kg for
                       a standard Olympic bar. Drives the W1 = bar default
                       in the warmup ramp. Omit for dumbbell/machine/bodyweight.

   To add an exercise: append below and bump SEED_VERSION so existing
   installs notice (optional — additive changes don't require it). To
   change a seeded entry's name or muscles for a single user, use the
   library editor — it writes to exerciseOverrides rather than mutating
   the seed. */

import { mutate, getDb } from './storage.js';

export const SEED_VERSION = 1;

const SEED = [
  // ── Chest ─────────────────────────────────────────────────────────
  { id: 'barbell-bench-press', name: 'Barbell Bench Press', bilateral: false,
    muscles: { primary: ['chest'], secondary: ['front-delts', 'triceps'] },
    defaultRest: 180, defaultWarmupSets: 2, equipmentWeight: 20 },
  { id: 'incline-barbell-bench-press', name: 'Incline Barbell Bench', bilateral: false,
    muscles: { primary: ['chest', 'front-delts'], secondary: ['triceps'] },
    defaultRest: 180, defaultWarmupSets: 2, equipmentWeight: 20 },
  { id: 'dumbbell-bench-press', name: 'Dumbbell Bench Press', bilateral: true,
    muscles: { primary: ['chest'], secondary: ['front-delts', 'triceps'] },
    defaultRest: 150, defaultWarmupSets: 1 },
  { id: 'incline-dumbbell-press', name: 'Incline Dumbbell Press', bilateral: true,
    muscles: { primary: ['chest', 'front-delts'], secondary: ['triceps'] },
    defaultRest: 150, defaultWarmupSets: 1 },
  { id: 'dumbbell-fly', name: 'Dumbbell Fly', bilateral: true,
    muscles: { primary: ['chest'], secondary: [] },
    defaultRest: 90, defaultWarmupSets: 0 },
  { id: 'cable-crossover', name: 'Cable Crossover', bilateral: false,
    muscles: { primary: ['chest'], secondary: ['front-delts'] },
    defaultRest: 90, defaultWarmupSets: 0 },
  { id: 'push-up', name: 'Push-up', bilateral: false,
    muscles: { primary: ['chest'], secondary: ['front-delts', 'triceps'] },
    defaultRest: 90, defaultWarmupSets: 0 },
  { id: 'dip', name: 'Dip', bilateral: false,
    muscles: { primary: ['chest', 'triceps'], secondary: ['front-delts'] },
    defaultRest: 150, defaultWarmupSets: 1 },
  { id: 'machine-chest-press', name: 'Machine Chest Press', bilateral: false,
    muscles: { primary: ['chest'], secondary: ['front-delts', 'triceps'] },
    defaultRest: 120, defaultWarmupSets: 1 },
  { id: 'pec-deck', name: 'Pec Deck', bilateral: false,
    muscles: { primary: ['chest'], secondary: [] },
    defaultRest: 90, defaultWarmupSets: 0 },

  // ── Back ──────────────────────────────────────────────────────────
  { id: 'deadlift', name: 'Deadlift', bilateral: false,
    muscles: { primary: ['lower-back', 'glutes', 'hamstrings'], secondary: ['lats', 'upper-back', 'traps', 'forearms'] },
    defaultRest: 240, defaultWarmupSets: 3, equipmentWeight: 20 },
  { id: 'barbell-row', name: 'Barbell Row', bilateral: false,
    muscles: { primary: ['upper-back', 'lats'], secondary: ['biceps', 'rear-delts', 'lower-back'] },
    defaultRest: 150, defaultWarmupSets: 2, equipmentWeight: 20 },
  { id: 'pendlay-row', name: 'Pendlay Row', bilateral: false,
    muscles: { primary: ['upper-back', 'lats'], secondary: ['biceps', 'rear-delts'] },
    defaultRest: 150, defaultWarmupSets: 2, equipmentWeight: 20 },
  { id: 'dumbbell-row', name: 'Dumbbell Row', bilateral: true,
    muscles: { primary: ['lats', 'upper-back'], secondary: ['biceps', 'rear-delts'] },
    defaultRest: 120, defaultWarmupSets: 1 },
  { id: 'pull-up', name: 'Pull-up', bilateral: false,
    muscles: { primary: ['lats'], secondary: ['biceps', 'upper-back'] },
    defaultRest: 150, defaultWarmupSets: 1 },
  { id: 'chin-up', name: 'Chin-up', bilateral: false,
    muscles: { primary: ['lats', 'biceps'], secondary: ['upper-back'] },
    defaultRest: 150, defaultWarmupSets: 1 },
  { id: 'lat-pulldown', name: 'Lat Pulldown', bilateral: false,
    muscles: { primary: ['lats'], secondary: ['biceps', 'upper-back'] },
    defaultRest: 120, defaultWarmupSets: 1 },
  { id: 'seated-cable-row', name: 'Seated Cable Row', bilateral: false,
    muscles: { primary: ['upper-back', 'lats'], secondary: ['biceps', 'rear-delts'] },
    defaultRest: 120, defaultWarmupSets: 1 },
  { id: 't-bar-row', name: 'T-Bar Row', bilateral: false,
    muscles: { primary: ['upper-back', 'lats'], secondary: ['biceps'] },
    defaultRest: 150, defaultWarmupSets: 1 },
  { id: 'face-pull', name: 'Face Pull', bilateral: false,
    muscles: { primary: ['rear-delts', 'upper-back'], secondary: ['traps'] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'shrug', name: 'Shrug', bilateral: false,
    muscles: { primary: ['traps'], secondary: ['forearms'] },
    defaultRest: 90, defaultWarmupSets: 0 },
  { id: 'hyperextension', name: 'Hyperextension', bilateral: false,
    muscles: { primary: ['lower-back'], secondary: ['glutes', 'hamstrings'] },
    defaultRest: 90, defaultWarmupSets: 0 },

  // ── Shoulders ─────────────────────────────────────────────────────
  { id: 'overhead-press', name: 'Overhead Press', bilateral: false,
    muscles: { primary: ['front-delts', 'side-delts'], secondary: ['triceps', 'upper-back'] },
    defaultRest: 180, defaultWarmupSets: 2, equipmentWeight: 20 },
  { id: 'seated-db-press', name: 'Seated DB Press', bilateral: true,
    muscles: { primary: ['front-delts', 'side-delts'], secondary: ['triceps'] },
    defaultRest: 150, defaultWarmupSets: 1 },
  { id: 'arnold-press', name: 'Arnold Press', bilateral: true,
    muscles: { primary: ['front-delts', 'side-delts'], secondary: ['triceps'] },
    defaultRest: 120, defaultWarmupSets: 1 },
  { id: 'lateral-raise', name: 'Lateral Raise', bilateral: true,
    muscles: { primary: ['side-delts'], secondary: [] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'front-raise', name: 'Front Raise', bilateral: true,
    muscles: { primary: ['front-delts'], secondary: [] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'rear-delt-fly', name: 'Rear Delt Fly', bilateral: true,
    muscles: { primary: ['rear-delts'], secondary: ['upper-back'] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'cable-lateral-raise', name: 'Cable Lateral Raise', bilateral: true,
    muscles: { primary: ['side-delts'], secondary: [] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'upright-row', name: 'Upright Row', bilateral: false,
    muscles: { primary: ['side-delts', 'traps'], secondary: ['biceps'] },
    defaultRest: 90, defaultWarmupSets: 0 },

  // ── Arms ──────────────────────────────────────────────────────────
  { id: 'barbell-curl', name: 'Barbell Curl', bilateral: false,
    muscles: { primary: ['biceps'], secondary: ['forearms'] },
    defaultRest: 90, defaultWarmupSets: 0 },
  { id: 'dumbbell-curl', name: 'Dumbbell Curl', bilateral: true,
    muscles: { primary: ['biceps'], secondary: ['forearms'] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'hammer-curl', name: 'Hammer Curl', bilateral: true,
    muscles: { primary: ['biceps', 'forearms'], secondary: [] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'preacher-curl', name: 'Preacher Curl', bilateral: false,
    muscles: { primary: ['biceps'], secondary: [] },
    defaultRest: 90, defaultWarmupSets: 0 },
  { id: 'cable-curl', name: 'Cable Curl', bilateral: false,
    muscles: { primary: ['biceps'], secondary: ['forearms'] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'close-grip-bench', name: 'Close-Grip Bench Press', bilateral: false,
    muscles: { primary: ['triceps'], secondary: ['chest', 'front-delts'] },
    defaultRest: 150, defaultWarmupSets: 1, equipmentWeight: 20 },
  { id: 'tricep-pushdown', name: 'Tricep Pushdown', bilateral: false,
    muscles: { primary: ['triceps'], secondary: [] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'skull-crusher', name: 'Skull Crusher', bilateral: false,
    muscles: { primary: ['triceps'], secondary: [] },
    defaultRest: 90, defaultWarmupSets: 0 },
  { id: 'overhead-tricep-extension', name: 'Overhead Tricep Extension', bilateral: false,
    muscles: { primary: ['triceps'], secondary: [] },
    defaultRest: 90, defaultWarmupSets: 0 },
  { id: 'tricep-dip', name: 'Tricep Dip', bilateral: false,
    muscles: { primary: ['triceps'], secondary: ['chest', 'front-delts'] },
    defaultRest: 120, defaultWarmupSets: 0 },
  { id: 'wrist-curl', name: 'Wrist Curl', bilateral: true,
    muscles: { primary: ['forearms'], secondary: [] },
    defaultRest: 60, defaultWarmupSets: 0 },
  { id: 'reverse-wrist-curl', name: 'Reverse Wrist Curl', bilateral: true,
    muscles: { primary: ['forearms'], secondary: [] },
    defaultRest: 60, defaultWarmupSets: 0 },

  // ── Legs ──────────────────────────────────────────────────────────
  { id: 'back-squat', name: 'Back Squat', bilateral: false,
    muscles: { primary: ['quads', 'glutes'], secondary: ['hamstrings', 'lower-back'] },
    defaultRest: 240, defaultWarmupSets: 3, equipmentWeight: 20 },
  { id: 'front-squat', name: 'Front Squat', bilateral: false,
    muscles: { primary: ['quads'], secondary: ['glutes', 'lower-back'] },
    defaultRest: 210, defaultWarmupSets: 2, equipmentWeight: 20 },
  { id: 'romanian-deadlift', name: 'Romanian Deadlift', bilateral: false,
    muscles: { primary: ['hamstrings', 'glutes'], secondary: ['lower-back'] },
    defaultRest: 180, defaultWarmupSets: 2, equipmentWeight: 20 },
  { id: 'stiff-leg-deadlift', name: 'Stiff-Leg Deadlift', bilateral: false,
    muscles: { primary: ['hamstrings', 'glutes'], secondary: ['lower-back'] },
    defaultRest: 180, defaultWarmupSets: 2, equipmentWeight: 20 },
  { id: 'leg-press', name: 'Leg Press', bilateral: false,
    muscles: { primary: ['quads', 'glutes'], secondary: ['hamstrings'] },
    defaultRest: 150, defaultWarmupSets: 1 },
  { id: 'walking-lunge', name: 'Walking Lunge', bilateral: true,
    muscles: { primary: ['quads', 'glutes'], secondary: ['hamstrings'] },
    defaultRest: 120, defaultWarmupSets: 0 },
  { id: 'bulgarian-split-squat', name: 'Bulgarian Split Squat', bilateral: true,
    muscles: { primary: ['quads', 'glutes'], secondary: ['hamstrings'] },
    defaultRest: 120, defaultWarmupSets: 1 },
  { id: 'leg-extension', name: 'Leg Extension', bilateral: false,
    muscles: { primary: ['quads'], secondary: [] },
    defaultRest: 90, defaultWarmupSets: 0 },
  { id: 'leg-curl', name: 'Leg Curl', bilateral: false,
    muscles: { primary: ['hamstrings'], secondary: [] },
    defaultRest: 90, defaultWarmupSets: 0 },
  { id: 'hip-thrust', name: 'Hip Thrust', bilateral: false,
    muscles: { primary: ['glutes'], secondary: ['hamstrings'] },
    defaultRest: 150, defaultWarmupSets: 1 },
  { id: 'standing-calf-raise', name: 'Standing Calf Raise', bilateral: false,
    muscles: { primary: ['calves'], secondary: [] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'seated-calf-raise', name: 'Seated Calf Raise', bilateral: false,
    muscles: { primary: ['calves'], secondary: [] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'hip-adductor-machine', name: 'Hip Adductor Machine', bilateral: false,
    muscles: { primary: ['adductors'], secondary: [] },
    defaultRest: 60, defaultWarmupSets: 0 },

  // ── Core ──────────────────────────────────────────────────────────
  { id: 'plank', name: 'Plank', bilateral: false, isTimed: true,
    muscles: { primary: ['abs'], secondary: ['obliques'] },
    defaultRest: 60, defaultWarmupSets: 0, defaultTargetSec: 60 },
  { id: 'hanging-leg-raise', name: 'Hanging Leg Raise', bilateral: false,
    muscles: { primary: ['abs'], secondary: [] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'ab-wheel', name: 'Ab Wheel', bilateral: false,
    muscles: { primary: ['abs'], secondary: ['lower-back'] },
    defaultRest: 75, defaultWarmupSets: 0 },
  { id: 'cable-crunch', name: 'Cable Crunch', bilateral: false,
    muscles: { primary: ['abs'], secondary: [] },
    defaultRest: 60, defaultWarmupSets: 0 },
  { id: 'russian-twist', name: 'Russian Twist', bilateral: false,
    muscles: { primary: ['obliques'], secondary: ['abs'] },
    defaultRest: 60, defaultWarmupSets: 0 },
  { id: 'side-plank', name: 'Side Plank', bilateral: true, isTimed: true,
    muscles: { primary: ['obliques'], secondary: ['abs'] },
    defaultRest: 60, defaultWarmupSets: 0, defaultTargetSec: 45 },
];

const SEED_BY_ID = Object.fromEntries(SEED.map((e) => [e.id, e]));


/* ── Public API ─────────────────────────────────────────────────────
   Exercises are a merge of three layers (later wins per-field):
     1. Built-in SEED
     2. exerciseOverrides[id] — partial patches from the library editor
     3. customExercises — entirely user-defined (id is uuid-ish, custom: true)
   This lets the user rename or retag a seeded exercise without losing
   the ability to receive future seed updates for fields they didn't touch.
   ──────────────────────────────────────────────────────────────────── */

export function listExercises() {
  const db = getDb();
  const overrides = db.exerciseOverrides || {};

  const seeded = SEED.map((e) => {
    const ov = overrides[e.id];
    return ov ? { ...e, ...ov, muscles: ov.muscles ?? e.muscles, custom: false } : { ...e, custom: false };
  });

  const custom = (db.customExercises || []).map((e) => ({ ...e, custom: true }));

  return [...seeded, ...custom].sort((a, b) => a.name.localeCompare(b.name));
}

export function getExercise(id) {
  return listExercises().find((e) => e.id === id) ?? null;
}

export function isSeeded(id) {
  return id in SEED_BY_ID;
}

export function upsertCustomExercise(exercise) {
  if (!exercise.id) {
    exercise.id = 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  mutate((db) => {
    const existing = (db.customExercises || []).findIndex((e) => e.id === exercise.id);
    if (existing >= 0) {
      db.customExercises[existing] = exercise;
    } else {
      (db.customExercises ||= []).push(exercise);
    }
  });
  return exercise.id;
}

export function patchSeededExercise(id, patch) {
  if (!isSeeded(id)) throw new Error(`Not a seeded exercise: ${id}`);
  mutate((db) => {
    (db.exerciseOverrides ||= {})[id] = { ...(db.exerciseOverrides[id] || {}), ...patch };
  });
}

export function resetSeededExercise(id) {
  mutate((db) => {
    if (db.exerciseOverrides) delete db.exerciseOverrides[id];
  });
}

export function deleteCustomExercise(id) {
  mutate((db) => {
    db.customExercises = (db.customExercises || []).filter((e) => e.id !== id);
  });
}
