// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// tivano-job-helper — Windows-only process-tree boundary for REAL provider
// launches. NOT YET EXECUTED on Windows: built and proven by the lead via
// scripts/build-job-helper.ps1 + tests/windows/helper-harness.mjs. Until
// that evidence exists, probeProcessTreeSupport() stays unsupported.
//
// Contract (see docs/phase-2c-windows-helper.md):
//   tivano-job-helper.exe --serve    <base64url(JSON SpawnSpec v1)>
//   tivano-job-helper.exe --run      <base64url(JSON SpawnSpec v1)>
//   tivano-job-helper.exe --terminal <base64url(JSON TerminalSpec v1)>
//                                    [--startup-trace]
//   tivano-job-helper.exe --version  → small JSON diagnostic (stdout)
//
// --terminal is the ConPTY terminal host (terminal_mode.cpp): fixed
// system PowerShell inside a Job created atomically with the pseudo
// console (JOB_LIST + PSEUDOCONSOLE in ONE attribute list), an NDJSON
// control channel and its own exit taxonomy. It shares owner
// verification, Job handling and bounded thread/exit discipline through
// helper_win32.hpp — the --serve/--run paths below are unchanged.
//
// --serve and --run share EVERYTHING (spec, owner verification, Job
// launch, monitoring, bounded cleanup). They differ only in how a clean
// payload exit is reported: --serve maps payload-exit=0 to helper exit 0
// and every nonzero/forced outcome to 6 (+payload-exit= diag); --run
// returns 1024+payloadExit for a natural exit 0..255 — the payload's own
// exit code travels in the helper's exit code, never in stderr text that
// a caller would have to parse (and a payload could fake). A payload
// code >255 fails closed as 6. Every setup/ownership/cleanup/forced/
// error class stays in 2..6 and can NEVER land in 1024..1279.
//
// Exit codes (unambiguous classes — payload nonzero is NEVER folded to 0):
//   0 = payload exited 0 AND the Job was already empty — nothing needed
//       force-termination (--serve only; --run uses 1024+code)
//   2 = invalid invocation/spec — payload never ran
//   3 = setup failure (job, owner identity, attributes, pipes, events,
//       threads) — payload never ran
//   4 = cleanup/I-O proof failure: job-empty query failed or timed out,
//       output could not be drained to natural EOF within its bound
//       (canceled/truncated streams included), a pump thread would not
//       die within its bound, a pump ended on a real I/O error, a stdio
//       write stalled past its no-progress deadline, the wait primitive
//       failed, or the payload's exit code is unprovable — and any
//       post-launch abort whose cleanup could not be proved
//   5 = CreateProcessW failed — payload never ran
//   6 = payload nonzero exit OR anything was force-terminated (owner
//       death, stdin-EOF grace expiry, lingering descendants). The
//       payload's own code is emitted as payload-exit=<n> on the
//       diagnostic stream.
//
// Ownership model (documented in the design doc):
//   · PROC_THREAD_ATTRIBUTE_JOB_LIST puts the payload INSIDE the Job at
//     CreateProcessW — no create-suspended/assign window (MS: Old New
//     Thing 2023-02-09). Assignment failure = CreateProcessW failure.
//   · JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE + NO breakaway permission: an
//     abrupt helper death tears the whole tree down (no cleanup proof is
//     claimed after death — the OS owns it).
//   · PROC_THREAD_ATTRIBUTE_HANDLE_LIST passes ONLY the three payload
//     stdio ends; the Job and owner handles are never inheritable.
//   · The owner is OUR ACTUAL PARENT: spec.ownerPid must equal the
//     parent PID recorded in the kernel process table for this helper
//     (CreateToolhelp32Snapshot → th32ParentProcessID). A spec naming
//     any other live process is refused BEFORE the payload exists —
//     an image-name match would prove nothing about who launched us
//     and is not used as an authorization check at all. The claimed
//     owner's creation FILETIME must not postdate ours (a pid newer
//     than this helper is a reuse, not a launcher) and the owner must
//     be unsignaled at open AND re-checked immediately before
//     CreateProcessW.
//   · Owner death = the launcher stopped driving the session →
//     TerminateJobObject on the WHOLE job, then job-empty proof.
//   · Our-stdin EOF = the transport stopped feeding the session → the
//     payload's stdin gets EOF, then a bounded grace; a payload that
//     still runs after the grace is terminated. A payload closing its
//     own stdin early is NOT treated as owner EOF.
//
// Threading: three pump threads (stdin→child, child stdout→our stdout,
// child stderr→our stderr) run synchronous I/O and are cancelled via
// CancelSynchronousIo on their DEDICATED, HELD thread handles — never a
// recycled handle, never TerminateThread. Every thread is joined before
// exit; a thread that will not die inside its bound turns the exit into
// a hard ExitProcess(4) — storage shared with live threads is never
// destructed and failure is reported, not claimed. Diagnostics run on a
// dedicated thread over a bounded drop queue: a full inherited stderr
// pipe can stall that thread but can never stall lifecycle teardown.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <process.h>
#include <tlhelp32.h>

