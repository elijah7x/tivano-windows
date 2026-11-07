// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F22 Hydra delegation helpers — frozen HydraDelegationStream parity:
// incremental fenced-block parsing, entry validation, roster naming,
// the head brief and the batched report message.

import { describe, expect, it } from "vitest";
import {
  HydraDelegationStreamParser,
  MAX_DELEGATED_TASKS,
  MAX_DELEGATION_ROUNDS,
  delegatedHeadPrompt,
  delegationFromEntry,
  hasSentDelegationBlock,
  hydraDelegationRequest,
  hydraLeadPolicy,
  hydraReportNote,
  hydraTeamStatus,
  hydraTurnNote,
  markingDelegationBlockSent,
  personaAt,
  personaIndex,
  personaNamed,
  reportMessage,
  rosterIndex,
  streamedDelegations,
  withoutDelegationBlock,
  withoutVerificationSteps,
} from "../src/shared/hydraDelegation";
import { HYDRA_PERSONAS } from "../src/shared/hydra";

const ARRAY_BLOCK =
  "```hydra\n" +
  '[{"task":"Draft the outline","prompt":"Write a short outline."},' +
  '{"task":"Verify the numbers","prompt":"Check the arithmetic.","name":"Ada"}]\n' +
  "```\n";

describe("streamedDelegations — whole-text rescan (frozen)", () => {
  it("parses both entries from a complete array block", () => {
    const r = streamedDelegations(`Working on it.\n\n${ARRAY_BLOCK}\nMore text.`);
    expect(r).not.toBeNull();
    expect(r!.isComplete).toBe(true);
    expect(r!.delegations).toHaveLength(2);
    expect(r!.delegations[0]).toMatchObject({
      task: "Draft the outline",
      prompt: "Write a short outline.",
    });
    expect(r!.delegations[1]!.name).toBe("Ada");
  });

  it("reads a bare-object block", () => {
    const r = streamedDelegations(
      '```hydra\n{"task":"T","prompt":"Do the thing."}\n```\n',
    );
    expect(r!.delegations).toHaveLength(1);
    expect(r!.isComplete).toBe(true);
  });

  it("a still-open block reports entries but stays incomplete", () => {
    const r = streamedDelegations(
      '```hydra\n[{"task":"A","prompt":"P one."},{"task":"B","prompt":"P two."',
    );
    expect(r!.isComplete).toBe(false);
    expect(r!.delegations).toHaveLength(1);
  });

  it("returns null when no hydra opener exists", () => {
    expect(streamedDelegations("plain reply, no fence")).toBeNull();
    expect(streamedDelegations("```ts\nconst x = 1;\n```")).toBeNull();
  });

  it("braces inside JSON strings do not confuse entry tracking", () => {
    const r = streamedDelegations(
      '```hydra\n[{"task":"T","prompt":"Braces {inside} and \\" escaped."}]\n```',
    );
    expect(r!.delegations).toHaveLength(1);
    expect(r!.delegations[0]!.prompt).toContain("{inside}");
  });
});

describe("HydraDelegationStreamParser — incremental ingest", () => {
  const feed = (parts: string[]): HydraDelegationStreamParser => {
    const p = new HydraDelegationStreamParser();
    for (const c of parts) p.ingest(c);
    return p;
  };

  it("emits an entry the moment its outer object closes, mid-array", () => {
    const p = new HydraDelegationStreamParser();
    p.ingest('text\n```hydra\n[{"task":"A","prompt":"P one."}');
    expect(p.delegations).toHaveLength(1);
    expect(p.isComplete).toBe(false);
    p.ingest(',{"task":"B","prompt":"P two."}]\n```\ntail');
    expect(p.delegations).toHaveLength(2);
    expect(p.isComplete).toBe(true);
  });

  it("matches byte-for-byte across single-byte feeds", () => {
    const whole = `lead\n${ARRAY_BLOCK}after`;
    const p = new HydraDelegationStreamParser();
    for (const ch of whole) p.ingest(ch);
    expect(p.delegations).toHaveLength(2);
    expect(p.isComplete).toBe(true);
    expect(p.delegations[1]!.name).toBe("Ada");
  });

  it("a ```hydra-sent block parses but is marked already-dispatched", () => {
    const p = feed([
      "x\n```hydra-sent\n",
      '[{"task":"A","prompt":"P."}]\n```\n',
    ]);
    expect(p.delegations).toHaveLength(1);
    expect(p.isSentBlock).toBe(true);
  });

  it("unparseable entries are skipped, not fatal", () => {
    const p = feed([
      '```hydra\n[{"task":"ok","prompt":"fine."},{broken json},{"task":"B","prompt":"P."}]\n```',
    ]);
    expect(p.delegations.map((d) => d.task)).toEqual(["ok", "B"]);
  });

  it("non-JSON bodies close on the fence without entries", () => {
    const p = feed(["```hydra\nnot json at all\n```\n"]);
    expect(p.delegations).toHaveLength(0);
  });
});

