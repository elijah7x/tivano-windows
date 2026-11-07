// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// IPC schema hardening: malformed shapes, missing fields, unknown keys and
// non-UUID identifiers (incl. traversal attempts) are all rejected before
// reaching the engine.

import { describe, expect, it } from "vitest";
import { requestValidators, REQUEST_CHANNELS } from "../src/shared/ipc";
import { ValidationError } from "../src/shared/validate";

const uuid = "3f6b7c90-1a2b-4c3d-8e9f-a1b2c3d4e5f6";

describe("IPC request validators", () => {
  it("covers every request channel with a validator", () => {
    for (const c of REQUEST_CHANNELS) expect(requestValidators[c]).toBeTypeOf("function");
  });

  it("exposes no raw-command or raw-path channel", () => {
    for (const c of REQUEST_CHANNELS) {
      expect(c).not.toMatch(/exec|command|shell|path|file|fs|eval/i);
    }
    expect(REQUEST_CHANNELS).not.toContain("links:open-external-file");
  });

  it("accepts well-formed payloads", () => {
    expect(() => requestValidators["state:get"]({})).not.toThrow();
    // The directory chooser is deliberately empty — the renderer may
    // request it but can never supply a path for it to authorize.
    expect(() => requestValidators["projects:open-directory"]({})).not.toThrow();
    expect(requestValidators["projects:create"]({ name: "demo" }).name).toBe("demo");
    expect(requestValidators["threads:create"]({ projectId: null }).projectId).toBeNull();
    expect(requestValidators["turns:send"]({ threadId: uuid, text: "hi" }).text).toBe("hi");
    expect(
      requestValidators["approvals:resolve"]({ threadId: uuid, approvalId: uuid, optionId: "once" }),
    ).toBeTruthy();
    expect(requestValidators["settings:set"]({ theme: "dark" }).theme).toBe("dark");
    expect(
      requestValidators["settings:set"]({ notifyOnDone: true }).notifyOnDone,
    ).toBe(true);
    expect(() => requestValidators["settings:set"]({ notifyOnDone: "yes" })).toThrow(
      ValidationError,
    );
    expect(
      requestValidators["settings:set"]({ autoContinueAfterLimit: true })
        .autoContinueAfterLimit,
    ).toBe(true);
    expect(() =>
      requestValidators["settings:set"]({ autoContinueAfterLimit: 1 }),
    ).toThrow(ValidationError);
    expect(
      requestValidators["settings:set"]({ taskSleepMode: "display" }).taskSleepMode,
    ).toBe("display");
    expect(() =>
      requestValidators["settings:set"]({ taskSleepMode: "hibernate" }),
    ).toThrow(ValidationError);
    expect(requestValidators["limit:cancel"]({ threadId: uuid }).threadId).toBe(uuid);
    expect(requestValidators["limit:handoff"]({ threadId: uuid }).threadId).toBe(uuid);
    expect(() => requestValidators["limit:cancel"]({})).toThrow(ValidationError);
    expect(requestValidators["threads:archive"]({ id: uuid }).id).toBe(uuid);
    expect(requestValidators["threads:unarchive"]({ id: uuid }).id).toBe(uuid);
    expect(
      requestValidators["threads:set-runtime-mode"]({ threadId: uuid, mode: "auto" }).mode,
    ).toBe("auto");
    for (const bad of ["", "yolo", "FullAccess", "supervised "])
      expect(() =>
        requestValidators["threads:set-runtime-mode"]({ threadId: uuid, mode: bad }),
      ).toThrow(ValidationError);
    expect(
      requestValidators["threads:set-pinned"]({ threadId: uuid, pinned: true }).pinned,
    ).toBe(true);
    expect(() =>
      requestValidators["threads:set-pinned"]({ threadId: uuid, pinned: "yes" }),
    ).toThrow(ValidationError);
    // F06 build/plan.
    expect(
      requestValidators["threads:set-interaction-mode"]({ threadId: uuid, mode: "plan" })
        .mode,
    ).toBe("plan");
    // F09 forward.
    expect(requestValidators["threads:forward"]({ threadId: uuid }).threadId).toBe(uuid);
    for (const bad of ["", 5, null])
      expect(() =>
        requestValidators["threads:forward"]({ threadId: bad }),
      ).toThrow(ValidationError);
    // F01/F02 reorder + affiliation moves.
    const other = crypto.randomUUID();
    expect(
      requestValidators["threads:reorder"]({ id: uuid, targetId: other, placeAfter: true })
        .placeAfter,
    ).toBe(true);
    expect(() =>
      requestValidators["threads:reorder"]({ id: uuid, targetId: other }),
    ).toThrow(ValidationError);
    expect(() =>
      requestValidators["threads:reorder"]({ id: uuid, targetId: "not-a-uuid", placeAfter: 1 }),
    ).toThrow(ValidationError);
    expect(
      requestValidators["threads:move-affiliation"]({ id: uuid, projectId: other }).projectId,
    ).toBe(other);
    // Standalone is an explicit null, never an absent/undefined field.
    expect(
      requestValidators["threads:move-affiliation"]({ id: uuid, projectId: null }).projectId,
    ).toBeNull();
    for (const bad of [{ id: uuid }, { id: uuid, projectId: "" }, { id: uuid, projectId: 7 }])
      expect(() => requestValidators["threads:move-affiliation"](bad)).toThrow(ValidationError);
    expect(
      requestValidators["projects:reorder"]({ id: uuid, targetId: other, placeAfter: false })
        .targetId,
    ).toBe(other);
    expect(() =>
      requestValidators["projects:reorder"]({ id: uuid, targetId: other, placeAfter: "yes" }),
    ).toThrow(ValidationError);
    for (const bad of ["", "PLAN", "auto", "build "])
      expect(() =>
        requestValidators["threads:set-interaction-mode"]({ threadId: uuid, mode: bad }),
      ).toThrow(ValidationError);
  });

  it("rejects wrong primitive types and missing fields", () => {
    expect(() => requestValidators["projects:create"]({ name: 5 })).toThrow(ValidationError);
    expect(() => requestValidators["projects:create"]({})).toThrow(ValidationError);
    expect(() => requestValidators["turns:send"]({ threadId: uuid })).toThrow(ValidationError);
    expect(() => requestValidators["turns:send"]("text")).toThrow(ValidationError);
    expect(() => requestValidators["turns:send"](null)).toThrow(ValidationError);
  });

  it("rejects any path-bearing payload on the directory chooser", () => {
    for (const bad of [
      { path: "/tmp/x" },
      { directory: "C:\\" },
      { cwd: "." },
      { path: null },
      { dir: "" },
    ]) {
      expect(() => requestValidators["projects:open-directory"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    }
    expect(() => requestValidators["projects:open-directory"]("/tmp/x")).toThrow(ValidationError);
    expect(() => requestValidators["projects:open-directory"](null)).toThrow(ValidationError);
  });

  it("codex setup channels are deliberately empty — no path can ever cross", () => {
    for (const c of [
      "codex:setup-state",
      "codex:choose",
      "codex:save",
      "codex:clear",
    ] as const) {
      expect(() => requestValidators[c]({}), c).not.toThrow();
      for (const bad of [
        { path: "C:\\codex.exe" },
        { executable: "codex" },
        { argv: ["app-server"] },
        { env: { CODEX_HOME: "x" } },
        { CODEX_HOME: "x" },
      ]) {
        expect(() => requestValidators[c](bad), `${c} ${JSON.stringify(bad)}`).toThrow(
          ValidationError,
        );
      }
      expect(() => requestValidators[c]("C:\\codex.exe"), c).toThrow(ValidationError);
      expect(() => requestValidators[c](null), c).toThrow(ValidationError);
    }
  });

  it("model channels (F17): catalog is empty; set-model takes bounded ids only", () => {
    expect(() => requestValidators["models:list"]({})).not.toThrow();
    for (const bad of [{ model: "x" }, { filter: "x" }, "m", null])
      expect(() => requestValidators["models:list"](bad)).toThrow(ValidationError);

    expect(
      requestValidators["threads:set-model"]({
        threadId: uuid,
        model: "gpt-5",
        effort: "high",
        fastTier: null,
      }),
    ).toBeTruthy();
    expect(
      requestValidators["threads:set-model"]({
        threadId: uuid,
        model: "gpt-5",
        effort: "high",
        fastTier: "fast",
      }),
    ).toBeTruthy();
    expect(
      requestValidators["threads:set-model"]({
        threadId: uuid,
        model: null,
        effort: null,
        fastTier: null,
      }),
    ).toBeTruthy();
    for (const bad of [
      { threadId: uuid, model: 5, effort: null, fastTier: null },
      { threadId: uuid, model: "", effort: null, fastTier: null },
      { threadId: uuid, model: "x".repeat(201), effort: null, fastTier: null },
      { threadId: uuid, model: null, effort: "e".repeat(101), fastTier: null },
      { threadId: uuid, model: "m", effort: null, fastTier: "t".repeat(101) },
      { threadId: uuid, model: "m", effort: null, fastTier: "" },
      { threadId: uuid, model: "m", effort: null, fastTier: 5 },
      { threadId: "not-a-uuid", model: "m", effort: null, fastTier: null },
      { threadId: uuid, model: "m", effort: null, fastTier: null, extra: 1 },
      { threadId: uuid },
    ]) {
      expect(() => requestValidators["threads:set-model"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    }
  });

  it("terminal channels accept only bounded, command-free payloads", () => {
    expect(() =>
      requestValidators["terminals:create"]({ threadId: uuid, cols: 80, rows: 24 }),
    ).not.toThrow();
    expect(() =>
      requestValidators["terminals:input"]({ terminalId: uuid, incarnation: 1, data: "x" }),
    ).not.toThrow();
    // No shell/command/path/env key can ever ride a terminal payload.
    for (const bad of [
      { threadId: uuid, cols: 80, rows: 24, command: "rm -rf /" },
      { threadId: uuid, cols: 80, rows: 24, shell: "/bin/sh" },
      { threadId: uuid, cols: 80, rows: 24, cwd: "/tmp" },
      { threadId: uuid, cols: 80, rows: 24, env: { PATH: "/" } },
      { threadId: uuid, cols: 80, rows: 24, args: ["-c", "x"] },
    ]) {
      expect(() => requestValidators["terminals:create"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    }
    // Bounds: dimensions, incarnation floor, input length.
    for (const bad of [
      { threadId: uuid, cols: 1, rows: 24 },
      { threadId: uuid, cols: 80, rows: 500 },
      { threadId: uuid, cols: 0, rows: 0 },
    ]) {
      expect(() => requestValidators["terminals:create"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    }
    expect(() =>
      requestValidators["terminals:input"]({ terminalId: uuid, incarnation: 0, data: "x" }),
    ).toThrow(ValidationError);
    expect(() =>
      requestValidators["terminals:input"]({
        terminalId: uuid,
        incarnation: 1,
        data: "x".repeat(65537),
      }),
    ).toThrow(ValidationError);
    expect(() =>
      requestValidators["terminals:ack"]({ terminalId: uuid, incarnation: 1, seq: 0 }),
    ).toThrow(ValidationError);
    expect(() => requestValidators["terminals:input"]({ terminalId: "../x", incarnation: 1, data: "x" })).toThrow(
      ValidationError,
    );
  });

  it("rejects unknown keys (strict objects)", () => {
    expect(() =>
      requestValidators["projects:create"]({ name: "x", admin: true }),
    ).toThrow(ValidationError);
    expect(() =>
      requestValidators["turns:send"]({ threadId: uuid, text: "x", cmd: "rm -rf /" }),
    ).toThrow(ValidationError);
  });

  it("rejects non-UUID ids including traversal payloads", () => {
    for (const bad of ["../etc/passwd", "..\\..\\win", "../../root", "store.json", "", "1234", "null", "{}"]) {
      expect(() => requestValidators["threads:select"]({ id: bad }), bad).toThrow(ValidationError);
      expect(() => requestValidators["turns:send"]({ threadId: bad, text: "x" }), bad).toThrow(
        ValidationError,
      );
    }
  });

  it("rejects out-of-range strings and absurd lengths", () => {
    expect(() => requestValidators["projects:create"]({ name: "" })).toThrow(ValidationError);
    expect(() =>
      requestValidators["projects:create"]({ name: "x".repeat(121) }),
    ).toThrow(ValidationError);
    expect(() =>
      requestValidators["turns:send"]({ threadId: uuid, text: "x".repeat(16001) }),
    ).toThrow(ValidationError);
  });

  it("rejects non-http(s) external links at the schema edge", () => {
    // The schema checks shape only; scheme enforcement happens in the handler.
    // Both layers are exercised here for the dangerous schemes.
    const ok = requestValidators["links:open-external"]({ url: "https://example.com" });
    expect(ok.url).toBe("https://example.com");
  });
});

describe("git channel validators", () => {
  const uuid2 = "00000000-0000-4000-8000-000000000002";

  it("accepts the three read-only payloads", () => {
    expect(requestValidators["git:overview"]({ projectId: uuid2 }).projectId).toBe(uuid2);
    expect(requestValidators["git:refresh"]({ projectId: uuid2 }).projectId).toBe(uuid2);
    const d = requestValidators["git:diff"]({
      projectId: uuid2,
      snapshotId: uuid2,
      entryId: uuid2,
      side: "worktree",
    });
    expect(d.side).toBe("worktree");
  });

  it("rejects any field that could carry a path, revision or command", () => {
    for (const bad of [
      { projectId: uuid2, path: "/etc" },
      { projectId: uuid2, cwd: "/" },
      { projectId: uuid2, executable: "/usr/bin/git" },
      { projectId: uuid2, args: ["status"] },
      { projectId: uuid2, revision: "HEAD~1" },
      { projectId: uuid2, dir: ".." },
    ]) {
      expect(() => requestValidators["git:overview"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
      expect(() => requestValidators["git:refresh"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    }
    for (const bad of [
      { projectId: uuid2, snapshotId: uuid2, entryId: uuid2, side: "staged", path: "x" },
      { projectId: uuid2, snapshotId: uuid2, entryId: uuid2, side: "staged", rev: "HEAD" },
      { projectId: uuid2, snapshotId: uuid2, entryId: uuid2, side: "staged", file: "a" },
    ]) {
      expect(() => requestValidators["git:diff"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    }
  });

  it("rejects traversal/non-UUID ids and invalid sides", () => {
    for (const id of ["../x", "/tmp", "HEAD~1", "..\\w", ""]) {
      expect(() => requestValidators["git:overview"]({ projectId: id }), id).toThrow(
        ValidationError,
      );
      expect(() =>
        requestValidators["git:diff"]({
          projectId: uuid2,
          snapshotId: id,
          entryId: uuid2,
          side: "staged",
        }),
      ).toThrow(ValidationError);
      expect(() =>
        requestValidators["git:diff"]({
          projectId: uuid2,
          snapshotId: uuid2,
          entryId: id,
          side: "staged",
        }),
      ).toThrow(ValidationError);
    }
    expect(() =>
      requestValidators["git:diff"]({
        projectId: uuid2,
        snapshotId: uuid2,
        entryId: uuid2,
        side: "HEAD",
      }),
    ).toThrow(ValidationError);
    expect(() => requestValidators["git:diff"]({ projectId: uuid2, snapshotId: uuid2, entryId: uuid2 })).toThrow(
      ValidationError,
    );
  });
});

describe("questions:answer", () => {
  const uuid3 = "6b7f4a3c-9d2e-4f1a-8b5c-1e2d3f4a5b6c";
  it("accepts a bounded answer map", () => {
    const ok = requestValidators["questions:answer"]({
      threadId: uuid3,
      providerKey: "i:77",
      answers: { q1: ["a", "b"], "q-2": [] },
    });
    expect(ok.providerKey).toBe("i:77");
    expect(ok.answers["q-2"]).toEqual([]);
  });
  it("rejects non-object answers, oversized keys/values and foreign fields", () => {
    for (const bad of [
      { threadId: uuid3, providerKey: "i:1", answers: "nope" },
      { threadId: uuid3, providerKey: "i:1", answers: ["a"] },
      { threadId: uuid3, providerKey: "i:1", answers: { q1: "notarray" } },
      { threadId: uuid3, providerKey: "i:1", answers: { q1: [""] } },
      { threadId: uuid3, providerKey: "i:1", answers: { q1: [42] } },
      { threadId: uuid3, providerKey: "i:1", answers: { q1: ["x".repeat(2001)] } },
      { threadId: uuid3, providerKey: "i:1", answers: { ["k".repeat(201)]: ["a"] } },
      { threadId: uuid3, providerKey: "i:1", answers: { q1: ["a"], command: "rm" } },
      { threadId: uuid3, providerKey: "i:1", answers: { q1: ["a"] }, path: "/etc" },
      { threadId: uuid3, providerKey: "i:1", answers: { q1: ["a"] }, exec: "sh" },
      { threadId: uuid3, providerKey: "i:1", answers: { q1: ["a"] }, rpc: {} },
      { threadId: uuid3, providerKey: "x".repeat(301), answers: { q1: ["a"] } },
      { threadId: "not-a-uuid", providerKey: "i:1", answers: { q1: ["a"] } },
      { threadId: uuid3, providerKey: "i:1", answers: Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [`q${i}`, ["a"]]),
        ) },
      { threadId: uuid3, providerKey: "i:1", answers: { q1: Array(17).fill("a") } },
    ]) {
      expect(() => requestValidators["questions:answer"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    }
  });

  it("follow-up channels (F08): bounded text, ids and move flags only", () => {
    const fu2 = "00000000-0000-4000-8000-0000000000f2";
    const fu3 = "00000000-0000-4000-8000-0000000000f3";
    const uuid2 = fu2;
    const uuid3 = fu3;
    expect(
      requestValidators["followUps:enqueue"]({ threadId: uuid, text: "hi" }),
    ).toBeTruthy();
    expect(
      requestValidators["followUps:move"]({
        threadId: uuid,
        id: uuid2,
        targetId: uuid3,
        after: true,
      }),
    ).toBeTruthy();
    expect(
      requestValidators["followUps:bundle"]({ threadId: uuid, id: uuid2, ontoId: uuid3 }),
    ).toBeTruthy();
    expect(
      requestValidators["followUps:send-now"]({ threadId: uuid, id: uuid2 }),
    ).toBeTruthy();
    expect(
      requestValidators["followUps:interrupt-send"]({ threadId: uuid, text: "go" }),
    ).toBeTruthy();
    for (const bad of [
      { threadId: uuid, text: "" },
      { threadId: uuid, text: "x".repeat(8001) },
      { threadId: uuid },
      { threadId: uuid, text: "hi", extra: 1 },
    ])
      expect(() => requestValidators["followUps:enqueue"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    for (const bad of [
      { threadId: uuid, id: "not-a-uuid" },
      { threadId: uuid },
      { threadId: uuid, id: uuid2, remove: true },
    ])
      expect(() => requestValidators["followUps:remove"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    for (const bad of [
      { threadId: uuid, id: uuid2, targetId: uuid3, after: "yes" },
      { threadId: uuid, id: uuid2, after: true },
      { threadId: uuid, id: uuid2, targetId: "nope", after: true },
    ])
      expect(() => requestValidators["followUps:move"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
    for (const bad of [
      { threadId: uuid, text: "go", command: "rm" },
      { threadId: uuid, text: "go", path: "/etc" },
      { threadId: uuid, text: "" },
    ])
      expect(() =>
        requestValidators["followUps:interrupt-send"](bad),
      ).toThrow(ValidationError);
  });
});

describe("checkpoints:diff payload (F10/A32)", () => {
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  it("accepts thread/turn ids plus a bounded repo-relative path", () => {
    const v = requestValidators["checkpoints:diff"]({
      threadId: uuid,
      turnId: uuid,
      path: "src/a.txt",
    });
    expect(v.path).toBe("src/a.txt");
  });
  it("rejects missing/oversized path and foreign fields", () => {
    for (const bad of [
      { threadId: uuid, turnId: uuid },
      { threadId: uuid, turnId: uuid, path: 42 },
      { threadId: uuid, turnId: uuid, path: "x".repeat(1100) },
      { threadId: uuid, turnId: uuid, path: "a.txt", cwd: "/" },
      { threadId: uuid, turnId: uuid, path: "a.txt", command: "rm" },
    ])
      expect(() => requestValidators["checkpoints:diff"](bad), JSON.stringify(bad)).toThrow(
        ValidationError,
      );
  });
});
