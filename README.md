# NerdSuite

An IDE in the browser for programs of 8 bit machines: the Commodore family (C64, C128, VIC-20, Plus/4, C16, PET) and the MEGA65, the Atari 8-bit computers and the Atari 2600, the Amstrad / Schneider CPC, the Nintendo NES and SNES, the Sinclair ZX81, the Tandy TRS-80 Model I and III and the BBC Micro. It has the layout, look and feel of [yopaca](../yopaca) and takes its graphics editors and its composer; in place of yopaca's story it has a tabbed code editor for assembler and BASIC, and a debugger that drives the VICE or the mimic emulator.

| View | What it does |
|---|---|
| **Code** | The sources in tabs: ACME assembler (`.asm .a .s .inc`) and BASIC (`.bas`) in the dialect of the file. Colours, autocompletion, the errors of the build, breakpoints in the gutter, an outline. |
| **Debugger** | The program in VICE through its binary remote monitor, or in mimic through its own debug protocol: breakpoints, watchpoints, stepping, registers, memory, disassembly, watches, the screen. |
| **Screen** | yopaca's screen editor: char screens of 25 rows, 40 to 120 columns, charsets, multicolor, ECM, layers and their animations. No objects, walk or behind areas. |
| **Sprites** | yopaca's sprite editor: sprites with frames, layers and animations, hires and multicolor, several sprites wide. |
| **Chars** | yopaca's char editor: 256 chars of a charset, tiles of chars, char animations. |
| **Tiles** | yopaca's tile editor: tilesets of 2 × 2 or 3 × 3 chars. |
| **Bitmap** | yopaca's bitmap editor: Koala (multicolor) and Art Studio (hires) pictures. |
| **Composer** | yopaca's SID tracker with GoatTracker's tables, import of GoatTracker songs, SID tunes and MIDI files. |
| **Hex** | Any file of the project or of the last build - or one from outside, dropped on the view or opened from the disk (read only, added to the project with a click) - as bytes: hex and ASCII, PETSCII, screen codes or ATASCII side by side, editing, insert and delete, fill, find, copy as ACME source, the bytes at the cursor as numbers and as code. |
| **Disassembler** | A program of the project or of the last build, or any binary dropped on the view or opened from the disk (its machine taken from a cartridge, or chosen): the disassembly on the left, the bytes on the right. **Auto** traces the code from its entry points (the SYS of the BASIC line, the load address, the vectors of a .nes, .sfc or .a26 cartridge, entries of your own); drag over the bytes and mark them as code or as data - bytes, words, text (ASCII, PETSCII, screen codes), chars, sprites, a bitmap, tiles. The registers and ROM routines of the machine name the operands (`sta VIC_BORDER`, `jsr CHROUT`), and a value stored to a register is told in words (`; $1b: y scroll 3 · rows 25 · screen on`); the side panel shows the register of the line with all its bits, and previews the bytes as chars, sprites or a bitmap (hires or multicolor) or as the tiles of the NES and the SNES (2 and 4 bits). Labels for jumps and data, follow a jump with Enter; copy or save the disassembly as ACME source that assembles to the same bytes. |
| **Problems** | The errors and warnings of the last build. |

## Start

```sh
nerdsuite                     # a binary of a release (a double click): the server, and the IDE in a window of its own
nerdsuite --port 8080         # another port (a port that is taken: the next free one); --no-browser: the server only
npm start                     # from a checkout: go run ./cmd/nerdsuite --root . (the files of the checkout), http://localhost:3064
npm run build                 # bin/nerdsuite(.exe): the server with the IDE built in
npm run dist                  # the binaries of every system into build/dist (tools/dist.mjs; packed with UPX when it is there)
npm test                      # the tests of the IDE: the assembler, the BASIC tokenizer, the languages (Node)
npm run test:go               # the tests of the server (Go): VICE, the emulators, KickAssembler, the toolchains
VICE_TEST=1 go test ./backend/vice/   # also the test that starts VICE for real
MIMIC_TEST=1 go test ./backend/mimic/ # also the test that starts mimic-headless for real
node tools/handbook-shots.mjs # the screenshots of the handbook (a headless Chrome and a server, see the file)
```