#include <algorithm>
#include <atomic>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <initializer_list>
#include <optional>
#include <string>
#include <vector>

#include "helper_common.hpp"
#include "helper_win32.hpp"
#include "terminal_mode.hpp"

namespace {

// ---- exit taxonomy --------------------------------------------------------
constexpr int kExitOk = 0;
constexpr int kExitInvalid = 2;
constexpr int kExitSetup = 3;
constexpr int kExitCleanup = 4;
constexpr int kExitSpawn = 5;
constexpr int kExitPayload = 6;

constexpr DWORD kIoBuf = 64 * 1024;
// Bounded waits — every one is documented, none is INFINITE.
constexpr DWORD kPumpJoinMs = 3000;   // thread-death bound after cancel
constexpr DWORD kDrainWaitMs = 10000; // output-drain bound after payload exit
constexpr DWORD kJobEmptyPollMs = 50;
constexpr DWORD kJobEmptyWaitMs = 10000;
constexpr DWORD kEofGraceMs = 5000;   // payload lifetime after its stdin EOF
constexpr DWORD kPumpStallMs = 15000; // zero-progress write deadline
constexpr DWORD kWatchSliceMs = 100;  // main-loop watchdog cadence

// kHelperVersion lives in helper_common.hpp next to the spec versions.
// --run mode: a payload that exits NATURALLY (no forced cleanup, Job
// proven empty, all stdio drained, exit code provable and <= 255) maps
// to 1024+payloadExit so the launcher can recover the real code without
// parsing stderr diagnostics. 1024 avoids STILL_ACTIVE (259) and every
// helper-level code stays inside 2..6 — never in 1024..1279.
constexpr uint32_t kRunExitBase = 1024;
constexpr uint32_t kRunExitMax = 255;

// ---- pump -----------------------------------------------------------------
// Handle, Diag/finalExit, thread bounds, owner verification, pipe creation
// and the job-empty proof are shared with --terminal mode through
// helper_win32.hpp — semantics unchanged, single implementation.
// One direction of byte forwarding on its own dedicated thread whose
// HANDLE we hold for the entire lifetime — CancelSynchronousIo is aimed
// at exactly this thread and no recycled handle can receive it.
struct Pump {
  // kSourceEof: the READ side ended (input drained). kDestClosed: the
  // WRITE side's peer went away. kWriteErr: an I/O error that is neither
  // EOF-class nor our own cancellation.
  enum class Why {
    kRunning,
    kSourceEof,
    kDestClosed,
    kReadErr,
    kWriteErr,
    kCanceled,
    kStopped,
  };
  HANDLE from = nullptr;
  HANDLE to = nullptr;              // owned when closeToOnDone
  bool closeToOnDone = false;
  HANDLE parentEofEvent = nullptr;  // signaled per signalOn* flags
  HANDLE fatalEvent = nullptr;      // signaled on real I/O failure
  bool signalOnSourceEnd = false;   // our stdin reached EOF
  bool signalOnDestClosed = false;  // our stdout/stderr peer died = parent gone
  std::atomic<bool> stop{false};
  std::atomic<Why> why{Why::kRunning};
  std::atomic<bool> writeInFlight{false};
  std::atomic<uint64_t> lastWriteTick{0};  // GetTickCount64 of last progress
  Handle thread;
};

unsigned __stdcall pumpRun(void* raw) {
  auto* p = static_cast<Pump*>(raw);
  std::vector<char> buf(kIoBuf);
  Pump::Why why = Pump::Why::kSourceEof;
  for (;;) {
    if (p->stop.load(std::memory_order_acquire)) {
      why = Pump::Why::kStopped;
      break;
    }
    DWORD n = 0;
    if (!ReadFile(p->from, buf.data(), kIoBuf, &n, nullptr)) {
      const DWORD e = GetLastError();
      if (e == ERROR_OPERATION_ABORTED)
        why = Pump::Why::kCanceled;
      else if (isPeerClosedError(e))
        why = Pump::Why::kSourceEof;  // read peer closed = input done
      else
        why = Pump::Why::kReadErr;
      break;
    }
    if (n == 0) { why = Pump::Why::kSourceEof; break; }
    bool done = false;
    DWORD off = 0;
    while (off < n) {
      if (p->stop.load(std::memory_order_acquire)) {
        why = Pump::Why::kStopped;
        done = true;
        break;
      }
      DWORD w = 0;
      // Timestamp BEFORE the release-store of the flag: an observer that
      // sees writeInFlight==true is guaranteed a fresh progress stamp —
      // it can never see the flag up with a stale (or zero) deadline.
      p->lastWriteTick.store(GetTickCount64(), std::memory_order_relaxed);
      p->writeInFlight.store(true, std::memory_order_release);
      const BOOL ok =
          WriteFile(p->to, buf.data() + off, n - off, &w, nullptr);
      p->writeInFlight.store(false, std::memory_order_release);
      if (!ok) {
        const DWORD e = GetLastError();
        if (e == ERROR_OPERATION_ABORTED)
          why = Pump::Why::kCanceled;
        else if (isPeerClosedError(e))
          why = Pump::Why::kDestClosed;
        else
          why = Pump::Why::kWriteErr;
        done = true;
        break;
      }
      if (w == 0) { why = Pump::Why::kWriteErr; done = true; break; }
      off += w;
      p->lastWriteTick.store(GetTickCount64(), std::memory_order_relaxed);
    }
    if (done) break;
  }
  p->why.store(why, std::memory_order_release);
  if (p->closeToOnDone && p->to) {
    // Source ended (EOF or cancel): the payload's stdin gets EOF either
    // way. The handle is OURS — nobody else holds it.
    CloseHandle(p->to);
    p->to = nullptr;
  }
  const bool signal =
      (why == Pump::Why::kSourceEof && p->signalOnSourceEnd) ||
      (why == Pump::Why::kDestClosed && p->signalOnDestClosed);
  if (signal && p->parentEofEvent) SetEvent(p->parentEofEvent);
  // A REAL I/O failure (or a dead output peer) must wake the lifecycle
  // thread — a failed pump next to a live payload is not a running
  // session, it is a failure needing bounded teardown.
  if ((why == Pump::Why::kReadErr || why == Pump::Why::kWriteErr ||
       (why == Pump::Why::kDestClosed && p->signalOnDestClosed)) &&
      p->fatalEvent)
    SetEvent(p->fatalEvent);
  return 0;
}

// Start a pump on its own dedicated thread. `false` = thread creation
// failed → setup failure, never detach-and-hope.
bool startPump(Pump& p) {
  unsigned tid = 0;
  p.thread.reset(reinterpret_cast<HANDLE>(
      _beginthreadex(nullptr, 0, &pumpRun, &p, 0, &tid)));
  return p.thread.get() != nullptr;
}

// Bounded stop: set the flag, then RETRY CancelSynchronousIo on OUR OWN
// thread handle — one cancel can race the worker entering its NEXT
// blocking I/O, so we re-issue it until the worker is observed dead or
// the total bound expires. A refusal returns kRefused and the caller
// turns it into a hard-exit failure — the thread and the storage it
// touches are never left to outlive the stack frame silently.
StopResult stopPump(Pump& p, DWORD joinMs) {
  p.stop.store(true, std::memory_order_release);
  if (!p.thread) return StopResult::kJoined;
  const DWORD slice = joinMs < 4 ? 1 : joinMs / 4;
  for (int i = 0; i < 4; i++) {
    if (WaitForSingleObject(p.thread.get(), 0) == WAIT_OBJECT_0) {
      p.thread.reset();
      return StopResult::kJoined;
    }
    CancelSynchronousIo(p.thread.get());  // only THIS thread's sync I/O
    if (WaitForSingleObject(p.thread.get(), slice) == WAIT_OBJECT_0) {
      p.thread.reset();
      return StopResult::kJoined;
    }
  }
  return StopResult::kRefused;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--version") {
    std::printf(
        "{\"helper\":\"tivano-job-helper\",\"version\":\"%s\",\"spec\":%u,"
        "\"mechanisms\":[\"job-object\",\"kill-on-job-close\","
        "\"proc-thread-attr-job-list\",\"proc-thread-attr-handle-list\","
        "\"actual-parent-owner\",\"cancel-synchronous-io\","
        "\"bounded-drain\",\"eof-grace\",\"conpty-terminal\"],"
        "\"diagnosticOnly\":true,"
        "\"runExitBase\":%u,\"runExitMax\":%u,"
        "\"terminalSpec\":%u}\n",
        th::kHelperVersion, th::kSpecVersion, kRunExitBase, kRunExitMax,
        th::kTerminalSpecVersion);
    return kExitOk;
  }
  const bool runMode = argc >= 2 && std::wstring(argv[1]) == L"--run";
  const bool serveMode = argc >= 2 && std::wstring(argv[1]) == L"--serve";
  const bool termMode = argc >= 2 && std::wstring(argv[1]) == L"--terminal";
  // Opt-in startup-stage trace — terminal mode ONLY, one explicit
  // non-secret switch appended to the frozen 3-argument form:
  //   tivano-job-helper.exe --terminal <base64url-spec> --startup-trace
  // It adds bounded "trace t=<ms> <stage>" markers on stderr via Diag;
  // protocol stdout, defaults and every other mode are unchanged.
  const bool traceFlag =
      argc == 4 && termMode && std::wstring(argv[3]) == L"--startup-trace";
  if ((!traceFlag && argc != 3) || (!runMode && !serveMode && !termMode)) {
    std::fputs(
        "tivano-job-helper: usage: --serve <base64url-spec> | --run <base64url-spec> | --terminal <base64url-terminal-spec> [--startup-trace] | --version\n",
        stderr);
    return kExitInvalid;
  }
  if (!g_diag.start()) {
    // NO blocking fputs fallback — an inherited stderr pipe can stall a
    // blocking write indefinitely. Exit codes are the honest channel.
    return kExitSetup;
  }

