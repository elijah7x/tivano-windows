#!/usr/bin/env node
// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// tivano — local-control CLI client (frozen ControlClient port).
// Talks the bounded local-control socket protocol (version 1, edition
// "dev"): 4-byte big-endian length-prefixed JSON frames over a
// same-account IPC socket. This is a client only — it never spawns
// commands, never touches provider credentials and only works while
// the app's external-control gate is enabled.
//
//   tivano info|providers|projects|threads
//   tivano thread <uuid> | history <uuid>
//   tivano create [--provider ID] [--model ID] [--workspace local]
//                 [--project UUID] [--prompt TEXT] [--continuation MODE]
//                 [--hydra on|off]
//   tivano send <uuid> --text TEXT|--stdin [--continuation MODE]
//   tivano interrupt <uuid> --turn <uuid>
//   tivano operation <ticket>
//   tivano settings [get [KEY]] [set KEY=BOOL|automatic|off]...
//   tivano agent models [--json]
//   tivano agent run [--json] --cwd DIR [--model ID] [--session SID]
//     (P1-45 agent bridge: prompt on stdin, JSON-line events on stdout;
//     its own endpoint, no Local control switch needed)
//
// Socket/pipe lookup order:
//   TIVANO_CONTROL_SOCKET env → explicit socket or pipe path
//   TIVANO_DATA_ROOT env      → \\.\pipe\tivano-control-<hash> (win32) or <root>/control/control.sock
//   platform app-data default → platform-default dataRoot endpoint
//
// Write calls carry a client-issued idempotency ticket
// (<instance>/<uuid>/<ms>) — replays return the stored receipt, they
// never re-execute.
//
// Exit codes: 0 ok · 2 usage · 3 connect failed · 4 refused/error reply.

import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

const VERSION = 1;
const EDITION = "dev";
const MAX_FRAME = 1_048_576;

function sockPath() {
  if (process.env.TIVANO_CONTROL_SOCKET) return process.env.TIVANO_CONTROL_SOCKET;
  const root =
    process.env.TIVANO_DATA_ROOT ??
    join(
      platform() === "win32"
        ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
        : platform() === "darwin"
          ? join(homedir(), "Library", "Application Support")
          : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")),
      "Tivano Windows Dev",
    );
  if (platform() === "win32") {
    const normalized = resolve(root).replace(/[\\/]+$/, "").toLowerCase();
    const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
    return `\\\\.\\pipe\\tivano-control-${digest}`;
  }
  return join(root, "control", "control.sock");
}

/** P1-45 agent endpoint: TIVANO_AGENT_SOCKET, else derived from the data
 *  root like the control endpoint (tivano-agent-<hash> / agent.sock). */
function agentSockPath() {
  if (process.env.TIVANO_AGENT_SOCKET) return process.env.TIVANO_AGENT_SOCKET;
  const control = sockPath();
  return /[\\/]pipe[\\/]/.test(control)
    ? control.replace("tivano-control-", "tivano-agent-")
    : join(dirname(control), "agent.sock");
}

const MAX_AGENT_PROMPT = 900_000;
const agentLine = (e) => process.stdout.write(JSON.stringify(e) + "\n");
const agentError = (code, message) => agentLine({ type: "error", code, message });