The handbook - the Code view, the debugger, the disassembler, the hex view and the settings - is in `public/handbook/en/` and `public/handbook/de/`; the menu opens it (the book next to each language).

macOS: the binary of a release is not notarized (no Developer ID), so a downloaded one has to be made executable and freed from the quarantine once (the `.tar.gz` of the release keeps the executable bit):

```sh
chmod +x nerdsuite-v0.1beta-macos
xattr -d com.apple.quarantine nerdsuite-v0.1beta-macos
./nerdsuite-v0.1beta-macos
```

Linux: a download loses the executable bit too - `chmod +x nerdsuite-v0.1beta-linux-amd64` (or the `.tar.gz` of the release). Windows: the `.exe` is not signed, so SmartScreen stops its first start ("Windows protected your PC"): **More info**, then **Run anyway** - or unblock it once with `Unblock-File .\nerdsuite-v0.1beta-windows-amd64.exe` (or **Unblock** in its Properties).

The server is written in Go (`backend/`, `cmd/nerdsuite`) and holds the IDE: one file of about 6 MB per system, nothing to install. A release (a tag `v*`) builds them on GitHub Actions (`.github/workflows/ci.yml`): Windows, Linux (amd64 and arm64) and macOS (one file for Apple silicon and Intel). Started, it opens the IDE in an app window of Edge, Chrome, Brave, Chromium or Vivaldi: no tabs, no address bar (only without any of them, in the default browser). The window has a browser profile of its own (`~/.nerdsuite/browser`): not the tabs, the session and the extensions of the browser you browse with - and the projects of the IDE are kept there (a project of an older version, kept in your browser's profile: Export it there, Import it in the app window). The Windows file opens no console window; on Linux and macOS a double click leaves the terminal. Without a console the server ends when the last window of the IDE is closed, and a second start opens a window of the running one. From a checkout: **Go 1.24+** for the server, **Node.js 20+** for the tests of the IDE (nothing from npm). For Run and Debug **VICE 3.5 or newer** (the binary remote monitor): the server looks for it in the folder of the environment variable `VICE`, else in `PATH`. Or **mimic** (`mimic.exe` with its `roms` folder): the setting or the environment variable `MIMIC`, else `~/applications/mimic`. For KickAssembler sources **KickAss.jar** and **Java** (see *The assemblers*).

The server serves the IDE, the example project (`examples/demo`) and the bridges to VICE and the other tools (`backend/`). It keeps no project: the project lives in the browser tab (IndexedDB, like yopaca) and is saved as a package `NAME.nsp` (a zip) with **Export** - or it is a folder of your computer: **File › Open folder…** opens one, **File › Save to a folder…** puts the project into one. The server reads its files and writes every change back a moment later (`backend/disk`), so git, another editor and the file manager see the same files; a reload reads the folder again. Only the page of the server itself may use these requests (not another site, not another name of the address). Assembling and tokenizing happen in the browser.

## Platforms

| Family | Machines | CPU | BASIC | Output | Runs in |
|---|---|---|---|---|---|
| Commodore | C64, C128, VIC-20, Plus/4, C16, PET | 6510 / 6502 | V2, Simons', 7.0, 3.5, 4.0 | .prg | mimic or VICE: run **and debug** |
| Atari | 800 XL / 130 XE | 6502 | Atari BASIC, Turbo-Basic XL | .xex (binary load file) | mimic: run **and debug**; Altirra (or atari800) |
| Atari | 2600 (VCS) | 6507 | - | .a26 cartridge | mimic: run **and debug**; Stella (or MAME) |
| Amstrad / Schneider | CPC 464, CPC 6128 | Z80 | Locomotive BASIC | AMSDOS binary on a .dsk | mimic: run **and debug**; WinAPE (or Caprice32) |
| Nintendo | NES | 6502 (2A03) | - | .nes cartridge (iNES, mapper 0) | Mesen, FCEUX, Nestopia (or MAME) |
| Nintendo | SNES | 65816 | - | .sfc cartridge (LoROM, 32K) | Mesen, bsnes, Snes9x (or MAME) |
| Sinclair | ZX81 (16K) | Z80 | ZX81 BASIC | .p file (code in a 1 REM line at $4082) | EightyOne (or ZEsarUX) |
| Tandy / Radio Shack | TRS-80 Model I, Model III | Z80 | Level II BASIC | /CMD file | trs80gp (or MAME) |
| Acorn | BBC Micro Model B | 6502 | BBC BASIC II | a .ssd disc that boots it | BeebEm, b2 (or MAME) |

The assembler is the same for all of them: ACME's syntax, with `!cpu z80` for the CPC and `!cpu 65816` for the SNES (long addresses, `[dp]`, `sr,s`, `mvn`/`mvp`, `brl`; `!al`/`!as` and `!rl`/`!rs` set the size of the immediates, as ACME's). `!to` picks the output (`cbm`, `plain`, `xex`, `amsdos`, `zx81`, `trs80`); without it the platform's. Two pseudo ops are nerdsuite's own: `!run ADDR` (the RUNAD segment of a .xex, the exec address of an AMSDOS header) and `!init ADDR` (INITAD). Atari BASIC, Locomotive BASIC, Level II BASIC and BBC BASIC are not tokenized: the build gives the listing the machine ENTERs or LOADs as text (the BBC: !BOOT of the disc types it in). ZX81 BASIC is: the build makes a .p file (its keywords as tokens, the numbers as 5 byte floats; `{$xx}` for the block graphics, `{inv}`...`{/inv}` for inverse letters). The debugger needs VICE's binary monitor or mimic: the other platforms run in their emulator, found by the environment variables `ALTIRRA`, `STELLA`, `WINAPE`, `MESEN` (or `ATARI800`, `CAPRICE`, `FCEUX`, `NESTOPIA`, `BSNES`, `SNES9X`, `MAME`), `EIGHTYONE` or `ZESARUX`, `TRS80GP`, `BEEBEM` or `B2`. The 64K of the assembler hold a NES cartridge of mapper 0 and the first 32K bank of a SNES ROM. The graphics editors and the composer make Commodore data (VIC-II, SID); for the other machines the hex view and the exports give the bytes.

