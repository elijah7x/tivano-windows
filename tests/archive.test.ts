// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// F02 archive management: frozen `deleteArchivedThreads(ids:)` — deletes
// exactly the archived∩ids set through the ordinary delete path (turn
// cancel, provider session end, checkpoints, worktree cleanup, segment
// files swept on flush), never matching unarchived or unknown ids. Also
// covers the confirmBeforeDeleting setting (frozen default on).

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  utimesSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Store, TURNS_DIRNAME } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import {
  cleanStorageDiagnostics,
  measureStorageDiagnostics,
} from "../src/main/storageDiagnostics";
import { requestValidators } from "../src/shared/ipc";
import { ValidationError } from "../src/shared/validate";
import {
  StorageDiagnosticsView,
  formatDiagnosticsBytes,
} from "../src/renderer/components/StorageDiagnosticsSection";
import { LanguageContext } from "../src/renderer/locale";
import { TRANSLATED_LANGUAGES, translate } from "../src/renderer/i18n";
import type { LanguageId } from "../src/shared/types";

const dirs: string[] = [];
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-arch-"));
  dirs.push(d);
  return d;
}
function makeEngine(root: string): { store: Store; engine: Engine } {
  const store = new Store(root);
  store.open();
  return { store, engine: new Engine(store, new MockProvider({ tickMs: 1 }), root, "t") };
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("deleteArchivedThreads (F02)", () => {
  it("deletes only the archived threads in the id set", () => {
    const { engine } = makeEngine(freshRoot());
    const a = engine.createThread(null);
    const b = engine.createThread(null);
    const live = engine.createThread(null);
    engine.archiveThread(a.id);
    engine.archiveThread(b.id);
    const deleted = engine.deleteArchivedThreads([a.id, live.id]);
    // `live` is not archived — frozen filters isArchived && ids.contains,
    // so this channel must not delete it even when asked.
    expect(deleted).toEqual([a.id]);
    const ids = engine.snapshot().threads.map((t) => t.id);
    expect(ids).not.toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(live.id);
  });

  it("skips unknown ids and returns only what was deleted", () => {
    const { engine } = makeEngine(freshRoot());
    const a = engine.createThread(null);
    engine.archiveThread(a.id);
    const deleted = engine.deleteArchivedThreads([a.id, "does-not-exist", a.id]);
    expect(deleted).toEqual([a.id]);
    expect(engine.snapshot().threads).toHaveLength(0);
  });

  it("emits a thread-removed event per deleted thread and clears selection", () => {
    const { engine } = makeEngine(freshRoot());
    const events: string[] = [];
    engine.onEvent((e) => events.push(e.type));
    const a = engine.createThread(null);
    const b = engine.createThread(null);
    engine.archiveThread(a.id);
    engine.archiveThread(b.id);
    const deleted = engine.deleteArchivedThreads([a.id, b.id]);
    expect(deleted).toHaveLength(2);
    expect(events.filter((t) => t === "thread-removed")).toHaveLength(2);
  });

  it("sweeps the deleted threads' segment files on flush", () => {
    const root = freshRoot();
    const { store, engine } = makeEngine(root);
    const a = engine.createThread(null);
    const b = engine.createThread(null);
    engine.archiveThread(a.id);
    store.flushNow();
    expect(existsSync(join(root, TURNS_DIRNAME, `${a.id}.json`))).toBe(true);
    expect(existsSync(join(root, TURNS_DIRNAME, `${b.id}.json`))).toBe(true);
    engine.deleteArchivedThreads([a.id]);
    store.flushNow();
    expect(existsSync(join(root, TURNS_DIRNAME, `${a.id}.json`))).toBe(false);
    expect(existsSync(join(root, TURNS_DIRNAME, `${b.id}.json`))).toBe(true);
  });

  it("persists the deletion — a reopened store no longer has the thread", () => {
    const root = freshRoot();
    const { store, engine } = makeEngine(root);
    const a = engine.createThread(null);
    engine.archiveThread(a.id);
    engine.deleteArchivedThreads([a.id]);
    store.flushNow();
    store.close();
    const reopened = new Store(root);
    reopened.open();
    try {
      expect(reopened.state.threads.find((t) => t.id === a.id)).toBeUndefined();
    } finally {
      reopened.close();
    }
  });
});

describe("confirmBeforeDeleting (F02)", () => {
  it("defaults to the frozen 'on' when the store predates the field", () => {
    const { engine } = makeEngine(freshRoot());
    // Absent from a pre-A43 store → frozen default true at read sites.
    expect(engine.snapshot().settings.confirmBeforeDeleting ?? true).toBe(true);
  });

  it("persists an explicit off/on through setSettings", () => {
    const { engine } = makeEngine(freshRoot());
    engine.setSettings({ confirmBeforeDeleting: false });
    expect(engine.snapshot().settings.confirmBeforeDeleting).toBe(false);
    engine.setSettings({ confirmBeforeDeleting: true });
    expect(engine.snapshot().settings.confirmBeforeDeleting).toBe(true);
  });
});

function writeSized(filePath: string, bytes: number, mtimeSec: number): void {
  writeFileSync(filePath, "x".repeat(bytes));
  utimesSync(filePath, mtimeSec, mtimeSec);
}

describe("storageDiagnostics (P1-03)", () => {
  it("reports zero sizes on an empty scratch directory and ignores live store files", () => {
    const root = freshRoot();
    mkdirSync(join(root, TURNS_DIRNAME), { recursive: true });
    writeFileSync(join(root, "store.json"), '{"schemaVersion":1}');
    writeFileSync(join(root, "store.lock"), '{"pid":1}');
    mkdirSync(join(root, "store.lock.guard"), { recursive: true });
    writeFileSync(join(root, "token-activity.json"), '{"v":1}');
    writeFileSync(join(root, "remote-mcp.json"), "{}");
    writeFileSync(join(root, ".store-123-abc.tmp"), "tmp");
    writeFileSync(join(root, TURNS_DIRNAME, "live-thread.json"), "{}");
    writeFileSync(join(root, TURNS_DIRNAME, ".seg-123.tmp"), "tmp");

    const measured = measureStorageDiagnostics({ dataRoot: root });
    expect(measured.categories).toEqual([
      {
        id: "recovery",
        totalBytes: 0,
        cleanableBytes: 0,
        fileCount: 0,
        cleanableCount: 0,
      },
    ]);

    const cleaned = cleanStorageDiagnostics({ dataRoot: root }, "recovery");
    expect(cleaned.cleanupError).toBeUndefined();
    expect(existsSync(join(root, "store.json"))).toBe(true);
    expect(existsSync(join(root, "store.lock"))).toBe(true);
    expect(existsSync(join(root, "store.lock.guard"))).toBe(true);
    expect(existsSync(join(root, "token-activity.json"))).toBe(true);
    expect(existsSync(join(root, "remote-mcp.json"))).toBe(true);
    expect(existsSync(join(root, TURNS_DIRNAME, "live-thread.json"))).toBe(true);
  });

  it("keeps a single recovery file with zero cleanable bytes", () => {
    const root = freshRoot();
    const onlyFile = join(root, "store.corrupt-2026-11-20T00-00-00-000Z.json");
    writeSized(onlyFile, 180, 1_700_000_000);

    const measured = measureStorageDiagnostics({ dataRoot: root });
    expect(measured.categories[0]).toEqual({
      id: "recovery",
      totalBytes: 180,
      cleanableBytes: 0,
      fileCount: 1,
      cleanableCount: 0,
    });

    const cleaned = cleanStorageDiagnostics({ dataRoot: root }, "recovery");
    expect(cleaned.cleanupError).toBeUndefined();
    expect(existsSync(onlyFile)).toBe(true);
  });

  it("measures total and cleanable bytes across recovery variants and preserves newest and protected files", () => {
    const root = freshRoot();
    const turnsDir = join(root, TURNS_DIRNAME);
    mkdirSync(turnsDir, { recursive: true });
    writeFileSync(join(root, "store.json"), '{"live":true}');
    writeFileSync(join(turnsDir, "t1.json"), '{"live":true}');

    const olderStore = join(root, "store.corrupt-2026-11-18T00-00-00-000Z.json");
    const protectedStore = join(root, "store.corrupt-2026-11-19T00-00-00-000Z.json");
    const olderSeg = join(turnsDir, "t1.corrupt-2026-11-19T01-00-00-000Z.json");
    const olderToken = join(root, "token-activity.corrupt-2026-11-19T02-00-00-000Z.json");
    const olderRemoteMcp = join(root, "remote-mcp.json.abc.corrupt");
    const olderTurnsBackupDir = join(root, "turns.corrupt-2026-11-19T03-00-00-000Z");
    const newestStore = join(root, "store.corrupt-2026-11-20T00-00-00-000Z.json");

    mkdirSync(olderTurnsBackupDir, { recursive: true });
    writeSized(olderStore, 100, 1_700_000_100);
    writeSized(protectedStore, 150, 1_700_000_200);
    writeSized(olderSeg, 75, 1_700_000_300);
    writeSized(olderToken, 60, 1_700_000_400);
    writeSized(olderRemoteMcp, 40, 1_700_000_500);
    writeSized(join(olderTurnsBackupDir, "seg-a.json"), 90, 1_700_000_600);
    utimesSync(olderTurnsBackupDir, 1_700_000_600, 1_700_000_600);
    writeSized(newestStore, 200, 1_700_000_900);

    const measured = measureStorageDiagnostics({
      dataRoot: root,
      getProtectedPaths: () => [protectedStore],
    });
    expect(measured.categories[0]).toEqual({
      id: "recovery",
      totalBytes: 100 + 150 + 75 + 60 + 40 + 90 + 200,
      cleanableBytes: 100 + 75 + 60 + 40 + 90,
      fileCount: 7,
      cleanableCount: 5,
    });

    const cleaned = cleanStorageDiagnostics(
      {
        dataRoot: root,
        getProtectedPaths: () => [protectedStore],
      },
      "recovery",
    );
    expect(cleaned.cleanupError).toBeUndefined();
    expect(cleaned.categories[0]).toEqual({
      id: "recovery",
      totalBytes: 150 + 200,
      cleanableBytes: 0,
      fileCount: 2,
      cleanableCount: 0,
    });
    expect(existsSync(olderStore)).toBe(false);
    expect(existsSync(olderSeg)).toBe(false);
    expect(existsSync(olderToken)).toBe(false);
    expect(existsSync(olderRemoteMcp)).toBe(false);
    expect(existsSync(olderTurnsBackupDir)).toBe(false);
    expect(existsSync(protectedStore)).toBe(true);
    expect(existsSync(newestStore)).toBe(true);
    expect(existsSync(join(root, "store.json"))).toBe(true);
    expect(existsSync(join(turnsDir, "t1.json"))).toBe(true);
  });

  it("keeps files in use when unlink fails with EBUSY and reports partial cleanup error", () => {
    const root = freshRoot();
    const locked = join(root, "store.corrupt-2026-11-18T00-00-00-000Z.json");
    const removable = join(root, "store.corrupt-2026-11-19T00-00-00-000Z.json");
    const newest = join(root, "store.corrupt-2026-11-20T00-00-00-000Z.json");
    writeSized(locked, 110, 1_700_000_100);
    writeSized(removable, 120, 1_700_000_200);
    writeSized(newest, 130, 1_700_000_300);

    const res = cleanStorageDiagnostics(
      {
        dataRoot: root,
        fs: {
          unlinkSync: (p) => {
            if (p === locked) {
              const err = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
              err.code = "EBUSY";
              throw err;
            }
            rmSync(p, { force: true });
          },
        },
      },
      "recovery",
    );

    expect(res.cleanupError).toContain("store.corrupt-2026-11-18T00-00-00-000Z.json");
    expect(res.categories[0]).toEqual({
      id: "recovery",
      totalBytes: 240,
      cleanableBytes: 110,
      fileCount: 2,
      cleanableCount: 1,
    });
    expect(existsSync(locked)).toBe(true);
    expect(existsSync(removable)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  it("reports a measurement error instead of zero when inspection fails or a symlink is present", () => {
    const root = freshRoot();
    // Putting a regular file where turns/ directory belongs fails measurement cleanly on any OS.
    writeFileSync(join(root, TURNS_DIRNAME), "not-a-directory");
    writeSized(join(root, "store.corrupt-2026-11-20T00-00-00-000Z.json"), 100, 1_700_000_000);

    const failedReal = measureStorageDiagnostics({ dataRoot: root });
    expect(failedReal.categories[0]!.error).toMatch(/not a directory/i);

    const cleanedOnErr = cleanStorageDiagnostics({ dataRoot: root }, "recovery");
    expect(cleanedOnErr.cleanupError).toMatch(/not a directory/i);
    expect(existsSync(join(root, "store.corrupt-2026-11-20T00-00-00-000Z.json"))).toBe(true);

    // Simulated permission failure on readdirSync.
    const root2 = freshRoot();
    const failedPerm = measureStorageDiagnostics({
      dataRoot: root2,
      fs: {
        readdirSync: (): Dirent[] => {
          const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        },
      },
    });
    expect(failedPerm.categories[0]!.error).toContain("permission denied");

    // Symlink recovery file refused via lstatSync on both win32 and posix path logic.
    const symlinkRes = measureStorageDiagnostics({
      dataRoot: root2,
      platform: "win32",
      fs: {
        lstatSync: (p): Stats =>
          ({
            isSymbolicLink: () => p.includes("store.corrupt-"),
            isDirectory: () => !p.includes("store.corrupt-"),
            isFile: () => false,
            size: 0,
            mtimeMs: 0,
          }) as Stats,
        readdirSync: (): Dirent[] =>
          [{ name: "store.corrupt-2026-11-20T00-00-00-000Z.json" } as Dirent],
      },
    });
    expect(symlinkRes.categories[0]!.error).toContain("symlink");
  });

  it("validates storage diagnostics IPC payloads strictly", () => {
    expect(() => requestValidators["storage:diagnostics"]({})).not.toThrow();
    expect(() => requestValidators["storage:diagnostics"]({ path: "C:\\bad" })).toThrow(
      ValidationError,
    );
    expect(
      requestValidators["storage:clean-diagnostics"]({ category: "recovery" }).category,
    ).toBe("recovery");
    expect(() =>
      requestValidators["storage:clean-diagnostics"]({ category: "logs" }),
    ).toThrow(ValidationError);
    expect(() =>
      requestValidators["storage:clean-diagnostics"]({ category: "recovery", path: "/" }),
    ).toThrow(ValidationError);
  });
});

describe("StorageDiagnosticsView (P1-03)", () => {
  function renderView(
    lang: LanguageId,
    props: Partial<Parameters<typeof StorageDiagnosticsView>[0]> = {},
  ): string {
    return renderToStaticMarkup(
      createElement(
        LanguageContext.Provider,
        { value: lang },
        createElement(StorageDiagnosticsView, {
          categories: [
            {
              id: "recovery",
              totalBytes: 360,
              cleanableBytes: 240,
              fileCount: 2,
              cleanableCount: 1,
            },
          ],
          measuring: false,
          cleaningId: null,
          confirmingId: null,
          loadError: null,
          cleanupErrors: {},
          onRefresh: () => {},
          onRequestConfirm: () => {},
          onCancelConfirm: () => {},
          onConfirmClean: () => {},
          ...props,
        }),
      ),
    );
  }

  it("formats bytes and renders total, cleanable, failure without 0 B, and separate confirmation", () => {
    expect(formatDiagnosticsBytes(0)).toBe("0 B");
    expect(formatDiagnosticsBytes(512)).toBe("512 B");
    expect(formatDiagnosticsBytes(2048)).toBe("2 KB");
    expect(formatDiagnosticsBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");

    const normalHtml = renderView("en");
    expect(normalHtml).toContain("Recovery files");
    expect(normalHtml).toContain("Total: 360 B · Cleanable: 240 B");
    expect(normalHtml).toContain("Clean up…");

    const zeroCleanableHtml = renderView("en", {
      categories: [
        {
          id: "recovery",
          totalBytes: 120,
          cleanableBytes: 0,
          fileCount: 1,
          cleanableCount: 0,
        },
      ],
    });
    expect(zeroCleanableHtml).toContain("Total: 120 B · Cleanable: 0 B · Nothing to clean up.");
    expect(zeroCleanableHtml).toContain("disabled");

    const failedHtml = renderView("en", {
      categories: [
        {
          id: "recovery",
          totalBytes: 0,
          cleanableBytes: 0,
          fileCount: 0,
          cleanableCount: 0,
          error: "permission denied",
        },
      ],
    });
    expect(failedHtml).toContain(
      "Could not measure these files. Not included in the measured total. permission denied",
    );
    expect(failedHtml).not.toContain("Total: 0 B");

    const confirmHtml = renderView("en", { confirmingId: "recovery" });
    expect(confirmHtml).toContain("Clean up recovery files?");
    expect(confirmHtml).toContain("Keeps the newest recovery file.");
    expect(confirmHtml).toContain("Cancel");

    const cleanupErrHtml = renderView("en", {
      cleanupErrors: { recovery: "EBUSY" },
    });
    expect(cleanupErrHtml).toContain(
      "Cleanup did not finish. Some files may already have been removed. EBUSY",
    );
  });

  it("localizes diagnostics strings across zh-Hans and all translated languages", () => {
    const zhHtml = renderView("zh-Hans", { confirmingId: "recovery" });
    expect(zhHtml).toContain("诊断");
    expect(zhHtml).toContain("恢复文件");
    expect(zhHtml).toContain("总量：360 B · 可清理：240 B");
    expect(zhHtml).toContain("清理恢复文件？");
    for (const lang of TRANSLATED_LANGUAGES) {
      expect(translate(lang, "Recovery files")).not.toBe("Recovery files");
      expect(translate(lang, "Clean up recovery files?")).not.toBe("Clean up recovery files?");
    }
  });
});
