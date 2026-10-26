import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORMS, platformOf, platformKin, canDebug, starterAsm } from '../public/js/platforms.js';
import { symbolsFor } from '../public/js/memmap.js';
import { videoOf } from '../public/js/video.js';
import { assemble } from '../public/js/acme/acme.js';

// the machines and models of mimic (crates/machine-*: entry())
const MODELS = { atari8: ['800xl', '65xe', '130xe', '800', '400'], zx81: ['zx81', 'ts1000'], amiga: ['500', '1000', '2000'], atari2600: [undefined], cpc: ['464', '6128'] };

test('every platform mimic runs names a machine and a model mimic has', () => {
  for (const p of PLATFORMS.filter(x => x.mimic && x.family !== 'commodore')) {
    assert.ok(MODELS[p.mimic.machine], `${p.id}: mimic machine ${p.mimic.machine}`);
    assert.ok(MODELS[p.mimic.machine].includes(p.mimic.model), `${p.id}: model ${p.mimic.model}`);
    assert.ok(canDebug(p), p.id);
  }
});

test('the models of the Atari and the ZX81 are like their machine: memory map, graphics, starter', () => {
  for (const [id, kin] of [['atari65xe', 'atari8'], ['atari130xe', 'atari8'], ['atari800', 'atari8'], ['ts1000', 'zx81']]) {
    assert.equal(platformKin(id), kin);
    assert.equal(symbolsFor(id).list.length, symbolsFor(kin).list.length, id);
    assert.deepEqual(videoOf(id).screen, videoOf(kin).screen, id);
    const p = platformOf(id);
    const r = assemble('main.asm', { 'main.asm': starterAsm(p) }, { cpu: p.cpu });
    assert.deepEqual(r.errors, [], id);
    assert.equal(r.format, platformOf(kin).format, id);
  }
  assert.equal(platformKin('c64'), 'c64');
});
