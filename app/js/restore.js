// "Restore from a backup" for the offline edition -- used on the first-run screen of a new computer
// (nobody has signed in yet, so `fresh` is true) and from Settings -> Backups.
//
// It looks for backups on the USB drives plugged in (and in the folders already in use), and also
// lets someone type the full path to a file, so a stick that shows up oddly is never a dead end.
import { h, modal, toast, confirmDialog } from './ui.js';

const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const size = (b) => (b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function openRestore({ repo, fresh = false, onDone = () => {} }) {
  const list = h('div', {}, h('p', { class: 'hint' }, 'Looking for backups…'));
  const err = h('div', { class: 'err', role: 'alert' });
  const typed = h('input', { placeholder: 'e.g. E:\\ChurchFlow Backups\\churchflow-backup-2026-10-04-080000.db', autocomplete: 'off', style: 'width:100%' });
  const body = h('div', {},
    h('p', {}, fresh
      ? 'Plug in the USB drive that has your church\'s backups, then choose one below. Your records, staff sign-ins and settings come back exactly as they were.'
      : 'Choose a backup to put back. Everything entered since that backup will be replaced. A copy of today\'s records is saved first, so this can be undone.'),
    list, err,
    h('details', {}, h('summary', {}, 'The backup is not listed'),
      h('p', { class: 'hint' }, 'Type the full path of the backup file (it ends in .db).'), typed,
      h('p', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => go(typed.value.trim().replace(/^"|"$/g, '')) }, 'Restore this file'))),
    h('p', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel')));
  const m = modal(fresh ? 'Restore your church from a backup' : 'Restore from another backup', body, { wide: true });

  let busy = false;
  async function go(path) {
    if (busy) return;
    err.textContent = '';
    if (!path) { err.textContent = 'Choose a backup first.'; return; }
    if (!fresh && !(await confirmDialog('Put the church\'s records back to this backup? Everything entered since then will be replaced. A copy of today\'s records is saved first.', 'Restore this backup'))) return;
    busy = true; list.replaceChildren(h('p', {}, 'Restoring… please wait a moment.'));
    try {
      await repo.restoreBackup(path);
      if (!(await repo.waitForServer(45_000))) { err.textContent = 'The restore is taking long. Close and reopen The ChurchFlow to finish.'; busy = false; return; }
      m.close(); toast('Restored. Your church records are back.'); onDone();
    } catch (e) { busy = false; err.textContent = e.message; list.replaceChildren(); load(); }
  }

  async function load() {
    try {
      const { files, drives } = await repo.findBackups();
      list.replaceChildren(files.length
        ? h('div', {}, ...files.slice(0, 12).map((f) => h('div', { class: 'feed' },
            h('span', {}, h('b', {}, when(f.modified)), h('span', { class: 'hint' }, ` · ${size(f.size)} · ${f.dir}`)),
            ' ', h('button', { class: 'btn sm', onclick: () => go(f.path) }, 'Restore'))))
        : h('p', { class: 'hint' }, drives.length
            ? `No backups found on ${drives.join('  ')}. Open the folder on the drive that holds them, or type the file's path below.`
            : 'No USB drive found. Plug it in and press “Look again”.'),
        h('p', { class: 'actions' }, h('button', { class: 'btn ghost sm', onclick: () => { list.replaceChildren(h('p', { class: 'hint' }, 'Looking for backups…')); load(); } }, 'Look again')));
    } catch (e) { list.replaceChildren(h('p', { class: 'err' }, e.message)); }
  }
  load();
}
