#!/usr/bin/env node
// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// OFFLINE ZCode Protocol app-server fixture — explicitly synthetic.
// Speaks the ZCode stdio JSONL wire contract (no "jsonrpc" member):
// provider/updateAccountConfig, session/create, session/resume,
// session/setMode, session/subscribe, session/send, session/stop,
// session/close, plus server requests (session/requestRuntimePreferences,
// interaction/requestProviderRuntimeHeaders, interaction/requestPermission,
// interaction/requestUserInput) and v4/telemetry/event + session/event.

import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WATCHDOG_MS = Number(process.env.TIVANO_ZCODE_FIXTURE_WATCHDOG_MS ?? "60000");
const STATE_DIR = process.env.TIVANO_ZCODE_FIXTURE_STATE_DIR ?? null;
let sessionSeq = 0;
let turnSeq = 0;
let srvSeq = 0;
let currentSessionId = null;
let currentMode = "build";
let activeTurn = null;
const sessions = new Map();

function loadSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  if (!STATE_DIR) return null;
  try {
    const raw = JSON.parse(readFileSync(join(STATE_DIR, `${id}.json`), "utf8"));
    if (raw && raw.sessionId === id) {
      sessions.set(id, raw);
      return raw;
    }
  } catch {
    /* absent */
  }
  return null;
}

function saveSession(s) {
  sessions.set(s.sessionId, s);
  if (!STATE_DIR) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const p = join(STATE_DIR, `${s.sessionId}.json`);
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, p);
  } catch {
    /* non-fatal */
  }
}

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

