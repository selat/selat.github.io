/* Muscle group taxonomy.

   Each exercise tags one or more muscles as `primary` (full hit) and
   optionally `secondary` (half hit) for the recovery model. The set of
   IDs here is the closed vocabulary — anything not in this map is
   ignored by recovery scoring and trends.

   Grouping into `regions` is purely cosmetic: it controls how muscles
   are clustered in the library editor and the recovery readout, and
   does not affect the recovery math. */

export const MUSCLES = {
  chest:       { label: 'Chest',         region: 'push' },
  'front-delts':{ label: 'Front Delts',  region: 'push' },
  'side-delts':{ label: 'Side Delts',    region: 'push' },
  triceps:     { label: 'Triceps',       region: 'push' },

  lats:        { label: 'Lats',          region: 'pull' },
  'upper-back':{ label: 'Upper Back',    region: 'pull' },
  traps:       { label: 'Traps',         region: 'pull' },
  'rear-delts':{ label: 'Rear Delts',    region: 'pull' },
  biceps:      { label: 'Biceps',        region: 'pull' },
  forearms:    { label: 'Forearms',      region: 'pull' },

  quads:       { label: 'Quads',         region: 'legs' },
  hamstrings:  { label: 'Hamstrings',    region: 'legs' },
  glutes:      { label: 'Glutes',        region: 'legs' },
  calves:      { label: 'Calves',        region: 'legs' },
  adductors:   { label: 'Adductors',     region: 'legs' },
  abductors:   { label: 'Abductors',     region: 'legs' },

  'lower-back':{ label: 'Lower Back',    region: 'core' },
  abs:         { label: 'Abs',           region: 'core' },
  obliques:    { label: 'Obliques',      region: 'core' },
};

export const REGIONS = {
  push: { label: 'Push' },
  pull: { label: 'Pull' },
  legs: { label: 'Legs' },
  core: { label: 'Core' },
};

export const MUSCLE_IDS = Object.keys(MUSCLES);

export function muscleLabel(id) {
  return MUSCLES[id]?.label ?? id;
}
