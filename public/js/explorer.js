// explorer.js - the files of the project as a tree, between the rail and the views: a click opens a
// file in the editor of its kind (app.js: open), the file of the open view is marked. It folds to a
// narrow strip and is resized at its right edge; both, and the folded folders, are kept in the browser.

import { h, Fragment, mount, icon, iconButton, openMenu, signal } from './pui.js';
import { allFiles, isOpen, onProjectChange, projectName } from './project.js';

const WIDTH_KEY = 'explorer.width', COLLAPSED_KEY = 'explorer.collapsed', FOLDED_KEY = 'explorer.folded';
const MIN_W = 160, MAX_W = 560, DEFAULT_W = 240;
const load = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const keep = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } };
const clamp = w => Math.round(Math.max(MIN_W, Math.min(w, MAX_W)));

const width = signal(clamp(load(WIDTH_KEY, DEFAULT_W)));
const collapsed = signal(!!load(COLLAPSED_KEY, false));
const folded = signal(new Set(load(FOLDED_KEY, [])));     // 'project/folder' of the folded folders
const version = signal(0);                                  // the files or the open file changed

// the icon of a file by its kind
const KINDS = [
  [/\.(asm|a|s|inc|c|h)$/i, 'code_file'], [/\.bas$/i, 'code'], [/\.(adv|json|cfg|txt)$/i, 'description'],
  [/\.sng$/i, 'music_note'], [/\.(kla|koa|art|png|jpe?g|gif)$/i, 'wallpaper'], [/\.(chr|til)$/i, 'grid_view'],
  [/\.spr$/i, 'person'], [/\.(scr|gfx|map|col)$/i, 'grid_on'],
];
const kindIcon = p => KINDS.find(([re]) => re.test(p))?.[1] ?? 'hashtag';

// the paths as a tree: { dirs: Map name -> node, files: [path] }, folders first, both sorted
function tree(paths) {
  const root = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    for (const d of parts.slice(0, -1)) {
      if (!node.dirs.has(d)) node.dirs.set(d, { dirs: new Map(), files: [] });
      node = node.dirs.get(d);
    }
    node.files.push(p);
  }
  return root;
}

// el: the aside of index.html; open(path, { hex }) opens a file, current() is the file shown
export function createExplorer(el, { open, current }) {
  const key = dir => `${projectName()}/${dir}`;
  const toggle = dir => {
    const next = new Set(folded.value);
    if (next.has(key(dir))) next.delete(key(dir)); else next.add(key(dir));
    folded.value = next;
    keep(FOLDED_KEY, [...next]);
  };
  const setCollapsed = on => { collapsed.value = on; keep(COLLAPSED_KEY, on); };
  const menu = (e, path) => {
    e.preventDefault();
    openMenu(e.currentTarget, [
      { label: 'Open', icon: 'open_in_new', onclick: () => open(path) },
      { label: 'Open in the hex view', icon: 'hashtag', onclick: () => open(path, { hex: true }) },
    ]);
  };

  const rows = (node, dir, depth, shown) => [
    ...[...node.dirs.keys()].sort().flatMap(name => {
      const path = dir ? `${dir}/${name}` : name, isFolded = folded.value.has(key(path));
      return [
        h('button', { class: 'explorer__row explorer__row--dir', type: 'button', style: { paddingLeft: `${8 + depth * 14}px` },
          'aria-expanded': String(!isFolded), title: path, onclick: () => toggle(path) },
        icon(isFolded ? 'chevron_right' : 'expand_more', 'explorer__chevron'), icon(isFolded ? 'drive_file_move' : 'folder_open'),
        h('span', { class: 'explorer__name', 'data-i18n': 'off' }, name)),
        ...(isFolded ? [] : rows(node.dirs.get(name), path, depth + 1, shown)),
      ];
    }),
    ...node.files.sort().map(path => h('button', {
      class: `explorer__row ${path === shown ? 'explorer__row--active' : ''}`, type: 'button', style: { paddingLeft: `${22 + depth * 14}px` },
      title: path, onclick: () => open(path), oncontextmenu: e => menu(e, path) },
    icon(kindIcon(path)), h('span', { class: 'explorer__name', 'data-i18n': 'off' }, path.split('/').at(-1)))),
  ];

  // the right edge: dragged it resizes the explorer, a double click gives it its own width, the arrow keys move it
  const grip = () => h('div', { class: 'explorer__resize', tabindex: '0', role: 'separator', 'aria-orientation': 'vertical',
    'aria-label': 'Resize the files', 'data-tip': 'Drag to resize, double click: its own width',
    onpointerdown: e => {
      e.preventDefault();
      const g = e.currentTarget, x0 = e.clientX, w0 = width.value;
      g.setPointerCapture(e.pointerId);
      document.body.classList.add('col-resizing');
      const move = ev => { width.value = clamp(w0 + ev.clientX - x0); };
      const stop = () => {
        g.removeEventListener('pointermove', move);
        g.removeEventListener('pointerup', stop);
        g.removeEventListener('pointercancel', stop);
        document.body.classList.remove('col-resizing');
        keep(WIDTH_KEY, width.value);
      };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', stop);
      g.addEventListener('pointercancel', stop);
    },
    ondblclick: () => { width.value = DEFAULT_W; keep(WIDTH_KEY, DEFAULT_W); },
    onkeydown: e => {
      const step = { ArrowLeft: -24, ArrowRight: 24 }[e.key];
      if (!step) return;
      e.preventDefault();
      width.value = clamp(width.value + step);
      keep(WIDTH_KEY, width.value);
    } });

  const view = () => {
    version.value;                                            // eslint-disable-line no-unused-expressions
    // the column of the grid (app.css): the strip when folded
    document.documentElement.style.setProperty('--explorer-w', collapsed.value ? '40px' : `${width.value}px`);
    el.classList.toggle('explorer--collapsed', collapsed.value);
    if (!isOpen()) return null;
    if (collapsed.value) {
      return h('div', { class: 'explorer__strip' },
        iconButton('right_panel_close', 'Show the files', () => setCollapsed(false)),
        h('span', { class: 'explorer__strip-label' }, 'Files'));
    }
    const files = allFiles();
    return h(Fragment, {},
      h('div', { class: 'explorer__head' },
        h('span', { class: 'explorer__title', title: projectName(), 'data-i18n': 'off' }, projectName()),
        iconButton('right_panel_open', 'Hide the files', () => setCollapsed(true))),
      h('div', { class: 'explorer__tree', role: 'tree' },
        files.length ? rows(tree(files), '', 0, current()) : h('div', { class: 'explorer__empty' }, 'No files')),
      grip());
  };

  const m = mount(el, view);
  onProjectChange(() => { version.value++; });
  return { refresh: () => { version.value++; }, dispose: m.dispose };
}
