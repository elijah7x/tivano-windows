// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 @-mention + downloads: the frozen word-scan and FileIndex scoring
// port, the cached directory index (git → enumerate fallback, skip set,
// depth/cap bounds, 60s freshness), and the downloads listing (15
// newest, hidden/dir skipped, id→path resolution by generation).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mentionQueryAt, scoreMentionPaths } from "../src/shared/fileMention";
import { FileIndexService } from "../src/main/fileIndex";
import { DownloadsService } from "../src/main/downloadsService";

const dirs: string[] = [];
function root(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-fm-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const touch = (dir: string, rel: string, body = "x"): string => {
  const p = join(dir, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};

describe("mentionQueryAt (frozen word scan)", () => {
  it("the whitespace-bounded word under the caret opens with @", () => {
    expect(mentionQueryAt("hello @src/ma", 13)).toEqual({ start: 6, query: "src/ma" });
    expect(mentionQueryAt("@abc", 4)).toEqual({ start: 0, query: "abc" });
    expect(mentionQueryAt("a @b", 4)).toEqual({ start: 2, query: "b" });
  });
  it("no @, a bare caret edge, or a different word yields nothing", () => {
    expect(mentionQueryAt("hello", 5)).toBeNull();
    expect(mentionQueryAt("hello", 0)).toBeNull();
    // The word under the caret is "a@b": it doesn't start with '@'.
    expect(mentionQueryAt("a@b", 3)).toBeNull();
    expect(mentionQueryAt("x y@z", 5)).toBeNull();
    // caret inside the word still scans back to the @.
    expect(mentionQueryAt("@foo bar", 4)).toEqual({ start: 0, query: "foo" });
  });
  it("tab and LF bound the word exactly like space", () => {
    expect(mentionQueryAt("a\t@f", 4)).toEqual({ start: 2, query: "f" });
    expect(mentionQueryAt("a\n@f", 4)).toEqual({ start: 2, query: "f" });
  });
});

describe("scoreMentionPaths (frozen FileIndex.search)", () => {
  const paths = [
    "src/main/engine.ts",
    "src/main/store.ts",
    "src/renderer/app.tsx",
    "docs/engine-notes.md",
    "README.md",
    "x/engine.ts",
  ];

  it("an empty query returns the first `limit` paths verbatim", () => {
    expect(scoreMentionPaths(paths, "", 3)).toEqual(paths.slice(0, 3));
  });

  it("exact-name beats prefix beats contains beats path beats subsequence", () => {
    const r = scoreMentionPaths(paths, "engine");
    // "engine.ts" exact-name hits (1000): x/engine.ts and src/main/engine.ts
    // rank first; shorter path wins the length-penalty tie-break.
    expect(r[0]).toBe("x/engine.ts");
    expect(r[1]).toBe("src/main/engine.ts");
    // "engine-notes.md" is a name-prefix (800); README.md doesn't match.
    expect(r).toContain("docs/engine-notes.md");
    expect(r).not.toContain("README.md");
  });

  it("path-contains (400) still beats a subsequence-only match (100)", () => {
    const r = scoreMentionPaths(["z/aaa-srore", "src/main/store.ts"], "srore", 8);
    // "aaa-srore" contains needle → 600; store.ts matches only as
    // subsequence (s-t-o-r-e vs s-r-o-r-e? srore IS in "store" letters:
    // s,r,o,r,e — 's' ok, 'r' ok, 'o' ok, second 'r' ok, 'e' ok → 100).
    expect(r[0]).toBe("z/aaa-srore");
    expect(r).toContain("src/main/store.ts");
  });

  it("limit keeps the best-N insertion order, never more", () => {
    const many = Array.from({ length: 40 }, (_, i) => `d${i}/note.md`);
    expect(scoreMentionPaths(many, "note", 8)).toHaveLength(8);
  });
});

describe("FileIndexService (frozen listing + cache)", () => {
  it("a git repo uses the injected ls-files and skips enumerate", async () => {
    const dir = root();
    touch(dir, "notlisted.txt");
    const svc = new FileIndexService({
      isRepo: async () => true,
      gitFiles: async () => ["src/a.ts", "src/b.ts"],
    });
    expect(await svc.list(dir)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("a non-repo enumerates with the frozen skip set and hidden rule", async () => {
    const dir = root();
    touch(dir, "keep/a.ts");
    touch(dir, "keep/b.md");
    touch(dir, "node_modules/pkg/i.js");
    touch(dir, "dist/out.js");
    touch(dir, ".hidden/secret.ts");
    touch(dir, ".dotfile.ts");
    const svc = new FileIndexService({
      isRepo: async () => false,
      gitFiles: async () => [],
    });
    const got = await svc.list(dir);
    expect(got.sort()).toEqual(["keep/a.ts", "keep/b.md"]);
  });

  it("a repo with an empty listing falls back to enumerate", async () => {
    const dir = root();
    touch(dir, "only/file.txt");
    const svc = new FileIndexService({
      isRepo: async () => true,
      gitFiles: async () => [],
    });
    expect(await svc.list(dir)).toEqual(["only/file.txt"]);
  });

  it("git failure degrades to enumerate, never throws", async () => {
    const dir = root();
    touch(dir, "x.ts");
    const svc = new FileIndexService({
      isRepo: async () => {
        throw new Error("git gone");
      },
      gitFiles: async () => [],
    });
    expect(await svc.list(dir)).toEqual(["x.ts"]);
  });

  it("the cache serves a fresh listing for 60s then rebuilds", async () => {
    const dir = root();
    let now = 1_000_000;
    let calls = 0;
    const svc = new FileIndexService({
      isRepo: async () => true,
      gitFiles: async () => {
        calls += 1;
        return [`f${calls}.ts`];
      },
      now: () => now,
    });
    expect(await svc.list(dir)).toEqual(["f1.ts"]);
    expect(await svc.list(dir)).toEqual(["f1.ts"]); // cached
    now += 61_000;
    expect(await svc.list(dir)).toEqual(["f2.ts"]); // rebuilt
    expect(calls).toBe(2);
  });

  it("the index keeps at most two directories (frozen RecentCache limit)", async () => {
    const calls2 = { n: 0 };
    const svc = new FileIndexService({
      isRepo: async () => true,
      gitFiles: async (d) => {
        calls2.n += 1;
        return [`${d}/v${calls2.n}`];
      },
      now: () => Date.now(),
    });
    const a = root(), b = root(), c = root();
    await svc.list(a); // v1
    await svc.list(b); // v2
    await svc.list(c); // v3 — a evicted
    // b and c are still cached → their original listings, no new calls.
    expect(await svc.list(b)).toEqual([`${b}/v2`]);
    expect(await svc.list(c)).toEqual([`${c}/v3`]);
    expect(calls2.n).toBe(3);
    // a was evicted → list() rebuilds it.
    expect(await svc.list(a)).toEqual([`${a}/v4`]);
    expect(calls2.n).toBe(4);
  });
});

describe("DownloadsService (frozen RecentDownloads)", () => {
  it("lists the 15 newest files, hidden and directories skipped", async () => {
    const dir = root();
    for (let i = 0; i < 20; i++) {
      const p = touch(dir, `f${String(i).padStart(2, "0")}.txt`);
      const t = new Date(2026, 0, 1, 0, 0, i);
      utimesSync(p, t, t);
    }
    touch(dir, ".hidden.txt");
    mkdirSync(join(dir, "subfolder"));
    const svc = new DownloadsService(dir);
    const items = await svc.list();
    expect(items).toHaveLength(15);
    expect(items[0]!.name).toBe("f19.txt"); // newest first
    expect(items[14]!.name).toBe("f05.txt");
    expect(items.every((i) => !i.name.startsWith("."))).toBe(true);
    expect(items[0]!.isImage).toBe(false);
  });

  it("image extensions flag isImage; sizes report real bytes", async () => {
    const dir = root();
    const p = touch(dir, "pic.png", "1234567890");
    utimesSync(p, new Date(), new Date());
    const svc = new DownloadsService(dir);
    const [item] = await svc.list();
    expect(item!.isImage).toBe(true);
    expect(item!.size).toBe(10);
  });

  it("resolve returns the listed path for a live id, null otherwise", async () => {
    const dir = root();
    touch(dir, "a.txt");
    const svc = new DownloadsService(dir);
    const items = await svc.list();
    expect(svc.resolve(items[0]!.id)).toBe(join(dir, "a.txt"));
    expect(svc.resolve("99:zz")).toBeNull();
    // A new listing replaces the generation: old ids no longer resolve.
    await svc.list();
    expect(svc.resolve(items[0]!.id)).toBeNull();
  });

  it("a missing directory lists nothing and resolves nothing", async () => {
    const svc = new DownloadsService(null);
    expect(await svc.list()).toEqual([]);
    expect(svc.dir()).toBeNull();
  });
});
