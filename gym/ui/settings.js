/* Settings sheet — units, recovery windows, export/import, wipe.
   Opened from the gear icon in the Home calendar header. */

import { getDb, mutate, exportJson, importJson, wipe } from '../data/storage.js';
import { openSheet } from '../app.js';
import { el, html } from './shared.js';

export function openSettings() {
  openSheet((close) => {
    const root = document.createElement('div');
    root.append(html('h2', 'eyebrow', 'SETTINGS'));

    const settings = getDb().settings;

    // ── Units ─────────────────────────────────────────────────────
    root.append(sectionLabel('DISPLAY UNITS'));
    const unitsRow = el('div');
    unitsRow.style.display = 'flex';
    unitsRow.style.gap = '8px';
    unitsRow.style.marginBottom = '8px';
    for (const u of ['kg', 'lb']) {
      const c = el('button', 'pill toggle' + (settings.units === u ? ' on' : ''));
      c.type = 'button';
      c.textContent = u.toUpperCase();
      c.style.fontSize = 'var(--t-base)';
      c.style.padding = '8px 16px';
      c.style.minHeight = '44px';
      c.addEventListener('click', () => {
        mutate((db) => { db.settings.units = u; });
        for (const sib of unitsRow.children) sib.classList.remove('on');
        c.classList.add('on');
      });
      unitsRow.append(c);
    }
    root.append(unitsRow);
    root.append(sectionHint('Stored internally as kg; this only changes display.'));

    // ── Recovery windows ──────────────────────────────────────────
    root.append(sectionLabel('RECOVERY WINDOWS'));
    const grid = el('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = '1fr 1fr';
    grid.style.gap = '8px';
    grid.style.marginBottom = '8px';
    grid.append(numField('PRIMARY (HRS)', settings.recoveryHoursPrimary, (v) => {
      mutate((db) => { db.settings.recoveryHoursPrimary = v; });
    }));
    grid.append(numField('SECONDARY (HRS)', settings.recoveryHoursSecondary, (v) => {
      mutate((db) => { db.settings.recoveryHoursSecondary = v; });
    }));
    root.append(grid);
    root.append(sectionHint('Time a primary/secondary muscle hit takes to fully recover. Higher = more conservative suggestions.'));

    // ── Backup ────────────────────────────────────────────────────
    root.append(sectionLabel('DATA'));
    root.append(sectionHint('Everything is stored in your browser. Export regularly — clearing site data wipes your history.'));
    const dataRow = el('div');
    dataRow.style.display = 'grid';
    dataRow.style.gridTemplateColumns = '1fr 1fr';
    dataRow.style.gap = '8px';
    dataRow.style.marginTop = '8px';
    const exportBtn = el('button', 'btn-secondary');
    exportBtn.textContent = 'EXPORT';
    exportBtn.addEventListener('click', () => doExport());
    dataRow.append(exportBtn);
    const importBtn = el('button', 'btn-secondary');
    importBtn.textContent = 'IMPORT';
    importBtn.addEventListener('click', () => doImport(close));
    dataRow.append(importBtn);
    root.append(dataRow);

    // ── Wipe ──────────────────────────────────────────────────────
    const wipeWrap = el('div');
    wipeWrap.style.marginTop = '20px';
    wipeWrap.style.paddingTop = '14px';
    wipeWrap.style.borderTop = '1px solid var(--line-soft)';
    const wipeBtn = el('button', 'btn-secondary danger');
    wipeBtn.style.width = '100%';
    wipeBtn.textContent = '⌫ WIPE ALL DATA';
    wipeBtn.addEventListener('click', () => {
      if (!confirm('Delete every session, custom exercise, and setting. Export first if you want a backup. Continue?')) return;
      close();
      wipe();
    });
    wipeWrap.append(wipeBtn);
    root.append(wipeWrap);

    // Done
    const done = el('button', 'btn-primary');
    done.style.marginTop = '14px';
    done.textContent = 'DONE';
    done.addEventListener('click', close);
    root.append(done);

    return root;
  });
}


function sectionLabel(text) {
  const e = el('div', 'eyebrow');
  e.style.marginTop = '14px';
  e.style.marginBottom = '6px';
  e.textContent = text;
  return e;
}

function sectionHint(text) {
  const e = el('div', 'muted');
  e.style.fontSize = 'var(--t-xs)';
  e.style.marginBottom = '8px';
  e.textContent = text;
  return e;
}

function numField(label, value, onChange) {
  const wrap = el('div');
  wrap.append(html('div', 'eyebrow', label));
  const input = document.createElement('input');
  input.className = 'input input-center';
  input.type = 'number';
  input.inputMode = 'numeric';
  input.min = '1';
  input.step = '1';
  input.value = String(value);
  input.style.marginTop = '4px';
  input.addEventListener('change', () => {
    const v = Math.max(1, parseInt(input.value, 10) || 0);
    input.value = String(v);
    onChange(v);
  });
  wrap.append(input);
  return wrap;
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
