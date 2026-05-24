/* Muscle recovery scoring.

   Model: every working set adds fatigue to each muscle the exercise
   touches, weighted by role (primary = 1.0, secondary = 0.5) and by
   number of working sets (saturating at 4 sets). Fatigue decays linearly
   to zero over the configured window (different for primary vs secondary
   contributions). Per-muscle fatigue from all recent sessions is summed,
   clipped to [0, 1]. Recovery is 1 minus that.

   This is deliberately simple — it's a heuristic for surfacing "what's
   fresh today", not a sports-science model. The user can tune the
   windows in Settings (M5). */

import { getDb } from './storage.js';
import { getExercise } from './exercises.js';
import { MUSCLES, MUSCLE_IDS, REGIONS } from './muscles.js';

const SET_SATURATION = 4;  // sets beyond this add no further fatigue


/** Returns { [muscleId]: { recovery: 0..1, lastHitAt: ms|null, lastIntensity: 0|0.5|1 } } */
export function muscleStatus(now = Date.now()) {
  const db = getDb();
  const primaryWindow = (db.settings.recoveryHoursPrimary || 48) * 3_600_000;
  const secondaryWindow = (db.settings.recoveryHoursSecondary || 24) * 3_600_000;

  // Initialise an entry for every known muscle so callers can iterate
  // without null-checking.
  const out = {};
  for (const m of MUSCLE_IDS) {
    out[m] = { recovery: 1, lastHitAt: null, lastIntensity: 0, fatigue: 0 };
  }

  for (const session of db.sessions) {
    const ageMs = now - session.startedAt;
    if (ageMs < 0) continue;
    // Past either window? Skip entirely (cheap optimisation).
    if (ageMs >= Math.max(primaryWindow, secondaryWindow)) continue;

    for (const entry of session.entries) {
      const ex = getExercise(entry.exerciseId);
      if (!ex) continue;
      const workingSets = entry.sets.filter((s) => !s.isWarmup).length;
      if (workingSets === 0) continue;
      const volumeFactor = Math.min(1, workingSets / SET_SATURATION);

      for (const muscleId of ex.muscles.primary) {
        if (!(muscleId in out)) continue;
        if (ageMs >= primaryWindow) continue;
        const decay = 1 - (ageMs / primaryWindow);
        out[muscleId].fatigue += 1.0 * volumeFactor * decay;
        if (out[muscleId].lastHitAt == null || session.startedAt > out[muscleId].lastHitAt) {
          out[muscleId].lastHitAt = session.startedAt;
          out[muscleId].lastIntensity = 1.0;
        }
      }
      for (const muscleId of (ex.muscles.secondary || [])) {
        if (!(muscleId in out)) continue;
        if (ageMs >= secondaryWindow) continue;
        const decay = 1 - (ageMs / secondaryWindow);
        out[muscleId].fatigue += 0.5 * volumeFactor * decay;
        if (out[muscleId].lastHitAt == null || session.startedAt > out[muscleId].lastHitAt) {
          out[muscleId].lastHitAt = session.startedAt;
          out[muscleId].lastIntensity = Math.max(out[muscleId].lastIntensity, 0.5);
        }
      }
    }
  }

  for (const m of MUSCLE_IDS) {
    out[m].recovery = Math.max(0, 1 - Math.min(1, out[m].fatigue));
  }
  return out;
}


/** Returns { [regionId]: averageRecovery } across the muscles in each region. */
export function regionRecovery(status = muscleStatus()) {
  const sums = {}, counts = {};
  for (const m of MUSCLE_IDS) {
    const r = MUSCLES[m].region;
    sums[r] = (sums[r] || 0) + status[m].recovery;
    counts[r] = (counts[r] || 0) + 1;
  }
  const out = {};
  for (const r of Object.keys(REGIONS)) {
    out[r] = counts[r] ? sums[r] / counts[r] : 1;
  }
  return out;
}


/** Convenience: list muscles sorted by recovery (lowest first → most cooked). */
export function muscleStatusList(status = muscleStatus()) {
  return MUSCLE_IDS.map((id) => ({ id, ...status[id] }))
    .sort((a, b) => a.recovery - b.recovery);
}