  std::string b64;
  for (const wchar_t* p = argv[2]; *p; ++p) {
    if (*p > 0x7F) {
      diag("spec argument is not base64url ASCII");
      finalExit(kExitInvalid);
    }
    b64.push_back(static_cast<char>(*p));
  }
  std::vector<uint8_t> specBytes;
  if (!th::b64urlDecode(b64, specBytes) || specBytes.empty() ||
      specBytes.size() > th::kMaxSpecJsonBytes) {
    diag("spec is not valid base64url within the size bound");
    finalExit(kExitInvalid);
  }
  if (termMode) {
    // Independent spec, protocol and exit taxonomy — never returns.
    tht::runTerminalMode(
        std::string_view(reinterpret_cast<const char*>(specBytes.data()),
                         specBytes.size()),
        traceFlag);
  }
  std::string err;
  std::optional<th::Spec> maybe = th::parseSpec(
      std::string_view(reinterpret_cast<const char*>(specBytes.data()), specBytes.size()),
      err);
  if (!maybe) {
    diag("spec rejected: %s", err.c_str());  // codes only — never content
    finalExit(kExitInvalid);
  }
  const th::Spec spec = std::move(*maybe);

  // Owner verification BEFORE any payload object exists: the claimed
  // ownerPid must be our real parent in the kernel process table.
  Handle owner;
  if (!openVerifiedOwner(spec.ownerPid, owner)) {
    diag("owner identity unverifiable or is not our actual parent");
    finalExit(kExitSetup);
  }

