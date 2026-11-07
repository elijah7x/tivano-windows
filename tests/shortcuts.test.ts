// F27 keyboard shortcuts (A35): frozen ShortcutStore semantics ported —
// defaults, overrides (stored null = cleared), refusal rules, platform
// normalization (⌃→mod on Windows), and durable persistence through
// settings:set + the store validator.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SHORTCUT_COMMANDS,
  chordFromEvent,
  chordLabel,
  defaultChord,
  effectiveChord,
  keyLabel,
  shortcutRefusal,
  type KeyChord,
} from "../src/shared/shortcuts";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { ProjectRuntimePaths } from "../src/main/projectRuntimePaths";
import { Store } from "../src/main/store";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "shcut-"));
  dirs.push(d);
  return d;
}

const C = (key: string, mod = false, ctrl = false, alt = false, shift = false): KeyChord =>
  ({ key, mod, ctrl, alt, shift });
const EV = (code: string, ctrlKey = false, altKey = false, shiftKey = false, metaKey = false) =>
  ({ code, ctrlKey, altKey, shiftKey, metaKey });

describe("shortcut model — defaults and overrides (frozen ShortcutStore)", () => {
  it("frozen defaults: ⌘K palette, ⌘, settings, ⌃Tab next on macOS", () => {
    expect(defaultChord("commandPalette", true)).toEqual(C("KeyK", true));
    expect(defaultChord("openSettings", true)).toEqual(C("Comma", true));
    expect(defaultChord("nextThread", true)).toEqual(C("Tab", false, true));
    expect(defaultChord("previousThread", true)).toEqual(C("Tab", false, true, false, true));
    expect(defaultChord("stopTurn", true)).toEqual(C("Period", true));
    expect(defaultChord("archiveThreadDirect", true)).toEqual(C("Backspace", true, false, false, true));
    // Every command ships a default — nothing unbound out of the box.
    for (const id of SHORTCUT_COMMANDS) expect(defaultChord(id, true)).not.toBeNull();
  });

  it("Windows folds the frozen ⌃ defaults into the primary Ctrl", () => {
    expect(defaultChord("nextThread", false)).toEqual(C("Tab", true));
    expect(defaultChord("previousThread", false)).toEqual(C("Tab", true, false, false, true));
    expect(defaultChord("commandPalette", false)).toEqual(C("KeyK", true));
  });

  it("an override wins; a stored null clears without falling back", () => {
    const mine = C("KeyS", true, false, false, true);
    const over: Record<string, KeyChord | null> = { toggleTerminal: mine, openSettings: null };
    expect(effectiveChord("toggleTerminal", over, true)).toEqual(mine);
    expect(effectiveChord("openSettings", over, true)).toBeNull();
    expect(effectiveChord("commandPalette", over, true)).toEqual(C("KeyK", true));
  });

  it("chordFromEvent maps mod per platform", () => {
    expect(chordFromEvent(EV("KeyK", false, false, false, true), true)).toEqual(C("KeyK", true));
    expect(chordFromEvent(EV("KeyK", true), true)).toEqual(C("KeyK", false, true));
    // Windows: Ctrl IS the primary modifier — never a separate flag.
    expect(chordFromEvent(EV("KeyK", true), false)).toEqual(C("KeyK", true));
    expect(chordFromEvent(EV("Tab", true, false, true), false)).toEqual(C("Tab", true, false, false, true));
  });
});

