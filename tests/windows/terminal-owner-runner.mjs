// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// terminal-owner-runner — Windows test harness helper for --terminal
// mode. Same role as owner-runner.mjs (which drives --serve): stands in
// for the REAL launcher in the owner-death case — reads a TerminalSpec
// JSON file, stamps in its OWN pid as ownerPid (exactly like
// windowsTerminalHost.ts does), spawns the helper in --terminal mode and
// proxies its NDJSON stdin/stdout verbatim. The harness kills THIS
// process to prove the helper notices owner death and tears the
// session's Job down.

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [helper, specFile] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specFile, "utf8"));
spec.ownerPid = process.pid;
spec.v = 1;
const b64 = Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");
const cp = spawn(helper, ["--terminal", b64], { stdio: ["pipe", "pipe", "pipe"] });
cp.once("spawn", () => process.stdout.write(`HELPERPID:${cp.pid}\n`));
cp.once("error", () => { process.exitCode = 1; });
cp.stdin.on("error", () => {});
process.stdin.pipe(cp.stdin);
cp.stdout.pipe(process.stdout);
cp.stderr.pipe(process.stderr);
cp.once("close", (code) => { process.exitCode = code ?? 1; process.stdin.destroy(); });
