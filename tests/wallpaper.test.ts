// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F26 wallpaper slice: library install/remove/read semantics (frozen
// WallpaperStore parity — generated basename, replace-after-land,
// traversal-guarded reads), the engine file/softness methods, the
// settings:set boundary (no wallpaper patch), opacity clamping and the
// document-level rejection of a renderer-named filename.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WallpaperService } from "../src/main/wallpaperService";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import {
  WALLPAPER_FILE_RE,
  WALLPAPER_MAX_BYTES,
  wallpaperBlurPx,
  wallpaperOpacity,
} from "../src/shared/wallpaper";

const dirs: string[] = [];
function root(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-wp-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function source(dir: string, name = "pic.png", data: Buffer = PNG): string {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}

describe("WallpaperService library (F26)", () => {
  function svc(pick: () => Promise<string | null> = () => Promise.resolve(null)) {
    const dir = root();
    return { dir, s: new WallpaperService(dir, pick) };
  }

  it("copies a picked picture into the library under a generated basename", () => {
    const { dir, s } = svc();
    const src = source(dir);
    const r = s.install(src);
    expect(r.status).toBe("installed");
    if (r.status !== "installed") return;
    expect(WALLPAPER_FILE_RE.test(r.file)).toBe(true);
    expect(r.file.endsWith(".png")).toBe(true);
    expect(readFileSync(join(dir, "wallpaper", r.file))).toEqual(PNG);
  });

  it("rejects a non-image name without touching the library", () => {
    const { dir, s } = svc();
    const r = s.install(source(dir, "notes.txt"));
    expect(r.status).toBe("notImage");
    expect(existsSync(join(dir, "wallpaper"))).toBe(false);
  });

  it("rejects a file over 25 MB", () => {
    const { s } = svc();
    const r = s.install(source(root(), "huge.png", Buffer.alloc(WALLPAPER_MAX_BYTES + 1)));
    expect(r.status).toBe("tooLarge");
  });

  it("a missing source reports error, not a crash", () => {
    const { s } = svc();
    const r = s.install(join(root(), "gone.png"));
    expect(r.status).toBe("error");
  });

  it("a new install removes the previous file only after the copy lands", () => {
    const { dir, s } = svc();
    const a = s.install(source(dir, "a.png"));
    const b = s.install(source(dir, "b.jpg"), a.status === "installed" ? a.file : undefined);
    expect(b.status).toBe("installed");
    if (a.status !== "installed" || b.status !== "installed") return;
    const left = readdirSync(join(dir, "wallpaper"));
    expect(left).toEqual([b.file]);
    // A failed pick keeps the installed wallpaper.
    const fail = s.install(source(dir, "c.txt"), b.file);
    expect(fail.status).toBe("notImage");
    expect(readdirSync(join(dir, "wallpaper"))).toEqual([b.file]);
  });

  it("installBytes accepts dropped bytes and sweeps orphans", () => {
    const { dir, s } = svc();
    const r = s.installBytes("dropped.webp", PNG);
    expect(r.status).toBe("installed");
    if (r.status !== "installed") return;
    // A stale library file from an earlier install is swept, the live
    // one is kept, and foreign names are never touched.
    writeFileSync(
      join(dir, "wallpaper", "wallpaper-00000000-0000-0000-0000-000000000000.png"),
      PNG,
    );
    writeFileSync(join(dir, "wallpaper", "keep-me.txt"), "x");
    const next = s.installBytes("new.png", PNG);
    expect(next.status).toBe("installed");
    if (next.status !== "installed") return;
    const left = readdirSync(join(dir, "wallpaper")).sort();
    expect(left).toEqual(["keep-me.txt", next.file]);
  });

  it("installBytes rejects empty data and bad names", () => {
    const { s } = svc();
    expect(s.installBytes("x.png", new Uint8Array(0)).status).toBe("error");
    expect(s.installBytes("x.txt", PNG).status).toBe("notImage");
  });

  it("chooseAndInstall maps a cancelled pick and installs a real one", async () => {
    const { dir } = (() => ({ dir: root() }))();
    const cancel = new WallpaperService(dir, () => Promise.resolve(null));
    expect((await cancel.chooseAndInstall()).status).toBe("cancelled");
    const src = source(dir, "chosen.png");
    const yes = new WallpaperService(dir, () => Promise.resolve(src));
    const r = await yes.chooseAndInstall();
    expect(r.status).toBe("installed");
  });

  it("remove deletes the installed file and tolerates absence", () => {
    const { dir, s } = svc();
    const r = s.install(source(dir));
    if (r.status !== "installed") throw new Error("install failed");
    s.remove(r.file);
    expect(readdirSync(join(dir, "wallpaper"))).toEqual([]);
    s.remove(r.file); // already gone — quiet no-op
    s.remove(undefined);
  });

  it("read returns installed bytes but never escapes the basename guard", () => {
    const { dir, s } = svc();
    const r = s.install(source(dir));
    if (r.status !== "installed") throw new Error("install failed");
    expect(s.read(r.file)).toEqual(PNG);
    expect(s.read("../store.json")).toBeNull();
    expect(s.read("wallpaper-notauuid.png")).toBeNull();
    expect(s.read("pic.png")).toBeNull();
    expect(s.exists(r.file)).toBe(true);
    expect(statSync(join(dir, "wallpaper", r.file)).size).toBe(PNG.length);
  });
});

describe("wallpaper + backdropOpacity settings (F26)", () => {
  function makeEngine(dir: string) {
    const store = new Store(dir);
    store.open();
    return { store, engine: new Engine(store, new MockProvider({ tickMs: 1 }), dir, "t") };
  }

  it("file + softness + opacity round-trip through a restart", () => {
    const dir = root();
    const { store, engine } = makeEngine(dir);
    engine.setWallpaperFile("wallpaper-11111111-1111-1111-1111-111111111111.png");
    engine.setWallpaperSoftness(0.4);
    engine.setSettings({ backdropOpacity: 0.8 });
    expect(engine.snapshot().settings.wallpaper).toEqual({
      file: "wallpaper-11111111-1111-1111-1111-111111111111.png",
      softness: 0.4,
    });
    store.close();

    const { store: s2, engine: e2 } = makeEngine(dir);
    expect(e2.snapshot().settings.wallpaper?.softness).toBe(0.4);
    expect(e2.snapshot().settings.backdropOpacity).toBe(0.8);
    // File slot survives softness updates; clearWallpaper drops both.
    e2.setWallpaperFile("wallpaper-22222222-2222-2222-2222-222222222222.jpg");
    expect(e2.snapshot().settings.wallpaper).toEqual({
      file: "wallpaper-22222222-2222-2222-2222-222222222222.jpg",
      softness: 0.4,
    });
    e2.clearWallpaper();
    expect(e2.snapshot().settings.wallpaper).toBeUndefined();
    s2.close();
  });

  it("settings:set accepts backdropOpacity only inside 0..1 (engine clamps)", () => {
    const { engine } = makeEngine(root());
    engine.setSettings({ backdropOpacity: 1.7 });
    expect(engine.snapshot().settings.backdropOpacity).toBe(1);
    engine.setSettings({ backdropOpacity: -0.2 });
    expect(engine.snapshot().settings.backdropOpacity).toBe(0);
  });

  it("the wallpaper slot is not a settings patch — a renderer cannot name a path", () => {
    const { engine } = makeEngine(root());
    engine.setSettings({ wallpaper: { file: "/etc/passwd", softness: 0 } } as never);
    expect(engine.snapshot().settings.wallpaper).toBeUndefined();
  });

  it("softness clamps to the frozen 0..1 slider range", () => {
    const { engine } = makeEngine(root());
    engine.setWallpaperFile("wallpaper-33333333-3333-3333-3333-333333333333.png");
    engine.setWallpaperSoftness(9);
    expect(engine.snapshot().settings.wallpaper?.softness).toBe(1);
    engine.setWallpaperSoftness(-3);
    expect(engine.snapshot().settings.wallpaper?.softness).toBe(0);
  });

  it("a document with a renderer-named wallpaper file is unreadable", () => {
    const dir = root();
    const { store, engine } = makeEngine(dir);
    engine.setSettings({ notifyOnDone: true });
    store.flushNow();
    const raw = JSON.parse(readFileSync(join(dir, "store.json"), "utf8"));
    raw.settings.wallpaper = { file: "../../secrets.png", softness: 0 };
    store.close();
    writeFileSync(join(dir, "store.json"), JSON.stringify(raw));
    const s = new Store(dir);
    s.open();
    expect(s.recoveredFrom).toBeTruthy();
    s.close();
  });

  it("shared helpers: opacity defaults to the frozen 0.5, softness maps to blur", () => {
    expect(wallpaperOpacity(undefined)).toBe(0.5);
    expect(wallpaperOpacity(0.25)).toBe(0.25);
    expect(wallpaperOpacity(9)).toBe(1);
    expect(wallpaperBlurPx(0)).toBe(0);
    expect(wallpaperBlurPx(1)).toBe(28);
  });
});
