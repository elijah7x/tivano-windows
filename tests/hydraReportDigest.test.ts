// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Frozen HydraReportDigest regressions: head headers, outcome/effort
// groups, landing lines, lead-instructions tail and non-head `## `
// sections staying in the body.

import { describe, expect, it } from "vitest";
import { parseHydraReportDigest } from "../src/shared/hydraReportDigest";

describe("hydra report digest (frozen HydraReportDigest)", () => {
  it("splits intro + head sections; outcome and effort off the header", () => {
    const d = parseHydraReportDigest(
      [
        "Hydra reports: Hank and Walter finished. Ada is still at work; its report comes as a later message.",
        "",
        "## Hank: fix the login race (42s, 3 tools)",
        "Landed in your checkout: src/login.ts (+12 −3), src/auth.ts (+4 −1).",
        "Patched the lock ordering and added a regression test.",
        "",
        "## Walter: write docs (failed)",
        "Did not land (apply failed): docs/readme.md (+5 −0).",
        "Could not finish — the spec moved mid-task.",
      ].join("\n"),
    );
    expect(d.intro).toContain("Hank and Walter finished");
    expect(d.heads).toHaveLength(2);
    const [hank, walter] = d.heads;
    expect(hank!.name).toBe("Hank");
    expect(hank!.task).toBe("fix the login race");
    expect(hank!.outcome).toBe("done");
    expect(hank!.effort).toBe("42s · 3 tools");
    expect(hank!.landing).toEqual({
      kind: "landed",
      files: [
        { path: "src/login.ts", additions: 12, deletions: 3, hasConflicts: false },
        { path: "src/auth.ts", additions: 4, deletions: 1, hasConflicts: false },
      ],
    });
    expect(hank!.body).toContain("Patched the lock ordering");
    expect(walter!.outcome).toBe("failed");
    expect(walter!.landing.kind).toBe("notLanded");
    if (walter!.landing.kind === "notLanded") {
      expect(walter!.landing.error).toBe("apply failed");
      expect(walter!.landing.files[0]!.path).toBe("docs/readme.md");
    }
  });

  it("a head's own `## ` markdown stays in its body", () => {
    const d = parseHydraReportDigest(
      [
        "Hydra reports: Hank finished.",
        "",
        "## Hank: survey the repo (10s)",
        "Changed nothing.",
        "## Findings",
        "The repo is clean.",
        "## Notes",
        "Nothing else.",
      ].join("\n"),
    );
    expect(d.heads).toHaveLength(1);
    expect(d.heads[0]!.body).toContain("## Findings");
    expect(d.heads[0]!.body).toContain("## Notes");
    expect(d.heads[0]!.landing).toEqual({ kind: "nothing" });
  });

  it("stopped outcome + copy-path landing parse", () => {
    const d = parseHydraReportDigest(
      [
        "Hydra reports: Walter finished.",
        "",
        "## Walter: refactor the cache (stopped by the user before finishing)",
        "Nothing landed; its unfinished work is in its copy at /tmp/copy-1.",
        "Half the files were moved.",
      ].join("\n"),
    );
    expect(d.heads[0]!.outcome).toBe("stopped");
    expect(d.heads[0]!.landing).toEqual({
      kind: "unfinished",
      copyPath: "/tmp/copy-1",
    });
  });

  it("conflicts mark + `and N more` tail on landed files", () => {
    const d = parseHydraReportDigest(
      [
        "## Hank: big change (5s)",
        "Landed in your checkout: a.ts (+1 −2) with conflicts, b.ts (+3 −0), and 7 more.",
        "Body here.",
      ].join("\n"),
    );
    const l = d.heads[0]!.landing;
    expect(l.kind).toBe("landed");
    if (l.kind === "landed") {
      expect(l.files).toHaveLength(2);
      expect(l.files[0]!.hasConflicts).toBe(true);
      expect(l.files[1]!.path).toBe("b.ts");
    }
  });

  it("lead-instructions tail leaves the LAST head's body only", () => {
    const d = parseHydraReportDigest(
      [
        "## Hank: task one",
        "Report one.",
        "",
        "## Walter: task two",
        "Report two.",
        "",
        "The heads worked in your checkout, so their changes are there already.",
      ].join("\n"),
    );
    expect(d.heads[0]!.body).toBe("Report one.");
    expect(d.heads[1]!.body).toBe("Report two.");
  });

  it("no head headers → intro only, no fabricated heads", () => {
    const d = parseHydraReportDigest("Hydra: the team's work was merged.\nDetails follow.");
    expect(d.heads).toHaveLength(0);
    expect(d.intro).toContain("merged");
  });
});
