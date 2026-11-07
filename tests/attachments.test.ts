// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 draft attachments: engine pending-set semantics (cap, consume,
// isolation, cleanup) plus AttachmentService copy/cleanup behavior.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentService } from "../src/main/attachmentService";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { Store } from "../src/main/store";
import type { ChatThread } from "../src/shared/types";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tivano-attach-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, ms = 9_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

function make(root = tmp()) {
  const store = new Store(root);
  store.open();
  const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
  return { store, engine };
}
const threadOf = (engine: Engine, id: string): ChatThread =>
  engine.snapshot().threads.find((t) => t.id === id)!;
const file = (i: number) => ({
  id: `a${i}`,
  name: `file-${i}.txt`,
  size: i * 10 + 1,
  path: `/lib/${i}/file-${i}.txt`,
});

describe("F05 engine pending attachments", () => {
  it("accepts files under the cap and returns path-free descriptors", () => {
    const { engine } = make();
    const t = engine.createThread(null);
    const r = engine.addAttachments(t.id, [file(1), file(2)]);
    expect(r.attached.map((a) => a.name)).toEqual(["file-1.txt", "file-2.txt"]);
    expect(r.dropped).toBe(0);
    // The renderer contract: descriptors carry no library path.
    expect("path" in r.attached[0]!).toBe(false);
    expect(engine.pendingAttachmentPaths(t.id)).toEqual([
      "/lib/1/file-1.txt",
      "/lib/2/file-2.txt",
    ]);
  });

  it("enforces the frozen 8-attachment cap and reports leftovers", () => {
    const { engine } = make();
    const t = engine.createThread(null);
    const first = engine.addAttachments(
      t.id,
      Array.from({ length: 6 }, (_, i) => file(i)),
    );
    expect(first.dropped).toBe(0);
    const second = engine.addAttachments(
      t.id,
      Array.from({ length: 5 }, (_, i) => file(10 + i)),
    );
    expect(second.attached).toHaveLength(2);
    expect(second.dropped).toBe(3);
    expect(engine.pendingAttachmentPaths(t.id)).toHaveLength(8);
  });

  it("removeAttachment returns the copy path; unknown ids are a no-op", () => {
    const { engine } = make();
    const t = engine.createThread(null);
    engine.addAttachments(t.id, [file(1), file(2)]);
    expect(engine.removeAttachment(t.id, "a1")).toBe("/lib/1/file-1.txt");
    expect(engine.removeAttachment(t.id, "nope")).toBeUndefined();
    expect(engine.pendingAttachmentPaths(t.id)).toEqual(["/lib/2/file-2.txt"]);
    engine.removeAttachment(t.id, "a2");
    expect(engine.pendingAttachmentPaths(t.id)).toEqual([]);
  });

  it("sendTurn consumes the set into the frozen 'Attached files:' prompt", async () => {
    const { engine } = make();
    const t = engine.createThread(null);
    engine.addAttachments(t.id, [file(1), file(2)]);
    engine.sendTurn(t.id, "look at these");
    await waitFor(() => threadOf(engine, t.id).turn?.status === "done");
    const th = threadOf(engine, t.id);
    const userMsg = th.messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toBe("look at these");
    expect(userMsg.attachments?.map((a) => a.name)).toEqual([
      "file-1.txt",
      "file-2.txt",
    ]);
    // Mock echo carries the provider prompt — the frozen suffix lands.
    const reply = th.messages.find((m) => m.role === "assistant")!.content;
    expect(reply).toContain("Attached files:");
    expect(reply).toContain("- /lib/1/file-1.txt");
    expect(reply).toContain("- /lib/2/file-2.txt");
    expect(engine.pendingAttachmentPaths(t.id)).toEqual([]);
  });

  it("an attachment-only draft is sendable; a truly empty one is not", async () => {
    const { engine } = make();
    const t = engine.createThread(null);
    expect(() => engine.sendTurn(t.id, "   ")).toThrow();
    engine.addAttachments(t.id, [file(1)]);
    engine.sendTurn(t.id, "");
    await waitFor(() => threadOf(engine, t.id).turn?.status === "done");
    const th = threadOf(engine, t.id);
    const userMsg = th.messages.find((m) => m.role === "user")!;
    expect(userMsg.attachments).toHaveLength(1);
    const reply = th.messages.find((m) => m.role === "assistant")!.content;
    expect(reply).toContain("Attached files:");
    expect(reply).toContain("- /lib/1/file-1.txt");
    // Provisional title falls back to the attachment name, not "".
    expect(th.title).toBe("file-1.txt");
  });

  it("keeps pending sets isolated per thread", () => {
    const { engine } = make();
    const a = engine.createThread(null);
    const b = engine.createThread(null);
    engine.addAttachments(a.id, [file(1)]);
    engine.addAttachments(b.id, [file(9)]);
    expect(engine.pendingAttachmentPaths(a.id)).toEqual(["/lib/1/file-1.txt"]);
    expect(engine.pendingAttachmentPaths(b.id)).toEqual(["/lib/9/file-9.txt"]);
    expect(engine.removeAttachment(a.id, "a9")).toBeUndefined();
  });

  it("deleteThread drops the pending set", () => {
    const { engine } = make();
    const t = engine.createThread(null);
    engine.addAttachments(t.id, [file(1)]);
    engine.deleteThread(t.id);
    expect(engine.pendingAttachmentPaths(t.id)).toEqual([]);
  });

  it("a read-only engine refuses new attachments", () => {
    const { engine } = make();
    const t = engine.createThread(null);
    engine.enterReadOnly();
    expect(() => engine.addAttachments(t.id, [file(1)])).toThrow();
    expect(() => engine.removeAttachment(t.id, "a1")).toThrow();
  });

  it("attachments survive a restart inside the sent message only", async () => {
    const root = tmp();
    const { store, engine } = make(root);
    const t = engine.createThread(null);
    engine.addAttachments(t.id, [file(1)]);
    engine.sendTurn(t.id, "with a file");
    await waitFor(() => threadOf(engine, t.id).turn?.status === "done");
    engine.addAttachments(t.id, [file(7)]); // fresh pending — never sent
    engine.shutdown();
    store.close();

    const reopened = new Store(root);
    reopened.open();
    const engine2 = new Engine(reopened, new MockProvider({ tickMs: 1 }), root, "0.0.0-test");
    const th = threadOf(engine2, t.id);
    const userMsg = th.messages.find((m) => m.role === "user")!;
    expect(userMsg.attachments).toHaveLength(1);
    // Unsent pending sets are runtime state — they do not persist.
    expect(engine2.pendingAttachmentPaths(t.id)).toEqual([]);
  });
});