  std::u16string cmd16, env16;
  if (!th::buildCommandLine(spec, cmd16, err)) {
    diag("command line: %s", err.c_str());
    finalExit(kExitInvalid);
  }
  if (!th::buildEnvBlock(spec, env16, err)) {
    diag("environment block: %s", err.c_str());
    finalExit(kExitInvalid);
  }
  std::u16string exe16, cwd16;
  if (!th::utf8ToUtf16(spec.exe, exe16) || !th::utf8ToUtf16(spec.cwd, cwd16)) {
    diag("path encoding failure");
    finalExit(kExitInvalid);
  }
  std::wstring exeW = u16ToWide(exe16);
  std::wstring cwdW = u16ToWide(cwd16);
  std::wstring cmdW = u16ToWide(cmd16);

  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job) {
    diag("CreateJobObjectW failed %lu", GetLastError());
    finalExit(kExitSetup);
  }
  {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim{};
    // Only KILL_ON_JOB_CLOSE. BREAKAWAY_OK / SILENT_BREAKAWAY_OK are
    // deliberately absent — no descendant may leave the Job.
    lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &lim,
                                 sizeof lim)) {
      diag("SetInformationJobObject failed %lu", GetLastError());
      finalExit(kExitSetup);
    }
  }

  HANDLE ourIn = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE ourOut = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE ourErr = GetStdHandle(STD_ERROR_HANDLE);
  if (!ourIn || ourIn == INVALID_HANDLE_VALUE || !ourOut ||
      ourOut == INVALID_HANDLE_VALUE || !ourErr || ourErr == INVALID_HANDLE_VALUE) {
    diag("no usable stdio handles");
    finalExit(kExitSetup);
  }
  // CreatePipe returns the READ handle first. makePipePair(parentEnd,
  // childEnd, parentReads): parentReads=false → parentEnd is the WRITE
  // side (input pump writes INTO the payload); childEnd is the READ
  // side (hStdInput). parentReads=true → parentEnd reads the payload's
  // output, childEnd is the child's WRITE side.
  Handle childInRd, childInWr, childOutRd, childOutWr, childErrRd, childErrWr;
  if (!makePipePair(childInWr, childInRd, false) ||
      !makePipePair(childOutRd, childOutWr, true) ||
      !makePipePair(childErrRd, childErrWr, true)) {
    diag("stdio pipe creation failed %lu", GetLastError());
    finalExit(kExitSetup);
  }

  HANDLE inheritList[3] = {childInRd.get(), childOutWr.get(), childErrWr.get()};
  HANDLE jobH = job.get();
  SIZE_T attrSize = 0;
  if (InitializeProcThreadAttributeList(nullptr, 2, 0, &attrSize) == FALSE &&
      GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    diag("attribute list sizing failed %lu", GetLastError());
    finalExit(kExitSetup);
  }
  if (attrSize == 0) {
    diag("attribute list sizing returned zero");
    finalExit(kExitSetup);
  }
  std::vector<uint8_t> attrBuf(attrSize);
  LPPROC_THREAD_ATTRIBUTE_LIST attrList =
      reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrBuf.data());
  if (!InitializeProcThreadAttributeList(attrList, 2, 0, &attrSize)) {
    diag("InitializeProcThreadAttributeList failed %lu", GetLastError());
    finalExit(kExitSetup);
  }
  struct AttrGuard {
    LPPROC_THREAD_ATTRIBUTE_LIST l;
    ~AttrGuard() {
      if (l) DeleteProcThreadAttributeList(l);
    }
  } attrGuard{attrList};
  if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobH,
                                 sizeof(HANDLE), nullptr, nullptr)) {
    diag("UpdateProcThreadAttribute(job) failed %lu", GetLastError());
    finalExit(kExitSetup);
  }
  if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 inheritList, sizeof(inheritList), nullptr, nullptr)) {
    diag("UpdateProcThreadAttribute(handles) failed %lu", GetLastError());
    finalExit(kExitSetup);
  }

  STARTUPINFOEXW siex{};
  siex.StartupInfo.cb = sizeof siex;
  siex.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  siex.StartupInfo.hStdInput = childInRd.get();
  siex.StartupInfo.hStdOutput = childOutWr.get();
  siex.StartupInfo.hStdError = childErrWr.get();
  siex.lpAttributeList = attrList;

  // Events are fallible setup too — created BEFORE the payload so a
  // failure still means "payload never ran" (exit 3 stays truthful).
  Handle parentEof(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  Handle pumpFatal(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!parentEof || !pumpFatal) {
    diag("CreateEventW failed %lu", GetLastError());
    finalExit(kExitSetup);
  }
  // Final owner check immediately before launch — the verified handle
  // pins the identity, so this can only detect a death since open,
  // never a different process.
  if (WaitForSingleObject(owner.get(), 0) != WAIT_TIMEOUT) {
    diag("owner died before payload launch — refusing");
    finalExit(kExitSetup);
  }

  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(exeW.c_str(), cmdW.data(), nullptr, nullptr, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                      const_cast<char16_t*>(env16.data()), cwdW.c_str(),
                      &siex.StartupInfo, &pi)) {
    diag("CreateProcessW failed %lu", GetLastError());
    finalExit(kExitSpawn);
  }
  Handle hProcess(pi.hProcess), hThread(pi.hThread);
  childInRd.reset();
  childOutWr.reset();
  childErrWr.reset();

  Pump inPump, outPump, errPump;
  inPump.from = ourIn;
  inPump.to = childInWr.release();
  inPump.closeToOnDone = true;
  inPump.parentEofEvent = parentEof.get();
  inPump.signalOnSourceEnd = true;   // parent stdin EOF → grace window
  inPump.fatalEvent = pumpFatal.get();
  // A payload closing ITS stdin is kDestClosed on inPump — benign, no
  // signal. The out/err pumps' kDestClosed means OUR stdout/stderr peer
  // (the launcher) died — that DOES signal end-of-session.
  outPump.from = childOutRd.get();
  outPump.to = ourOut;
  outPump.parentEofEvent = parentEof.get();
  outPump.signalOnDestClosed = true;
  outPump.fatalEvent = pumpFatal.get();
  errPump.from = childErrRd.get();
  errPump.to = ourErr;
  errPump.parentEofEvent = parentEof.get();
  errPump.signalOnDestClosed = true;
  errPump.fatalEvent = pumpFatal.get();
  if (!startPump(inPump) || !startPump(outPump) || !startPump(errPump)) {
    // POST-LAUNCH failure: the payload already exists — exit 3's
    // documented meaning (payload never ran) would be a lie. Kill the
    // job, attempt bounded cleanup proof, report honestly.
    diag("pump thread creation failed %lu — terminating payload job",
         GetLastError());
    TerminateJobObject(job.get(), 1);
    const auto inputStop = stopPump(inPump, kPumpJoinMs);
    const auto outputStop = stopPump(outPump, kPumpJoinMs);
    const auto errorStop = stopPump(errPump, kPumpJoinMs);
    if (inputStop == StopResult::kRefused || outputStop == StopResult::kRefused ||
        errorStop == StopResult::kRefused) {
      diag("postlaunch abort left an unjoined pump — cleanup unprovable");
      g_diag.stop(500);
      ExitProcess(kExitCleanup);
    }
    DWORD n = 0;
    const bool emptied = jobActiveCount(job.get(), n) && n == 0;
    diag(emptied ? "postlaunch abort — job emptied (exit 6)"
                 : "postlaunch abort — cleanup unprovable (exit 4)");
    finalExit(emptied ? kExitPayload : kExitCleanup);
  }

  // ---- main watch loop ----------------------------------------------------
  // Signals: payload exit · owner death · parent-stdin EOF.
  // Watchdog: zero-progress pump writes past kPumpStallMs; EOF grace past
  // kEofGraceMs with the payload still alive.
  enum class TermReason {
    kNone, kOwnerDead, kEofGrace, kStalledWrite, kWaitFailed, kPumpFatal,
  };
  TermReason reason = TermReason::kNone;
  bool payloadExited = false;
  bool payloadExitUnknown = false;
  DWORD payloadExit = 0;
  uint64_t eofAt = 0;  // 0 = grace not started

  HANDLE waitSet[4] = {hProcess.get(), owner.get(), parentEof.get(),
                     pumpFatal.get()};
  for (;;) {
    const DWORD r = WaitForMultipleObjects(4, waitSet, FALSE, kWatchSliceMs);
    if (r == WAIT_OBJECT_0) {
      payloadExited = true;
      if (!GetExitCodeProcess(hProcess.get(), &payloadExit)) {
        diag("GetExitCodeProcess failed %lu — payload exit unprovable",
             GetLastError());
        payloadExitUnknown = true;
      }
      break;
    }
    if (r == WAIT_OBJECT_0 + 1) {
      diag("owner died — terminating job");
      reason = TermReason::kOwnerDead;
      break;
    }
    if (r == WAIT_OBJECT_0 + 2) {
      if (eofAt == 0) {
        eofAt = GetTickCount64();
        // Consume the wake: a manual-reset event stays signaled and
        // would spin this loop hot for the whole grace window.
        ResetEvent(parentEof.get());
      }
      // else: already in grace — fall through to the grace check
    }
    if (r == WAIT_OBJECT_0 + 3) {
      diag("a stdio pump ended on a real I/O error — terminating job");
      reason = TermReason::kPumpFatal;
      break;
    }
    if (r == WAIT_FAILED) {
      diag("wait failed %lu", GetLastError());
      reason = TermReason::kWaitFailed;
      break;
    }
    // Watchdog checks run every iteration (signals and timeouts alike).
    if (eofAt != 0 &&
        GetTickCount64() - eofAt >= static_cast<uint64_t>(kEofGraceMs)) {
      diag("parent stdin EOF grace expired — terminating job");
      reason = TermReason::kEofGrace;
      break;
    }
    for (Pump* p : {&inPump, &outPump, &errPump}) {
      const bool writing = p->writeInFlight.load(std::memory_order_acquire);
      const uint64_t lastWrite = p->lastWriteTick.load(std::memory_order_relaxed);
      const uint64_t now = GetTickCount64();
      if (writing && now >= lastWrite && now - lastWrite >= kPumpStallMs) {
        diag("stdio write made no progress for %lu ms — terminating job",
             static_cast<unsigned long>(kPumpStallMs));
        reason = TermReason::kStalledWrite;
        break;
      }
    }
    if (reason != TermReason::kNone) break;
  }

  bool forced = reason != TermReason::kNone;
  if (forced) {
    if (!TerminateJobObject(job.get(), 1))
      diag("TerminateJobObject failed %lu — cleanup unprovable", GetLastError());
  }

  // Payload exited but the Job still holds members (e.g. a lingering
  // grandchild): actively terminate them — waiting politely is not the
  // cleanup policy. Exit 4 stays reserved for real proof failures.
  if (payloadExited && !forced) {
    DWORD active = 0;
    if (!jobActiveCount(job.get(), active)) {
      diag("job accounting query failed — cleanup unprovable");
      finalExit(kExitCleanup);
    }
    if (active > 0) {
      diag("payload exited with %lu job member(s) still live — terminating",
           static_cast<unsigned long>(active));
      if (!TerminateJobObject(job.get(), 1)) {
        diag("TerminateJobObject failed %lu", GetLastError());
        finalExit(kExitCleanup);
      }
      forced = true;
    }
  }

  // ---- pump shutdown: input first, then bounded output drain -------------
  bool ioSound = true;
  if (stopPump(inPump, kPumpJoinMs) == StopResult::kRefused) {
    diag("stdin pump thread refused to die — aborting with live thread");
    g_diag.stop(500);
    ExitProcess(kExitCleanup);  // never unwind past live threads
  }
  // inPump: kSourceEof/kDestClosed/kCanceled/kStopped are all expected
  // endings; only real I/O errors count against the session.
  const Pump::Why inWhy = inPump.why.load();
  if (inWhy == Pump::Why::kReadErr || inWhy == Pump::Why::kWriteErr)
    ioSound = false;

  // out/err pumps: drain through NATURAL pipe EOF within kDrainWaitMs.
  // Job teardown closes the child ends → EOF arrives and every buffered
  // tail byte reaches OUR stdio first. ONLY kSourceEof is a clean
  // ending: a canceled, stopped, errored or truncated stream means the
  // bytes handed to the parent are incomplete — that can NEVER be a
  // successful session.
  for (Pump* p : {&outPump, &errPump}) {
    if (WaitForSingleObject(p->thread.get(), kDrainWaitMs) != WAIT_OBJECT_0) {
      diag("output drain exceeded %lu ms — cancelling",
           static_cast<unsigned long>(kDrainWaitMs));
      ioSound = false;  // truncated output, regardless of what follows
      if (stopPump(*p, kPumpJoinMs) == StopResult::kRefused) {
        diag("output pump thread refused to die — aborting");
        g_diag.stop(500);
        ExitProcess(kExitCleanup);
      }
    } else {
      p->thread.reset();
    }
    const Pump::Why w = p->why.load();
    if (w != Pump::Why::kSourceEof) ioSound = false;
  }

  // ---- job-empty proof ----------------------------------------------------
  DWORD elapsed = 0;
  bool empty = false;
  while (elapsed <= kJobEmptyWaitMs) {
    DWORD n = 0;
    if (!jobActiveCount(job.get(), n)) {
      diag("job accounting query failed — cleanup state unprovable");
      finalExit(kExitCleanup);
    }
    if (n == 0) { empty = true; break; }
    if (forced && !TerminateJobObject(job.get(), 1))
      diag("TerminateJobObject retry failed %lu", GetLastError());
    Sleep(kJobEmptyPollMs);
    elapsed += kJobEmptyPollMs;
  }
  if (!empty) {
    diag("job not empty after %lu ms — refusing to claim cleanup", kJobEmptyWaitMs);
    finalExit(kExitCleanup);
  }
  if (!ioSound) {
    diag("a stdio pump ended on an I/O error — not a clean session");
    finalExit(kExitCleanup);
  }
  if (payloadExitUnknown) {
    diag("payload exited but its exit code is unprovable");
    finalExit(kExitCleanup);
  }
  if (reason == TermReason::kWaitFailed) {
    diag("wait primitive failed — session state unprovable (job emptied)");
    finalExit(kExitCleanup);
  }
  if (reason == TermReason::kStalledWrite) {
    diag("stdio write stalled past deadline — session failed (job emptied)");
    finalExit(kExitCleanup);
  }
  if (reason == TermReason::kPumpFatal) {
    diag("stdio pump I/O failure — session torn down (job emptied)");
    finalExit(kExitCleanup);
  }
  if (!payloadExited) {
    if (!runMode) diag("payload-exit=terminated (job emptied, cleanup confirmed)");
    else diag("payload terminated (job emptied, cleanup confirmed)");
    finalExit(kExitPayload);
  }
  if (forced) {
    if (!runMode)
      diag("payload-exit=%lu (descendants terminated; job emptied)",
           payloadExit);
    else
      diag("descendants terminated (job emptied)");
    finalExit(kExitPayload);
  }
  if (!runMode && payloadExit != 0) {
    diag("payload-exit=%lu", payloadExit);
    finalExit(kExitPayload);
  }
  // --run contract: payload ended naturally, job proven empty, all stdio
  // drained — the exit code travels in OUR exit code, never on stderr.
  // A payload code outside 0..255 cannot be represented: fail closed
  // with the same "payload nonzero" class instead of lying.
  if (runMode) {
    if (payloadExit > kRunExitMax) {
      diag("payload exit code outside the --run range — failing closed (job emptied)");
      finalExit(kExitPayload);
    }
    finalExit(static_cast<int>(kRunExitBase + payloadExit));
  }
  finalExit(kExitOk);
}
