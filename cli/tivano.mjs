#!/usr/bin/env node
// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// tivano — local-control CLI client (frozen ControlClient port).
// Talks the bounded local-control socket protocol (version 1, edition
// "dev"): 4-byte big-endian length-prefixed JSON frames over a
// same-account IPC socket. This is a client only — it never spawns
// commands, never touches provider credentials and only works while
// the app's alpha+external-control gates are enabled.
//
//   tivano info|providers|projects|threads
//   tivano thread <uuid> | history <uuid>
//   tivano create [--provider ID] [--model ID] [--workspace local]
//                 [--project UUID] [--prompt TEXT] [--continuation MODE]
//   tivano send <uuid> --text TEXT|--stdin [--continuation MODE]
//   tivano interrupt <uuid> --turn <uuid>
//   tivano operation <ticket>
//   tivano settings [get [KEY]] [set KEY=BOOL|automatic|off]...
//
// Socket lookup order:
//   TIVANO_CONTROL_SOCKET env → explicit path
//   TIVANO_DATA_ROOT env      → <root>/control/control.sock
//   platform app-data default → …/Tivano Windows Dev/control/control.sock
//
// Write calls carry a client-issued idempotency ticket
// (<instance>/<uuid>/<ms>) — replays return the stored receipt, they
// never re-execute.
//
// Exit codes: 0 ok · 2 usage · 3 connect failed · 4 refused/error reply.

import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";

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
  return join(root, "control", "control.sock");
}

const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");

function usage() {
  process.stderr.write(
    `usage: tivano info|providers|projects|threads
       tivano thread <uuid> | history <uuid>
       tivano create [--provider ID] [--model ID] [--workspace local] [--project UUID] [--prompt TEXT] [--continuation MODE]
       tivano send <uuid> --text TEXT|--stdin [--continuation automatic|providerSession|fresh|transcript]
       tivano interrupt <uuid> --turn <uuid>
       tivano operation <ticket>
       tivano settings [get [KEY]] [set KEY=VALUE]...\n`,
  );
  process.exit(2);
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
  out({ error: e.message, ...(e.detail ? { detail: e.detail } : {}) });
  process.exit(rc);
});
