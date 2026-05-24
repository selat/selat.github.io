/* Seeded workout templates + the suggestion / auto-generate algorithm.

   Templates are static here. Each is a list of exerciseIds — we don't
   prescribe set/rep targets at v1, the session screen uses each
   exercise's defaults. Custom templates are deferred to a later
   milestone; nothing in the codebase reads from db.templates yet.

   Suggestion strategy (suggestWorkout):
     1. Score each seeded template by the average recovery of the muscles
        its exercises primarily target.
     2. If the best template scores >= 0.7, suggest it.
     3. Otherwise auto-generate: greedily pick exercises that target
        muscles in the freshest region(s), avoiding ones whose primary
        muscles are too cooked, and trying to spread coverage rather
        than piling onto a single muscle. */

import { listExercises, getExercise } from './exercises.js';
import { muscleStatus, regionRecovery } from './recovery.js';
import { MUSCLES } from './muscles.js';

const TEMPLATES = [
  {
    id: 'push-day',
    name: 'Push Day',
    description: 'Chest, shoulders, triceps.',
    exerciseIds: ['barbell-bench-press', 'overhead-press', 'incline-dumbbell-press', 'lateral-raise', 'tricep-pushdown'],
  },
  {
    id: 'pull-day',
    name: 'Pull Day',
    description: 'Back and biceps.',
    exerciseIds: ['deadlift', 'pull-up', 'barbell-row', 'face-pull', 'barbell-curl'],
  },
  {
    id: 'leg-day',
    name: 'Leg Day',
    description: 'Quads, hamstrings, glutes, calves.',
    exerciseIds: ['back-squat', 'romanian-deadlift', 'leg-press', 'leg-curl', 'standing-calf-raise'],
  },
  {
    id: 'upper-body',
    name: 'Upper Body',
    description: 'Balanced push/pull.',
    exerciseIds: ['barbell-bench-press', 'barbell-row', 'overhead-press', 'lat-pulldown', 'lateral-raise', 'barbell-curl'],
  },
  {
    id: 'lower-body',
    name: 'Lower Body',
    description: 'Squat-focused with posterior chain.',
    exerciseIds: ['back-squat', 'romanian-deadlift', 'bulgarian-split-squat', 'leg-curl', 'standing-calf-raise'],
  },
  {
    id: 'full-body',
    name: 'Full Body',
    description: 'One compound per region plus accessories.',
    exerciseIds: ['back-squat', 'barbell-bench-press', 'barbell-row', 'overhead-press', 'romanian-deadlift'],
  },
];

export function listTemplates() {
  return TEMPLATES;
}

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}


/** Average recovery of the muscles primarily targeted by a list of exercises. */
function scoreExercises(exerciseIds, status) {
  const muscleHits = new Set();
  for (const id of exerciseIds) {
    const ex = getExercise(id);
    if (!ex) continue;
    for (const m of ex.muscles.primary) muscleHits.add(m);
  }
  if (muscleHits.size === 0) return 1;
  let sum = 0;
  for (const m of muscleHits) sum += status[m]?.recovery ?? 1;
  return sum / muscleHits.size;
}


/** Returns { kind: 'template'|'generated', name, exerciseIds, score, freshRegions }.
    Always returns something — even with empty history the suggestion is
    just "Full Body" because every muscle is fully recovered. */
export function suggestWorkout() {
  const status = muscleStatus();
  const regions = regionRecovery(status);

  // 1. Score templates.
  const scoredTemplates = TEMPLATES.map((t) => ({
    template: t,
    score: scoreExercises(t.exerciseIds, status),
  })).sort((a, b) => b.score - a.score);

  const best = scoredTemplates[0];
  const freshRegions = Object.entries(regions)
    .filter(([, v]) => v >= 0.65)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  if (best && best.score >= 0.7) {
    return {
      kind: 'template',
      id: best.template.id,
      name: best.template.name,
      description: best.template.description,
      exerciseIds: best.template.exerciseIds,
      score: best.score,
      freshRegions,
    };
  }

  // 2. Auto-generate: greedy fill from fresh regions.
  const chosen = generateWorkout(status, regions);
  return {
    kind: 'generated',
    name: chosen.length === 0 ? 'Take a rest day' : namedFromRegions(freshRegions),
    description: chosen.length === 0
      ? 'No muscle group is fresh enough. Your body needs the recovery.'
      : `Targeting fresh muscles: ${freshRegions.map((r) => r).join(', ') || 'mixed'}.`,
    exerciseIds: chosen,
    score: chosen.length === 0 ? 0 : scoreExercises(chosen, status),
    freshRegions,
  };
}

function namedFromRegions(freshRegions) {
  if (freshRegions.length === 0) return 'Light session';
  const labels = { push: 'Push', pull: 'Pull', legs: 'Legs', core: 'Core' };
  if (freshRegions.length === 1) return labels[freshRegions[0]] + ' focus';
  if (freshRegions.length === 2) return labels[freshRegions[0]] + ' + ' + labels[freshRegions[1]];
  return 'Mixed session';
}

function generateWorkout(status, regions) {
  const allExercises = listExercises();

  // Eligible: every primary muscle has recovery >= 0.5.
  const eligible = allExercises.filter((ex) => {
    if (ex.muscles.primary.length === 0) return false;
    return ex.muscles.primary.every((m) => (status[m]?.recovery ?? 1) >= 0.5);
  });
  if (eligible.length === 0) return [];

  // Prefer exercises whose region(s) are fresh.
  const regionFreshness = (ex) => {
    let max = 0;
    for (const m of ex.muscles.primary) {
      const r = MUSCLES[m]?.region;
      const v = r ? regions[r] : 0;
      if (v > max) max = v;
    }
    return max;
  };
  const exScore = (ex) => {
    const primRec = ex.muscles.primary.reduce((s, m) => s + (status[m]?.recovery ?? 1), 0) / ex.muscles.primary.length;
    return primRec * 0.6 + regionFreshness(ex) * 0.4;
  };

  const ranked = [...eligible].sort((a, b) => exScore(b) - exScore(a));

  // Greedy pick: 4-5 exercises, each adding at least one new primary muscle
  // we haven't already over-targeted.
  const chosen = [];
  const muscleCount = new Map();
  const MAX = 5;
  const MAX_PER_MUSCLE = 2;

  // Pass 1: prioritise compounds (2+ primary muscles) for the first 1-2 slots.
  for (const ex of ranked) {
    if (chosen.length >= 2) break;
    if (ex.muscles.primary.length < 2) continue;
    if (ex.muscles.primary.some((m) => (muscleCount.get(m) || 0) >= MAX_PER_MUSCLE)) continue;
    chosen.push(ex);
    for (const m of ex.muscles.primary) muscleCount.set(m, (muscleCount.get(m) || 0) + 1);
  }

  // Pass 2: fill with anything eligible that adds a new muscle.
  for (const ex of ranked) {
    if (chosen.length >= MAX) break;
    if (chosen.includes(ex)) continue;
    const overuse = ex.muscles.primary.some((m) => (muscleCount.get(m) || 0) >= MAX_PER_MUSCLE);
    if (overuse) continue;
    const addsNew = ex.muscles.primary.some((m) => !muscleCount.has(m));
    if (!addsNew && chosen.length >= 3) continue;
    chosen.push(ex);
    for (const m of ex.muscles.primary) muscleCount.set(m, (muscleCount.get(m) || 0) + 1);
  }

  return chosen.map((ex) => ex.id);
}
