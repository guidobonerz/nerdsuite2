// a project as a folder of the computer (project.js openFolder, backend/disk): the files the editors write
// are read again - the versions of the example project are ones this editor reads, and a manifest made of
// them opens the project again (as a folder or a package does)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { migrateFiles, migrateProject, makeManifest, readManifest } from '../public/js/migrate.js';

const ROOT = new URL('../examples/demo/', import.meta.url);
function files(dir = ROOT.pathname.replace(/^\/([a-z]:)/i, '$1')) {
  const out = new Map();
  const walk = d => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else out.set(relative(dir, p).replace(/\\/g, '/'), new Uint8Array(readFileSync(p)));
    }
  };
  walk(dir);
  return out;
}

test('the files of the example are versions this editor reads (the screens with their look: YSCR 3)', () => {
  const all = files();
  assert.ok(all.size > 5);
  assert.doesNotThrow(() => migrateFiles(all));
});

test('a project with the manifest of its own files opens again', () => {
  const all = files();
  const manifest = readManifest(makeManifest(all, 'v-test'));
  const r = migrateProject(all, manifest);
  assert.equal(r.files.size, all.size);
});