describe("delegationFromEntry — frozen validation", () => {
  it("keeps only entries with a non-empty prompt", () => {
    expect(delegationFromEntry({ task: "T" })).toBeNull();
    expect(delegationFromEntry({ prompt: "   " })).toBeNull();
    expect(delegationFromEntry("a string")).toBeNull();
    expect(delegationFromEntry(null)).toBeNull();
  });

  it("derives a single-line task from the prompt when absent", () => {
    const d = delegationFromEntry({
      prompt: "multi\nline\nprompt text here",
    });
    expect(d!.task).toBe("multi line prompt text here");
  });

  it("accepts the frozen aliases name/head and project/repo", () => {
    const d = delegationFromEntry({
      prompt: "P",
      head: "Otto",
      repo: "Demo",
    });
    expect(d!.name).toBe("Otto");
    expect(d!.project).toBe("Demo");
  });
});

describe("roster — frozen naming rules", () => {
  it("personaAt wraps the roster and rounds name suffixes", () => {
    expect(personaAt(0).name).toBe("Hank");
    expect(personaAt(HYDRA_PERSONAS.length).name).toBe("Hank 2");
    expect(personaAt(3).name).toBe("Otto");
  });

  it("rosterIndex and personaIndex agree on bare and rounded names", () => {
    expect(rosterIndex("Otto")).toBe(3);
    expect(personaIndex("Otto")).toBe(3);
    expect(personaIndex("Otto 2")).toBe(3 + HYDRA_PERSONAS.length);
    expect(personaIndex("Nobody")).toBeUndefined();
    expect(personaNamed("Otto 2")!.name).toBe("Otto 2");
  });
});

describe("delegatedHeadPrompt + reportMessage — frozen text", () => {
  it("the brief names the persona, task, prompt and shared checkout", () => {
    const text = delegatedHeadPrompt(
      personaAt(0),
      { task: "Survey", prompt: "Look around." },
      "/tmp/checkout",
    );
    expect(text).toContain("You are Hank");
    expect(text).toContain("## Your task: Survey");
    expect(text).toContain("Look around.");
    expect(text).toContain("/tmp/checkout");
  });

  it("batches reports by name and marks failed/stopped honestly", () => {
    const msg = reportMessage([
      {
        headIndex: 0,
        task: "A",
        status: "completed",
        text: "Done it.",
        elapsedMs: 65_000,
        toolCalls: 3,
      },
      { headIndex: 1, task: "B", status: "stopped", text: "" },
      { headIndex: 3, task: "C", status: "failed", text: "Broke." },
    ]);
    expect(msg).toContain("Hydra reports: Hank, Walter and Otto finished.");
    expect(msg).toContain("## Hank: A");
    expect(msg).toContain("(stopped by the user before finishing)");
    expect(msg).toContain("(failed)");
    expect(msg).toContain("1m 5s");
    expect(msg).toContain("3 tools");
    expect(msg).toContain("do it yourself or send it out again");
    expect(msg).toContain("leaves its part alone");
  });

  it("names still-working heads in the opening", () => {
    const msg = reportMessage(
      [{ headIndex: 0, task: "A", status: "completed", text: "R." }],
      ["Nova"],
    );
    expect(msg).toContain("Nova is still at work");
  });
});

