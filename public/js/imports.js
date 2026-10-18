// imports.js - a game in several files (advc/adv/import.go)
//
//   import "demo/hall.adv"          // at the top level of a script
//
// The model stays one list of items: the items of an imported file follow its import node, each
// with _file, the path it is written in (a path of the import, from the directory of the main
// script). The serializer writes every file with its own items (advgen.js, serialize: sources) and
// the compiler gets all of them as one text (serialize inline), which is the game the import
// gives. What the editor makes new goes into the main script.

import { AdvError, parse } from './adv.js';

const IMPORT_RE = /^[ \t]*import[ \t]+"([^"\n]+)"/gm;

// the files a text imports, as written in it
export const importRefs = text => [...new Set([...text.matchAll(IMPORT_RE)].map(m => m[1]))];

// resolveImports: the items of the imported files (texts: Map path -> text) after their imports
export function resolveImports(game, texts) {
  const seen = new Set();
  const expand = (items, file) => {
    const out = [];
    for (const it of items) {
      if (file) it._file = file;
      out.push(it);
      if (it.kind !== 'import') continue;
      if (seen.has(it.path)) throw new AdvError(`'${it.path}' is imported twice`, it.line);
      seen.add(it.path);
      const text = texts?.get(it.path);
      if (text == null) throw new AdvError(`cannot import '${it.path}'`, it.line);
      let sub;
      try {
        sub = parse(text);
      } catch (e) {
        throw new AdvError(`${it.path} line ${e.line ?? '?'}: ${e.plain ?? e.message}`, it.line);
      }
      if (sub.tail) (game.fileTails ??= {})[it.path] = sub.tail;
      out.push(...expand(sub.items, it.path));
    }
    return out;
  };
  game.items = expand(game.items, null);
  return game;
}

// the files of the game: the main script ('') and the imported ones, in the order they are read
export const gameFileList = game => ['', ...game.items.filter(it => it.kind === 'import').map(it => it.path)];
