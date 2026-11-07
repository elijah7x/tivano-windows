// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F01 frozen General settings — defaultRuntimeMode seeding on every
// new-thread path (createThread, forwardThread continuation), plus the
// frozen absent-field defaults on an old store.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeEngine(root: string) {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  return { store, engine };
}

describe("F01 defaultRuntimeMode seeding", () => {
  it("defaults a new thread to fullAccess when the setting is absent", () => {
    const r = makeEngine(tmp("tivano-gen-"));
    const t = r.engine.createThread(null, "t");
    expect(t.runtimeMode).toBe("fullAccess");
    r.engine.shutdown();
    r.store.close();
  });

  it("seeds a new thread from settings.defaultRuntimeMode", () => {
    const r = makeEngine(tmp("tivano-gen-"));
    r.engine.setSettings({ defaultRuntimeMode: "supervised" });
    const t = r.engine.createThread(null, "t");
    expect(t.runtimeMode).toBe("supervised");
    r.engine.setSettings({ defaultRuntimeMode: "autoAcceptEdits" });
    const t2 = r.engine.createThread(null, "t2");
    expect(t2.runtimeMode).toBe("autoAcceptEdits");
    // The earlier thread keeps its seed — the setting is not retroactive.
    const t1 = r.engine.snapshot().threads.find((x) => x.id === t.id)!;
    expect(t1.runtimeMode).toBe("supervised");
    r.engine.shutdown();
    r.store.close();
  });

  it("forwardThread seeds the continuation from the current default", () => {
    const r = makeEngine(tmp("tivano-gen-"));
    r.engine.setSettings({ defaultRuntimeMode: "auto" });
    const src = r.engine.createThread(null, "src");
    const dest = r.engine.forwardThread(src.id);
    expect(dest.runtimeMode).toBe("auto");
    r.engine.shutdown();
    r.store.close();
  });

  // A81: the dragged layout sizes land persisted within the frozen
  // bounds (sidebar 210–440, terminal drawer 140–760) and absent keys
  // keep earlier stores loading verbatim.
  it("clamps dragged layout sizes to the frozen bounds", () => {
    const r = makeEngine(tmp("tivano-gen-"));
    r.engine.setSettings({ sidebarWidth: 90, terminalHeight: 4000 });
    let s = r.engine.snapshot().settings;
    expect(s.sidebarWidth).toBe(210);
    expect(s.terminalHeight).toBe(760);
    r.engine.setSettings({ sidebarWidth: 330, terminalHeight: 200 });
    s = r.engine.snapshot().settings;
    expect(s.sidebarWidth).toBe(330);
    expect(s.terminalHeight).toBe(200);
    r.engine.setSettings({ sidebarWidth: 900, terminalHeight: 50 });
    s = r.engine.snapshot().settings;
    expect(s.sidebarWidth).toBe(440);
    expect(s.terminalHeight).toBe(140);
    r.engine.shutdown();
    r.store.close();
  });
});
