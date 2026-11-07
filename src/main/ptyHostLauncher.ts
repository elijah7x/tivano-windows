// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Production factory for PTY host processes: one Electron
// utilityProcess.fork per terminal incarnation. The host module never runs
// as node-in-electron and never inside the renderer — the native node-pty
// binding stays confined to this dedicated process so a native crash or a
// wedged PTY cannot take the main process down with it.

import { utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
import type { TerminalHostHandle } from "./terminalService";

const modulePath = (): string => join(__dirname, "ptyHost.cjs");

export function forkPtyHost(): TerminalHostHandle {
  const child: UtilityProcess = utilityProcess.fork(modulePath(), [], {
    // Host stdio is diagnostic only — nothing on it drives correctness.
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();

  const msgCbs = new Set<(m: unknown) => void>();
  const exitCbs = new Set<(code: number | null) => void>();
  let fired = false;
  let exitCode: number | null = null;
  child.on("message", (m: unknown) => {
    for (const cb of msgCbs) cb(m);
  });
  child.on("exit", (code: number | null) => {
    if (fired) return;
    fired = true;
    exitCode = code;
    for (const cb of exitCbs) cb(code);
  });

  return {
    post: (m) => {
      child.postMessage(m);
    },
    kill: () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
    onMessage: (cb) => {
      msgCbs.add(cb);
    },
    onExit: (cb) => {
      if (fired) cb(exitCode);
      else exitCbs.add(cb);
    },
  };
}
