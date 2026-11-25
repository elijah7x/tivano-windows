// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-54 unit & service tests: StorageService measure/clean/worktree-review,
// computeStorageMetrics, formatStorageBytes, and LocalControl outside Alpha.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { LocalControlService } from "../src/main/localControl";
import { StorageService } from "../src/main/storageUsage";
import {
  computeStorageMetrics,
  formatStorageBytes,
  type StorageUsageReport,
} from "../src/shared/storage";

const roots: string[] = [];
function mkRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-storage-"));
  roots.push(d);
  return d;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("storage shared helpers (P2-54)", () => {
  it("formats decimal byte sizes cleanly", () => {
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(999)).toBe("999 B");
    expect(formatStorageBytes(1500)).toBe("1.5 KB");
    expect(formatStorageBytes(12_500_000)).toBe("12.5 MB");
    expect(formatStorageBytes(2_000_000_000)).toBe("2 GB");
  });

  it("computes overview metrics matching v3.0.0 breakdown", () => {
    const usage: StorageUsageReport = {
      chatsBytes: 2000,
      attachmentsBytes: 1000,
      patchesBytes: 500,
      diagnostics: { totalBytes: 800, cleanableBytes: 600, supported: true },
      updates: { totalBytes: 400, cleanableBytes: 300, supported: false },
      worktrees: [
        {
          id: "p1/wt-idle",
          name: "wt-idle",
          sizeBytes: 5000,
          buildFilesSizeBytes: 3500,
          buildFolderCount: 1,
          isRegistered: true,
          changedFiles: 0,
          branch: "feat/a",
          lastCommitAt: null,
          isIdle: true,
          canRemove: true,
          removeReason: null,
          usedByThreadTitle: null,
          usedByArchived: false,
        },
        {
          id: "p1/wt-active",
          name: "wt-active",
          sizeBytes: 4000,
          buildFilesSizeBytes: 1000,
          buildFolderCount: 1,
          isRegistered: true,
          changedFiles: 2,
          branch: "feat/b",
          lastCommitAt: null,
          isIdle: false,
          canRemove: false,
          removeReason: "active-or-archived-chat",
          usedByThreadTitle: "Active chat",
          usedByArchived: false,
        },
      ],
      worktreesDir: win32.join("C:\\tmp", "worktrees"),
    };

    const m = computeStorageMetrics(usage);
    expect(m.idleWorktreeCount).toBe(1);
    expect(m.idleBuildBytes).toBe(3500);
    expect(m.activeBuildBytes).toBe(1000);
    expect(m.uncommittedCount).toBe(1);
    expect(m.defaultCleanableBytes).toBe(3500 + 600 + 300);
    expect(m.totalBytes).toBe(
      3000 + (9000 - 3500) + (3500 + 600 + 300) + 500 + 200 + 100,
    );
  });
});

