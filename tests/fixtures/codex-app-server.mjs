#!/usr/bin/env node
// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// OFFLINE Codex app-server protocol fixture — explicitly synthetic.
// Implements the pinned wire contract (Codex CLI 0.164.0 / 6aaac694):
// stdio JSONL, no "jsonrpc" member, typed int|string ids, client/server
// requests, notifications. It is deterministic (behavior is driven ONLY by
// prompt keywords), finite (watchdog + stdin-EOF exit), spawns nothing and
// touches no network/credentials. It is NOT a model — every "response" is
// canned text acknowledging the protocol.
//
// Prompt-driven scenarios:
//   (default)        → turn/started + agentMessage deltas + completed
//   "approval"       → item/commandExecution/requestApproval, waits for the
//                      client's answer, completes accordingly
//   "perm"           → item/permissions/requestApproval (same wait)
//   "filechange"     → item/fileChange/requestApproval (same wait)
//   "question"       → item/tool/requestUserInput (single question, choices
//                      + isOther); the client's answers echo into the turn
//   "qmulti"         → two questions (navigation/paging path)
//   "qsecret"        → isSecret question (masked input)
//   "qresolve"       → question resolved server-side instead
//   "qbad"           → malformed questions payload — the client must
//                      decline IN PROTOCOL; the turn still completes
//   "elsewhere"      → approval request resolved server-side instead
//   "tool"           → commandExecution started + outputDelta + completed
//   "plan"           → turn/plan/updated + plan item + mcpToolCall/webSearch/
//                      dynamicToolCall items (NOT for "imode" prompts)
//   "ckptfile"       → REALLY writes fixture-checkpoint.txt (and appends
//                      to tracked.txt when present) inside the granted
//                      cwd, then reports a structured fileChange item —
//                      the checkpoint-turn fixture path (P2L)
//   "fail"           → error notification + turn/completed status "failed"
//   "slow"           → many deltas spread over a longer schedule
//   "sleep"          → never completes until turn/interrupt arrives
//   "die"            → the process exits mid-turn (process exception)
//   "badjson"        → emits one malformed line, then completes normally
//   "stringid"       → server uses STRING request ids for its approvals

import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLATFORM_FAMILY = process.platform === "win32" ? "windows" : "unix";
const WATCHDOG_MS = Number(process.env.TIVANO_CODEX_FIXTURE_WATCHDOG_MS ?? "120000");

// Cross-instance synthetic identity: the fixture keeps ONE FILE PER
// thread inside the isolated CODEX_HOME — a restarted app gets a NEW
// fixture process that still knows the synthetic threads created by the
// old one, and two concurrent fixture processes can never collide on a
// shared seq or clobber each other's thread rows (each writes only its
// own thread files via tmp+rename). Ids carry a per-process instance tag.
// Everything here is test-only synthetic state; nothing is real.
const STATE_DIR = join(process.env.CODEX_HOME ?? ".", "fixture-state");
const INSTANCE = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
const threads = new Map(); // codexThreadId → {cwd, model, effort, config}
try {
  for (const f of readdirSync(STATE_DIR)) {
    if (!f.startsWith("thread-") || !f.endsWith(".json")) continue;
    try {
      const t = JSON.parse(readFileSync(join(STATE_DIR, f), "utf8"));
      if (t && typeof t.id === "string" && typeof t.cwd === "string")
        threads.set(t.id, {
          cwd: t.cwd,
          model: typeof t.model === "string" ? t.model : "fixture-model",
          effort: typeof t.effort === "string" ? t.effort : null,
          config: t.config && typeof t.config === "object" ? t.config : null,
        });
    } catch {
      /* a partial tmp write — ignored, never fatal */
    }
  }
} catch {
  /* first run or unreadable — start empty */
}
function persistThread(id, row) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const p = join(STATE_DIR, `${id}.json`);
    const tmp = `${p}.tmp-${INSTANCE}`;
    writeFileSync(tmp, JSON.stringify({ id, ...row }));
    renameSync(tmp, p);
  } catch {
    /* state loss only breaks synthetic resume — loud, never fatal */
  }
}

let seq = 0;
let srvSeq = 0;
let activeTurn = null; // {turnId, threadId, timers[], pendingApproval}
let useStringIds = false;