describe("withoutDelegationBlock — drop-block rewrite", () => {
  it("removes the fenced block and keeps surrounding text", () => {
    const out = withoutDelegationBlock(`before\n\n${ARRAY_BLOCK}\nafter`);
    expect(out).not.toContain("```hydra");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("strips an unterminated block to the end", () => {
    const out = withoutDelegationBlock('lead\n```hydra\n[{"task":"A","prompt":"P."}');
    expect(out.trim()).toBe("lead");
  });
});

describe("markingDelegationBlockSent / hasSentDelegationBlock (frozen)", () => {
  it("rewrites the bare hydra opener to hydra-sent", () => {
    const out = markingDelegationBlockSent(
      "lead reply\n\n" + ARRAY_BLOCK + "tail",
    );
    expect(out).toContain("```hydra-sent");
    expect(out).not.toMatch(/```hydra[ \t]*\n/);
    expect(out).toContain("tail");
    expect(hasSentDelegationBlock(out)).toBe(true);
  });

  it("leaves an already-sent block alone", () => {
    const sent = "x\n```hydra-sent\n[]\n```";
    expect(markingDelegationBlockSent(sent)).toBe(sent);
    expect(hasSentDelegationBlock(sent)).toBe(true);
  });

  it("leaves text without a delegation block alone", () => {
    expect(markingDelegationBlockSent("plain reply")).toBe("plain reply");
    expect(hasSentDelegationBlock("plain reply")).toBe(false);
  });
});

describe("withoutVerificationSteps (frozen)", () => {
  it("drops lines that ask the head to verify, keeping the rest", () => {
    const out = withoutVerificationSteps(
      "Edit src/a.ts to add the flag.\nRun the tests to prove it works.\nReport what changed.",
    );
    expect(out).toContain("Edit src/a.ts");
    expect(out).toContain("Report what changed");
    expect(out).not.toContain("Run the tests");
    expect(out).toContain("lead handles all validation");
  });

  it("returns a clean prompt unchanged", () => {
    const p = "Edit src/a.ts to add the flag.\nReport what changed.";
    expect(withoutVerificationSteps(p)).toBe(p);
  });

  it("strips verification lines out of the head brief", () => {
    const brief = delegatedHeadPrompt(
      personaAt(0),
      { task: "t", prompt: "Do the edit.\nRun the test suite." },
      "/checkout",
    );
    expect(brief).not.toContain("Run the test suite");
    expect(brief).toContain("lead handles all validation");
  });
});

describe("lead policy + turn notes (frozen HydraPrompts slice)", () => {
  const label = (id: string) => (id === "mock" ? "Mock Provider" : id);

  it("teaches the fenced block, the roster and the bounds honestly", () => {
    const p = hydraLeadPolicy({ providerLabel: label });
    expect(p).toContain("[Hydra is on]");
    expect(p).toContain("```hydra");
    expect(p).toContain("Hank, Walter, Ada, Otto");
    expect(p).toContain("a team of helper agents");
    expect(p).toContain("The heads work in your checkout");
    expect(p).not.toContain("merge request");
    expect(p).not.toContain("copy of its project");
  });

  it("sizes the team and names profile routes when the pair has them", () => {
    const p = hydraLeadPolicy({
      maxHeads: 2,
      providerLabel: label,
      profiles: [
        { id: "p1", name: "deep", model: "m1", provider: "mock" },
      ],
    });
    expect(p).toContain("a team of up to 2 helper agents");
    expect(p).toContain("deep (m1 on Mock Provider)");
    expect(p).toContain('"profile": "deep"');
  });

  it("delegation request + turn note + report note carry the team", () => {
    expect(hydraDelegationRequest()).toContain("[Hydra setting: enabled]");
    expect(hydraTurnNote(undefined)).toBe("");
    expect(hydraTurnNote("Your heads so far: Hank (working).")).toContain(
      "Your heads so far",
    );
    const more = hydraReportNote(undefined, true);
    const done = hydraReportNote(undefined, false);
    expect(more).toContain("send heads out again");
    expect(done).toContain("Send out no more heads");
  });

  it("teamStatus reports each head's state", () => {
    const line = hydraTeamStatus(
      [
        { name: "Hank", status: "running", startedAt: Date.now() - 120_000 },
        { name: "Walter", status: "completed", startedAt: 0 },
        { name: "Ada", status: "stopped", startedAt: 0 },
      ],
      Date.now(),
    );
    expect(line).toContain("Hank (working for 2m)");
    expect(line).toContain("Walter (done)");
    expect(line).toContain("Ada (stopped)");
    expect(hydraTeamStatus([])).toBeUndefined();
  });
});

describe("frozen bounds", () => {
  it("keeps the frozen limits", () => {
    expect(MAX_DELEGATION_ROUNDS).toBe(3);
    expect(MAX_DELEGATED_TASKS).toBe(32);
    expect(HYDRA_PERSONAS.length).toBe(25);
  });
});