describe("StorageService (P2-54)", () => {
  it("measures chats, diagnostics, updates, and worktrees and cleans only regenerable files", async () => {
    const root = mkRoot();
    const store = new Store(root);
    store.open();
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "t");
    const proj = engine.createProject("Proj");
    const activeThread = engine.createThread(proj.id, "Active");
    const wtActiveDir = join(root, "worktrees", proj.id, "wt-active");
    const wtIdleDir = join(root, "worktrees", proj.id, "wt-idle");
    mkdirSync(join(wtActiveDir, "node_modules"), { recursive: true });
    mkdirSync(join(wtIdleDir, "dist"), { recursive: true });
    writeFileSync(join(wtActiveDir, ".git"), "gitdir: /fake\n");
    writeFileSync(join(wtIdleDir, ".git"), "gitdir: /fake\n");
    writeFileSync(join(wtActiveDir, "src.ts"), "code");
    writeFileSync(join(wtActiveDir, "node_modules", "pkg.js"), "a".repeat(200));
    writeFileSync(join(wtIdleDir, "keep.ts"), "source");
    writeFileSync(join(wtIdleDir, "dist", "bundle.js"), "b".repeat(500));

    // Attach wt-active to activeThread via store mutation
    store.update((d) => {
      const th = d.threads.find((t) => t.id === activeThread.id)!;
      th.worktreeDir = wtActiveDir;
    });

    // Diagnostics: 2 hang reports (keep newest, clean older) + current log (kept)
    const diagDir = join(root, "diagnostics");
    mkdirSync(diagDir, { recursive: true });
    writeFileSync(join(diagDir, "hang-2026-01-01.txt"), "old".repeat(50));
    await new Promise((r) => setTimeout(r, 25));
    writeFileSync(join(diagDir, "hang-2026-01-02.txt"), "new");
    writeFileSync(join(diagDir, "app.log"), "live");

    // Updates: obsolete file + pending dir (kept)
    const updDir = join(root, "updates");
    mkdirSync(join(updDir, "pending"), { recursive: true });
    writeFileSync(join(updDir, "pending", "next.exe"), "keep");
    writeFileSync(join(updDir, "old-installer.exe"), "x".repeat(120));

    const svc = new StorageService({
      dataRoot: root,
      engine,
      runGit: async (cwd, args) => {
        if (args[0] === "status") {
          const out = cwd.endsWith("wt-idle")
            ? "!! dist/\0"
            : " M src.ts\0!! node_modules/\0";
          return { code: 0, signal: null, stdout: out, stderr: "", timedOut: false, overflowed: false, cancelled: false };
        }
        if (args[0] === "rev-parse" && args.includes("--abbrev-ref")) {
          return { code: 0, signal: null, stdout: "feat/test\n", stderr: "", timedOut: false, overflowed: false, cancelled: false };
        }
        if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
          return { code: 0, signal: null, stdout: cwd + "\n", stderr: "", timedOut: false, overflowed: false, cancelled: false };
        }
        if (args[0] === "check-ignore") {
          return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: false };
        }
        if (args[0] === "--literal-pathspecs") {
          return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: false };
        }
        return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, overflowed: false, cancelled: false };
      },
    });

    const before = await svc.measure();
    expect(before.worktrees.length).toBe(2);
    const idleWt = before.worktrees.find((w) => w.name === "wt-idle")!;
    const activeWt = before.worktrees.find((w) => w.name === "wt-active")!;
    expect(idleWt.isIdle).toBe(true);
    expect(idleWt.canRemove).toBe(true);
    expect(idleWt.buildFilesSizeBytes).toBe(500);
    expect(activeWt.isIdle).toBe(false);
    expect(activeWt.canRemove).toBe(false);
    expect(activeWt.changedFiles).toBe(1);
    expect(before.diagnostics.cleanableBytes).toBe(150);
    expect(before.updates.cleanableBytes).toBe(120);

    const cleaned = await svc.clean({
      idleWorktrees: true,
      activeWorktrees: false,
      diagnostics: true,
      updates: true,
    });
    expect(cleaned.error).toBeUndefined();
    expect(existsSync(join(wtIdleDir, "dist"))).toBe(false);
    expect(existsSync(join(wtIdleDir, "keep.ts"))).toBe(true);
    expect(existsSync(join(wtActiveDir, "node_modules"))).toBe(true);
    expect(existsSync(join(diagDir, "hang-2026-01-01.txt"))).toBe(false);
    expect(existsSync(join(diagDir, "hang-2026-01-02.txt"))).toBe(true);
    expect(existsSync(join(updDir, "old-installer.exe"))).toBe(false);
    expect(existsSync(join(updDir, "pending", "next.exe"))).toBe(true);

    // Refuses removing active worktree and traversal ids
    await expect(svc.removeWorktree(activeWt.id, false)).rejects.toThrow();
    await expect(svc.removeWorktree("../outside", false)).rejects.toThrow();

    // Prefills cleanup-review standalone chat without sending
    const review = await svc.startWorktreeReview();
    expect(review.text).toContain("## Goal");
    expect(review.text).toContain("wt-idle");
    const created = engine.snapshot().threads.find((t) => t.id === review.threadId)!;
    expect(created.projectId).toBeNull();
    expect(created.messages.length).toBe(0);
    expect(created.turn).toBeNull();

    // Local control enables outside Alpha when externalControlEnabled is true.
    const lc = new LocalControlService(engine, root, "dev");
    engine.setSettings({ alphaEnabled: false, externalControlEnabled: true });
    lc.refreshListening();
    expect(lc.listening).toBe(true);
    await expect(lc.handleExternal("info", {}, "local")).resolves.toMatchObject({
      info: { edition: "dev" },
    });
    engine.setSettings({ externalControlEnabled: false });
    lc.refreshListening();
    expect(lc.listening).toBe(false);
    lc.dispose();

    engine.shutdown();
    store.close();
  });
});
