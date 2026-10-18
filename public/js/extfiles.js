// extfiles.js - binaries from outside the project, dropped on the Hex view or the Disassembler or
// opened from the disk, to look at them: kept in the tab while it is open as 'ext:NAME' (a file of the
// same name dropped again replaces it), added to the project when asked.

import { promptDialog, snackbar } from './pui.js';
import { hasFile, writeBinary, BINARY_EXT } from './project.js';

export const EXT = 'ext:';
const MAX = 16 * 1024 * 1024;
const files = new Map();

export const isExternal = p => !!p?.startsWith(EXT);
export const externalFiles = () => [...files.keys()].map(n => EXT + n);
export const readExternal = p => files.get(String(p).slice(EXT.length)) ?? null;
export const fileLabel = p => (p.startsWith('build:') ? `${p.slice(6)} (build)` : isExternal(p) ? `${p.slice(EXT.length)} (dropped)` : p);

// the files of a drop or of the file picker, read: their paths ('ext:NAME')
export async function addExternal(list) {
  const paths = [];
  for (const f of list) {
    if (f.size > MAX) { snackbar(`${f.name} is larger than 16 MB`, { error: true }); continue; }
    files.set(f.name, new Uint8Array(await f.arrayBuffer()));
    paths.push(EXT + f.name);
  }
  return paths;
}

// a file from the disk: its path, or null
export function pickFile() {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file' });
    input.onchange = async () => resolve((await addExternal(input.files))[0] ?? null);
    input.click();
  });
}

// the element takes dropped files: onfiles(paths) with the first of them opened by the view
export function dropTarget(el, onfiles) {
  const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files');
  let depth = 0;
  el.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; el.classList.add('ns-drop--over'); } });
  el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('ns-drop--over'); } });
  el.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  el.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    el.classList.remove('ns-drop--over');
    const paths = await addExternal(e.dataTransfer.files);
    if (paths.length) onfiles(paths);
  });
}

// a dropped file into the project: its path there, or null
export async function addToProject(path) {
  const name = path.slice(EXT.length), ext = (/\.[^.]*$/.exec(name)?.[0] ?? '').toLowerCase();
  const stem = name.replace(/\.[^.]*$/, '').replace(/[^\w-]/g, '_') || 'file';
  const v = await promptDialog({ title: 'Add to the project', ok: 'Add', fields: [
    { name: 'path', label: 'Path', value: `data/${stem}${BINARY_EXT.includes(ext) ? ext : '.bin'}`, mono: true,
      validate: p => (!/^[\w./-]+$/.test(p) || !BINARY_EXT.includes((/\.[^.]*$/.exec(p)?.[0] ?? '').toLowerCase()) ? `a path ending in ${BINARY_EXT.join(' ')}` : hasFile(p) ? 'there is such a file' : null) }] });
  if (!v) return null;
  writeBinary(v.path, readExternal(path));
  snackbar(`${v.path} added to the project`);
  return v.path;
}
