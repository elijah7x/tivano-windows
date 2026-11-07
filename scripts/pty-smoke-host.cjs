// PTY smoke host — runs inside an Electron utility process (or a
// child_process.fork with ELECTRON_RUN_AS_NODE). Loads the REAL node-pty
// native module, spawns one isolated PTY, round-trips a marker through
// the shell, then proves a clean exit. Emits JSON lines on stdout so the
// launcher can record evidence — no text the harness greps blindly.
"use strict";

const report = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const versions = {
  electron: process.versions.electron ?? null,
  node: process.versions.node,
  modules: process.versions.modules,
  napi: process.versions.napi ?? null,
  platform: process.platform,
  arch: process.arch,
  runAsNode: !!process.env.ELECTRON_RUN_AS_NODE,
};

let pty;
try {
  pty = require("node-pty");
  report({ kind: "native-load", ok: true, versions });
} catch (err) {
  report({ kind: "native-load", ok: false, versions, error: String(err) });
  process.exit(17);
}

const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const home = mkdtempSync(join(tmpdir(), "tivano-ptysmoke-"));
const MARKER = `PTY_SMOKE_${process.pid}_✓漢字`;

const term = pty.spawn("/bin/zsh", ["-f", "-c", `printf '%s\\n' '${MARKER}'; read -r _; exit 7`], {
  name: "xterm-256color",
  cols: 97,
  rows: 31,
  cwd: home,
  env: { HOME: home, TMPDIR: home, TERM: "xterm-256color", PATH: "/usr/bin:/bin" },
});

let buf = "";
let sawMarker = false;
term.onData((d) => {
  buf += d;
  if (!sawMarker && buf.includes(MARKER)) {
    sawMarker = true;
    // feed the pending `read` so the shell can exit on its own
    term.write("\n");
  }
});
term.onExit(({ exitCode, signal }) => {
  report({
    kind: "exit",
    exitCode,
    signal,
    sawMarker,
    pid: term.pid,
    bytes: buf.length,
    cols: term.cols,
    rows: term.rows,
  });
  process.exit(sawMarker && exitCode === 7 ? 0 : 18);
});

setTimeout(() => {
  report({ kind: "timeout", sawMarker, buf: buf.slice(0, 400) });
  try { term.kill(); } catch { /* best effort */ }
  process.exit(19);
}, 10000);