function send(obj) {
  if (process.stdout.writable) process.stdout.write(JSON.stringify(obj) + "\n");
}
function respond(id, result) {
  send({ id, result });
}
function respondError(id, code, message) {
  send({ id, error: { code, message } });
}
function notify(method, params) {
  send({ method, params });
}
function serverRequest(method, params) {
  const id = useStringIds ? `srv-${++srvSeq}` : 9000 + ++srvSeq;
  send({ id, method, params });
  return id;
}

function fakeThread(id, cwd, model, effort) {
  return {
    id,
    sessionId: `sess-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "fixture",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "full",
    modelProvider: "fixture",
    model: model ?? "fixture-model",
    reasoningEffort: effort ?? null,
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: "fixture-0.164.0",
    originator: "tivano-win-fixture",
    source: "vscode",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "fixture-thread",
    turns: [],
  };
}
function fakeTurn(id) {
  return {
    id,
    rootTurnId: null,
    items: [],
    itemsView: { kind: "all" },
    status: "inProgress",
    error: null,
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: null,
    durationMs: null,
  };
}
function completeTurn(status, error) {
  if (!activeTurn) return;
  const t = activeTurn;
  activeTurn = null;
  t.timers.forEach(clearTimeout);
  const turn = fakeTurn(t.turnId);
  turn.status = status;
  turn.completedAt = Math.floor(Date.now() / 1000);
  if (error) turn.error = { message: error, codexErrorInfo: "other", additionalDetails: null, misalignment: null };
  notify("turn/completed", { threadId: t.threadId, turn });
}

function isObjLocal(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function schedule(fn, ms) {
  const t = setTimeout(fn, ms);
  if (activeTurn) activeTurn.timers.push(t);
  return t;
}

function runTurn(threadId, turnId, prompt, model, effort, serviceTier, policy, collab) {
  const t = {
    turnId,
    threadId,
    timers: [],
    pendingApproval: null, // server request id awaiting client answer
    decision: null,
  };
  activeTurn = t;
  const turn = fakeTurn(turnId);
  notify("turn/started", { threadId, turn });
  const agentItemId = `item-agent-${turnId}`;
  // App-injected guidance (anti-slop, the F22 Hydra policy) rides ahead
  // of the user's text and always ends with a "---" rule — keyword
  // fixtures key off the user's words only, or the policy's own prose
  // ("ask no questions", "failed") would trigger their branches.
  const lower = (prompt.split("---\n\n").pop() ?? prompt).toLowerCase();

  if (lower.includes("die")) {
    // Process exception scenario: exit hard before completing.
    process.exit(2);
    return;
  }

  const begin = () => {
    if (activeTurn !== t) return;
    // F19 telemetry — a deterministic context-window reading every turn
    // (synthetic; proves the event mapping, never a real account).
    notify("thread/tokenUsage/updated", {
      threadId, turnId,
      tokenUsage: {
        last: { totalTokens: 12800, inputTokens: 12000, outputTokens: 800 },
        total: { totalTokens: 45210, inputTokens: 43000, outputTokens: 2210 },
        modelContextWindow: 128000,
      },
    });
    notify("item/started", {
      threadId,
      turnId,
      startedAtMs: Date.now(),
      item: { type: "agentMessage", id: agentItemId, text: "", phase: null, memoryCitation: null, delivery: null, questions: null },
    });
    // Echo the client-sent override so tests can VERIFY it reached the
    // wire — synthetic, never a proof of a real provider.
    const meTag =
      model !== undefined || effort !== undefined || serviceTier !== undefined
        ? ` [m=${model ?? "inherit"} e=${effort ?? "default"}${serviceTier !== undefined ? ` t=${serviceTier}` : ""}]`
        : "";
    const polTag =
      policy !== undefined ? ` [ap=${policy.ap} rev=${policy.rev} sb=${policy.sb}]` : "";
    const cmTag = collab !== undefined ? ` [cm=${collab}]` : "";
    // "markdown" → canned rich-markdown reply so the renderer's extended
    // blocks get exercised end to end (fixture only, still synthetic).
    const text = lower.includes("markdown")
      ? [
          "# Heading",
          "",
          "Para with **bold**, *em*, ~~gone~~ and [ok](https://example.com).",
          "",
          "```ts",
          "const answer = 42;",
          "```",
          "",
          "3. three",
          "4. four",
          "",
          "- [ ] open task",
          "- [x] done task",
          "",
          "| l | c | r |",
          "|:--|:-:|--:|",
          "| a | b | d |",
          "",
          "---",
          "",
          "![cat](https://example.com/c.png) ![bad](file:///etc/passwd) [bad](file:///x)",
        ].join("\n")
      : `fixture response: ${prompt.slice(0, 80)}${meTag}${polTag}${cmTag}`;
    const chunks = lower.includes("slow") ? text.split(/(?<=.{4})/) : [text];
    chunks.forEach((c, i) =>
      schedule(() => {
        if (activeTurn !== t) return;
        notify("item/agentMessage/delta", { threadId, turnId, itemId: agentItemId, delta: c });
      }, 10 * (i + 1)),
    );
    schedule(() => {
      if (activeTurn !== t) return;
      notify("item/completed", {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { type: "agentMessage", id: agentItemId, text, phase: null, memoryCitation: null, delivery: null, questions: null },
      });
      if (lower.includes("badjson")) {
        process.stdout.write('{"method":"turn/completed", BROKEN\n');
      }
      if (lower.includes("fail")) {
        notify("error", {
          error: { message: "fixture failure", codexErrorInfo: "other", additionalDetails: null, misalignment: null },
          willRetry: false,
          threadId,
          turnId,
        });
        completeTurn("failed");
      } else if (lower.includes("limit forever")) {
        completeTurn("failed", "usage limit reached on the fixture account");
      } else if (/\blimit\b/.test(lower)) {
        // "limit[:N]" — a provider-worded failure whose bar-timestamp is
        // N seconds out (default 90): the F20 auto-continue exercise.
        const secs = Number(/limit:(\d+)/.exec(lower)?.[1]) || 90;
        completeTurn("failed", `usage limit reached|${Math.floor(Date.now() / 1000) + secs}`);
      } else {
        completeTurn("completed");
      }
    }, 10 * (chunks.length + 2));
  };

  const wantApproval = lower.includes("approval");
  const wantPerm = lower.includes("perm");
  const wantFile = lower.includes("filechange");
  const wantQuestion =
    lower.includes("question") ||
    lower.includes("qmulti") ||
    lower.includes("qsecret") ||
    lower.includes("qresolve") ||
    lower.includes("qbad");
  const wantElsewhere = lower.includes("elsewhere");
  const wantTool = lower.includes("tool");
  if (lower.includes("stringid")) useStringIds = true;

  if (wantQuestion) {
    let questions;
    if (lower.includes("qmulti")) {
      questions = [
        {
          id: "q-region", header: "Region", question: "Which region should it deploy to?",
          options: [
            { label: "us-east-1 (recommended)", description: "Closest to most users" },
            { label: "eu-west-1", description: "GDPR scope" },
          ],
          isOther: false, isSecret: false,
        },
        {
          id: "q-name", header: "Name", question: "What should the service be called?",
          options: [], isOther: true, isSecret: false,
        },
      ];
    } else if (lower.includes("qsecret")) {
      questions = [
        { id: "q-token", header: "Token", question: "Paste the deploy token", options: [], isOther: true, isSecret: true },
      ];
    } else if (lower.includes("qbad")) {
      questions = "not-an-array"; // malformed — must be declined in-protocol
    } else {
      questions = [
        {
          id: "q-deploy", header: "Deploy", question: "Proceed with the deploy?",
          options: [
            { label: "Yes, deploy (recommended)", description: "Ships the current build" },
            { label: "Hold", description: "Keeps staging untouched" },
          ],
          isOther: true, isSecret: false,
        },
      ];
    }
    const id = serverRequest("item/tool/requestUserInput", {
      threadId, turnId, itemId: "item-q",
      questions,
    });
    t.pendingApproval = id;
    if (lower.includes("qresolve")) {
      // Server-side resolution: the card must expire without a user answer.
      schedule(() => {
        if (activeTurn !== t) return;
        t.pendingApproval = null;
        notify("serverRequest/resolved", { threadId, requestId: id });
        begin();
      }, 15);
    }
    return; // client's answer/decline resumes via onServerResponse
  }
  if (wantApproval || wantPerm || wantFile) {
    let method, params;
    if (wantPerm) {
      const w = threads.get(threadId)?.cwd ?? "/";
      method = "item/permissions/requestApproval";
      params = {
        threadId, turnId, itemId: "item-perm", environmentId: null, startedAtMs: Date.now(),
        cwd: w,
        reason: "fixture requests permissions",
        permissions: {
          network: { enabled: true },
          // Paths must live inside the granted workspace or the adapter
          // legitimately declines the request as unverifiable.
          fileSystem: { read: [w + "/fixture-read"], write: [w + "/fixture-write"] },
        },
      };
    } else if (wantFile) {
      method = "item/fileChange/requestApproval";
      params = {
        threadId, turnId, itemId: "item-file", startedAtMs: Date.now(),
        reason: "fixture wants to write files",
        grantRoot: threads.get(threadId)?.cwd ?? "/",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      };
    } else {
      method = "item/commandExecution/requestApproval";
      params = {
        kind: "command", threadId, turnId, itemId: "item-cmd", startedAtMs: Date.now(),
        environmentId: null, reason: "fixture wants to run a command",
        command: "echo fixture-command", cwd: threads.get(threadId)?.cwd ?? "/",
        // Frozen wire shape — the "amend" scenario adds the execpolicy
        // amendment object that only command requests may carry.
        availableDecisions: lower.includes("amend")
          ? ["accept", "acceptForSession", "decline", "cancel",
             { acceptWithExecpolicyAmendment: { proposedExecPolicy: { network: false } } }]
          : ["accept", "acceptForSession", "decline", "cancel"],
      };
    }
    const id = serverRequest(method, params);
    t.pendingApproval = id;
    if (wantElsewhere) {
      // Server-side resolution: the card must expire without a user answer.
      schedule(() => {
        if (activeTurn !== t) return;
        t.pendingApproval = null;
        notify("serverRequest/resolved", { threadId, requestId: id });
        begin();
      }, 15);
    }
    return;
  }
  if (wantTool) {
    const itemId = `item-cmd-${turnId}`;
    schedule(() => {
      if (activeTurn !== t) return;
      notify("item/started", {
        threadId, turnId, startedAtMs: Date.now(),
        item: {
          type: "commandExecution", id: itemId, pluginId: null, scriptPath: null,
          command: "fixture-tool --run", cwd: threads.get(threadId)?.cwd ?? "/",
          processId: null, source: "fixture", status: "inProgress",
          commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
        },
      });
      notify("item/commandExecution/outputDelta", { threadId, turnId, itemId, delta: "fixture tool output\n" });
    }, 10);
    schedule(() => {
      if (activeTurn !== t) return;
      notify("item/completed", {
        threadId, turnId, completedAtMs: Date.now(),
        item: {
          type: "commandExecution", id: itemId, pluginId: null, scriptPath: null,
          command: "fixture-tool --run", cwd: threads.get(threadId)?.cwd ?? "/",
          processId: null, source: "fixture", status: "completed",
          commandActions: [], aggregatedOutput: "fixture tool output\n", exitCode: 0, durationMs: 20,
        },
      });
      begin();
    }, 30);
    return;
  }
  const wantPlan = lower.includes("plan") && !lower.includes("imode");
  if (wantPlan) {
    // Plan/todos/tool-kind coverage: a turn/plan/updated list, one plan
    // item (started→delta→completed, completed text authoritative), and
    // mcpToolCall/webSearch/dynamicToolCall rows. Synthetic — proves the
    // adapter's frozen event mapping, never a real provider capability.
    const planItemId = `item-plan-${turnId}`;
    const mcpId = `item-mcp-${turnId}`;
    const webId = `item-web-${turnId}`;
    const dynId = `item-dyn-${turnId}`;
    schedule(() => {
      if (activeTurn !== t) return;
      notify("turn/plan/updated", {
        threadId, turnId,
        plan: [
          { step: "Survey the workspace", status: "completed" },
          { step: "Draft the change", status: "inProgress" },
          { step: "Verify and report", status: "pending" },
        ],
      });
      notify("item/started", {
        threadId, turnId, startedAtMs: Date.now(),
        item: { type: "plan", id: planItemId, text: "" },
      });
      notify("item/plan/delta", { threadId, turnId, itemId: planItemId, delta: "## Fixture plan\n- streamed step" });
      notify("item/started", {
        threadId, turnId, startedAtMs: Date.now(),
        item: {
          type: "mcpToolCall", id: mcpId, server: "fixture-mcp", tool: "lookup",
          arguments: { q: "plan" }, status: "inProgress", result: null, error: null,
        },
      });
      notify("item/started", {
        threadId, turnId, startedAtMs: Date.now(),
        item: { type: "webSearch", id: webId, query: "fixture plan search", status: "inProgress" },
      });
      notify("item/started", {
        threadId, turnId, startedAtMs: Date.now(),
        item: { type: "dynamicToolCall", id: dynId, tool: "fixtureDynamicTool", status: "inProgress" },
      });
    }, 10);
    schedule(() => {
      if (activeTurn !== t) return;
      notify("item/completed", {
        threadId, turnId, completedAtMs: Date.now(),
        item: { type: "plan", id: planItemId, text: "## Fixture plan\n1. Survey\n2. Draft\n3. Verify" },
      });
      notify("item/completed", {
        threadId, turnId, completedAtMs: Date.now(),
        item: {
          type: "mcpToolCall", id: mcpId, server: "fixture-mcp", tool: "lookup",
          arguments: { q: "plan" }, status: "completed",
          result: { content: [{ type: "text", text: "mcp fixture result" }] }, error: null,
        },
      });
      notify("item/completed", {
        threadId, turnId, completedAtMs: Date.now(),
        item: { type: "webSearch", id: webId, query: "fixture plan search", status: "completed" },
      });
      notify("item/completed", {
        threadId, turnId, completedAtMs: Date.now(),
        item: { type: "dynamicToolCall", id: dynId, tool: "fixtureDynamicTool", status: "completed" },
      });
      notify("turn/plan/updated", {
        threadId, turnId,
        plan: [
          { step: "Survey the workspace", status: "completed" },
          { step: "Draft the change", status: "completed" },
          { step: "Verify and report", status: "inProgress" },
        ],
      });
      begin();
    }, 30);
    return;
  }
  if (lower.includes("ckptfile")) {
    // CHECKPOINT FIXTURE: actually modify the authorized workspace — a
    // newly created file plus an appended line in tracked.txt when it
    // exists — then report the SAME paths through a structured
    // fileChange item. Writes stay strictly inside the granted cwd;
    // anything outside this synthetic repo is never touched.
    const w = threads.get(threadId)?.cwd ?? "/";
    const changes = [];
    try {
      writeFileSync(join(w, "fixture-checkpoint.txt"), `checkpoint fixture ${turnId}\n`);
      changes.push({ path: "fixture-checkpoint.txt", kind: "add" });
    } catch {
      /* workspace not writable — still reports only what it did */
    }
    try {
      const tracked = join(w, "tracked.txt");
      writeFileSync(
        tracked,
        readFileSync(tracked, "utf8") + `checkpoint line ${turnId}\n`,
      );
      changes.push({ path: "tracked.txt", kind: "update" });
    } catch {
      /* tracked.txt absent — only the created file is reported */
    }
    const itemId = `item-file-${turnId}`;
    schedule(() => {
      if (activeTurn !== t) return;
      notify("item/started", {
        threadId, turnId, startedAtMs: Date.now(),
        item: { type: "fileChange", id: itemId, changes, status: "inProgress" },
      });
    }, 10);
    schedule(() => {
      if (activeTurn !== t) return;
      notify("item/completed", {
        threadId, turnId, completedAtMs: Date.now(),
        item: { type: "fileChange", id: itemId, changes, status: "completed" },
      });
      begin();
    }, 30);
    return;
  }
  if (/\breason\b/.test(lower)) {
    // F03 reasoning items: started → text deltas → summary separator →
    // completed with an authoritative summary (frozen event sequence).
    const itemId = `item-reason-${turnId}`;
    schedule(() => {
      if (activeTurn !== t) return;
      notify("item/started", {
        threadId, turnId, startedAtMs: Date.now(),
        item: { type: "reasoning", id: itemId },
      });
    }, 10);
    schedule(() => {
      if (activeTurn !== t) return;
      notify("item/reasoning/textDelta", { threadId, turnId, itemId, delta: "Considering the request — " });
      notify("item/reasoning/summaryPartAdded", { threadId, turnId, itemId, summaryIndex: 1 });
      notify("item/reasoning/textDelta", { threadId, turnId, itemId, delta: "weighing options" });
    }, 20);
    schedule(() => {
      if (activeTurn !== t) return;
      notify("item/completed", {
        threadId, turnId, completedAtMs: Date.now(),
        item: {
          type: "reasoning", id: itemId,
          summary: ["Considering the request — weighing options (done)"],
          content: [],
        },
      });
      begin();
    }, 40);
    return;
  }
  if (lower.includes("sleep")) return; // sits until turn/interrupt
  schedule(begin, 10);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // malformed inbound — bounded ignore
  }
  if (typeof msg !== "object" || msg === null) return;
  const { id, method, params } = msg;
  if (method === undefined) {
    // Client answering OUR server request.
    if (activeTurn && activeTurn.pendingApproval === id) {
      activeTurn.pendingApproval = null;
      if (msg.error) {
        // -32601 decline or similar → complete the turn failed? No — the
        // server request was declined; the turn simply completes.
        completeTurn("completed");
        return;
      }
      const r = msg.result ?? {};
      if (r.answers !== undefined) {
        // Question answered — echo the received map into the turn text so
        // tests prove the exact wire shape (skip → empty map).
        const keys = isObjLocal(r.answers) ? Object.keys(r.answers) : [];
        const summary = keys.length === 0
          ? "question skipped"
          : `answered: ${keys
              .map((k) => `${k}=${(r.answers[k]?.answers ?? []).join("|")}`)
              .join(", ")}`;
        const t = activeTurn;
        schedule(() => {
          if (activeTurn === t) {
            notify("item/agentMessage/delta", {
              threadId: t.threadId, turnId: t.turnId,
              itemId: `item-agent-${t.turnId}`, delta: summary,
            });
            notify("item/completed", {
              threadId: t.threadId, turnId: t.turnId, completedAtMs: Date.now(),
              item: { type: "agentMessage", id: `item-agent-${t.turnId}`, text: summary, phase: null, memoryCitation: null, delivery: null, questions: null },
            });
            completeTurn("completed");
          }
        }, 10);
        return;
      }
      if (typeof r.decision === "string") {
        if (r.decision === "decline" || r.decision === "cancel") {
          completeTurn("completed");
          return;
        }
      }
      // accept / permissions grant → proceed with the scripted turn.
      // Echo the picked decision / permission scope so e2e can prove the
      // exact payload the client wrote back ([d=…] / [scope=…] / [amend]).
      const tag = typeof r.decision === "object" && r.decision !== null
        ? " [amend]"
        : typeof r.decision === "string" && r.decision !== "accept"
          ? ` [d=${r.decision}]`
          : typeof r.scope === "string"
            ? ` [scope=${r.scope}]`
            : "";
      const ack = `granted — proceeding${tag}`;
      const t = activeTurn;
      schedule(() => {
        if (activeTurn === t) {
          // emit a tiny agent message acknowledging the grant
          notify("item/agentMessage/delta", {
            threadId: t.threadId, turnId: t.turnId,
            itemId: `item-agent-${t.turnId}`, delta: ack,
          });
          notify("item/completed", {
            threadId: t.threadId, turnId: t.turnId, completedAtMs: Date.now(),
            item: { type: "agentMessage", id: `item-agent-${t.turnId}`, text: ack, phase: null, memoryCitation: null, delivery: null, questions: null },
          });
          completeTurn("completed");
        }
      }, 10);
    }
    return;
  }
  switch (method) {
    case "initialize":
      respond(id, {
        userAgent: `codex-app-server-fixture/0.164.0 (${PLATFORM_FAMILY})`,
        codexHome: process.env.CODEX_HOME ?? "",
        platformFamily: PLATFORM_FAMILY,
        platformOs: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
      });
      break;
    case "initialized":
      break; // notification — no response
    case "thread/start": {
      // F18 fixture: a config.mcp_servers naming "badmcp" refuses the
      // request like a real config-load failure — the frozen retry then
      // arrives WITHOUT mcp_servers and binds.
      const mcp = params?.config?.mcp_servers;
      if (mcp && typeof mcp === "object" && "badmcp" in mcp) {
        respondError(id, -32000, "failed to load configuration: unknown MCP server badmcp");
        break;
      }
      const id2 = `thread-${INSTANCE}-${++seq}`;
      const cwd = params?.cwd ?? process.cwd();
      const row = {
        cwd,
        model: typeof params?.model === "string" ? params.model : "fixture-model",
        effort: null,
        config: params?.config && typeof params.config === "object" ? params.config : null,
      };
      threads.set(id2, row);
      persistThread(id2, row);
      respond(id, { thread: fakeThread(id2, cwd, row.model, row.effort) });
      break;
    }
    case "thread/resume": {
      const tid = params?.threadId;
      if (typeof tid !== "string" || !threads.has(tid)) {
        // Unknown resume target — the real server errors; so do we.
        respondError(id, -32000, `thread not found: ${String(tid)}`);
        break;
      }
      const row = threads.get(tid);
      if (typeof params?.model === "string") row.model = params.model;
      if (params?.config && typeof params.config === "object") row.config = params.config;
      persistThread(tid, row);
      respond(id, { thread: fakeThread(tid, row.cwd, row.model, row.effort) });
      break;
    }
    case "thread/compact/start": {
      // F09 fixture: accept the compaction, then report it the way the
      // real server does — a thread-level notification, no turn attached.
      const tid = params?.threadId;
      if (typeof tid !== "string" || !threads.has(tid)) {
        respondError(id, -32000, `thread not found: ${String(tid)}`);
        break;
      }
      respond(id, {});
      setTimeout(() => notify("thread/compacted", { threadId: tid }), 15);
      break;
    }
    case "model/list": {
      // Pinned-shape synthetic catalog: visible entries, one hidden
      // (must be filtered), efforts + default + a fast service tier.
      respond(id, {
        data: [
          {
            id: "fixture-model",
            displayName: "Fixture Model",
            description: "the synthetic default",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: true,
            serviceTiers: [{ id: "fast", name: "Fast tier" }],
          },
          {
            id: "fixture-max",
            displayName: "Fixture Max",
            description: "the synthetic heavyweight",
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
              { reasoningEffort: "xhigh" },
            ],
            defaultReasoningEffort: "high",
            isDefault: false,
            serviceTiers: [],
          },
          {
            id: "fixture-hidden",
            displayName: "Hidden Row",
            hidden: true,
            supportedReasoningEfforts: [],
            isDefault: false,
          },
        ],
        nextCursor: null,
      });
      break;
    }
    case "turn/start": {
      const tid = params?.threadId;
      if (typeof tid !== "string" || !threads.has(tid)) {
        respondError(id, -32000, `unknown thread: ${String(tid)}`);
        break;
      }
      if (activeTurn) {
        respondError(id, -32000, "a turn is already in progress");
        break;
      }
      const input = Array.isArray(params?.input) ? params.input : [];
      const prompt = input.map((i) => (i && i.type === "text" ? i.text : "")).join("\n");
      const turnId = `turn-${INSTANCE}-${++seq}`;
      // turn/start model/effort override the thread for subsequent turns.
      const row = threads.get(tid);
      const sentModel = typeof params?.model === "string" ? params.model : undefined;
      const sentEffort = typeof params?.effort === "string" ? params.effort : undefined;
      const sentTier =
        typeof params?.serviceTierForTurn === "string"
          ? params.serviceTierForTurn
          : undefined;
      const sentCollab = isObjLocal(params?.collaborationMode)
        ? String(params.collaborationMode.mode ?? "?")
        : undefined;
      const sentPolicy =
        typeof params?.approvalPolicy === "string" ||
        typeof params?.approvalsReviewer === "string" ||
        isObjLocal(params?.sandboxPolicy)
          ? {
              ap: typeof params?.approvalPolicy === "string" ? params.approvalPolicy : "?",
              rev: typeof params?.approvalsReviewer === "string" ? params.approvalsReviewer : "?",
              sb: isObjLocal(params?.sandboxPolicy) ? String(params.sandboxPolicy.type) : "?",
            }
          : undefined;
      row.model = sentModel ?? row.model;
      row.effort = sentEffort ?? row.effort;
      persistThread(tid, row);
      respond(id, { turn: fakeTurn(turnId) });
      // Echo only the CLIENT-SENT override — a silent default is proven
      // by the absence of the tag, not by a guessed value.
      runTurn(
        tid,
        turnId,
        prompt,
        sentModel !== undefined || sentEffort !== undefined || sentTier !== undefined
          ? sentModel
          : undefined,
        sentEffort,
        sentTier,
        sentPolicy,
        sentCollab,
      );
      break;
    }
    case "turn/interrupt": {
      respond(id, {});
      if (activeTurn) completeTurn("interrupted");
      break;
    }
    default:
      if (id !== undefined) respondError(id, -32601, `unknown method: ${method}`);
  }
});
rl.on("close", () => {
  completeTurn("interrupted");
  process.exit(0);
});
setTimeout(() => process.exit(0), WATCHDOG_MS).unref?.();
