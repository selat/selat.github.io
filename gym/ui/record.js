/* RECORD screen — start-a-workout. Three paths:
     1. Today's autogen workout (inverse hero card, big START)
     2. Saved templates (with pinned indicator)
     3. Blank session
   Tapping any start path enters startSessionFlow() which creates an
   active session and routes to the active session view. */

import { suggestWorkout, listTemplates } from '../data/templates.js';
import { getDb, mutate } from '../data/storage.js';
import { exerciseLabel } from '../data/sessions.js';
import { getExercise } from '../data/exercises.js';
import { MUSCLES } from '../data/muscles.js';
import { muscleStatus } from '../data/recovery.js';
import { el, html, divider, pill } from './shared.js';
import { startSessionFlow } from './session.js';

export function renderRecord(container) {
  container.replaceChildren();

  // Topbar
  const tb = el('div', 'topbar with-meta');
  const meta = el('div', 'topbar-meta');
  meta.append(el('span', null, 'NO SESSION ACTIVE'));
  meta.append(el('span', null, formatNowLabel()));
  tb.append(meta);
  const main = el('div', 'topbar-main');
  main.append(html('h1', 'title', 'RECORD'));
  main.append(el('span', 'topbar-sub', 'START A WORKOUT'));
  tb.append(main);
  container.append(tb);

  const body = el('div', 'body-pad');

  body.append(autogenHero());
  body.append(templatesSection());
  body.append(blankSection());

  container.append(body);
}


