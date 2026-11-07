// Electron main for the PTY native-load smoke: forks the smoke host as a
// utilityProcess (preferred; real Electron utility-process native loading)
// and relays its JSON evidence lines. Exits with the host's verdict.
"use strict";

const { app, utilityProcess } = require("electron");
const { join } = require("node:path");

const mode = process.env.PTY_SMOKE_MODE ?? "utility";

app.whenReady().then(() => {
  const hostPath = join(__dirname, "pty-smoke-host.cjs");
  let child;
  if (mode === "utility") {
    child = utilityProcess.fork(hostPath, [], { stdio: "pipe" });
  } else {
    const { fork } = require("node:child_process");
    child = fork(hostPath, [], {
      stdio: "pipe",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
  }
  child.stdout.on("data", (d) => process.stdout.write(`[host] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[host:err] ${d}`));
  child.on("exit", (code, signal) => {
    console.log(`[smoke] host exit code=${code} signal=${signal} mode=${mode}`);
    app.exit(code ?? 20);
  });
  setTimeout(() => {
    try { child.kill(); } catch { /* best effort */ }
    app.exit(21);
  }, 20000);
});