const pendingServerRequests = new Map();
function serverRequest(method, params) {
  const id = `server-${++srvSeq}`;
  return new Promise((resolve, reject) => {
    pendingServerRequests.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

function emitEvent(turnId, type, payload = {}) {
  notify("session/event", {
    sessionId: currentSessionId,
    turnId,
    type,
    payload,
  });
}

async function runTurn(content, modelSelection) {
  const turnId = `zturn-${++turnSeq}`;
  const rawContent = String(content ?? "");
  const lower = (rawContent.split("---\n\n").pop() ?? rawContent).toLowerCase();
  const modelId = modelSelection?.modelId ?? "GLM-5.3";
  const level = modelSelection?.options?.reasoningLevel ?? "max";
  activeTurn = { turnId, cancelled: false };

  emitEvent(turnId, "turn.started", {});

  // Ask runtime preferences and runtime headers on every turn/first turn
  // so tests verify both server requests + P2-37 native toolSearchMode omission.
  const prefs = await serverRequest("session/requestRuntimePreferences", {
    sessionId: currentSessionId,
    scope: "runtime-materialization",
  });
  const headers = await serverRequest("interaction/requestProviderRuntimeHeaders", {
    sessionId: currentSessionId,
  });
  if (activeTurn?.cancelled) return;

  if (lower.includes("die")) {
    process.exit(2);
    return;
  }

  if (lower.includes("telemetry-cancel")) {
    notify("v4/telemetry/event", {
      sessionId: currentSessionId,
      turnId,
      kind: "turn.terminal",
      status: "cancelled",
    });
    activeTurn = null;
    return;
  }

  if (lower.includes("telemetry-error")) {
    notify("v4/telemetry/event", {
      sessionId: currentSessionId,
      turnId,
      kind: "turn.terminal",
      status: "error",
      errorMessage: "fixture telemetry failure",
    });
    activeTurn = null;
    return;
  }

  if (lower.includes("empty-approval")) {
    let errCode = null;
    try {
      await serverRequest("interaction/requestPermission", {
        sessionId: currentSessionId,
        toolCallId: `tc-empty-${turnId}`,
        toolName: "Bash",
        input: { command: "echo empty" },
        reason: "Empty options check",
        options: [],
      });
    } catch (err) {
      errCode = err?.code ?? -32000;
    }
    emitEvent(turnId, "model.streaming", {
      kind: "text_delta",
      assistantMessageId: `msg-${turnId}`,
      delta: `empty-approval-err=${errCode}`,
    });
    emitEvent(turnId, "turn.completed", { resultType: "success" });
    activeTurn = null;
    return;
  }

  if (lower.includes("approval")) {
    const decision = await serverRequest("interaction/requestPermission", {
      sessionId: currentSessionId,
      toolCallId: `tc-perm-${turnId}`,
      toolName: "Bash",
      input: { command: "/bin/zsh -lc 'echo zcode-ok'" },
      reason: "Needs command approval",
      options: [
        { optionId: "allow_once", kind: "allow_once", name: "Allow once", response: { granted: true } },
        { optionId: "allow_always", kind: "allow_always", name: "Allow always", response: { granted: true, always: true } },
        { optionId: "reject_once", kind: "reject_once", name: "Deny", response: { granted: false } },
      ],
    });
    if (activeTurn?.cancelled) return;
    if (!decision?.granted) {
      emitEvent(turnId, "turn.completed", { resultType: "cancelled" });
      activeTurn = null;
      return;
    }
  }

  if (lower.includes("question")) {
    const qRes = await serverRequest("interaction/requestUserInput", {
      sessionId: currentSessionId,
      questions: [
        {
          header: "Region",
          question: "Which endpoint?",
          options: [
            { label: "Global (recommended)", description: "api.z.ai" },
            { label: "China", description: "open.bigmodel.cn" },
          ],
        },
      ],
    });
    if (activeTurn?.cancelled) return;
    const ans = qRes?.content?.answers ? JSON.stringify(qRes.content.answers) : "declined";
    emitEvent(turnId, "model.streaming", {
      kind: "text_delta",
      assistantMessageId: `msg-${turnId}`,
      delta: `answer=${ans}`,
    });
    emitEvent(turnId, "turn.completed", { resultType: "success" });
    activeTurn = null;
    return;
  }

  if (lower.includes("sleep")) {
    // Wait until session/stop cancels it
    return;
  }

  if (lower.includes("tool-fail-nonfatal")) {
    // P2-37: a single failing tool.updated must NOT end the turn.
    emitEvent(turnId, "model.streaming", {
      kind: "tool_call",
      toolCallId: `tc-1-${turnId}`,
      toolName: "Bash",
      input: { command: "false" },
    });
    emitEvent(turnId, "tool.updated", {
      kind: "result",
      toolCallId: `tc-1-${turnId}`,
      result: { success: false, content: "exit 1" },
      error: { message: "tool exited 1" },
    });
    // Also emit a subagent-forwarded tool result without parent tool_call — must be dropped.
    emitEvent(turnId, "tool.updated", {
      kind: "result",
      source: "subagent",
      toolCallId: `tc-sub-${turnId}`,
      result: { success: true, content: "subagent internal" },
    });
  }

  if (lower.includes("file-edit")) {
    emitEvent(turnId, "model.streaming", {
      kind: "tool_call",
      toolCallId: `tc-edit-${turnId}`,
      toolName: "Edit",
      input: { file_path: join(process.cwd(), "src", "example.ts") },
    });
    emitEvent(turnId, "tool.updated", {
      kind: "result",
      toolCallId: `tc-edit-${turnId}`,
      result: {
        success: true,
        display: {
          kind: "file_diff",
          filePath: join(process.cwd(), "src", "example.ts"),
          structuredPatch: [{ lines: ["+const a = 1;", "-const a = 0;"] }],
        },
      },
    });
  }

  emitEvent(turnId, "model.streaming", {
    kind: "reasoning_delta",
    assistantMessageId: `msg-${turnId}`,
    delta: "thinking...",
  });
  const prefToolMode = prefs?.toolSearchMode ?? "omitted";
  const authTag = headers?.headersApplied ? "authed" : "noauth";
  emitEvent(turnId, "model.streaming", {
    kind: "text_delta",
    assistantMessageId: `msg-${turnId}`,
    delta: `zcode-fixture [m=${modelId} e=${level} mode=${currentMode} ts=${prefToolMode} auth=${authTag}]`,
  });
  emitEvent(turnId, "session.updated", {
    querySource: "main_turn",
    contextWindow: 200000,
    usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10 },
  });

  if (lower.includes("completed-error")) {
    emitEvent(turnId, "turn.completed", {
      resultType: "error_api",
      error: { message: "fixture completed error" },
    });
  } else if (lower.includes("completed-cancelled")) {
    emitEvent(turnId, "turn.completed", { resultType: "cancelled" });
  } else {
    emitEvent(turnId, "turn.completed", {
      resultType: "success",
      contextWindow: 200000,
      usage: { inputTokens: 120, outputTokens: 35, cacheReadTokens: 10 },
    });
  }
  activeTurn = null;
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg.method && "id" in msg) {
    const entry = pendingServerRequests.get(String(msg.id));
    if (entry) {
      pendingServerRequests.delete(String(msg.id));
      if (msg.error) entry.reject(msg.error);
      else entry.resolve(msg.result);
    }
    return;
  }
  const { id, method, params } = msg;
  switch (method) {
    case "provider/updateAccountConfig":
      if (process.env.TIVANO_ZCODE_FIXTURE_FAIL_CONNECT === "1") {
        respondError(id, -32010, "fixture account reject");
        break;
      }
      respond(id, {
        receivedRevision: params?.revision ?? "tivano-1",
        providerCount: Object.keys(params?.providers ?? {}).length,
        status: "received",
      });
      break;
    case "session/create": {
      currentSessionId = `zsess-${process.pid}-${++sessionSeq}`;
      currentMode = params?.mode ?? "build";
      saveSession({ sessionId: currentSessionId, mode: currentMode });
      respond(id, { session: { sessionId: currentSessionId } });
      break;
    }
    case "session/resume": {
      const sid = params?.sessionId;
      const loaded = sid ? loadSession(sid) : null;
      if (!loaded) {
        respondError(id, -32001, "Session not found");
        break;
      }
      currentSessionId = loaded.sessionId;
      currentMode = loaded.mode ?? "build";
      respond(id, { session: { sessionId: currentSessionId } });
      break;
    }
    case "session/setMode":
      currentMode = params?.mode ?? currentMode;
      if (currentSessionId) saveSession({ sessionId: currentSessionId, mode: currentMode });
      respond(id, { mode: currentMode });
      break;
    case "session/subscribe":
      respond(id, { subscribed: true });
      break;
    case "session/send":
      respond(id, { accepted: true });
      void runTurn(params?.content, params?.modelSelection);
      break;
    case "session/stop":
      if (activeTurn) {
        activeTurn.cancelled = true;
        const tid = activeTurn.turnId;
        activeTurn = null;
        emitEvent(tid, "turn.completed", { resultType: "cancelled" });
      }
      respond(id, { stopped: true });
      break;
    case "session/close":
      respond(id, { closed: true });
      setImmediate(() => process.exit(0));
      break;
    default:
      respondError(id, -32601, "Method not found");
  }
});

rl.on("close", () => process.exit(0));
setTimeout(() => process.exit(1), WATCHDOG_MS).unref();
