// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Controlled synthetic stdio fixture — the ONLY process this build is
// allowed to spawn. It speaks the NDJSON v1 wire contract documented in
// docs/phase-2a-process.md: newline-delimited {v,type,requestId,…} frames.
//
// Properties: finite (always exits), local (no network, no filesystem
// writes, no children), deterministic (fixed scripts + scenario flag),
// and isolated (env is rebuilt by the parent — this file inherits nothing
// it needs). Prompts select in-protocol reply markers ([syn:approval] /
// [syn:fail] / [syn:slow]) inside the "chat" scenario only — they never
// change which process runs or where it runs.

const scenario =
  (process.argv.find((a) => a.startsWith("--scenario=")) ?? "").split("=")[1] || "chat";
// Every fixture is finite by construction: even "hang", paused stdin or a
// stuck approval may never outlive this watchdog — it is the backstop that
// proves a bound, not the parent's request deadline.
const watchdogMs =
  Number((process.argv.find((a) => a.startsWith("--watchdog-ms=")) ?? "").split("=")[1]) ||
  10_000;
setTimeout(() => process.exit(0), watchdogMs);
// --pause-ms=N: hold stdin reads for N ms so a real parent sees genuine
// kernel-buffer backpressure (write()=false → drain), then resume.
const pauseMs =
  Number((process.argv.find((a) => a.startsWith("--pause-ms=")) ?? "").split("=")[1]) || 0;
if (pauseMs > 0) {
  process.stdin.pause();
  setTimeout(() => process.stdin.resume(), pauseMs);
}

let nextEventSeq = new Map(); // turnId -> last emitted seq

function write(buf) {
  try {
    return process.stdout.write(buf);
  } catch {
    return false;
  }
}

/** Emit one envelope; chat scenario splits ONE chosen frame mid-wire. */
let splitUsed = false;
function send(env, { split = false } = {}) {
  const line = Buffer.from(JSON.stringify(env) + "\n", "utf8");
  if (split && !splitUsed) {
    splitUsed = true;
    const mid = line.byteLength >> 1;
    write(line.subarray(0, mid));
    setTimeout(() => write(line.subarray(mid)), 15);
    return;
  }
  write(line);
}

function respond(requestId, result) {
  send({ v: 1, type: "response", requestId, result });
}
function respondError(requestId, code, message) {
  send({ v: 1, type: "response", requestId, error: { code, message } });
}
function emitEvent(requestId, turnId, event, payload, opts) {
  const seq = (nextEventSeq.get(turnId) ?? 0) + 1;
  nextEventSeq.set(turnId, seq);
  send({ v: 1, type: "event", requestId, turnId, seq, event, payload }, opts);
}

const turns = new Map(); // turnId -> {requestId, prompt, timers}

function finishTurn(requestId, turnId, tailChunks) {
  for (const delta of tailChunks)
    emitEvent(requestId, turnId, "chunk", { delta });
  // The done frame is deliberately split across two writes — exercises the
  // parent's line buffer; the exit waits for the second half to flush.
  emitEvent(requestId, turnId, "done", { outcome: "done" }, { split: true });
  turns.delete(turnId);
  setTimeout(() => process.exit(0), 40);
}

function runChat(req) {
  const { requestId, params } = req;
  const { prompt, turnId } = params;
  respond(requestId, { accepted: true, turnId });
  turns.set(turnId, { requestId, prompt });

  const head = [
    `Synthetic turn on "${prompt}" — a controlled local child process.`,
    "No real model, file, tool or network is involved.",
  ];

  if (prompt.includes("[syn:fail]")) {
    for (const d of head) emitEvent(requestId, turnId, "chunk", { delta: d + "\n" });
    emitEvent(requestId, turnId, "error", { message: "synthetic failure marker seen" });
    turns.delete(turnId);
    process.exit(0);
    return;
  }

  emitEvent(requestId, turnId, "chunk", { delta: head[0] + "\n" });
  if (prompt.includes("[syn:approval]")) {
    emitEvent(requestId, turnId, "approval", {
      approval: {
        title: "synthetic-write ./scratch.txt",
        detail:
          "Synthetic action from the controlled fixture child. The child itself ran; approving never produces a real file, command or model side effect.",
        reason: "Phase-2a stdio approval exercise.",
        options: [{ id: "once" }, { id: "deny" }],
      },
    });
    return; // paused until a resolve request arrives
  }
  const rest = [
    head[1],
    "Done — a controlled local synthetic child ran; no real model request, tool or command was executed.",
  ];
  finishTurn(requestId, turnId, rest);
}

