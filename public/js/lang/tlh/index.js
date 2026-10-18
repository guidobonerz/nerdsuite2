// tlh/index.js - the Klingon (tlhIngan Hol) texts of the editor's UI (see ../../i18n.js), in the
// Latin spelling of Marc Okrand. The parts are those of ../de, with the same English texts; a
// text that several parts have is the one of the later part, and core.js wins over all of them.
// Technical words Klingon has no word for (sprite, PETSCII, SID) stay as they are. The game is not translated.
import model from './model.js';
import app from './app.js';
import board from './board.js';
import inspector from './inspector.js';
import draw from './draw.js';
import sprites from './sprites.js';
import more from './more.js';
import chapters from './chapters.js';
import joined from './joined.js';
import common from './common.js';
import ui from './ui.js';
import play from './play.js';
import wizard from './wizard.js';
import tiles from './tiles.js';
import pixels from './pixels.js';
import core from './core.js';
import remove from './remove.js';
import sequence from './sequence.js';
import compiler from './compiler.js';
import files from './files.js';
import editor from './editor.js';

export default { ...model, ...app, ...board, ...inspector, ...draw, ...sprites, ...more, ...chapters, ...joined, ...common, ...ui, ...play, ...wizard, ...tiles, ...pixels, ...core, ...remove, ...sequence, ...compiler, ...files, ...editor };
