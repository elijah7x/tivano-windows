// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Controlled offline Antigravity (`agy`) stream-json fixture for unit/E2E tests.
// Matches `agy 1.5.x` headless stream-json protocol (`init` / `step_update` / `result`).

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import * as readline from "node:readline";

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("1.5.16-fixture\n");
  process.exit(0);
}

if (args.includes("--help")) {
  const settingsLine =
    process.env.TIVANO_ANTIGRAVITY_FIXTURE_NO_SETTINGS === "1"
      ? ""
      : "  --settings <json>           JSON settings override\n";
  process.stdout.write(
    [
      "Usage of agy.exe:",
      "  --input-format              stream-json",
      "  --output-format             stream-json",
      "  --print-timeout             0",
      "  --mode                      accept-edits | plan",
      "  --model                     model id",
      "  --effort                    reasoning effort",
      "  --conversation              resume conversation",
      "  --log-file                  log file path",
      "  --add-dir                   additional readable dir",
      "  --dangerously-skip-permissions",
      settingsLine.trimEnd(),
      "  models                      list available models",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
  process.exit(0);
}

if (args[0] === "models") {
  process.stdout.write(
    [
      "Fetching available models...",
      "gemini-4-neon-low\tGemini 4 Neon (Low)",
      "gemini-4-neon-medium\tGemini 4 Neon (Medium)",
      "gemini-4-neon-high\tGemini 4 Neon (High)",
      "gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)",
      "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
      "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
      "gemini-2.5-pro\tGemini 2.5 Pro",
      "gemini-3.5-pro\tGemini 3.5 Pro",
      "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

function argVal(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const logFile = argVal("--log-file");
const conversationId = argVal("--conversation") || "ag-conv-1";
let initSent = false;
let turnCounter = 0;
let stepCounter = 0;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function logLine(text) {
  if (!logFile) return;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, text + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (frame.event !== "user") return;
  turnCounter++;
  const prompt = String(frame.message?.content ?? "");

  if (prompt.includes("[hang-init]")) {
    return;
  }

  if (prompt.includes("[unauth]")) {
    process.stderr.write("Error: Not signed in. Run `agy` to authenticate.\n");
    process.exit(1);
  }

  const sendInit = () => {
    if (!initSent) {
      initSent = true;
      emit({
        event: "init",
        conversation_id: conversationId,
      });
    }
  };

  if (prompt.includes("[slow-init]")) {
    setTimeout(() => {
      sendInit();
      const idx = ++stepCounter;
      emit({
        event: "step_update",
        step_update: {
          step_index: idx,
          step_type: "agent_response",
          state: "DONE",
          text_delta: "Slow init complete.",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });
      emit({
        event: "result",
        result: {
          status: "SUCCESS",
          conversation_id: conversationId,
          response: "Slow init complete.",
          usage: { total_tokens: 15 },
        },
      });
    }, 120);
    return;
  }

  sendInit();

  if (prompt.includes("[echo-args]")) {
    const out = JSON.stringify({ args });
    const idx = ++stepCounter;
    emit({
      event: "step_update",
      step_update: {
        step_index: idx,
        step_type: "agent_response",
        state: "DONE",
        text_delta: out,
      },
    });
    emit({
      event: "result",
      result: { status: "SUCCESS", conversation_id: conversationId, response: out },
    });
    return;
  }

  if (prompt.includes("[retry-log]")) {
    logLine(
      "W1124 09:00:01.123456 100 run.go:184] Run: attempt 1 failed (request failed: HTTP 503 capacity exhausted), retrying in 2s",
    );
    setTimeout(() => {
      const idx = ++stepCounter;
      emit({
        event: "step_update",
        step_update: {
          step_index: idx,
          step_type: "agent_response",
          state: "DONE",
          text_delta: "Done after agy retry.",
        },
      });
      emit({
        event: "result",
        result: {
          status: "SUCCESS",
          conversation_id: conversationId,
          response: "Done after agy retry.",
        },
      });
    }, 80);
    return;
  }

  if (prompt.includes("[503-fail]")) {
    emit({
      event: "result",
      result: {
        status: "ERROR",
        finished_reason: "error",
        error: "HTTP 503 Service Unavailable: MODEL_CAPACITY_EXHAUSTED",
      },
    });
    return;
  }

  const dropMarker = logFile ? `${logFile}.drop-always` : null;
  if (prompt.includes("[drop-always]") || (dropMarker && existsSync(dropMarker))) {
    if (dropMarker) {
      try {
        mkdirSync(dirname(dropMarker), { recursive: true });
        writeFileSync(dropMarker, "1", "utf8");
      } catch {
        /* ignore */
      }
    }
    process.stderr.write("stream closed: connection dropped\n");
    process.exit(2);
  }

  if (prompt.includes("[drop-once]")) {
    if (!argVal("--conversation")) {
      process.stderr.write("connection dropped\n");
      process.exit(2);
    }
  }

  if (prompt.includes("[sticky-turn-1]")) {
    const idx = ++stepCounter;
    emit({
      event: "step_update",
      step_update: {
        step_index: idx,
        step_type: "error",
        state: "ERROR",
        error: { message: "stale upstream glitch" },
      },
    });
    emit({
      event: "result",
      result: {
        status: "ERROR",
        finished_reason: "error",
        error: "stale upstream glitch",
      },
    });
    return;
  }

  if (prompt.includes("[sticky-turn-2]")) {
    const idx = ++stepCounter;
    emit({
      event: "step_update",
      step_update: {
        step_index: idx,
        step_type: "agent_response",
        state: "DONE",
        text_delta: "Turn 2 worked fine.",
      },
    });
    emit({
      event: "result",
      result: {
        status: "ERROR",
        finished_reason: "error",
        error: "stale upstream glitch",
        response: "Turn 2 worked fine.",
      },
    });
    return;
  }

  if (prompt.includes("[recovered-error]")) {
    const errIdx = ++stepCounter;
    emit({
      event: "step_update",
      step_update: {
        step_index: errIdx,
        step_type: "error",
        state: "ERROR",
        error: { message: "transient step error" },
      },
    });
    const okIdx = ++stepCounter;
    emit({
      event: "step_update",
      step_update: {
        step_index: okIdx,
        step_type: "agent_response",
        state: "DONE",
        text_delta: "Recovered cleanly.",
      },
    });
    emit({
      event: "result",
      result: {
        status: "ERROR",
        finished_reason: "error",
        error: "transient step error",
        response: "Recovered cleanly.",
      },
    });
    return;
  }

  if (prompt.includes("[tool-deny]")) {
    const idx = ++stepCounter;
    emit({
      event: "step_update",
      step_update: {
        step_index: idx,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "echo hi" } },
      },
    });
    emit({
      event: "step_update",
      step_update: {
        step_index: idx,
        step_type: "tool",
        state: "ERROR",
        tool_name: "run_command",
        tool_info: {
          parameters: { CommandLine: "echo hi" },
          error: { message: "permission check failed: blocked" },
        },
      },
    });
    emit({
      event: "result",
      result: {
        status: "WAITING",
        denied_actions: [{ display_name: "echo hi" }],
      },
    });
    return;
  }

  const editMatch = /\[edit-file:([^\]]+)\]/.exec(prompt);
  if (editMatch) {
    const rel = editMatch[1];
    const target = isAbsolute(rel) ? rel : join(process.cwd(), rel);
    const idx = ++stepCounter;
    emit({
      event: "step_update",
      step_update: {
        step_index: idx,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "write_to_file",
        tool_info: { parameters: { TargetFile: target } },
      },
    });
    setTimeout(() => {
      writeFileSync(target, "edited by antigravity fixture\n", "utf8");
      emit({
        event: "step_update",
        step_update: {
          step_index: idx,
          step_type: "tool",
          state: "DONE",
          tool_name: "write_to_file",
          tool_info: { parameters: { TargetFile: target }, output: "ok" },
        },
      });
      const replyIdx = ++stepCounter;
      emit({
        event: "step_update",
        step_update: {
          step_index: replyIdx,
          step_type: "agent_response",
          state: "DONE",
          text_delta: "Edited file.",
        },
      });
      emit({
        event: "result",
        result: { status: "SUCCESS", conversation_id: conversationId, response: "Edited file." },
      });
    }, 25);
    return;
  }

  if (prompt.includes("[review]")) {
    const text = "Finding 1: Check edge case in Antigravity provider.";
    const idx = ++stepCounter;
    emit({
      event: "step_update",
      step_update: {
        step_index: idx,
        step_type: "agent_response",
        state: "DONE",
        text_delta: text,
      },
    });
    emit({
      event: "result",
      result: { status: "SUCCESS", response: text },
    });
    return;
  }

  const reply = `Fixture reply #${turnCounter}: ${prompt.slice(0, 60)}`;
  const idx = ++stepCounter;
  emit({
    event: "step_update",
    step_update: {
      step_index: idx,
      step_type: "agent_response",
      state: "DONE",
      text_delta: reply,
      usage: { input_tokens: 15, output_tokens: 12 },
    },
  });
  emit({
    event: "result",
    result: {
      status: "SUCCESS",
      conversation_id: conversationId,
      response: reply,
      usage: { total_tokens: 27 },
    },
  });
});

rl.on("close", () => {
  process.exit(0);
});