describe("F05 AttachmentService", () => {
  function svc(root: string, pick: string[] | null, engine: Engine, threadId: string) {
    const attachmentsRoot = join(root, "attachments");
    return new AttachmentService({
      attachmentsRoot,
      showOpenDialog: () =>
        Promise.resolve(
          pick === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: pick },
        ),
      add: (tid, files) => engine.addAttachments(tid === threadId ? tid : tid, files),
      remove: (tid, id) => engine.removeAttachment(tid, id),
      resolve: (tid, id) => engine.attachmentDescriptor(tid, id),
    });
  }

  function srcFile(root: string, name: string, bytes = 12): string {
    const p = join(root, "src");
    mkdirSync(p, { recursive: true });
    const f = join(p, name);
    writeFileSync(f, Buffer.alloc(bytes, 65));
    return f;
  }

  it("copies picks into <dataRoot>/attachments/<id>/ and attaches", async () => {
    const root = tmp();
    const { engine } = make(join(root, "data"));
    const t = engine.createThread(null);
    const src = srcFile(root, "notes.txt");
    const s = svc(root, [src], engine, t.id);
    const r = await s.pick(t.id);
    expect(r.attached).toHaveLength(1);
    expect(r.attached[0]!.name).toBe("notes.txt");
    const libDir = join(root, "attachments", r.attached[0]!.id);
    expect(existsSync(join(libDir, "notes.txt"))).toBe(true);
    expect(engine.pendingAttachmentPaths(t.id)[0]).toBe(join(libDir, "notes.txt"));
  });

  it("a canceled dialog attaches nothing and reports canceled", async () => {
    const root = tmp();
    const { engine } = make(join(root, "data"));
    const t = engine.createThread(null);
    const r = await svc(root, null, engine, t.id).pick(t.id);
    expect(r).toEqual({ attached: [], dropped: 0, canceled: true });
  });

  it("over-cap leftovers are dropped and their copies removed", async () => {
    const root = tmp();
    const { engine } = make(join(root, "data"));
    const t = engine.createThread(null);
    const picks = Array.from({ length: 10 }, (_, i) => srcFile(root, `f${i}.txt`));
    const r = await svc(root, picks, engine, t.id).pick(t.id);
    expect(r.attached).toHaveLength(8);
    expect(r.dropped).toBe(2);
    // Exactly 8 library dirs survive — orphans are gone.
    const lib = join(root, "attachments");
    expect(readdirSync(lib)).toHaveLength(8);
  });

  it("remove() drops both the pending entry and the library copy", async () => {
    const root = tmp();
    const { engine } = make(join(root, "data"));
    const t = engine.createThread(null);
    const src = srcFile(root, "x.txt");
    const s = svc(root, [src], engine, t.id);
    const r = await s.pick(t.id);
    const libDir = join(root, "attachments", r.attached[0]!.id);
    expect(existsSync(libDir)).toBe(true);
    s.remove(t.id, r.attached[0]!.id);
    expect(existsSync(libDir)).toBe(false);
    expect(engine.pendingAttachmentPaths(t.id)).toEqual([]);
  });

  it("addBlobs writes renderer-held bytes into the same library", async () => {
    const root = tmp();
    const { engine } = make(join(root, "data"));
    const t = engine.createThread(null);
    const s = svc(root, null, engine, t.id);
    const r = await s.addBlobs(t.id, [
      { name: "pasted-image.png", data: new Uint8Array([1, 2, 3, 4]) },
      { name: "clip.txt", data: new TextEncoder().encode("clipboard bytes") },
    ]);
    expect(r.attached).toHaveLength(2);
    const p = engine.pendingAttachmentPaths(t.id)[0]!;
    expect(readFileSync(p)).toEqual(Buffer.from([1, 2, 3, 4]));
    // The byte channel is also cap-bounded.
    const r2 = await s.addBlobs(
      t.id,
      Array.from({ length: 10 }, (_, i) => ({ name: `b${i}`, data: new Uint8Array([i]) })),
    );
    expect(r2.attached).toHaveLength(6);
    expect(r2.dropped).toBe(4);
    expect(readdirSync(join(root, "attachments"))).toHaveLength(8);
  });

  it("weird basenames never escape the library root", async () => {
    const root = tmp();
    const { engine } = make(join(root, "data"));
    const t = engine.createThread(null);
    // A dotfile/dirname edge: ".." as a name is impossible from the OS
    // dialog, but copyName still guards the join.
    const weird = srcFile(root, "a:b?.txt");
    const r = await svc(root, [weird], engine, t.id).pick(t.id);
    const p = engine.pendingAttachmentPaths(t.id)[0]!;
    expect(p.startsWith(join(root, "attachments"))).toBe(true);
    expect(r.attached[0]!.name).toBe("a:b?.txt"); // display keeps the truth
  });
describe("A80 attachment read (preview)", () => {
  it("a draft image resolves to display bytes", async () => {
    const root = tmp();
    const { engine } = make(join(root, "data"));
    const t = engine.createThread(null);
    const s = svc(root, null, engine, t.id);
    const r = await s.addBlobs(t.id, [
      { name: "shot.png", data: new Uint8Array([137, 80, 78, 71]) },
    ]);
    const got = s.read(t.id, r.attached[0]!.id);
    expect(got?.kind).toBe("image");
    if (got?.kind === "image") {
      expect(got.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
      expect(got.name).toBe("shot.png");
    }
  });

  it("non-image and unknown attachments stay descriptors", async () => {
    const root = tmp();
    const { engine } = make(join(root, "data"));
    const t = engine.createThread(null);
    const s = svc(root, null, engine, t.id);
    const r = await s.addBlobs(t.id, [
      { name: "notes.txt", data: new TextEncoder().encode("text") },
      { name: "scan.heic", data: new Uint8Array([9, 9]) },
    ]);
    expect(s.read(t.id, r.attached[0]!.id)?.kind).toBe("file");
    // heic is not decodeable by this build — honest file chip.
    expect(s.read(t.id, r.attached[1]!.id)?.kind).toBe("file");
    expect(s.read(t.id, "no-such-id")).toBeUndefined();
  });

  it("a sent message's attachment still resolves from the library", async () => {
    const root = tmp();
    const { engine } = make(join(root, "data"));
    const t = engine.createThread(null);
    const s = svc(root, null, engine, t.id);
    const r = await s.addBlobs(t.id, [
      { name: "after.png", data: new Uint8Array([137, 80, 78, 71]) },
    ]);
    engine.sendTurn(t.id, "see");
    await waitFor(() => threadOf(engine, t.id).turn?.status === "done");
    // Pending set consumed — the read resolves via the message record.
    const got = s.read(t.id, r.attached[0]!.id);
    expect(got?.kind).toBe("image");
    // And an id borrowed from another thread stays out.
    const t2 = engine.createThread(null);
    expect(s.read(t2.id, r.attached[0]!.id)).toBeUndefined();
  });
});
});
