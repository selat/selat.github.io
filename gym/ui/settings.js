/* Settings sheet — units, recovery windows, export/import, wipe.
   Opened from the gear icon in the Home calendar header. */

import { getDb, mutate, exportJson, importJson, wipe } from '../data/storage.js';
import { openSheet } from '../app.js';

export function openSettings() {
  openSheet((close) => {
    // Markup lives in #tpl-settings in index.html; clone + wire here.
    const root = document.getElementById('tpl-settings')
      .content.firstElementChild.cloneNode(true);
    const settings = getDb().settings;

    // ── Units ─────────────────────────────────────────────────────
    const unitBtns = root.querySelectorAll('.settings-unit');
    unitBtns.forEach((btn) => {
      btn.classList.toggle('on', settings.units === btn.dataset.unit);
      btn.addEventListener('click', () => {
        mutate((db) => { db.settings.units = btn.dataset.unit; });
        unitBtns.forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
      });
    });

    // ── Recovery windows ──────────────────────────────────────────
    wireNumField(root.querySelector('[name="recoveryPrimary"]'),
      settings.recoveryHoursPrimary,
      (v) => mutate((db) => { db.settings.recoveryHoursPrimary = v; }));
    wireNumField(root.querySelector('[name="recoverySecondary"]'),
      settings.recoveryHoursSecondary,
      (v) => mutate((db) => { db.settings.recoveryHoursSecondary = v; }));

    // ── Backup ────────────────────────────────────────────────────
    root.querySelector('[data-act="export"]').addEventListener('click', () => doExport());
    root.querySelector('[data-act="import"]').addEventListener('click', () => doImport(close));

    // ── Wipe ──────────────────────────────────────────────────────
    root.querySelector('[data-act="wipe"]').addEventListener('click', () => {
      if (!confirm('Delete every session, custom exercise, and setting. Export first if you want a backup. Continue?')) return;
      close();
      wipe();
    });

    // ── Done ──────────────────────────────────────────────────────
    root.querySelector('[data-act="done"]').addEventListener('click', close);

    return root;
  });
}

function wireNumField(input, value, onChange) {
  input.value = String(value);
  input.addEventListener('change', () => {
    const v = Math.max(1, parseInt(input.value, 10) || 0);
    input.value = String(v);
    onChange(v);
  });
}


/* ── Export / import ──────────────────────────────────────────────── */

function doExport() {
  const text = exportJson();
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `rep-log-backup-${stamp}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function doImport(closeSettings) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        importJson(String(reader.result));
        closeSettings();
        alert('Imported successfully.');
      } catch (e) {
        alert('Import failed: ' + e.message);
      }
    };
    reader.onerror = () => alert('Could not read file.');
    reader.readAsText(file);
  });
  input.click();
}