describe("shortcut refusal rules (frozen ShortcutStore.refusal)", () => {
  const over: Record<string, KeyChord | null> = {};
  it("the same chord is allowed (re-recording the current binding)", () => {
    expect(shortcutRefusal(C("KeyK", true), "commandPalette", over, true)).toBeNull();
  });
  it("a bare modifier press is refused, asking for a real key", () => {
    expect(shortcutRefusal(C("ControlLeft", false, true), "stopTurn", over, true)).toBe(
      "Add a key to the modifiers.",
    );
  });
  it("a typing key with no real modifier is refused", () => {
    expect(shortcutRefusal(C("KeyA"), "stopTurn", over, true)).toBe(
      "Add a modifier so typing still works.",
    );
    // Shift-only still types — refused too.
    expect(shortcutRefusal(C("KeyA", false, false, false, true), "stopTurn", over, true)).toBe(
      "Add a modifier so typing still works.",
    );
    // But a modifier alone cannot type: ⌘⇧T is fine.
    expect(shortcutRefusal(C("KeyT", true, false, false, true), "stopTurn", over, true)).toBeNull();
  });
  it("an unlabeled key cannot be a shortcut", () => {
    expect(shortcutRefusal(C("IntlBackslash", true), "stopTurn", over, true)).toBe(
      "This key cannot be a shortcut.",
    );
  });
  it("system-reserved chords are refused (⌘Q/⌘C/⌘1… on macOS, same keys on Windows)", () => {
    expect(shortcutRefusal(C("KeyQ", true), "stopTurn", over, true)).toBe(
      "The system or Tivano already uses this chord.",
    );
    expect(shortcutRefusal(C("KeyC", true), "stopTurn", over, false)).toBe(
      "The system or Tivano already uses this chord.",
    );
    expect(shortcutRefusal(C("Digit5", true), "stopTurn", over, true)).toBe(
      "The system or Tivano already uses this chord.",
    );
  });
  it("a chord owned by another command names the owner", () => {
    expect(shortcutRefusal(C("KeyK", true), "stopTurn", over, true)).toBe(
      "%@ already uses this chord.|commandPalette",
    );
  });
  it("cleared and overridable bindings are respected in ownership checks", () => {
    // ⌘, is free once openSettings is cleared; a new chord the override
    // owns is refused for anyone else.
    const o: Record<string, KeyChord | null> = {
      openSettings: null,
      toggleTerminal: C("KeyT", true),
    };
    expect(shortcutRefusal(C("Comma", true), "stopTurn", o, true)).toBeNull();
    expect(shortcutRefusal(C("KeyT", true), "stopTurn", o, true)).toBe(
      "%@ already uses this chord.|toggleTerminal",
    );
  });
});

describe("chord labels", () => {
  it("letters, digits, arrows and punctuation label correctly", () => {
    expect(keyLabel("KeyK")).toBe("K");
    expect(keyLabel("Digit0")).toBe("0");
    expect(keyLabel("Tab")).toBe("Tab");
    expect(keyLabel("ArrowLeft")).toBe("←");
    expect(keyLabel("Period")).toBe(".");
    expect(keyLabel("F5")).toBe("F5");
    expect(keyLabel("IntlBackslash")).toBeNull();
  });
  it("macOS uses frozen symbols; Windows spells modifiers", () => {
    expect(chordLabel(C("KeyK", true), true)).toBe("⌘K");
    expect(chordLabel(C("Tab", false, true, false, true), true)).toBe("⌃⇧Tab");
    expect(chordLabel(C("KeyK", true), false)).toBe("Ctrl+K");
    expect(chordLabel(C("Period", true, false, true), false)).toBe("Ctrl+Alt+.");
  });
});

describe("shortcuts persisted via settings", () => {
  function rig() {
    const dataRoot = tmp();
    const store = new Store(dataRoot);
    store.open();
    stores.push(store);
    const paths = new ProjectRuntimePaths([], join(dataRoot, "grants.json"), dataRoot);
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), dataRoot, "0.0.0-test", paths);
    return { engine, store };
  }

  it("settings:set persists overrides and clears bindings honestly", () => {
    const r = rig();
    r.engine.setSettings({ shortcuts: { toggleTerminal: C("KeyT", true), openSettings: null } });
    const s = r.engine.snapshot().settings;
    expect(s.shortcuts?.toggleTerminal).toEqual(C("KeyT", true));
    expect(s.shortcuts?.openSettings).toBeNull();
    // Empty map removes the field entirely.
    r.engine.setSettings({ shortcuts: {} });
    expect(r.engine.snapshot().settings.shortcuts).toBeUndefined();
  });

  it("overrides survive a store reload; unknown ids are rejected on load", async () => {
    const { validateStoreFile } = await import("../src/main/storeDoc");
    const r = rig();
    r.engine.setSettings({ shortcuts: { nextThread: C("KeyJ", true, false, true) } });
    const state = JSON.parse(
      JSON.stringify((r.store as unknown as { state: unknown }).state),
    ) as Record<string, unknown>;
    // A valid store passes with the override intact.
    const good = validateStoreFile(state);
    expect(good.settings.shortcuts?.nextThread).toEqual(C("KeyJ", true, false, true));
    // A bogus command id fails validation — unknown commands cannot
    // smuggle in through the file.
    const bad = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    (bad.settings as Record<string, unknown>).shortcuts = {
      bogusCommand: { key: "KeyX", mod: true, ctrl: false, alt: false, shift: false },
    };
    expect(() => validateStoreFile(bad)).toThrow(/unknown shortcut command/);
    // A malformed chord shape is rejected too.
    const bad2 = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    (bad2.settings as Record<string, unknown>).shortcuts = {
      nextThread: { key: "KeyX", mod: "yes" },
    };
    expect(() => validateStoreFile(bad2)).toThrow();
  });
});
