// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Deterministic synthetic provider. It runs NO real model, tool or command:
// every turn is a fixed script whose scenario is selected by a marker in the
// prompt. The renderer labels it "Mock Provider" everywhere it appears.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalRequest } from "../shared/types";
import type {
  AdapterDisposeResult,
  ProviderAdapter,
  ProviderCallbacks,
  ProviderDescriptor,
  ProviderTurnHandle,
  TextGenerationOptions,
  TurnContext,
} from "./provider";

export const MOCK_PROVIDER_ID = "mock";
export const MOCK_PROVIDER_LABEL = "Mock Provider (synthetic — no real model, tools or commands)";

/** Synthetic action identity used for session/always grants. */
export const MOCK_ACTION_ID = "mock:write-notes";

export type { ProviderCallbacks, ProviderTurnHandle };

const DEFAULT_TICK_MS = 12;

function replyScript(prompt: string): string[] {
  // The wire prompt may carry injected guidance (the Hydra
  // policy, forwarded context). Its echo is verbatim EXCEPT the fenced
  // hydra opener: a policy that teaches the block shape embeds one as
  // an example, and an echoed live fence would parse as a real
  // delegation — a phantom head. The sanitizer keeps the text legible
  // while the opener can never come back through the parser.
  const shown = prompt
    .replaceAll(
      /```[ \t]*hydra(?:-sent|-leaving)?[^\n]*\n[\s\S]*?```/gi,
      "〔hydra-block〕",
    )
    .replaceAll(/```[ \t]*hydra(?:-sent|-leaving)?/gi, "〔hydra-block〕")
    // `[mock:*]` tokens steer the fixture; they are control input, not
    // content. Letting them echo would re-arm the same fixture wherever
    // the reply travels — a head's summary reaching the report turn
    // would re-run `[mock:touch]` writes in the lead's workspace, and an
    // echoed `[mock:approval]` would wedge the report itself.
    .replaceAll(/\[mock:[^\]\n]*\]/gi, "〔mock〕");
  const head = `Working on: “${shown}” — a **synthetic** turn. No real model, file or command is involved.`;
  return [
    head + "\n\n",
    "Fixed reply from the **Mock Provider**:\n\n",
    "- deterministic item one\n",
    "- deterministic item two\n\n",
    "```ts\nconst synthetic = true; // mock output, not generated code\n```\n",
    "\nDone — nothing was executed.",
    // P1-38 fixture: the lead answering an independent review gives one
    // verdict line per finding (accept the first, reject the rest), so
    // the card's accepted/rejected counts have a real reply to parse.
    ...(prompt.includes("[Hydra] Review: an independent review by")
      ? [
          "\n\nFinding 1: accepted - restored the guard\n",
          "Finding 2: rejected - the assertion already runs first\n",
        ]
      : []),
  ];
}

function slowScript(): string[] {
  const out: string[] = [];
  for (let i = 1; i <= 30; i++) out.push(`chunk ${i}/30 of a slow synthetic reply.\n`);
  return out;
}

export interface MockProviderOptions {
  tickMs?: number;
  /** Test hook: drive ticks manually instead of a timer. */
  manual?: boolean;
}

interface TurnDriver {
  cancelled: boolean;
  paused: boolean;
  seq: number;
  queue: Array<() => void>;
  cb: ProviderCallbacks;
}

/**
 * Runs one scripted turn. Chunks carry a monotonically increasing seq; the
 * engine re-checks it, so even a buggy adapter cannot replay old deltas.
 */