function onRequest(env) {
  const { requestId, method, params } = env;
  switch (method) {
    case "handshake":
      respond(requestId, {
        fixture: "synthetic-stdio",
        protocolVersion: 1,
        pid: process.pid,
        scenario,
      });
      break;
    case "stream": {
      if (scenario === "badframe") {
        // Emit a structurally invalid line — the parent must fail the turn.
        respond(requestId, { accepted: true, turnId: params.turnId });
        write(Buffer.from("this is not json\n", "utf8"));
        return;
      }
      if (scenario === "nonutf8") {
        respond(requestId, { accepted: true, turnId: params.turnId });
        write(Buffer.from([0xff, 0xfe, 0x0a]));
        return;
      }
      if (scenario === "earlyexit") {
        respond(requestId, { accepted: true, turnId: params.turnId });
        process.exit(0);
        return;
      }
      if (scenario === "stderr") {
        respond(requestId, { accepted: true, turnId: params.turnId });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let n = 0;
        const iv = setInterval(() => {
          process.stderr.write(chunk);
          if (++n >= 20) clearInterval(iv); // ≈1.25 MiB → over the 1 MiB cap
        }, 5);
        return;
      }
      if (scenario === "hang") {
        respond(requestId, { accepted: true, turnId: params.turnId });
        return; // ack but never finish — cancelled by parent
      }
      if (scenario === "flood") {
        respond(requestId, { accepted: true, turnId: params.turnId });
        for (let i = 1; i <= 300; i++)
          emitEvent(requestId, params.turnId, "chunk", { delta: `f${i} ` });
        emitEvent(requestId, params.turnId, "done", { outcome: "done" });
        process.exit(0);
        return;
      }
      if (scenario === "slow") {
        respond(requestId, { accepted: true, turnId: params.turnId });
        let i = 0;
        const iv = setInterval(() => {
          i++;
          if (i > 12) {
            clearInterval(iv);
            emitEvent(requestId, params.turnId, "done", { outcome: "done" });
            process.exit(0);
            return;
          }
          emitEvent(requestId, params.turnId, "chunk", { delta: `s${i} ` });
        }, 25);
        return;
      }
      runChat(env);
      break;
    }
    case "resolve": {
      const { turnId, optionId } = params ?? {};
      respond(requestId, { resolved: true, turnId, optionId });
      const t = turns.get(turnId);
      if (!t) return;
      if (optionId === "once") {
        finishTurn(t.requestId, turnId, [
          "Approved once — continuing.\n",
          "Done — a controlled local synthetic child ran; no real model request, tool or command was executed.",
        ]);
      } else {
        emitEvent(t.requestId, turnId, "done", { outcome: "denied" });
        turns.delete(turnId);
        process.exit(0);
      }
      break;
    }
    case "cancel": {
      respond(requestId, { cancelled: true, turnId: params?.turnId ?? null });
      process.exit(0);
      break;
    }
    default:
      respondError(requestId, "UNKNOWN_METHOD", `unknown method ${method}`);
  }
}

// stdin framing: LF-delimited, UTF-8, one JSON envelope per line.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let env;
    try {
      env = JSON.parse(line);
    } catch {
      continue; // unparseable input is dropped, never echoed
    }
    if (env?.v !== 1 || env?.type !== "request" || typeof env?.requestId !== "string") continue;
    onRequest(env);
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
