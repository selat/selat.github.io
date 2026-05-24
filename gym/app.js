/* App entry: hash-based router with sub-routes + sheet host + SW registration.

   Routes:
     #home                 → home overview (calendar + recent)
     #history              → past sessions list
     #session/<id>         → past session detail
     #record               → start-a-workout (or active session, if one is running)
     #workout              → current workout overview (reached from active session)
     #library              → exercise library
     #exercise/<id>        → exercise detail (chart + history)
     #body                 → recovery map

   The hash is parsed into { route, param }. Each route function receives
   the screen container and optional id; it's responsible for rendering
   everything inside it. Storage changes trigger a rerender of the
   current route as long as no sheet is open. */

import { renderHome } from './ui/home.js';
import { renderRecord } from './ui/record.js';
import { renderSession } from './ui/session.js';
import { renderHistory, renderPastSession } from './ui/history.js';
import { renderWorkout } from './ui/workout.js';
import { renderLibrary, renderExerciseDetail } from './ui/library.js';
import { renderBody } from './ui/body.js';
import { getActiveSession } from './data/sessions.js';
import { subscribe } from './data/storage.js';
import { installDemoData } from './data/seed-demo.js'; // TEMPORARY — remove for real use

const ROUTES = {
  home:     { render: renderHome,     tab: 'home'    },
  history:  { render: renderHistory,  tab: 'history' },
  session:  { render: renderPastSession, tab: 'history', needsParam: true },
  record:   { render: renderRecordOrSession, tab: 'record' },
  workout:  { render: renderWorkout,  tab: 'record'  },
  library:  { render: renderLibrary,  tab: 'library' },
  exercise: { render: renderExerciseDetail, tab: 'library', needsParam: true },
  body:     { render: renderBody,     tab: 'body'    },
};

const DEFAULT_ROUTE = 'home';

const screen = document.getElementById('screen');
let currentRoute = null;
let currentParam = null;

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return { route: DEFAULT_ROUTE, param: null };
  const [route, param] = raw.split('/');
  if (!ROUTES[route]) return { route: DEFAULT_ROUTE, param: null };
  return { route, param: param || null };
}

function render() {
  const { route, param } = parseHash();
  const entry = ROUTES[route];
  currentRoute = route;
  currentParam = param;

  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.route === entry.tab);
  }

  window.scrollTo(0, 0);

  if (entry.needsParam && !param) {
    // Tried to open a detail route without an id — bounce to the section list.
    location.hash = entry.tab;
    return;
  }
  entry.render(screen, param);
}

function rerender() {
  if (document.getElementById('sheet-host').firstChild) return;
  const entry = ROUTES[currentRoute];
  if (!entry) return;
  entry.render(screen, currentParam);
}

/* Record tab is overloaded: if a session is in progress, show it directly
   so the user lands back in their workout when they tap the record icon. */
function renderRecordOrSession(container) {
  if (getActiveSession()) {
    renderSession(container);
  } else {
    renderRecord(container);
  }
}

subscribe(rerender);
window.addEventListener('hashchange', render);

// TEMPORARY: pre-populate demo data on a fresh install so every screen
// has something to render. Safe to remove once the app is in real use.
installDemoData();

render();


/* ── Sheet helper (bottom-drawer modal) ───────────────────────────── */

const sheetHost = document.getElementById('sheet-host');

export function openSheet(buildContent) {
  closeSheet();
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeSheet();
  });

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  sheet.append(handle);

  const body = buildContent(closeSheet);
  if (body) sheet.append(body);

  backdrop.append(sheet);
  sheetHost.append(backdrop);
  document.body.style.overflow = 'hidden';
}

export function closeSheet() {
  sheetHost.replaceChildren();
  document.body.style.overflow = '';
}

export function go(route) {
  location.hash = route;
}


/* ── Service worker registration ──────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('SW registration failed', err);
    });
  });
}
