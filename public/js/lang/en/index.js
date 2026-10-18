// en/index.js - the English texts of the editor's UI: a label (§0001) and its text, a pattern with
// {0}, {1} for the values the code hands t(). The sources name the texts by their labels; de/ and
// tlh/ have the same labels. The game is not translated.
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
import remove from './remove.js';
import sequence from './sequence.js';
import compiler from './compiler.js';
import files from './files.js';
import editor from './editor.js';

export default { ...model, ...app, ...board, ...inspector, ...draw, ...sprites, ...more, ...chapters, ...joined, ...common, ...ui, ...play, ...wizard, ...tiles, ...pixels, ...remove, ...sequence, ...compiler, ...files, ...editor };
