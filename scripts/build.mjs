// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Deterministic esbuild pipeline: main + preload as single CommonJS files
// (sandboxed preload must be CJS), renderer as a browser bundle, plus the
// static shell copied verbatim. No watch mode, no dev server.
//
// --terminal-candidate: COMPILE-TIME only. Bakes TIVANO_TERMINAL_CANDIDATE
// as a `true` literal into the MAIN bundle — the Windows terminal
// validation candidate. Ordinary builds omit the define entirely (the
// identifier stays `undefined`; no environment variable, settings key or
// IPC flag can mint it).

import { build } from "esbuild";
import { mkdirSync, copyFileSync, chmodSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "dist");
if (process.platform === "darwin") {
  const helper = join(root, "node_modules/node-pty/prebuilds", `darwin-${process.arch}`, "spawn-helper");
  chmodSync(helper, statSync(helper).mode | 0o111);
}

mkdirSync(join(out, "main"), { recursive: true });
mkdirSync(join(out, "preload"), { recursive: true });
mkdirSync(join(out, "renderer"), { recursive: true });

const terminalCandidate = process.argv.includes("--terminal-candidate");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: [join(root, "src/main/index.ts")],
  outfile: join(out, "main/index.cjs"),
  external: ["electron"],
  // Main bundle only: the candidate flag is baked into the one place the
  // gate is enforced. Preload/renderer never see the identifier.
  ...(terminalCandidate
    ? { define: { TIVANO_TERMINAL_CANDIDATE: "true" } }
    : {}),
});

await build({
  ...common,
  entryPoints: [join(root, "src/preload/index.ts")],
  outfile: join(out, "preload/index.cjs"),
  external: ["electron"],
});

// PTY host: runs inside Electron utilityProcess.fork — node-pty stays
// external so the native binding resolves from node_modules at runtime
// (its N-API prebuild is loaded, never bundled).
await build({
  ...common,
  entryPoints: [join(root, "src/main/ptyHost.ts")],
  outfile: join(out, "main", "ptyHost.cjs"),
  external: ["node-pty"],
});

await build({
  bundle: true,
  platform: "browser",
  target: "chrome126",
  format: "iife",
  sourcemap: true,
  logLevel: "warning",
  entryPoints: [join(root, "src/renderer/main.tsx")],
  outfile: join(out, "renderer/renderer.js"),
});

for (const f of ["index.html", "styles.css"]) {
  copyFileSync(join(root, "src/renderer", f), join(out, "renderer", f));
}

console.log("built dist/{main,preload,renderer}");
