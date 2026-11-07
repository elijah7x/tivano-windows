// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Async close coordination: the single-flight contract — work is blocked
// synchronously, children are disposed before the store gate, success
// re-issues the quit exactly once, "keep" parks the app read-only, and a
// retry re-runs only the still-unconfirmed steps.

import { describe, expect, it, vi } from "vitest";
import { CloseCoordinator, type CloseCoordinatorDeps } from "../src/main/lifecycle";

interface Rig {
  deps: CloseCoordinatorDeps;
  coord: CloseCoordinator;
  calls: string[];
}

function rig(overrides: Partial<CloseCoordinatorDeps> = {}): Rig {
  const calls: string[] = [];
  const deps: CloseCoordinatorDeps = {
    blockNewWork: () => calls.push("block"),
    disposeChildren: async () => {
      calls.push("dispose");
      return (await overrides.disposeChildren?.()) ?? { problems: [] };
    },
    saveStore: () => {
      calls.push("save");
      overrides.saveStore?.();
    },
    askUser: async () => {
      calls.push("ask");
      return (await overrides.askUser?.("")) ?? "keep";
    },
    finishQuit: () => calls.push("quit"),
    enterReadOnly: () => calls.push("readonly"),
    ...(overrides.blockNewWork ? { blockNewWork: overrides.blockNewWork } : {}),
    ...(overrides.finishQuit ? { finishQuit: overrides.finishQuit } : {}),
    ...(overrides.enterReadOnly ? { enterReadOnly: overrides.enterReadOnly } : {}),
  };
  return { deps, coord: new CloseCoordinator(deps), calls };
}

/** Wait until the coordinator's run finishes (microtasks settle). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("CloseCoordinator ordering", () => {
  it("blocks work before dispose, saves only after confirmed cleanup, then quits", async () => {
    const { coord, calls } = rig();
    coord.requestClose();
    await settle();
    expect(calls).toEqual(["block", "dispose", "save", "quit"]);
    expect(coord.allowQuit).toBe(true);
    expect(coord.inFlight).toBe(false);
  });

  it("is single-flight — a second request never starts a duplicate task", async () => {
    let releaseDispose!: () => void;
    const { coord, calls } = rig({
      disposeChildren: () =>
        new Promise((r) => {
          releaseDispose = () => r({ problems: [] });
        }),
    });
    coord.requestClose();
    coord.requestClose();
    coord.requestClose();
    releaseDispose();
    await settle();
    expect(calls.filter((c) => c === "dispose")).toHaveLength(1);
    expect(calls.filter((c) => c === "quit")).toHaveLength(1);
  });

  it("an unconfirmed child blocks the save entirely and prompts", async () => {
    const { coord, calls } = rig({
      disposeChildren: async () => ({ problems: ["child pid 42: CLEANUP_INCOMPLETE"] }),
    });
    coord.requestClose();
    await settle();
    expect(calls).toEqual(["block", "dispose", "ask", "readonly"]);
    expect(calls).not.toContain("save");
    expect(calls).not.toContain("quit");
    expect(coord.allowQuit).toBe(false);
  });

  it("a save failure prompts and keep-open stays read-only", async () => {
    const { coord, calls } = rig({
      saveStore: () => {
        throw new Error("ENOSPC");
      },
    });
    coord.requestClose();
    await settle();
    expect(calls).toEqual(["block", "dispose", "save", "ask", "readonly"]);
    expect(coord.allowQuit).toBe(false);
  });

  it("retry after a failed save re-runs only the save, then quits", async () => {
    let fails = 1;
    const { coord, calls } = rig({
      saveStore: () => {
        if (fails-- > 0) throw new Error("ENOSPC");
      },
      askUser: async () => "retry",
    });
    coord.requestClose();
    await settle();
    // dispose already confirmed → it is NOT re-run on the retry pass.
    expect(calls).toEqual(["block", "dispose", "save", "ask", "save", "quit"]);
    expect(coord.allowQuit).toBe(true);
  });

  it("disposeChildren throwing counts as a cleanup failure", async () => {
    const { coord, calls } = rig({
      disposeChildren: async () => {
        throw new Error("adapter exploded");
      },
    });
    coord.requestClose();
    await settle();
    expect(calls).toEqual(["block", "dispose", "ask", "readonly"]);
  });

  it("keep-open then a NEW close request retries only unconfirmed steps", async () => {
    let disposeCalls = 0;
    const { coord, calls } = rig({
      disposeChildren: async () => {
        disposeCalls++;
        // first pass fails cleanup; the retry pass confirms
        return { problems: disposeCalls === 1 ? ["CLEANUP_INCOMPLETE"] : [] };
      },
      askUser: async () => "keep",
    });
    coord.requestClose();
    await settle();
    expect(calls).toEqual(["block", "dispose", "ask", "readonly"]);
    expect(coord.allowQuit).toBe(false);
    // User closes again → unconfirmed steps re-run: dispose is retried
    // (its first pass never confirmed), then save, then exactly one quit.
    coord.requestClose();
    await settle();
    expect(calls).toEqual([
      "block", "dispose", "ask", "readonly",
      "block", "dispose", "save", "quit",
    ]);
    expect(coord.allowQuit).toBe(true);
  });

  it("dispose already confirmed → save fails → retry skips dispose entirely", async () => {
    let disposeCalls = 0;
    let saveCalls = 0;
    const { coord, calls } = rig({
      disposeChildren: async () => {
        disposeCalls++;
        return { problems: [] }; // cleanup always confirmed
      },
      saveStore: () => {
        saveCalls++;
        if (saveCalls === 1) throw new Error("ENOSPC");
      },
      askUser: async () => "keep",
    });
    coord.requestClose();
    await settle();
    expect(calls).toEqual(["block", "dispose", "save", "ask", "readonly"]);
    coord.requestClose();
    await settle();
    // dispose was confirmed — the retry only re-runs the save, then quits.
    expect(calls).toEqual([
      "block", "dispose", "save", "ask", "readonly",
      "block", "save", "quit",
    ]);
    expect(disposeCalls).toBe(1);
    expect(saveCalls).toBe(2);
    expect(coord.allowQuit).toBe(true);
  });

  it("a pending approval + wedged child close → keep → retry quits once", async () => {
    let pass = 0;
    const { coord, calls } = rig({
      disposeChildren: async () => {
        pass++;
        return pass === 1 ? { problems: ["turn t pending approval; child unconfirmed"] } : { problems: [] };
      },
      askUser: async () => "keep",
    });
    coord.requestClose();
    await settle();
    coord.requestClose();
    await settle();
    expect(calls.filter((c) => c === "quit")).toHaveLength(1);
    expect(coord.allowQuit).toBe(true);
  });
});