## A new project

**New project** opens the wizard, in the manner of yopaca's: the machine (family and model), the project and its first programs - assembler, BASIC in a dialect of the machine, which is the main program - the graphics and the sound to start with (a charset copied from the ROM, a title screen, a sprite, a song, a bitmap), and a summary of the files. Create on any step makes the project of what is filled in so far.

## A project

```
nerdsuite.json      the settings: the machine, the main program, the dialect of each BASIC file, the CPU, the marks of the Disassembler
assets.json         the graphics model, kept by the IDE: the charset and the sprites with their
                    animations (JSON); the art is in gfx/, every screen a file of its own
src/                the sources: .asm .a .s .inc .bas
gfx/screen/         screens (.scr)              gfx/charset/   charsets (.chr, 2048 bytes)
gfx/sprite/         sprites (.spr)              gfx/tiles/     tilesets (.til)
gfx/bitmap/         pictures (.kla, .art)       audio/music/   songs (.sng)
```

A source includes the graphics with `!binary`: a charset is the raw 2048 bytes (`!binary "../gfx/charset/chars.chr"`); for screens, sprites and pictures the **Export** button of each editor writes the raw formats (screen and color RAM, sprite blocks of 64 bytes, Koala) to put next to the sources.

## Code

- **Tabs:** a click opens, the middle button or × closes, the right button renames, makes the main program or deletes. The flag in the bar makes the file the **main program** - what Build, Run and Debug make; without one the source in the editor.
- **Autocompletion** (Ctrl+Space, and while typing):
  - assembler: the mnemonics of the CPU (`!cpu`, the select in the bar: 6502, 6510 with the illegal opcodes, 65C02 …), every pseudo op of ACME with its syntax and a description, the labels, constants and macros of all sources of the project and the symbols of the last build (`+` lists the macros);
  - BASIC: the keywords of the dialect with their syntax, the `{control codes}` in strings (`{clr}`, `{wht}`, `{rvs on}` …), and the line numbers after `GOTO`, `GOSUB`, `THEN`.
