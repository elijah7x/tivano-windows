// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Bounded close for e2e-owned Electron instances. app.close() itself is a
// Promise that may never settle — the runner must not hang on it. Close is
// time-boxed, later settle/reject is consumed (never an unhandled
// rejection), exit is observed on THIS instance's own ChildProcess handle
// (never a process-name or historical-PID sweep), and a surviving process
// is terminated only through the handle we already own.
//
// A "timeout"/rejected close stays a failure even when the process is
// later reaped — the run cannot be painted green by cleanup afterwards.

import { once } from "node:events";

/**
 * True only when the process really exited: exitCode/signalCode already
 * set, or an 'exit' event before the deadline. Timeout → false, never a
 * pass. A dead handle is uncertainty, not proof.
 */
export async function awaitExit(proc, ms = 10000) {
  if (!proc) return false;
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  return Promise.race([
    once(proc, "exit").then(() => true),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ]);
}

/**
 * Time-boxed close of one owned instance.
 *   app:  playwright ElectronApplication (close() → Promise)
 *   proc: the ChildProcess captured at launch — identity never re-looked-up
 * Returns { outcome, exited, killed, exitCode, signalCode }:
 *   outcome: "resolved" | "rejected:<err>" | "timeout"
 *   exited:  exitCode/signalCode observed (a real exit, not kill() return)
 *   killed:  SIGKILL was dispatched through the owned handle
 */
export async function boundedClose(
  app,
  proc,
  { closeMs = 15000, exitMs = 10000, killWaitMs = 5000 } = {},
) {
  const closer = app
    .close()
    .then(() => "resolved")
    .catch((e) => `rejected:${(e?.message ?? String(e)).slice(0, 200)}`);
  const outcome = await Promise.race([
    closer,
    new Promise((r) => setTimeout(() => r("timeout"), closeMs)),
  ]);
  // The close promise may settle or reject AFTER the timeout — attach a
  // consumer WITHOUT awaiting it, so a never-settling close can't hang us
  // and a late rejection never goes unhandled.
  closer.catch(() => {});

  let exited = await awaitExit(proc, exitMs);
  let killed = false;
  if (!exited && proc && proc.exitCode === null && proc.signalCode === null) {
    try {
      killed = proc.kill("SIGKILL") === true;
    } catch {
      /* already gone */
    }
    exited = await awaitExit(proc, killWaitMs);
  }
  return {
    outcome,
    exited,
    killed,
    exitCode: proc?.exitCode ?? null,
    signalCode: proc?.signalCode ?? null,
  };
}
