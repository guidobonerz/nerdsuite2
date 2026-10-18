// songfiles.js - the songs of the project (.sng, the files of the Sound view) for the panels
// that name them: 'music NAME "file.sng"' and 'sound NAME "file.sng"'

import { charsetKey } from './chr.js';
import { listBinaries, onProjectOpen } from './project.js';

export const songKey = charsetKey;                      // the project path of a song named in the script
let files = null;
onProjectOpen(() => { files = null; });

// the songs of the project (project paths); onLoaded: from the time the list came from the server
export function songFiles(onLoaded) {
  files ??= listBinaries().filter(f => /\.sng$/i.test(f)).sort();
  return files;
}

// the sound editor saved a song
export function addSongFile(key) {
  if (files && !files.includes(key)) files = [...files, key].sort();
}