/** tivano agent models|run — exit 0 on success/done, 1 on error, 130/143 on signal. */
async function runAgent(args) {
  const [sub, ...rest] = args;
  if (sub !== "models" && sub !== "run") {
    agentError("bad_request", sub ? `Unknown agent subcommand '${sub}'. Expected 'models' or 'run'.` : "Missing agent subcommand. Expected 'models' or 'run'.");
    return 1;
  }
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    const key = t.slice(2);
    if (t === "--json") {
      if (opts.json) return badAgent(sub, "Duplicate flag '--json'.");
      opts.json = true;
    } else if (sub === "run" && ["--cwd", "--model", "--session"].includes(t)) {
      if (opts[key] !== undefined) return badAgent(sub, `Duplicate flag '${t}'.`);
      const v = rest[++i];
      if (v === undefined) return badAgent(sub, `Missing value for '${t}'.`);
      if (!v || v.startsWith("--")) return badAgent(sub, `Invalid value for '${t}'.`);
      opts[key] = v;
    } else return badAgent(sub, `Unexpected argument '${t}'.`);
  }
  if (sub === "models") {
    try {
      const reply = await agentExchange({ method: "agentModels" });
      if (reply.error) return badAgent(sub, reply.error.code ?? "error", "internal");
      process.stdout.write(JSON.stringify(reply.result?.agentModels ?? { version: 1, models: [] }) + "\n");
      return 0;
    } catch (e) {
      return badAgent(sub, e.message, "app_unavailable");
    }
  }
  if (!opts.cwd) return badAgent(sub, "Missing required '--cwd' option.");
  if (process.stdin.isTTY) return badAgent(sub, "Prompt must be piped on stdin.");
  const chunks = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += c.length;
    if (size > MAX_AGENT_PROMPT) return badAgent(sub, `Prompt exceeds the ${MAX_AGENT_PROMPT}-byte limit.`);
    chunks.push(c);
  }
  let prompt;
  try {
    prompt = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return badAgent(sub, "Prompt is not valid UTF-8.");
  }
  const params = { cwd: resolve(opts.cwd), prompt, ...(opts.model ? { model: opts.model } : {}), ...(opts.session ? { session: opts.session } : {}) };
  let terminal;
  let signaled;
  let live;
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]])
    process.once(sig, () => {
      signaled = code;
      if (!live) process.exit(code);
      live.destroy();
    });
  try {
    await agentExchange({ method: "agentRun", params }, Object.assign((msg) => {
      const ev = msg.result?.agentEvent;
      if (msg.error || !ev) {
        agentError(msg.error ? "app_unavailable" : "internal", msg.error?.code ?? "Unexpected response from Tivano.");
        terminal = 1;
        return false;
      }
      process.stdout.write(ev.json + "\n");
      if (ev.type === "done" || ev.type === "error") {
        terminal = ev.type === "done" ? 0 : 1;
        return false;
      }
      return true;
    }, { attach: (sock) => (live = sock) }));
  } catch (e) {
    if (signaled) return signaled;
    agentError("app_unavailable", e.message);
    return 1;
  }
  if (terminal !== undefined) return terminal;
  if (signaled) return signaled;
  agentError("internal", "connection closed");
  return 1;
}

function badAgent(sub, message, code = "bad_request") {
  if (sub === "models") process.stdout.write(JSON.stringify({ version: 1, models: [], error: { code, message } }) + "\n");
  else agentError(code, message);
  return 1;
}

/** hello → welcome → one command. Without `onStream` resolves the single
 *  reply; with it, feeds frames until it returns false or the app closes. */
function agentExchange(command, onStream) {
  return new Promise((resolvePromise, reject) => {
    const path = agentSockPath();
    const sock = connect(path);
    let buf = Buffer.alloc(0);
    let welcomed = false;
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      sock.setTimeout(0);
      sock.destroy();
      fn();
    };
    const frame = (body) => {
      const p = Buffer.from(JSON.stringify(body), "utf8");
      const h = Buffer.alloc(4);
      h.writeUInt32BE(p.length, 0);
      sock.write(Buffer.concat([h, p]));
    };
    sock.on("error", (e) =>
      finish(() => reject(new Error(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "Tivano is not running. Open Tivano and try again." : `cannot connect to the Tivano agent endpoint: ${e.code ?? e.message}`))));
    sock.on("close", () => finish(() => (onStream ? resolvePromise() : reject(new Error("connection closed")))));
    sock.on("connect", () => frame({ version: VERSION, edition: EDITION }));
    sock.setTimeout(15_000, () => finish(() => reject(new Error("Tivano did not answer within 15 seconds."))));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const size = buf.readUInt32BE(0);
        if (size <= 0 || size > MAX_FRAME) return finish(() => reject(new Error("bad frame")));
        if (buf.length < 4 + size) return;
        let msg;
        try {
          msg = JSON.parse(buf.subarray(4, 4 + size).toString("utf8"));
        } catch {
          return finish(() => reject(new Error("invalid reply")));
        }
        buf = buf.subarray(4 + size);
        if (!welcomed) {
          if (msg.error || !msg.result?.welcome?.methods?.includes(command.method))
            return finish(() => reject(new Error(msg.error?.code ?? "This Tivano version has no agent bridge; update Tivano.")));
          welcomed = true;
          if (onStream) {
            sock.setTimeout(0);
            onStream.attach?.(sock);
          }
          frame({ id: "a0", instance: msg.result.welcome.instance, command });
          continue;
        }
        if (!onStream) return finish(() => resolvePromise(msg));
        if (!onStream(msg, sock)) return finish(() => resolvePromise());
      }
    });
  });
}