- **Keys:** Ctrl+click on a label or macro goes to its definition, Ctrl+/ comments lines in or out, Tab and Shift+Tab indent, Enter keeps the indent (BASIC: proposes the next line number). The bar renumbers a BASIC program, with its jumps.
- **BASIC dialects:** BASIC V2 (C64, VIC-20), 4.0 (PET), 3.5 (C16, Plus/4), 7.0 (C128) and Simons' BASIC - tokens as VICE's `petcat` writes them.

## The assemblers

A project has two assemblers: **ACME** (the default) and **KickAssembler**. The select in the bar of the Code view sets it for the file shown (`assemblers` in `nerdsuite.json`; `assembler` is the project's own, the wizard sets it). New source files are made for either one.

**KickAssembler** is the real one: the server runs `KickAss.jar` (Java) on a copy of the project's files (`backend/kickass`), with the project folder as its library folder, so `#import "lib/macros.asm"` and `.import binary "../gfx/charset/font.chr"` work. Its errors come with file, line and column (`-asminfo`); the source line of every address (`-debugdump`, macro bodies included) gives breakpoints and the source lines of the debugger, `-vicesymbols` the labels, `-bytedumpfile` the listing. The editor colours its syntax (`//` and `/* */` comments, `.directives`, `#import`, `!multi:` labels, macro calls) and completes its mnemonics, directives, preprocessor directives, its whole library (`LoadBinary`, `LoadSid`, `sin`, `BLACK` …, from `public/js/kickass/docs.js`: `node tools/kickass-docs.mjs` makes it anew from the installed version, through a running server) and the labels, constants, macros, functions and pseudo commands of the project's KickAssembler sources. It writes `.prg` files: Commodore machines only. Where the jar is: env `KICKASS` (the jar or its folder), else `~/applications/KickAss/KickAss.jar` or `~/KickAss/KickAss.jar`; Java: env `JAVA` or `JAVA_HOME`, else `PATH`.

**ACME:** `public/js/acme/` is an assembler compatible with **ACME 0.97**, in JavaScript: multi-pass, global, zone-local (`.x`), cheap (`@x`) and anonymous (`+`, `-`) labels, macros with references, `!for`, `!do`, `!if`, `!pseudopc`, `!binary`, `!source`, the text conversions, `!to` with cbm/plain, the illegal opcodes of the NMOS 6502 and the 65C02. The build also gives the VICE label list and a listing (Export, in the Code view).

## The debugger

**Run** (F5) builds the main program and starts it in VICE or mimic - the one chosen in the Settings (*Emulator per platform*), else mimic when it is found, else VICE; **Debug** (F6) does the same with the breakpoints and opens the Debugger view. mimic runs and debugs the Atari 800 XL, the Atari 2600 and the CPC too: there Run uses mimic when it is chosen in the Settings or none is, Debug whenever mimic is found. A Commodore .prg and an Atari .xex go into mimic's program slot (into the RAM, RUN for a BASIC program; the .xex loaded as DOS does); a 2600 cartridge (.a26) goes into mimic's cartridge slot and the console powers up; a CPC binary is put into the RAM once BASIC is up and started with `CALL`, a Locomotive BASIC listing goes onto a disc in drive A and is started with `RUN"` (the 6128 - the 464 has no drive); an Atari BASIC listing is typed in after a cold start into BASIC, then `RUN` (letters as capitals, as the Atari types them with caps lock on). The debugger shows the Z80's registers, flags and stack for the CPC. Click a line number of an assembler source for a breakpoint - it is a checkpoint of the emulator at the address of the line, set again after each build. While the CPU is stopped:

| Key | |
|---|---|
| F8 / F5 | continue (F8 pauses while it runs) |
| F10 | step over (a JSR as one step) |
| F11 | step into |
| Shift+F11 | step out: run until RTS |

The view shows the registers and flags (editable), the stack, the disassembly around the PC with the labels and source lines of the build (a dot sets a breakpoint), the memory as hex and PETSCII in every bank (double click a byte to change it), breakpoints and watchpoints (exec, read, write, a range, a condition such as `A == $10`, once), watches of labels and addresses, the screen of the emulator and a log. A BASIC program shows the line the interpreter is at.

## Files

| file | content |
|---|---|
| `cmd/nerdsuite`, `embed.go` | the program: the server with the IDE (`public/`) and the example project built in; flags, the browser |
| `backend/server.go`, `settings_api.go` | static files, `/api/info`, `/api/examples`, the routes of the parts, the settings of the tools |
| `backend/core` | what the parts share: JSON answers, errors, the tools found, the settings file |
| `backend/vice` | the binary remote monitor of VICE: the codec, the process and connection, the HTTP and event-stream API |
| `backend/mimic` | mimic and its debug protocol (JSON lines): the process and connection, the checkpoints, the same HTTP and event-stream API as VICE's under `/api/mimic` |
| `public/js/app.js` | the shell: the project, the views, Save, Build, Run, Debug, routes, keys |
| `public/js/codeview.js`, `codeeditor.js` | the Code view and its editor surface |
| `public/js/lang-acme.js`, `lang-basic.js` | colours and completion of the languages |
| `public/js/acme/` | the ACME compatible assembler and its documentation data |
| `public/js/basic/` | the BASIC tokenizer and its dialects |
| `public/js/nsbuild.js` | the project settings, the build, the debug info (addresses ↔ lines) |
| `public/js/vice.js`, `debugview.js` | the debugger: the browser side of VICE and mimic, the Debugger view |
| `backend/kickass` | KickAssembler on the server: `/api/kickass/status`, `/info`, `/assemble` |
| `public/js/lang-kickass.js`, `public/js/kickass/docs.js` | colours and completion of KickAssembler; its directives and library |
| `public/js/platforms.js` | the machines: CPU, BASIC, output, start address, emulator, the starter programs |
| `public/js/memmap.js` | the addresses of every machine - the graphics, sound and I/O chips, ROM routines, vectors, RAM areas - and the meanings of the bits of the registers; a new assembler project gets them as `src/hardware.inc` |
| `public/js/nswizard.js` | the project wizard |
| `public/js/hexview.js` | the Hex view |
| `public/js/extfiles.js` | the files from outside the project, dropped or opened from the disk, for the Hex view and the Disassembler |
| `public/js/disasm.js`, `disasmview.js` | the Disassembler: code and data of a binary, labels, ACME source; the view and its preview |
| `backend/emu` | Altirra, Stella, WinAPE and the others: run a build; a CPC disk image, a BBC .ssd disc |
| `backend/toolchain`, `backend/ultimate` | the toolchains (compiler › packer › emulator); run on an Ultimate 64 |
| `tools/dist.mjs`, `tools/smoke.mjs` | the binaries of every system; a binary started and checked |
| `tools/cdp.mjs` | drives a headless Chrome for checks of the UI |
| the rest of `public/js/` | the editors of yopaca and what they need (see yopaca's README) |
