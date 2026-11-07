// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-27.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// SOURCE-level invariants for the opt-in --terminal startup trace. These
// checks read the helper sources; they do NOT compile or execute Win32
// code and do NOT count as Windows verification. They pin the contract:
// opt-in only, bounded through Diag, stderr only, no spec/env/path bytes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../helpers/win32", import.meta.url));
const term = readFileSync(`${DIR}/terminal_mode.cpp`, "utf8");
const termH = readFileSync(`${DIR}/terminal_mode.hpp`, "utf8");
const main = readFileSync(`${DIR}/tivano-job-helper.cpp`, "utf8");

const STAGES = [
  "armed ver=",
  "spec-accepted",
  "stdio-ok",
  "events-ok",
  "worker-start writer",
  "worker-start reader",
  "owner-verified",
  "shell-located",
  "env-block-ok",
  "job-configured",
  "pipes-created",
  "conpty-create-begin",
  "conpty-create-end",
  "attr-list-init",
  "attr-job-set",
  "attr-conpty-set",
  "createprocess-begin",
  "createprocess-end",
  "spawned-enqueued",
  "writer-flushed",
  "worker-start drain",
  "worker-start input",
  "watch-entered",
  "watch-exit",
  "teardown-begin",
  "job-empty",
  "exit-enqueued",
  "hpcon-close-begin",
  "hpcon-close-end",
  "cleanup-enqueued",
  "exit cls=",
];

describe("--terminal startup trace (source-level)", () => {
  it("emits every required stage marker", () => {
    for (const s of STAGES) expect(term, `missing marker ${s}`).toContain(s);
  });

  it("is strictly opt-in: CLI switch, default off, signature explicit", () => {
    expect(termH).toContain("bool traceEnabled");
    expect(term).toContain("runTerminalMode(std::string_view specJsonUtf8, bool traceEnabled)");
    expect(main).toContain('L"--startup-trace"');
    expect(main).toContain("argc == 4 && termMode");
    expect(term).toContain("g_traceOn = traceEnabled;");
    expect(term).toContain("if (!g_traceOn) return;");
  });

  it("goes through the bounded Diag queue only — never stdout/stderr writes", () => {
    // The trace body must enqueue into Diag; no direct WriteFile/fputs/
    // std::fprintf to any stream anywhere in the trace path.
    const fn = term.slice(term.indexOf("void trace("), term.indexOf("termExit"));
    expect(fn).toContain("g_diag.line(line);");
    expect(fn).not.toMatch(/WriteFile|fputs|fprintf|std::cout|std::cerr/);
  });

  it("never dumps spec/env/path/input content", () => {
    for (const m of term.matchAll(/trace\(([^;]*)\)/g)) {
      expect(m[1], `trace call leaks content: ${m[1]}`).not.toMatch(
        /spec\.cwd|spec\.env|argv|shellW|cwdW|cmdW|b64|\.data\(\)/,
      );
    }
  });

  it("keeps the --version contract and the frozen 3-arg form unchanged", () => {
    expect(main).toContain("th::kHelperVersion");
    expect(main).not.toMatch(/"version":"[^"]*trace/);
    // serve/run get no flag; argc!=3 without the exact terminal flag is usage.
    expect(main).toContain("!traceFlag && argc != 3");
  });
});
