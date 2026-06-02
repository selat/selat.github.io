/* Cross-screen helpers: formatters, DOM builders, the audio chime.
   Stays dependency-light so any UI module can import without cycles. */

import { getDb } from '../data/storage.js';

const KG_TO_LB = 2.2046226218;

/* ── DOM helpers ─────────────────────────────────────────────────── */

export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

export function html(tag, className, htmlStr) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (htmlStr != null) e.innerHTML = htmlStr;
  return e;
}

/* Escape a string for safe interpolation into innerHTML templates
   (exercise names and other user-entered text may contain <, &, "). */
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function svg(tag, attrs = {}) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/* Convenience: build a `<div class="stat-cell">` containing a stat block
   matching the Gym style — uppercase label + tabular value + unit + sub. */
export function statCell({ label, value, unit, sub, size = 'lg' }) {
  const cell = el('div', 'stat-cell');
  const inner = el('div', 'stat' + (size === 'md' ? ' stat-md' : ''));
  inner.append(el('span', 'stat-label', label));
  const row = el('div');
  row.style.display = 'flex';
  row.style.alignItems = 'baseline';
  row.style.gap = '3px';
  const v = el('span', 'stat-value');
  v.textContent = value;
  row.append(v);
  if (unit) row.append(el('span', 'stat-unit', unit));
  inner.append(row);
  if (sub) inner.append(el('span', 'stat-sub', sub));
  cell.append(inner);
  return cell;
}

/* Divider with leading dashes + optional right-side count. */
export function divider(label, right) {
  const d = el('div', 'divider');
  d.append(el('span', null, `── ${label}`));
  d.append(el('span', 'divider-line'));
  if (right) d.append(el('span', 'divider-right', right));
  return d;
}

/* Pill (uppercase chip). variant: 'default' | 'soft' | 'filled' | 'good' | 'danger' */
export function pill(text, variant = 'default') {
  const c = el('span', 'pill' + (variant !== 'default' ? ' ' + variant : ''));
  c.textContent = text;
  return c;
}


/* ── Weight + units ─────────────────────────────────────────────── */

/** Format a stored weight (kg) into a string in the user's display unit. */
export function formatWeight(weightKg, { withUnit = true } = {}) {
  if (weightKg == null || !isFinite(weightKg)) return '—';
  const units = getDb().settings.units;
  if (units === 'lb') {
    const v = Math.round(weightKg * KG_TO_LB);
    return withUnit ? `${v} lb` : String(v);
  }
  const v = Math.round(weightKg * 10) / 10;
  const s = v % 1 === 0 ? String(v) : v.toFixed(1);
  return withUnit ? `${s} kg` : s;
}

export function unitLabel() {
  return getDb().settings.units === 'lb' ? 'LB' : 'KG';
}


/* ── Duration formatting ──────────────────────────────────────────── */

/** Seconds → "M:SS" (e.g. 95 → "1:35"). */
export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Seconds → "MM:SS" zero-padded — used in workout timer display. */
export function formatDurationPad(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Total seconds → "Xh Ym" or "Ym". */
export function formatTrainTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/** Short "FRI 24" style label for History/recent rows. */
export function formatShortDate(ms) {
  const d = new Date(ms);
  const weekday = d.toLocaleDateString([], { weekday: 'short' }).toUpperCase();
  return `${weekday} ${d.getDate()}`;
}

/** "MAY 2026" month header. */
export function formatMonth(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString([], { month: 'short', year: 'numeric' }).toUpperCase();
}


/* ── Audio chime ──────────────────────────────────────────────────── */

let _audioCtx = null;
function audioCtx() {
  if (_audioCtx) return _audioCtx;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    _audioCtx = new Ctor();
    return _audioCtx;
  } catch {
    return null;
  }
}

export function playChime() {
  const ctx = audioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  for (const [freq, when, dur] of [[660, 0, 0.18], [880, 0.22, 0.22]]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    const t0 = ctx.currentTime + when;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
}


/* ── Haptics ─────────────────────────────────────────────────────── */

export function vibrate(pattern) {
  if (!('vibrate' in navigator)) return;
  try { navigator.vibrate(pattern); } catch {}
}


/* ── Screen wake lock ────────────────────────────────────────────── */
/* Browsers auto-release the wake lock when the tab is hidden, so we
   track the *desired* state and re-acquire on visibilitychange. */

let _wakeLock = null;
let _wakeLockWanted = false;

async function _acquireWakeLock() {
  if (!('wakeLock' in navigator) || _wakeLock) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
  } catch {
    _wakeLock = null;
  }
}

function _releaseWakeLock() {
  if (!_wakeLock) return;
  _wakeLock.release().catch(() => {});
  _wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (_wakeLockWanted && document.visibilityState === 'visible') _acquireWakeLock();
});

export function setKeepScreenAwake(on) {
  _wakeLockWanted = on;
  if (on) _acquireWakeLock();
  else _releaseWakeLock();
}


/* ── Notifications (one-shot, e.g. rest done) ───────────────────── */

export function ensureNotificationPermission() {
  if (!('Notification' in window)) return Promise.resolve('denied');
  if (Notification.permission !== 'default') return Promise.resolve(Notification.permission);
  return Notification.requestPermission().catch(() => 'denied');
}

export function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag: 'gym-rest', renotify: true }); } catch {}
}