const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");

function usage(stream = process.stderr, code = 2) {
  stream.write(
    `Tivano local control (the app must already be running and manually enabled under Local control in Settings › Connections).
usage: tivano info|providers|projects|threads
       tivano thread <uuid> | history <uuid>
       tivano create [--provider ID] [--model ID] [--workspace local] [--project UUID] [--prompt TEXT] [--continuation MODE] [--hydra on|off]
       tivano send <uuid> --text TEXT|--stdin [--continuation automatic|providerSession|fresh|transcript]
       tivano interrupt <uuid> --turn <uuid>
       tivano operation <ticket>
       tivano settings [get [KEY]] [set KEY=VALUE]...
Agent bridge (no Local control switch needed; Tivano must be running):
       tivano agent models [--json]
       tivano agent run [--json] --cwd DIR [--model ID] [--session SID]   (prompt from stdin, NDJSON events on stdout)\n`,
  );
  process.exit(code);
}

/** One-shot framed session: hello → commands → close.
 *  Resolves { welcome, results } — instance lives in welcome. */
function session(commands) {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath());
    const results = [];
    let buf = Buffer.alloc(0);
    let welcomed = false;
    let welcome = {};
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(e);
    };
    const frame = (body) => {
      const p = Buffer.from(JSON.stringify(body), "utf8");
      const f = Buffer.alloc(4 + p.length);
      f.writeUInt32BE(p.length, 0);
      p.copy(f, 4);
      sock.write(f);
    };
    sock.on("error", (e) => fail(new Error(`cannot connect to ${sockPath()}: ${e.code ?? e.message}`)));
    sock.on("connect", () => frame({ version: VERSION, edition: EDITION }));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const size = buf.readUInt32BE(0);
        if (size <= 0 || size > MAX_FRAME) return fail(new Error("bad frame"));
        if (buf.length < 4 + size) return;
        const payload = buf.subarray(4, 4 + size);
        buf = buf.subarray(4 + size);
        let msg;
        try {
          msg = JSON.parse(payload.toString("utf8"));
        } catch {
          return fail(new Error("invalid reply"));
        }
        if (msg.error) {
          return fail(Object.assign(new Error(msg.error.code ?? "error"), { detail: msg.error.detail }));
        }
        if (!welcomed) {
          welcomed = true;
          welcome = msg.result?.welcome ?? {};
          for (let i = 0; i < commands.length; i++)
            frame({ id: `c${i}`, instance: welcome.instance, command: commands[i] });
          if (commands.length === 0) {
            settled = true;
            sock.end();
            resolve({ welcome, results });
          }
          continue;
        }
        results.push(msg.result ?? {});
        if (results.length === commands.length && !settled) {
          settled = true;
          sock.end();
          resolve({ welcome, results });
        }
      }
    });
    sock.setTimeout(15_000, () => fail(new Error("timed out")));
  });
}

const readStdin = () =>
  new Promise((res, rej) => {
    let d = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => res(d));
    process.stdin.on("error", rej);
  });

/** Parse repeated --key value pairs; null on malformed input. */
function kvPairs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || args[i + 1] === undefined) return null;
    out[args[i].slice(2)] = args[i + 1];
  }
  return out;
}

