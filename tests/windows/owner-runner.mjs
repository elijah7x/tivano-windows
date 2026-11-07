// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// owner-runner — Windows test harness helper. Stands in for the REAL
// launcher in the owner-death case: reads a spec JSON file, stamps in its
// OWN pid as ownerPid (exactly like makeJobHelperSpawnImpl does), spawns
// the helper and proxies its stdio. The harness kills THIS process to
// prove the helper notices owner death and tears the Job down.

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [helper, specFile] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specFile, "utf8"));
spec.ownerPid = process.pid;
spec.v = 1;
const b64 = Buffer.from(JSON.stringify(spec), "utf8").toString("base64url");
const cp = spawn(helper, ["--serve", b64], { stdio: ["pipe", "pipe", "pipe"] });
cp.once("spawn", () => process.stdout.write(`HELPERPID:${cp.pid}\n`));
cp.once("error", () => { process.exitCode = 1; });
cp.stdin.on("error", () => {});
process.stdin.pipe(cp.stdin);
cp.stdout.pipe(process.stdout);
cp.stderr.pipe(process.stderr);
cp.once("close", (code) => { process.exitCode = code ?? 1; process.stdin.destroy(); });
