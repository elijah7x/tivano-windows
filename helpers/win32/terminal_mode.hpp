// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// terminal_mode — the ConPTY terminal host inside tivano-job-helper.exe.
// Dispatched by wmain on `--terminal <base64url TerminalSpec v1>`.
// Windows-only; never returns (calls finalExit on every path).
//
#pragma once

#include <string_view>

namespace tht {

/**
 * Run one terminal session: verify the owner, create the Job and the
 * pseudo console, launch the fixed system shell with JOB_LIST +
 * PSEUDOCONSOLE in a single attribute list, speak the NDJSON control
 * protocol, then prove Job-empty + output finality before reporting
 * cleanup and exiting with the --terminal exit class.
 *
 * `traceEnabled` is the opt-in startup-stage trace: ONLY reachable via
 * the explicit `--startup-trace` CLI switch (see wmain). On, it emits
 * bounded `trace t=<ms> <stage>` markers on stderr through Diag; off,
 * every trace call is a compile-away no-op. It never touches stdout,
 * never dumps spec/env/path/input bytes and never blocks the lifecycle
 * thread (the Diag queue drops + counts when its bound is hit).
 *
 * NEVER returns — every outcome exits via finalExit/ExitProcess.
 */
[[noreturn]] void runTerminalMode(std::string_view specJsonUtf8,
                                  bool traceEnabled);

}  // namespace tht
