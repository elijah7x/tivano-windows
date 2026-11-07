// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// test-runner — a tiny --case runner used ONLY by
// harness-control.test.ts to prove the outer-watchdog semantics on any
// platform. It never touches Windows APIs or the real helper.

import { spawn } from "node:child_process";

const a = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i]] = process.argv[i + 1];

const emit = (r) => console.log(`RESULT:${JSON.stringify({ cleanup: "clean", ...r })}`);

switch (a["--case"]) {
  case "late-close": {
    const cp = spawn(process.execPath, ["-e", "setTimeout(()=>{},400)"], {
      stdio: ["ignore", process.stdout, process.stderr],
    });
    cp.unref();
    emit({ pass: true });
    process.exit(0);
  }
  case "unknown-cleanup":
    emit({ pass: true, cleanup: "unknown" });
    break;
  case "bad-plus-good":
    console.log("RESULT:broken");
    emit({ pass: true });
    break;
  case "sleep":
    setTimeout(() => emit({ pass: true, detail: "slept" }), 60000);
    break;
  case "ok":
    emit({ pass: true, detail: "fine" });
    break;
  case "fail":
    emit({ pass: false, detail: "deliberate" });
    break;
  case "silent":
    process.exit(0);
    break;
  case "exit17":
    // RESULT pass then a nonzero exit — MUST be a failed case.
    emit({ pass: true, detail: "claimed" });
    setTimeout(() => process.exit(17), 20);
    break;
  case "two-results":
    emit({ pass: true, detail: "one" });
    emit({ pass: true, detail: "two" });
    break;
  case "bad-result":
    console.log("RESULT:not-json{");
    break;
  case "die-signal":
    process.kill(process.pid, "SIGKILL");
    break;
  case "diag-fail":
    // Reproduces the lead's synthetic runner: diagnostics on stderr, a
    // parsed RESULT carrying a failure sentinel, then a nonzero exit.
    console.error("RUNNER_DIAGNOSTIC_SENTINEL");
    emit({ pass: false, cleanup: "unknown", detail: "CASE_FAILURE_SENTINEL" });
    process.exit(1);
    break;
  case "unicode-overflow":
  case "overflow": {
    emit({ pass: true, detail: "claimed" });
    // Flood stdout past the 4MiB capture bound — evidence must record
    // it. Writes go through drain so process.exit cannot truncate the
    // userland buffer; ending the stream lets the process exit 0.
    let i = 0;
    const pump = () => {
      let ok = true;
      while (i < 80 && ok) { ok = process.stdout.write((a["--case"] === "unicode-overflow" ? "中" : "x").repeat(65536)); i++; }
      if (i < 80) process.stdout.once("drain", pump);
      else process.stdout.end();
    };
    pump();
    break;
  }
  default:
    emit({ pass: false, detail: `unknown case ${a["--case"]}` });
}