const ticket = (instance) => `${instance}/${randomUUID()}/${Date.now()}`;

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (!verb) usage();
  if (verb === "--help" || verb === "-h" || verb === "help") usage(process.stdout, 0);
  if (verb === "agent") process.exit(await runAgent(rest));
  // Commands may be built lazily once the welcome arrives — write ops
  // need the instance for their idempotency ticket.
  let build;
  switch (verb) {
    case "info":
      build = () => [{ method: "info" }];
      break;
    case "providers":
      build = () => [{ method: "providers" }];
      break;
    case "projects":
    case "threads": {
      const params = kvPairs(rest);
      if (params === null) usage();
      build = () => [{ method: verb, params }];
      break;
    }
    case "thread":
    case "history": {
      if (!rest[0]) usage();
      const params = kvPairs(rest.slice(1));
      if (params === null) usage();
      build = () => [{ method: verb, params: { id: rest[0], ...params } }];
      break;
    }
    case "create": {
      const params = kvPairs(rest);
      if (params === null) usage();
      const prompt = params.prompt;
      delete params.prompt;
      // --hydra on|off rides the create request as a boolean (frozen
      // ControlCreate.hydra).
      if (params.hydra !== undefined) {
        if (params.hydra === "on") params.hydra = true;
        else if (params.hydra === "off") params.hydra = false;
        else usage();
      }
      build = (inst) => {
        const cmds = [{ method: "create", params: { ...params, ticket: ticket(inst) } }];
        return cmds;
      };
      break;
    }
    case "send": {
      const thread = rest[0];
      const ti = rest.indexOf("--text");
      const si = rest.indexOf("--stdin");
      const ci = rest.indexOf("--continuation");
      if (!thread || (ti < 0) === (si < 0)) usage();
      const text = ti >= 0 ? rest[ti + 1] : await readStdin();
      if (text === undefined) usage();
      build = (inst) => [
        {
          method: "submit",
          params: {
            threadId: thread,
            text,
            ...(ci >= 0 && rest[ci + 1] ? { continuation: rest[ci + 1] } : {}),
            ticket: ticket(inst),
          },
        },
      ];
      break;
    }
    case "interrupt": {
      const thread = rest[0];
      const ti = rest.indexOf("--turn");
      if (!thread || ti < 0 || !rest[ti + 1]) usage();
      build = (inst) => [
        {
          method: "interrupt",
          params: { threadId: thread, turnId: rest[ti + 1], ticket: ticket(inst) },
        },
      ];
      break;
    }
    case "operation":
      if (!rest[0]) usage();
      build = () => [{ method: "operation", params: { ticket: rest[0] } }];
      break;
    case "settings": {
      const getIdx = rest.indexOf("get");
      const sets = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] !== "set" || !rest[i + 1]?.includes("=")) continue;
        const pair = rest[i + 1];
        const eq = pair.indexOf("=");
        const key = pair.slice(0, eq);
        const raw = pair.slice(eq + 1);
        const value = raw === "true" ? true : raw === "false" ? false : raw;
        sets.push({ key, value });
      }
      build = (inst) => {
        const cmds = [];
        if (getIdx >= 0 || sets.length === 0) cmds.push({ method: "settingsGet" });
        for (const s of sets)
          cmds.push({
            method: "settingsSet",
            params: {
              key: s.key,
              ...(s.key === "textGeneration" ? { textGeneration: s.value } : { bool: s.value }),
              ticket: ticket(inst),
            },
          });
        return cmds;
      };
      break;
    }
    default:
      usage();
  }
  // Two-phase session: hello first, then build commands (tickets need
  // the instance), send, collect.
  const commands = await new Promise((resolve, reject) => {
    const sock = connect(sockPath());
    let buf = Buffer.alloc(0);
    const frame = (body) => {
      const p = Buffer.from(JSON.stringify(body), "utf8");
      const f = Buffer.alloc(4 + p.length);
      f.writeUInt32BE(p.length, 0);
      p.copy(f, 4);
      sock.write(f);
    };
    sock.on("error", (e) =>
      reject(new Error(`cannot connect to ${sockPath()}: ${e.code ?? e.message}`)));
    sock.on("connect", () => frame({ version: VERSION, edition: EDITION }));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const size = buf.readUInt32BE(0);
      if (buf.length < 4 + size) return;
      const msg = JSON.parse(buf.subarray(4, 4 + size).toString("utf8"));
      sock.destroy();
      if (msg.error)
        reject(Object.assign(new Error(msg.error.code ?? "error"), { detail: msg.error.detail }));
      else resolve(msg.result?.welcome ?? {});
    });
    sock.setTimeout(15_000, () => {
      sock.destroy();
      reject(new Error("timed out"));
    });
  });
  const cmds = build(commands.instance);
  const { results } = await session(cmds);
  out(results.length === 1 ? results[0] : results);
}

main().catch((e) => {
  const rc = /cannot connect/.test(e.message) ? 3 : 4;
  if (rc === 3) {
    process.stderr.write(
      "Open the correct edition of Tivano yourself and enable Local control in Settings › Connections. Use --help for syntax. Never blindly retry a write after a disconnect.\n",
    );
  }
  out({ error: e.message, ...(e.detail ? { detail: e.detail } : {}) });
  process.exit(rc);
});