function formatNowLabel() {
  const d = new Date();
  const date = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} · ${time}`;
}


/* ── Autogen hero ─────────────────────────────────────────────────── */

function autogenHero() {
  const suggestion = suggestWorkout();
  const card = el('div', 'autogen-hero section-mt');
  card.style.marginTop = '12px';

  const top = el('div', 'row-baseline');
  top.append(html('span', 'eyebrow', '★ TODAY · AUTOGEN'));
  const exCount = suggestion.exerciseIds?.length || 0;
  top.append(html('span', 'eyebrow', estimateMinutes(exCount) + ' MIN'));
  card.append(top);

  const title = el('h2', 'autogen-title');
  title.textContent = suggestion.name || 'TAKE A REST DAY';
  card.append(title);

  if (exCount > 0) {
    const meta = el('div', 'autogen-meta');
    meta.append(el('span', null, `${exCount} EXERCISES`));
    meta.append(el('span', 'sep', '·'));
    meta.append(el('span', null, `~${estimateSets(suggestion)} SETS`));
    card.append(meta);
  }

  card.append(rationaleLines(suggestion));

  // Actions
  const actions = el('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.marginTop = '4px';
  if (exCount > 0) {
    const start = el('button', 'btn-primary');
    start.style.flex = '1';
    start.innerHTML = '<span>START SESSION</span><span>▶</span>';
    start.addEventListener('click', () => startSessionFlow(suggestion.exerciseIds));
    actions.append(start);
  }
  card.append(actions);
  return card;
}

function estimateMinutes(exCount) {
  return String(Math.round(exCount * 8 / 5) * 5);
}
function estimateSets(suggestion) {
  return suggestion.exerciseIds.reduce((sum, id) => {
    const ex = getExercise(id);
    return sum + 3 + (ex?.defaultWarmupSets ?? 0);
  }, 0);
}

function rationaleLines(suggestion) {
  const status = muscleStatus();
  const wrap = el('div', 'autogen-rationale');

  // Targets: top 3 recovered primary muscles across suggested exercises.
  const targetSet = new Map();
  for (const id of suggestion.exerciseIds || []) {
    const ex = getExercise(id);
    if (!ex) continue;
    for (const m of ex.muscles.primary) {
      if ((status[m]?.recovery ?? 1) >= 0.7) {
        targetSet.set(m, status[m]?.recovery ?? 1);
      }
    }
  }
  const targets = [...targetSet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (targets.length > 0) {
    const row = el('div', 'pill-row');
    row.append(html('span', 'lbl', 'TARGETS'));
    for (const [m, r] of targets) {
      const label = (MUSCLES[m]?.label ?? m).toUpperCase();
      const p = el('span', 'pill good filled');
      p.textContent = `${label} ${Math.round(r * 100)}`;
      row.append(p);
    }
    wrap.append(row);
  }

  // Avoids: most cooked 1–2 muscles.
  const cooked = Object.entries(status)
    .filter(([, v]) => v.recovery < 0.5)
    .sort((a, b) => a[1].recovery - b[1].recovery)
    .slice(0, 2);
  if (cooked.length > 0) {
    const row = el('div', 'pill-row');
    row.append(html('span', 'lbl', 'AVOIDS'));
    for (const [m, v] of cooked) {
      const label = (MUSCLES[m]?.label ?? m).toUpperCase();
      const p = el('span', 'pill danger filled');
      p.textContent = `${label} ${Math.round(v.recovery * 100)}`;
      row.append(p);
    }
    wrap.append(row);
  }

  return wrap;
}


/* ── Templates ────────────────────────────────────────────────────── */

function templatesSection() {
  const wrap = el('div', 'section-mt');
  const pinned = new Set(getDb().pinnedTemplateIds || []);
  const templates = listTemplates();
  wrap.append(divider('TEMPLATES', `${templates.length} SAVED`));

  const list = el('div');
  for (const t of templates) {
    const row = el('button', 'template-row');
    row.type = 'button';
    const left = el('div');
    left.style.minWidth = '0';
    const nameRow = el('div', 'template-row-name');
    nameRow.append(html('span', 'name', t.name));
    if (pinned.has(t.id)) nameRow.append(html('span', 'pinned', '◆ PINNED'));
    left.append(nameRow);
    left.append(el('div', 'template-row-muscles', t.description));
    const meta = el('div', 'template-row-meta');
    meta.append(el('span', null, `${t.exerciseIds.length} EXERCISES`));
    const lastUse = lastTemplateUse(t);
    if (lastUse) {
      meta.append(el('span', 'sep', '·'));
      meta.append(el('span', null, 'LAST · ' + lastUse));
    }
    left.append(meta);
    row.append(left);
    row.append(html('span', null, '›'));

    row.addEventListener('click', () => startSessionFlow(t.exerciseIds));
    // Long-press to pin/unpin
    let pressTimer = null;
    row.addEventListener('pointerdown', () => {
      pressTimer = setTimeout(() => {
        pressTimer = null;
        togglePin(t.id);
      }, 600);
    });
    row.addEventListener('pointerup', () => { if (pressTimer) clearTimeout(pressTimer); });
    row.addEventListener('pointerleave', () => { if (pressTimer) clearTimeout(pressTimer); });

    list.append(row);
  }
  wrap.append(list);

  const hint = el('div', 'muted');
  hint.style.fontSize = 'var(--t-xs)';
  hint.style.letterSpacing = '0.08em';
  hint.style.textTransform = 'uppercase';
  hint.style.marginTop = '8px';
  hint.textContent = 'Long-press to pin';
  wrap.append(hint);

  return wrap;
}

function togglePin(id) {
  mutate((db) => {
    const list = db.pinnedTemplateIds || [];
    if (list.includes(id)) db.pinnedTemplateIds = list.filter((x) => x !== id);
    else db.pinnedTemplateIds = [...list, id];
  });
}

function lastTemplateUse(template) {
  // Heuristic: most recent session whose exercise set is a subset (>= 60%) of the template.
  const sessions = (getDb().sessions || []).filter((s) => s.endedAt);
  const tSet = new Set(template.exerciseIds);
  for (const s of [...sessions].sort((a, b) => b.startedAt - a.startedAt)) {
    const sSet = new Set(s.entries.map((e) => e.exerciseId));
    const overlap = [...tSet].filter((id) => sSet.has(id)).length;
    if (overlap / tSet.size >= 0.6) {
      const d = new Date(s.startedAt);
      const today = new Date();
      const diff = Math.round((today - d) / 86400000);
      if (diff === 0) return 'TODAY';
      if (diff === 1) return 'YESTERDAY';
      if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' }).toUpperCase();
      return d.toLocaleDateString([], { day: 'numeric', month: 'short' }).toUpperCase();
    }
  }
  return null;
}


/* ── Blank session ───────────────────────────────────────────────── */

function blankSection() {
  const wrap = el('div', 'section-mt');
  wrap.append(divider('BLANK'));
  const card = el('button', 'template-row');
  card.type = 'button';
  card.style.padding = '14px';
  card.style.border = '1px solid var(--line)';
  card.style.borderBottom = '1px solid var(--line)';
  card.style.gridTemplateColumns = '1fr auto';
  card.style.minHeight = '56px';

  const left = el('div');
  left.append(html('div', 'template-row-name',
    '<span class="name">EMPTY WORKOUT</span>'));
  left.append(html('div', 'template-row-muscles', 'No plan · add exercises as you go'));
  card.append(left);
  card.append(html('span', null, '+'));
  card.lastChild.style.fontSize = 'var(--t-lg)';
  card.lastChild.style.fontWeight = '700';

  card.addEventListener('click', () => startSessionFlow([]));
  wrap.append(card);
  return wrap;
}
