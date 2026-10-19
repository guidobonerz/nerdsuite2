// folderchooser.js - a folder of the computer, chosen in a dialog: the folders are listed by the server
// (backend/disk), the browser cannot list them itself. The places to start: home, the drives (Windows) or
// /, and the folders chosen before. A folder with a nerdsuite.json is a project: marked, and a double
// click opens it.

import { h, signal, icon, iconButton, field, dialog, promptDialog, snackbar } from './pui.js';
import { listDirs, makeDir } from './project.js';

const RECENT = 'nerdsuite.folders';
const MAX_RECENT = 8;

// the folders chosen before, the last first
export function recentFolders() {
  try { return JSON.parse(localStorage.getItem(RECENT) ?? '[]').filter(x => typeof x === 'string'); } catch { return []; }
}
export function rememberFolder(path) {
  try { localStorage.setItem(RECENT, JSON.stringify([path, ...recentFolders().filter(x => x !== path)].slice(0, MAX_RECENT))); } catch { /* no storage */ }
}
export function forgetFolder(path) {
  try { localStorage.setItem(RECENT, JSON.stringify(recentFolders().filter(x => x !== path))); } catch { /* no storage */ }
}

// a folder: its full path, or null. title, ok: the button that takes the folder shown ('Open', 'Save here');
// note: a line above the folders; start: the folder to show first (else the last one chosen, else home)
export function chooseFolder({ title = 'Choose a folder', ok = 'Choose', note, start } = {}) {
  return new Promise(resolve => {
    const at = signal(null);            // the listing shown
    const error = signal('');
    const typed = signal('');
    let asked = 0;                       // the last listing asked for: an older answer that comes later is not shown
    const go = async path => {
      const n = ++asked;
      try {
        const l = await listDirs(path);
        if (n !== asked) return true;
        at.value = l;
        typed.value = l.path;
        error.value = '';
        return true;
      } catch (e) { if (n === asked) error.value = e.message; return false; }
    };
    // a folder chosen before: its name, with the folder it is in when another one has the same name
    const parts = p => p.split(/[\\/]/).filter(Boolean);
    const recentLabel = (p, all) => {
      const name = parts(p).pop() || p;
      return all.filter(x => (parts(x).pop() || x) === name).length > 1 ? parts(p).slice(-2).join('/') : name;
    };
    const pick = path => { rememberFolder(path); d.close('picked'); resolve(path); };
    const join = name => (at.value.path.endsWith(at.value.sep) ? at.value.path + name : at.value.path + at.value.sep + name);
    const newFolder = async () => {
      if (!at.value) return false;
      const v = await promptDialog({ title: 'New folder', fields: [{ name: 'name', label: `in ${at.value.path}`, value: '',
        validate: s => (!s ? 'a name' : /[\\/:*?"<>|]/.test(s) ? 'no \\ / : * ? " < > |' : null) }], ok: 'Create' });
      if (!v) return false;
      try { const r = await makeDir(join(v.name)); await go(r.path); } catch (e) { snackbar(e.message, { error: true }); }
      return false;                     // the dialog stays
    };

    const View = () => {
      const l = at.value;
      const recent = recentFolders();
      return h('div', { class: 'ns-folders', 'data-keep-enter': '' },
        note && h('div', { class: 'md-body-medium' }, note),
        h('div', { class: 'ns-folders__path' },
          iconButton('arrow_upward', 'The folder above', () => l?.parent && go(l.parent), '', { disabled: !l?.parent }),
          field({ label: 'Folder', dense: true, mono: true, value: typed.value, oninput: v => { typed.value = v; },
            onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); go(typed.value.trim()); } } })),
        h('div', { class: 'ns-folders__places' },
          (l?.roots ?? []).map(r => h('button', { type: 'button', class: 'ns-folders__place', onclick: () => go(r.path), title: r.path }, icon('disk'), r.name)),
          // a folder chosen before that is gone: out of the list
          recent.map(p => h('button', { type: 'button', class: 'ns-folders__place', title: p,
            onclick: async () => { if (!(await go(p))) { forgetFolder(p); error.value = `${p} is not there any more`; } } },
          icon('history'), recentLabel(p, recent)))),
        error.value && h('div', { class: 'ns-folders__error' }, error.value),
        h('div', { class: 'ns-folders__list', role: 'listbox' },
          !l ? h('div', { class: 'section__hint' }, 'Asking the server …')
            : !l.dirs.length ? h('div', { class: 'section__hint' }, 'No folders in it.')
              : l.dirs.map(x => h('button', { type: 'button', class: `ns-folders__dir ${x.project ? 'ns-folders__dir--project' : ''}`, role: 'option',
                onclick: () => go(join(x.name)), ondblclick: () => x.project && pick(join(x.name)),
                title: x.project ? `${x.name}: a nerdsuite project - a double click opens it` : x.name },
              icon(x.project ? 'code' : 'folder'), h('span', { class: 'ns-folders__name', 'data-i18n': 'off' }, x.name), x.project && h('span', { class: 'ns-folders__tag' }, 'project')))),
        l?.project && h('div', { class: 'section__hint' }, 'This folder is a nerdsuite project.'));
    };

    const d = dialog({
      title, wide: true, content: h(View, {}),
      actions: () => [
        { label: 'New folder…', icon: 'add', onclick: newFolder },
        { label: '§0006', value: null },
        { label: ok, variant: 'filled', onclick: () => { if (!at.value) return false; pick(at.value.path); return false; } },
      ],
      onclose: value => { if (value !== 'picked') resolve(null); },
    });
    go(start ?? recentFolders()[0] ?? '').then(ok => { if (!ok && !at.value) go(''); });
  });
}