export class MockProvider implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: MOCK_PROVIDER_ID,
    label: MOCK_PROVIDER_LABEL,
    mode: "mock",
    synthetic: true,
  };
  private readonly drivers = new Set<TurnDriver>();
  private disposed = false;
  /** F19: per-thread cumulative token counter — deterministic synthetic
   *  values only (labelled synthetic everywhere the mock appears). The
   *  cumulative shape lets the engine's spend tracker exercise its real
   *  delta accounting; the numbers themselves are not real usage. */
  private readonly sessionTotals = new Map<string, number>();
  /** P1-36: lead threads whose report turns keep re-delegating
   *  (`[mock:hydra-loop*]` fixtures) — the loop flavor decides whether
   *  the next batch's heads work or quiet-fail. */
  private readonly hydraLoops = new Map<string, "ok" | "fail">();
  /** P1-12: leads whose next report-turn reply carries a "continue"
   *  entry (one-shot latch); "ghost" names a head that never spawned. */
  private readonly hydraContinueLeads = new Set<string>();
  private readonly hydraContinueGhosts = new Set<string>();

  constructor(private readonly opts: MockProviderOptions = {}) {}

  start(ctx: TurnContext, cb: ProviderCallbacks): ProviderTurnHandle {
    if (this.disposed) throw new Error("provider already disposed");
    const prompt = ctx.prompt;
    const driver: TurnDriver = {
      cancelled: false,
      paused: false,
      seq: 0,
      queue: [],
      cb,
    };
    this.drivers.add(driver);

    const wantsApproval = prompt.includes("[mock:approval]");
    const wantsFail = prompt.includes("[mock:fail]");
    // F20: `[mock:limit]` fails the turn with a limit worded like a real
    // provider's; `[mock:limit:N]` claims the reset is N seconds out, and
    // `[mock:limit-notime]` names no reset at all.
    const limitMatch = /\[mock:limit(?::(\d+))?\]/.exec(prompt);
    const limitSecs = limitMatch?.[1];
    const wantsLimit = limitMatch !== null;
    const wantsLimitNoTime = prompt.includes("[mock:limit-notime]");
    const wantsSlow = prompt.includes("[mock:slow]");
    // F22 fixtures: `[mock:hydra]` streams a mid-reply delegation block
    // split inside the JSON (incremental dispatch parity);
    // `[mock:hydra-wait]` hides an approval hold inside the head's
    // prompt so a test can stop it deterministically.
    const wantsHydraWait = prompt.includes("[mock:hydra-wait]");
    const wantsHydra = prompt.includes("[mock:hydra]");
    // F22 pair-binding fixtures: `[mock:hydra-waitmany]` = a held head
    // plus two plain ones (cap pacing / hydraWaiting drain);
    // `[mock:hydra-profile]` = one delegation routed to the `deep`
    // profile and one unrouted (profile binding parity).
    const wantsHydraWaitMany = prompt.includes("[mock:hydra-waitmany]");
    const wantsHydraProfile = prompt.includes("[mock:hydra-profile]");
    // F22 isolation fixtures: `[mock:hydra-touch]` = two delegations
    // whose prompts each carry `[mock:touch <file>]` — the mock writes
    // that file inside the turn's workspace dir, so an isolated head's
    // landing has real bytes to carry back (fixture-only filesystem
    // write, still synthetic; confined to the granted workspace).
    const wantsHydraTouch = prompt.includes("[mock:hydra-touch]");
    // 2.2.12 start-failure fixtures: `[mock:hydra-badroute]` = one
    // delegation routed to a project that is not in the sidebar;
    // `[mock:hydra-deadcheckout]` = one routed to the project named
    // "ghost-checkout" (a test binds it with no live directory);
    // `[mock:hydra-waitroute]` = a held head plus a waiting unroutable
    // one, so the queued head fails after the lead is already idle.
    const wantsHydraBadRoute = prompt.includes("[mock:hydra-badroute]");
    const wantsHydraDeadCheckout = prompt.includes("[mock:hydra-deadcheckout]");
    const wantsHydraWaitRoute = prompt.includes("[mock:hydra-waitroute]");
    // P2-07 fixture: `[mock:hydra-waitq]` = one head that parks on a
    // user-input question instead of an approval.
    const wantsHydraWaitQ = prompt.includes("[mock:hydra-waitq]");
    // F03/P2-06 fixture: `[mock:hydra-quiet]` = one head whose own prompt
    // goes silent — the quiet watchdog owns what happens to it.
    const wantsHydraQuiet = prompt.includes("[mock:hydra-quiet]");
    // 2.2.12 startup-failure fixtures: `[mock:hydra-failstart]` = two
    // heads whose turns error before a word or a tool plus one that
    // completes (likely-temporary wording); `[mock:hydra-failall]` = all
    // quiet-fail (provider-environment wording); `[mock:hydra-failtransient]`
    // = a quiet-fail with a transient error (generic take-over wording).
    const wantsHydraFailStart = prompt.includes("[mock:hydra-failstart]");
    const wantsHydraFailAll = prompt.includes("[mock:hydra-failall]");
    const wantsHydraFailTransient = prompt.includes("[mock:hydra-failtransient]");
    // P1-36 fixtures: `[mock:hydra-role]` = one delegation whose entry
    // carries the adaptive mode's `role` job-title field;
    // `[mock:hydra-loop]` re-delegates on every report turn (round
    // budget) and `[mock:hydra-loop-fail]` the same with quiet-fail
    // heads (producedNothing refunds). Loops stick per lead thread —
    // the report turn itself carries no token.
    const wantsHydraRole = prompt.includes("[mock:hydra-role]");
    // P1-37 fixture: `[mock:hydra-identity]` = one delegation whose entry
    // carries the adaptive mode's `identity` number plus `role` title.
    const wantsHydraIdentity = prompt.includes("[mock:hydra-identity]");
    // P1-08 fixture: `[mock:hydra-path]` followed by the absolute path —
    // the delegation routes the head at that folder so a test drives
    // non-Git/system/broken-Git routing with a real directory. A quoted
    // path exercises folders whose names contain spaces.
    const hydraPathMatch = prompt.match(/\[mock:hydra-path\]("[^"]+"|\S+)/);
    const wantsHydraPath = hydraPathMatch !== null;
    const hydraPathArg = wantsHydraPath
      ? hydraPathMatch[1]!.replace(/^"|"$/g, "")
      : "";
    const hydraPathEntry = wantsHydraPath
      ? `[{"task":"Folder work","prompt":"Try it.","project":${JSON.stringify(hydraPathArg)}}]`
      : "";
    // P1-12 fixture: `[mock:hydra-continue]` — the lead's reply to the
    // batch report emits one `"continue": "Hank"` entry, sending the
    // rework back into Hank's own session and copy (same job). It
    // latches like the loop fixtures and fires once.
    const wantsHydraContinue = prompt.includes("[mock:hydra-continue]");
    const wantsHydraContinueGhost = prompt.includes("[mock:hydra-continue-ghost]");
    if (wantsHydraContinue) this.hydraContinueLeads.add(ctx.threadId);
    if (wantsHydraContinueGhost) this.hydraContinueGhosts.add(ctx.threadId);
    const continueReport =
      prompt.includes("Hydra reports:") &&
      (this.hydraContinueLeads.has(ctx.threadId) ||
        this.hydraContinueGhosts.has(ctx.threadId));
    const continueGhost = this.hydraContinueGhosts.has(ctx.threadId) && continueReport;
    if (continueReport) {
      this.hydraContinueLeads.delete(ctx.threadId);
      this.hydraContinueGhosts.delete(ctx.threadId);
    }
    const wantsHydraLoop = prompt.includes("[mock:hydra-loop]");
    const wantsHydraLoopFail = prompt.includes("[mock:hydra-loop-fail]");
    if (wantsHydraLoop) this.hydraLoops.set(ctx.threadId, "ok");
    if (wantsHydraLoopFail) this.hydraLoops.set(ctx.threadId, "fail");
    const looped =
      this.hydraLoops.has(ctx.threadId) && prompt.includes("Hydra reports:");
    // `[mock:fail-quiet]` errors the turn before ANY chunk — a head that
    // failed having said nothing and run no tool (frozen startupFailure);
    // `[mock:fail-quiet-transient]` the same with a transient error.
    const wantsFailQuietTransient = prompt.includes("[mock:fail-quiet-transient]");
    const wantsFailQuiet =
      prompt.includes("[mock:fail-quiet]") || wantsFailQuietTransient;
    // F03 watchdog fixtures: `[mock:quiet]` emits its opening chunks then
    // goes silent forever (paused queue, nothing left) — the quiet
    // watchdog owns what happens next. `[mock:mend]` leads with an
    // unclosed `**` so the stream-mend display path is observable, then
    // holds the same way.
    const wantsQuiet = prompt.includes("[mock:quiet]");
    const wantsMend = prompt.includes("[mock:mend]");
    // P2-07 fixture: `[mock:question]` presents a user-input request then
    // holds — the waiting-for-answer path an approval already exercises.
    const wantsQuestion = prompt.includes("[mock:question]");
    // `[mock:reason]` streams a reasoning item then holds — the running
    // indicator's chevron has thinking steps to open (frozen disclosure).
    const wantsReason = prompt.includes("[mock:reason]");
    const touchMatch = /\[mock:touch ([A-Za-z0-9._/-]+)\]/.exec(prompt);
    if (touchMatch?.[1] && ctx.workspace?.directory) {
      const rel = touchMatch[1];
      if (!rel.startsWith("/") && !rel.split("/").includes("..")) {
        try {
          writeFileSync(
            join(ctx.workspace.directory, rel),
            `mock touch ${rel} — synthetic fixture write, never provider work. dir=${ctx.workspace.directory}\n`,
          );
          // A real write reports itself like Codex's fileChange item —
          // the ledger's touched paths then cover what the head did.
          cb.onFileChanges?.([rel]);
        } catch {
          /* a write that cannot happen stays invisible — the fixture
             is honest about doing nothing rather than faking a file */
        }
      }
    }
    // F03: `[mock:notice]` / `[mock:notice:warning]` / `[mock:notice:error]`
    // emits a provider notice mid-turn at the given severity.
    const noticeMatch = /\[mock:notice(?::(warning|error))?\]/.exec(prompt);
    const noticeLevel = (noticeMatch?.[1] ?? "info") as
      | "info"
      | "warning"
      | "error";
    const chunks = wantsSlow ? slowScript() : replyScript(prompt);
    if (
      wantsHydra || wantsHydraWait || wantsHydraWaitMany ||
      wantsHydraProfile || wantsHydraTouch || wantsHydraBadRoute ||
      wantsHydraDeadCheckout || wantsHydraWaitRoute || wantsHydraWaitQ ||
      wantsHydraQuiet || wantsHydraFailStart || wantsHydraFailAll ||
      wantsHydraFailTransient || wantsHydraRole || wantsHydraIdentity ||
      wantsHydraLoop || wantsHydraLoopFail || continueReport || looped ||
      wantsHydraPath
    ) {
      const entries = wantsHydraWait || wantsHydraWaitMany || wantsHydraWaitRoute || wantsHydraWaitQ
        ? wantsHydraWaitMany
          ? '[{"task":"Hold for approval","prompt":"Work then hold. [mock:approval]"},{"task":"Part two","prompt":"Second part."},{"task":"Part three","prompt":"Third part."}]'
          : wantsHydraWaitRoute
            ? '[{"task":"Hold for approval","prompt":"Work then hold. [mock:approval]"},{"task":"Lost errand","prompt":"Try it.","project":"ghost-proj"}]'
          : wantsHydraWaitQ
            ? '[{"task":"Ask something","prompt":"Work then ask. [mock:question]"}]'
            : '[{"task":"Hold for approval","prompt":"Work then hold. [mock:approval]"}]'
        : wantsHydraTouch
          ? '[{"task":"Write alpha","prompt":"Write the file. [mock:touch hydra-alpha.txt]"},{"task":"Write beta","prompt":"Write the file. [mock:touch hydra-beta.txt]"}]'
        : wantsHydraProfile
          ? '[{"task":"Deep pass","prompt":"Deep work.","profile":"deep"},{"task":"Plain pass","prompt":"Plain work."}]'
        : wantsHydraBadRoute
          ? '[{"task":"Lost errand","prompt":"Try it.","project":"ghost-proj"}]'
        : wantsHydraDeadCheckout
          ? '[{"task":"Dead checkout","prompt":"Try it.","project":"ghost-checkout"}]'
        : wantsHydraPath
          ? hydraPathEntry
        : wantsHydraQuiet
          ? '[{"task":"Sit still","prompt":"Open up then sit silent. [mock:quiet]"}]'
        : wantsHydraFailStart
          ? '[{"task":"Quiet fail one","prompt":"Try it. [mock:fail-quiet]"},{"task":"Quiet fail two","prompt":"Try it. [mock:fail-quiet]"},{"task":"Steady part","prompt":"Normal work."}]'
        : wantsHydraFailAll
          ? '[{"task":"Quiet fail one","prompt":"Try it. [mock:fail-quiet]"},{"task":"Quiet fail two","prompt":"Try it. [mock:fail-quiet]"}]'
        : wantsHydraFailTransient
          ? '[{"task":"Flaky start","prompt":"Try it. [mock:fail-quiet-transient]"},{"task":"Steady part","prompt":"Normal work."}]'
        : wantsHydraRole
          ? '[{"role":"Outline it","prompt":"Normal work."}]'
        : wantsHydraIdentity
          ? '[{"role":"Scout","prompt":"Map the area.","identity":1},{"role":"No pick","prompt":"Plain work."}]'
        : continueReport
          ? continueGhost
            ? '[{"task":"Rework Nova","prompt":"Try again.","continue":"Nova"}]'
            : '[{"task":"Rework Hank","prompt":"Rework your part: tighten the intro.","continue":"Hank"}]'
        : wantsHydraLoopFail || (looped && this.hydraLoops.get(ctx.threadId) === "fail")
          ? '[{"task":"Quiet fail","prompt":"Try it. [mock:fail-quiet]"}]'
        : wantsHydraLoop || looped
          ? '[{"task":"Loop part","prompt":"Normal work."}]'
          : '[{"task":"Draft the outline","prompt":"Write a short outline."},{"task":"Verify the numbers","prompt":"Check the arithmetic."}]';
      // Split so the first entry closes one chunk BEFORE the second —
      // deterministic incremental dispatch (a head spawns while the
      // block is still open), and a window exists to stop mid-block.
      const boundary = entries.indexOf("},");
      const cut = Math.max(boundary + 2, 80);
      chunks.splice(
        3,
        0,
        "\n\nSending heads out:\n\n```hydra\n",
        entries.slice(0, 60),
        entries.slice(60, cut),
        entries.slice(cut) + "\n",
        "```\n\nHeads dispatched.",
      );
    }
    // The mend text must be the LAST-arriving paragraph — the driver
    // emits chunks[0..1] then holds, so it slots in at index 1, after the
    // scripted head, leaving its `**` open inside the streaming block.
    if (wantsMend) chunks.splice(1, 0, "\n\nDraft reply with **an open");

    // F19: deterministic synthetic usage — emitted once at turn end like
    // a real provider's final reading. used = context occupancy for the
    // turn; sessionTotal = this thread's running counter.
    const syntheticUsed = 1200 + (prompt.length % 400) * 7;
    const emitUsage = () => {
      const prev = this.sessionTotals.get(ctx.threadId) ?? 0;
      const total = prev + syntheticUsed;
      this.sessionTotals.set(ctx.threadId, total);
      cb.onUsage?.({
        usedTokens: syntheticUsed,
        windowTokens: 200_000,
        sessionTotalTokens: total,
      });
    };

    for (const delta of chunks.slice(0, wantsFailQuiet ? 0 : 2)) {
      driver.queue.push(() => cb.onChunk(++driver.seq, delta));
    }
    if (noticeMatch) {
      driver.queue.push(() =>
        cb.onNotice?.(`Synthetic ${noticeLevel} notice from the Mock Provider.`, noticeLevel),
      );
    }

    if (wantsFailQuietTransient) {
      driver.queue.push(() =>
        cb.onError("Synthetic provider error: the connection dropped before the turn began."),
      );
    } else if (wantsFailQuiet) {
      driver.queue.push(() =>
        // No literal fixture token in the error: a quoted error landing
        // in the lead's report-turn prompt must not re-arm the fixture.
        cb.onError("Synthetic provider error (synthetic fail-quiet)."),
      );
    } else if (wantsLimitNoTime) {
      driver.queue.push(() =>
        cb.onError("usage limit reached on the synthetic account"),
      );
    } else if (wantsLimit) {
      driver.queue.push(() => {
        const at = Math.floor(Date.now() / 1000) + (Number(limitSecs) || 90);
        cb.onError(`usage limit reached|${at}`);
      });
    } else if (wantsFail) {
      driver.queue.push(() =>
        cb.onError("Synthetic provider error (synthetic fail)."),
      );
    } else if (wantsApproval) {
      driver.queue.push(() => {
        driver.paused = true;
        cb.onApproval({
          kind: "command",
          headline: "Allow this action?",
          title: "mock-write ./notes.txt",
          detail:
            "Synthetic action requested by the Mock Provider. Nothing will be executed regardless of the answer.",
          reason: "Phase-1 vertical-slice approval exercise.",
          symbol: "exclamationmark.shield",
          options: [
            { id: "deny", title: "Deny", role: "deny", scope: "none" },
            { id: "once", title: "Allow once", role: "approve", scope: "once" },
            { id: "session", title: "Allow for session", role: "approve", scope: "session" },
            { id: "always", title: "Always allow", role: "approve", scope: "always" },
          ],
        });
      });
      // Post-approval chunks are queued only after resume(true); see below.
      const tail = chunks.slice(2);
      driver.queue.push(() => {
        // Reached only when resumed; emits the remaining chunks then done.
        for (const delta of tail) cb.onChunk(++driver.seq, delta);
        emitUsage();
        cb.onDone();
      });
    } else if (wantsQuestion) {
      driver.queue.push(() => {
        driver.paused = true;
        cb.onQuestion?.({
          providerKey: "mock-q-1",
          questions: [
            {
              id: "q1",
              header: "Synthetic check",
              prompt: "Pick a synthetic answer.",
              choices: [{ label: "continue" }, { label: "hold" }],
              allowsOther: false,
              isSecret: false,
            },
          ],
        });
      });
      const tail = chunks.slice(2);
      driver.queue.push(() => {
        // Reached only when the question is answered; emits the rest.
        for (const delta of tail) cb.onChunk(++driver.seq, delta);
        emitUsage();
        cb.onDone();
      });
    } else if (wantsQuiet || wantsMend || wantsReason) {
      if (wantsReason) {
        driver.queue.push(() =>
          cb.onReasoning?.({
            itemId: "r1",
            delta: "Considering the request — weighing options",
          }),
        );
        driver.queue.push(() =>
          cb.onReasoning?.({
            itemId: "r1",
            done: true,
            finalText: "Considering the request — weighing options (done)",
          }),
        );
        // One settled step + one still running — the disclosure's
        // WorkSteps and the counted work-group label both get material.
        driver.queue.push(() =>
          cb.onToolActivity?.({
            itemId: "t1",
            kind: "read",
            title: "notes.txt",
            status: "completed",
          }),
        );
        driver.queue.push(() =>
          cb.onToolActivity?.({
            itemId: "t2",
            kind: "command",
            title: "echo synthetic hold",
            status: "started",
          }),
        );
      }
      driver.queue.push(() => {
        // Silent hold — a stalled queue stands in for a provider that
        // has gone quiet mid-turn. Nothing resumes it; the watchdog or
        // a user cancel is the only way out (frozen quiet-stop parity).
        driver.paused = true;
      });
    } else {
      for (const delta of chunks.slice(2)) {
        driver.queue.push(() => cb.onChunk(++driver.seq, delta));
      }
      driver.queue.push(() => {
        emitUsage();
        cb.onDone();
      });
    }

    const pump = () => {
      if (driver.cancelled || driver.paused) return;
      const step = driver.queue.shift();
      if (!step) return;
      step();
      if (driver.queue.length > 0 && !driver.cancelled && !driver.paused)
        schedule();
    };

    const schedule = () => {
      if (this.opts.manual) return;
      setTimeout(pump, this.opts.tickMs ?? DEFAULT_TICK_MS);
    };

    schedule();

    const handle: ProviderTurnHandle = {
      cancel: () => {
        driver.cancelled = true;
        driver.queue.length = 0;
        this.drivers.delete(driver);
      },
      resume: (approved: boolean) => {
        if (driver.cancelled) return;
        driver.paused = false;
        if (!approved) {
          driver.queue.length = 0;
          return;
        }
        pump();
      },
      answer: (providerKey: string) => {
        if (driver.cancelled) return;
        cb.onQuestionAnswered?.(providerKey);
        driver.paused = false;
        pump();
      },
    };
    if (this.opts.manual) {
      (handle as { pump?: () => void }).pump = pump;
    }
    return handle;
  }

  /**
   * F31: deterministic synthetic title — a text transform of the request,
   * NOT a model call. Strips scenario markers, keeps ≤7 words / ≤40 chars,
   * sentence case, matching the frozen title rules. Null when the request
   * has no usable words so the engine keeps its prompt-derived fallback.
   */
  async generateTitle(message: string): Promise<string | null> {
    const words = message
      .replace(/\[(?:mock|syn):[^\]]*\]/g, " ")
      .replace(/["'`*#?_!]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 7);
    if (words.length === 0) return null;
    let title = words.join(" ");
    if (title.length > 40) title = title.slice(0, 40).replace(/\s+\S*$/, "");
    title = title.replace(/[:;,!….\s]+$/, "");
    if (!title) return null;
    return title[0]!.toUpperCase() + title.slice(1);
  }

  /**
   * F13: deterministic synthetic commit draft — the first changed path
   * from `status --short` becomes an imperative subject. A text transform,
   * NOT a model call; instructions are recorded in the prompt contract
   * but a synthetic engine cannot honor free-form text.
   */
  async generateCommitMessage(summary: string): Promise<string | null> {
    const first = summary
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    const path = first?.replace(/^[A-Z?!.]+\s+/, "").replace(/^"|"$/g, "");
    const base = path?.split(" -> ").pop()?.split("/").pop()?.trim();
    return base ? `Update ${base}` : "Update project files";
  }

  /**
   * P1-38: deterministic synthetic review — the review prompt carries
   * the job's own request, so a `[mock:review-findings]` token in the
   * USER's message yields two findings and `[mock:review-error]` a
   * null (unusable) reply; everything else reports NO FINDINGS.
   */
  async generateHydraReview(prompt: string): Promise<string | null> {
    if (prompt.includes("[mock:review-error]")) return null;
    if (!prompt.includes("[mock:review-findings]")) return "NO FINDINGS";
    return [
      "Finding 1: src/app.ts:12, the deleted null check lets a missing config reach the parser — restore the guard.",
      "Finding 2: tests/app.test.ts:4, the new assertion never runs behind the early return — move it above.",
    ].join("\n");
  }

  /**
   * P2-01: deterministic synthetic composer prediction — inspects ONLY the
   * latest `User:` line in `context` for `[mock:predict*]` fixture markers:
   * - `[mock:predict-fail]` rejects to exercise error resilience
   * - `[mock:predict-empty]` returns `{"suggestion":null}`
   * - `[mock:predict-invalid]` returns non-JSON output
   * - `[mock:predict:TEXT]` returns `{"suggestion":"TEXT"}`
   * Everything else returns a fixed single-line JSON suggestion.
   */
  async generateNextPrompt(context: string, _options?: TextGenerationOptions): Promise<string | null> {
    const userLines = context
      .split(/\r?\n/)
      .filter((line) => line.startsWith("User: "));
    const latestUser = userLines[userLines.length - 1] ?? context;
    if (latestUser.includes("[mock:predict-fail]")) {
      throw new Error("Synthetic prediction failure");
    }
    if (latestUser.includes("[mock:predict-empty]")) {
      return JSON.stringify({ suggestion: null });
    }
    if (latestUser.includes("[mock:predict-invalid]")) {
      return "not valid json";
    }
    const custom = /\[mock:predict:([^\]\r\n]*)\]/.exec(latestUser);
    if (custom) {
      return JSON.stringify({ suggestion: custom[1] });
    }
    return JSON.stringify({ suggestion: "Run the tests to verify the changes." });
  }

  /** No children to reap — cancel every live driver and report cleanly. */
  async dispose(): Promise<AdapterDisposeResult> {
    this.disposed = true;
    for (const d of this.drivers) {
      d.cancelled = true;
      d.queue.length = 0;
    }
    this.drivers.clear();
    return { children: [], orphanedPending: 0 };
  }
}
