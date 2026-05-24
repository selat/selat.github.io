/* Single-blob localStorage persistence.

   The whole DB lives under one key as JSON. This is fine for a single-user
   text-only dataset: ~1KB per logged set means years of training fit
   comfortably under the ~5MB localStorage cap. If we ever blow that, the
   migration path is IndexedDB with the same shape — readers/writers go
   through getDb()/mutate() so the storage backend can swap without
   touching call sites.

   In-memory cache: every mutate() writes the full blob. JSON.stringify
   on a 100KB object is sub-millisecond, so we don't bother with debouncing. */

const KEY = 'gym/v1';

function emptyDb() {
  return {
    schema: 1,
    settings: {
      units: 'kg',             // 'kg' | 'lb' — display only, all weights stored as numbers
      defaultRest: 120,        // seconds, fallback when exercise has none
      recoveryHoursPrimary: 48,
      recoveryHoursSecondary: 24,
    },
    customExercises: [],
    exerciseOverrides: {},
    sessions: [],              // newest last
    templates: [],
    activeSessionId: null,
  };
}

let cache = null;
const listeners = new Set();

function load() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Merge with empty so additive schema changes don't trip readers.
      cache = { ...emptyDb(), ...parsed, settings: { ...emptyDb().settings, ...(parsed.settings || {}) } };
    } else {
      cache = emptyDb();
    }
  } catch (e) {
    console.error('Failed to parse gym DB, starting fresh', e);
    cache = emptyDb();
  }
  return cache;
}

function persist() {
  if (!cache) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (e) {
    console.error('Failed to write gym DB', e);
    alert('Could not save — storage may be full. Export your data from Settings and clear old sessions.');
  }
}

export function getDb() { return load(); }

export function mutate(fn) {
  const db = load();
  fn(db);
  persist();
  for (const l of listeners) l();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}


/* ── Export / import ────────────────────────────────────────────── */

export function exportJson() {
  return JSON.stringify(load(), null, 2);
}

export function importJson(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('Not a JSON object');
  if (parsed.schema !== 1) throw new Error(`Unsupported schema: ${parsed.schema}`);
  cache = { ...emptyDb(), ...parsed };
  persist();
  for (const l of listeners) l();
}

export function wipe() {
  cache = emptyDb();
  persist();
  for (const l of listeners) l();
}
