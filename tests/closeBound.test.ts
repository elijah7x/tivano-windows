// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// boundedClose coverage: close never resolving, close rejecting late,
// close resolving but the process not yet exited, and already-exited —
// plus the owned-handle kill path when nothing cooperates.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module without types
import { awaitExit, boundedClose } from "../scripts/closeBound.mjs";

/** Minimal ChildProcess-shaped fake owned by the test. */
function fakeProc() {
  const p = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: string | null;
    kill: (sig?: string) => boolean;
    killed: string[];
  };
  p.exitCode = null;
  p.signalCode = null;
  p.killed = [];
  p.kill = (sig = "SIGTERM") => {
    p.killed.push(sig);
    return true;
  };
  return p;
}

function fakeApp(impl: () => Promise<void>) {
  return { close: impl };
}

describe("boundedClose", () => {
  it("close resolves and the process already exited", async () => {
    const proc = fakeProc();
    proc.exitCode = 0;
    const r = await boundedClose(fakeApp(() => Promise.resolve()), proc, {
      closeMs: 200,
      exitMs: 100,
      killWaitMs: 50,
    });
    expect(r.outcome).toBe("resolved");
    expect(r.exited).toBe(true);
    expect(r.killed).toBe(false);
  });

  it("close never resolving → timeout outcome, then owned-handle kill", async () => {
    const proc = fakeProc();
    proc.kill = (sig = "SIGTERM") => {
      proc.killed.push(sig);
      proc.exitCode = null;
      proc.signalCode = "SIGKILL";
      proc.emit("exit");
      return true;
    };
    const r = await boundedClose(
      fakeApp(() => new Promise<void>(() => {})), // never settles
      proc,
      { closeMs: 60, exitMs: 200, killWaitMs: 500 },
    );
    expect(r.outcome).toBe("timeout");
    expect(r.killed).toBe(true);
    expect(r.exited).toBe(true);
  });

  it("close rejects LATE — outcome recorded, no unhandled rejection", async () => {
    const proc = fakeProc();
    proc.exitCode = 0;
    const r = await boundedClose(
      fakeApp(
        () => new Promise<void>((_, rej) => setTimeout(() => rej(new Error("nope")), 30)),
      ),
      proc,
      { closeMs: 500, exitMs: 100, killWaitMs: 50 },
    );
    expect(r.outcome).toMatch(/^rejected:nope|rejected:Error: nope$/);
    expect(r.exited).toBe(true);
  });

  it("close resolves but the process has not exited — bounded kill follows", async () => {
    const proc = fakeProc();
    proc.kill = (sig = "SIGTERM") => {
      proc.killed.push(sig);
      proc.signalCode = "SIGKILL";
      proc.emit("exit");
      return true;
    };
    const r = await boundedClose(fakeApp(() => Promise.resolve()), proc, {
      closeMs: 200,
      exitMs: 80,
      killWaitMs: 500,
    });
    expect(r.outcome).toBe("resolved");
    expect(r.killed).toBe(true);
    expect(r.exited).toBe(true);
  });

  it("a never-exiting process reports exited=false — never painted green", async () => {
    const proc = fakeProc();
    const r = await boundedClose(fakeApp(() => Promise.resolve()), proc, {
      closeMs: 50,
      exitMs: 50,
      killWaitMs: 50,
    });
    expect(r.exited).toBe(false);
    expect(r.killed).toBe(true); // kill was attempted through the owned handle
  });

  it("awaitExit on a null handle is false — a lost handle is uncertainty", async () => {
    expect(await awaitExit(null as never, 10)).toBe(false);
  });
});
