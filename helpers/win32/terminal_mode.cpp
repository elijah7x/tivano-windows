// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// terminal_mode — `--terminal <base64url TerminalSpec v1>`: one Windows
// terminal session hosted by the job helper instead of a PTY utility
// process. NOT YET EXECUTED on Windows — JOB_LIST + PSEUDOCONSOLE in one
// attribute list, old-Windows ClosePseudoConsole hang behaviour and
// conhost lifetime after a hard helper death are the documented Windows
// unknowns; if they cannot be proven, this mode is a reported blocker,
// never a fallback.
//
// Creation order (the ownership contract):
//   1. TerminalSpec parsed + fully validated BEFORE any OS object.
//   2. Owner verified (helper_win32 openVerifiedOwner — our REAL parent).
//   3. Job + KILL_ON_JOB_CLOSE, no breakaway. ConPTY pipes + pseudo
//      console (flags=0) created. STARTUPINFOEXW carries BOTH
//      PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE and PROC_THREAD_ATTRIBUTE_
//      JOB_LIST in ONE attribute list — the shell's first thread starts
//      already inside the Job. No suspended-create/assign fallback.
//   4. The shell is FIXED: <GetSystemDirectoryW>\WindowsPowerShell\v1.0\
//      powershell.exe -NoLogo -NoProfile. The spec can never choose it.
//
// Startup trace (OPT-IN, default OFF): `--startup-trace` on the
// --terminal command line emits bounded `trace t=<ms> <stage>` markers
// on stderr through the same Diag queue — stage names, monotonic times,
// helper identity and native error codes only. Never stdout, never
// spec/env/path/input bytes, never a blocking write on the lifecycle
// thread. Instrumentation only: it does not reorder or widen anything.
//
// Control protocol — versioned-bounded NDJSON on OUR stdin/stdout
// (diagnostics stay on stderr through Diag):
//   main → helper: {"type":"input","data":"<base64>"}          (≤48KiB/msg)
//                  {"type":"resize","cols":2..500,"rows":2..200}
//                  {"type":"ack","seq":N} · {"type":"pause"} ·
//                  {"type":"resume"} · {"type":"stop"}
//                  stdin EOF = owner stopped driving → forced teardown
//   helper → main: {"type":"spawned","pid":N}
//                  {"type":"spawn-failed","code":"<stable code>"}
//                  {"type":"data","seq":N,"data":"<base64>"}   raw ≤4096
//                    bytes, cut only on complete UTF-8 sequences
//                  {"type":"exit","exitCode":<u32>|null,"forced":bool}
//                  {"type":"cleanup","jobEmpty":bool,"outputComplete":bool}
//                  {"type":"error","code":"<stable code>"}
//   One line ≤ 512 KiB; a longer line is a protocol violation.
//
// --terminal exit classes (NOT the serve/run mapping — a shell's nonzero
// exit is DATA inside the "exit" message, not a helper failure):
//   0 = session ended cleanly: shell exit observed, Job emptied WITHOUT
//       force, output drained to real EOF, cleanup message emitted
//   2 = invalid spec/invocation — nothing was created
//   3 = setup failure (stdio, events, threads, owner, job, pipes, ConPTY,
//       attributes, missing system shell) — shell never ran
//   4 = cleanup/I-O proof failure: job-empty query failed/expired, drain
//       ended on real error or bound, a worker/ClosePseudoConsole refused
//       its bound, output provably truncated outside a forced teardown,
//       or the shell's exit code is unprovable
//   5 = CreateProcessW failed — shell never ran
//   6 = forced teardown completed with Job proven empty (stop request,
//       owner death, control EOF, protocol violation, stall or overflow);
//       also a natural shell exit that left live Job members needing
//       termination
//
// Threads: control reader (stdin→lines→dispatch), input writer (queue→
// ConPTY input), output drain (ConPTY output→UTF-8-safe frames→queue),
// protocol writer (queue→our stdout). Input/output never block each
// other or the owner/stop wait; ClosePseudoConsole runs on a dedicated
// thread AFTER the Job is proven empty while the drain keeps running —
// never synchronous on the read thread (old builds may block inside
// ClosePseudoConsole).
//
// Backpressure mirrors the host contract: helper pauses reading ConPTY
// output at 128 KiB unacked, resumes below 32 KiB, hard-fails the session
// past 512 KiB. Pending input is capped at 256 KiB; overflow is an
// explicit failure, never silent key loss.

#include "terminal_mode.hpp"

#include <algorithm>
#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <deque>
#include <initializer_list>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "helper_common.hpp"
#include "helper_win32.hpp"
#include "third_party/nlohmann/json.hpp"

namespace tht {
namespace {

// ---- exit classes --------------------------------------------------------
constexpr int kTermOk = 0;
constexpr int kTermInvalid = 2;
constexpr int kTermSetup = 3;
constexpr int kTermCleanup = 4;
constexpr int kTermSpawn = 5;
constexpr int kTermForced = 6;

// ---- bounds --------------------------------------------------------------
constexpr DWORD kIoBuf = 4096;
constexpr size_t kCtrlLineMax = 512 * 1024;
constexpr size_t kInputMsgMax = 48 * 1024;
constexpr size_t kInputB64Max = ((kInputMsgMax + 2) / 3) * 4 + 4;
constexpr size_t kInputPendingMax = 256 * 1024;
constexpr uint64_t kUnackedPause = 128 * 1024;
constexpr uint64_t kUnackedResume = 32 * 1024;
constexpr uint64_t kUnackedHard = 512 * 1024;
constexpr size_t kOutQueueMaxLines = 4096;
constexpr size_t kOutQueueMaxBytes = 6 * 1024 * 1024;
constexpr DWORD kJobEmptyWaitMs = 10000;
constexpr DWORD kJobEmptyPollMs = 50;
constexpr DWORD kDrainWaitMs = 10000;
constexpr DWORD kThreadJoinMs = 4000;
constexpr DWORD kHpconJoinMs = 10000;
constexpr DWORD kPumpStallMs = 15000;
constexpr DWORD kWatchSliceMs = 100;
constexpr DWORD kWriterFlushMs = 4000;

// ---- opt-in startup trace ---------------------------------------------------
// Reached ONLY through `--startup-trace`. Every line goes through the
// bounded Diag queue (<=448 chars, <=64 queued, drops counted) — the
// lifecycle thread never blocks on stderr and never writes to stdout.
// Markers are deliberately narrow: stage names, monotonic ms since mode
// entry, our pid/creation-stamp identity and native error/HRESULT codes.
// Both globals are written once at mode entry, before any worker exists.
bool g_traceOn = false;
uint64_t g_traceT0 = 0;

void trace(const char* fmt, ...) {
  if (!g_traceOn) return;
  char body[384];
  va_list ap;
  va_start(ap, fmt);
  const int n = std::vsnprintf(body, sizeof body, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  body[sizeof body - 1] = '\0';
  char line[448];
  std::snprintf(line, sizeof line, "trace t=%llums %s",
                static_cast<unsigned long long>(GetTickCount64() - g_traceT0),
                body);
  g_diag.line(line);
}

[[noreturn]] void termExit(int cls) {
  trace("exit cls=%d", cls);
  finalExit(cls);
}

// A worker that will not die inside its bound still references session
// storage — the only honest exit is hard, after one last marker.
[[noreturn]] void hardExit(int cls) {
  trace("hard-exit cls=%d", cls);
  g_diag.stop(500);
  ExitProcess(cls);
}

// ---- session state ---------------------------------------------------------
// Every mutable field below is guarded by `lock` UNLESS declared atomic.
// The session object lives on runTerminalMode's frame for the whole
// session; a worker that refuses to die turns the exit into a hard
// ExitProcess before any storage could be destructed.
struct Sess {
  // owned handles
  Handle owner, job, hProcess;
  HPCON hpcon = nullptr;
  Handle ptyInWr;   // we WRITE → ConPTY input
  Handle ptyOutRd;  // we READ ← ConPTY output
  HANDLE ourIn = nullptr, ourOut = nullptr;

  // events
  Handle controlEv;   // control actions/flags updated
  Handle outEv;       // outLines fed
  Handle inputEv;     // inputBlobs fed
  Handle resumeEv;    // output may resume (unpause or teardown)
  Handle drainDoneEv; // drain thread ended
  Handle ioFatalEv;   // a worker hit a real I/O error

  SRWLOCK lock = SRWLOCK_INIT;
  std::deque<std::string> outLines;
  size_t outBytes = 0;
  std::deque<std::string> inputBlobs;
  size_t inputPending = 0;
  std::deque<std::pair<uint32_t, uint32_t>> seqBytes;  // seq → raw bytes
  uint64_t unackedBytes = 0;
  uint32_t sentSeq = 0;         // frames emitted — allocated under lock
  std::string carry;            // utf8 tail held for next frame (drain only)

  std::atomic<bool> pausedExplicit{false};
  std::atomic<bool> pausedCredit{false};
  std::atomic<bool> teardown{false};

  bool stopRequested = false, stdinEof = false;
  bool resizePending = false;
  COORD resizeNext{};
  bool protocolBad = false;
  std::string protocolCode;
  bool inputOverflow = false;
  std::atomic<bool> outOverflow{false};
  std::atomic<bool> inputDead{false}, writerDead{false};
  std::atomic<int> drainWhy{0};  // 0 running, 1 eof, 2 canceled, 3 err, 4 stopped

  std::atomic<bool> stopReaderF{false}, stopInputF{false};
  std::atomic<bool> stopDrainF{false}, stopWriterF{false};
  std::atomic<bool> inputBusy{false}, writerBusy{false};
  std::atomic<uint64_t> inputTick{0}, writerTick{0};

  Handle thReader, thInput, thDrain, thWriter;
};

// ---- protocol emit ---------------------------------------------------------

void enqueueLine(Sess& s, std::string line) {
  {
    AcquireSRWLockExclusive(&s.lock);
    if (!s.outOverflow.load() && s.outLines.size() < kOutQueueMaxLines &&
        s.outBytes + line.size() <= kOutQueueMaxBytes) {
      s.outBytes += line.size();
      s.outLines.push_back(std::move(line));
    } else {
      s.outOverflow.store(true, std::memory_order_release);
    }
    ReleaseSRWLockExclusive(&s.lock);
  }
  SetEvent(s.outEv.get());
}

void emitCode(Sess& s, const char* type, const char* code) {
  char buf[160];
  std::snprintf(buf, sizeof buf, "{\"type\":\"%s\",\"code\":\"%s\"}",
                type, code);
  enqueueLine(s, buf);
}

void emitSpawnFailed(Sess& s, const char* code) {
  char buf[192];
  std::snprintf(buf, sizeof buf,
                "{\"type\":\"spawn-failed\",\"code\":\"%s\"}", code);
  enqueueLine(s, buf);
}

// Emit one data frame. The sequence number is allocated INSIDE the lock
// so the control reader's ack-vs-sentSeq check is race-free (only the
// drain thread ever calls this, but the lock makes it provable).
void emitData(Sess& s, std::string_view chunk) {
  uint32_t seq = 0;
  {
    AcquireSRWLockExclusive(&s.lock);
    seq = ++s.sentSeq;
    s.seqBytes.emplace_back(seq, static_cast<uint32_t>(chunk.size()));
    s.unackedBytes += chunk.size();
    if (!s.pausedCredit.load() && s.unackedBytes >= kUnackedPause)
      s.pausedCredit.store(true, std::memory_order_release);
    ReleaseSRWLockExclusive(&s.lock);
  }
  std::string line = "{\"type\":\"data\",\"seq\":";
  line += std::to_string(seq);
  line += ",\"data\":\"";
  line += th::b64Encode(chunk);
  line += "\"}";
  enqueueLine(s, std::move(line));
}

// ---- protocol writer (outLines → our stdout) -------------------------------

unsigned __stdcall writerRun(void* raw) {
  auto* s = static_cast<Sess*>(raw);
  for (;;) {
    WaitForSingleObject(s->outEv.get(), INFINITE);
    for (;;) {
      std::string line;
      bool stopping = false;
      {
        AcquireSRWLockExclusive(&s->lock);
        if (!s->outLines.empty()) {
          line = std::move(s->outLines.front());
          s->outLines.pop_front();
          s->outBytes -= line.size();
          s->writerTick.store(GetTickCount64(), std::memory_order_relaxed);
          s->writerBusy.store(true, std::memory_order_release);
        }
        stopping = s->stopWriterF.load(std::memory_order_acquire);
        ReleaseSRWLockExclusive(&s->lock);
      }
      if (line.empty()) {
        if (stopping) return 0;  // queue drained AND stop requested
        break;                   // back to the outer wait
      }
      line.push_back('\n');
      DWORD off = 0;
      bool dead = false;
      DWORD werr = 0;
      while (off < static_cast<DWORD>(line.size())) {
        DWORD w = 0;
        const BOOL ok = WriteFile(s->ourOut, line.data() + off,
                                  static_cast<DWORD>(line.size()) - off, &w,
                                  nullptr);
        if (!ok || w == 0) {
          if (!ok) werr = GetLastError();
          dead = true;
          break;
        }
        off += w;
        s->writerTick.store(GetTickCount64(), std::memory_order_relaxed);
      }
      s->writerBusy.store(false, std::memory_order_release);
      if (dead) {
        trace("writer-dead err=%lu", static_cast<unsigned long>(werr));
        s->writerDead.store(true, std::memory_order_release);
        SetEvent(s->ioFatalEv.get());
        return 0;
      }
      // Actual flush — distinguishable from the enqueue marker upstream.
      // Data frames are high-volume and excluded; control frames are few.
      if (g_traceOn && line.compare(0, 14, "{\"type\":\"data\"") != 0)
        trace("writer-flushed %.40s", line.c_str());
    }
    {
      AcquireSRWLockExclusive(&s->lock);
      const bool done = s->stopWriterF.load(std::memory_order_acquire) &&
                        s->outLines.empty();
      ReleaseSRWLockExclusive(&s->lock);
      if (done) return 0;
    }
  }
}

// ---- console control events ------------------------------------------------

// ETX (0x03) written to the ConPTY input stream is only *queued* as a console
// input record — whether conhost converts it to a real CTRL_C_EVENT depends on
// the hosted app's console input mode (ENABLE_PROCESSED_INPUT), which line
// editors like PSReadLine mutate around prompt reads. A literal byte can sit
// unread in the input queue while a foreground command keeps running
// (observed: input-echo-and-ctrl-c — Start-Sleep kept sleeping, queued input
// behind it never consumed, helper needed forced rescue). For a REAL Ctrl-C
// we attach to the hosted console and generate the event ourselves — the same
// event conhost would raise. The byte is still forwarded so apps that read
// raw key events keep seeing it.
void sendCtrlC(HANDLE hChild) {
  const DWORD pid = hChild ? GetProcessId(hChild) : 0;
  if (!pid) return;
  FreeConsole();  // we normally have none; AttachConsole refuses a second
  if (!AttachConsole(pid)) return;
  SetConsoleCtrlHandler(nullptr, TRUE);  // we join the console — don't die on
                                         // the event we're about to post
  GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
  FreeConsole();
  SetConsoleCtrlHandler(nullptr, FALSE);
}

// ---- input writer (inputBlobs → ConPTY input) ------------------------------

unsigned __stdcall inputRun(void* raw) {
  auto* s = static_cast<Sess*>(raw);
  for (;;) {
    WaitForSingleObject(s->inputEv.get(), INFINITE);
    for (;;) {
      std::string blob;
      bool stopping = false;
      {
        AcquireSRWLockExclusive(&s->lock);
        if (!s->inputBlobs.empty()) {
          blob = std::move(s->inputBlobs.front());
          s->inputBlobs.pop_front();
          s->inputPending -= blob.size();
        }
        stopping = s->stopInputF.load(std::memory_order_acquire);
        ReleaseSRWLockExclusive(&s->lock);
      }
      if (blob.empty()) {
        if (stopping) return 0;
        break;
      }
      DWORD off = 0;
      bool dead = false;
      DWORD werr = 0;
      while (off < static_cast<DWORD>(blob.size())) {
        DWORD w = 0;
        s->inputTick.store(GetTickCount64(), std::memory_order_relaxed);
        s->inputBusy.store(true, std::memory_order_release);
        const BOOL ok = WriteFile(s->ptyInWr.get(), blob.data() + off,
                                  static_cast<DWORD>(blob.size()) - off, &w,
                                  nullptr);
        s->inputBusy.store(false, std::memory_order_release);
        if (!ok || w == 0) {
          if (!ok) werr = GetLastError();
          dead = true;
          break;
        }
        off += w;
        s->inputTick.store(GetTickCount64(), std::memory_order_relaxed);
      }
      if (dead) {
        trace("input-dead err=%lu", static_cast<unsigned long>(werr));
        s->inputDead.store(true, std::memory_order_release);
        SetEvent(s->ioFatalEv.get());
        return 0;
      }
      // The byte went through as literal input; ETX additionally needs the
      // real console control event (see sendCtrlC) — one per blob, not per
      // byte.
      if (memchr(blob.data(), 0x03, blob.size()) != nullptr)
        sendCtrlC(s->hProcess.get());
    }
    {
      AcquireSRWLockExclusive(&s->lock);
      const bool done = s->stopInputF.load(std::memory_order_acquire) &&
                        s->inputBlobs.empty();
      ReleaseSRWLockExclusive(&s->lock);
      if (done) return 0;
    }
  }
}

// ---- output drain (ConPTY output → utf8-safe data frames) ------------------

bool drainPaused(const Sess& s) {
  return !s.teardown.load(std::memory_order_acquire) &&
         (s.pausedExplicit.load(std::memory_order_acquire) ||
          s.pausedCredit.load(std::memory_order_acquire));
}

// Emit complete frames from s.carry. With flush=false the trailing bytes
// of an incomplete UTF-8 sequence stay held for the next chunk; flush=true
// emits the remainder verbatim (the strict consumer decides validity).
void emitFrames(Sess& s, bool flush) {
  for (;;) {
    const size_t avail = s.carry.size();
    if (avail == 0) return;
    size_t take = std::min(avail, static_cast<size_t>(kIoBuf));
    if (!flush) {
      const size_t tail =
          th::utf8TailBytes(std::string_view(s.carry).substr(0, take));
      if (tail == take) return;  // all pending — need more bytes
      take -= tail;
    }
    if (take == 0) return;
    const std::string chunk = s.carry.substr(0, take);
    s.carry.erase(0, take);
    emitData(s, chunk);
  }
}

unsigned __stdcall drainRun(void* raw) {
  auto* s = static_cast<Sess*>(raw);
  std::vector<char> buf(kIoBuf);
  int why = 1;  // eof
  for (;;) {
    if (s->stopDrainF.load(std::memory_order_acquire) ||
        s->outOverflow.load(std::memory_order_acquire)) {
      why = 4;
      break;
    }
    if (drainPaused(*s)) {
      WaitForSingleObject(s->resumeEv.get(), 50);
      continue;
    }
    DWORD n = 0;
    if (!ReadFile(s->ptyOutRd.get(), buf.data(), kIoBuf, &n, nullptr)) {
      const DWORD e = GetLastError();
      if (e == ERROR_OPERATION_ABORTED) why = 2;
      else if (isPeerClosedError(e)) why = 1;
      else {
        why = 3;
        trace("drain-read-err %lu", static_cast<unsigned long>(e));
      }
      break;
    }
    if (n == 0) {
      why = 1;
      break;
    }
    s->carry.append(buf.data(), n);
    emitFrames(*s, false);
  }
  emitFrames(*s, true);  // final remainder — verbatim
  s->drainWhy.store(why, std::memory_order_release);
  trace("drain-end why=%d", why);
  SetEvent(s->drainDoneEv.get());
  return 0;
}

// ---- control channel parsing ------------------------------------------------

// Strict field whitelist per type; values type-checked. `bad` carries a
// stable code — never content.
struct Ctrl {
  enum class Kind { kInput, kResize, kAck, kPause, kResume, kStop, kBad };
  Kind kind = Kind::kBad;
  std::vector<uint8_t> bytes;
  uint32_t cols = 0, rows = 0;
  uint64_t seq = 0;
  const char* bad = "protocol";
};

Ctrl parseCtrl(std::string_view line) {
  Ctrl c;
  // A 512 KiB line of pure nesting would stack-overflow nlohmann's
  // recursive DOM parser — bounded SAX pre-scan first, same as specs.
  if (!th::jsonBoundedOk(line)) {
    c.bad = "ctrl-json";
    return c;
  }
  nlohmann::json doc;
  try {
    doc = nlohmann::json::parse(line.begin(), line.end());
  } catch (...) {
    c.bad = "ctrl-json";
    return c;
  }
  if (!doc.is_object()) return c;
  const std::string type =
      doc.contains("type") && doc["type"].is_string()
          ? doc["type"].get<std::string>()
          : "";
  auto fields = [&](std::initializer_list<const char*> ok) {
    for (auto& [k, _] : doc.items()) {
      if (k == "type") continue;
      bool found = false;
      for (const char* f : ok)
        if (k == f) {
          found = true;
          break;
        }
      if (!found) return false;
    }
    return true;
  };
  auto uintIn = [&](const char* f, uint64_t lo, uint64_t hi, uint64_t& out) {
    if (!doc.contains(f) || !doc[f].is_number_unsigned()) return false;
    const uint64_t v = doc[f].get<uint64_t>();
    if (v < lo || v > hi) return false;
    out = v;
    return true;
  };
  if (type == "input") {
    if (!fields({"data"}) || !doc.contains("data") ||
        !doc["data"].is_string()) {
      c.bad = "ctrl-input";
      return c;
    }
    const std::string d = doc["data"].get<std::string>();
    if (d.size() > kInputB64Max || !th::b64Decode(d, c.bytes) ||
        c.bytes.size() > kInputMsgMax) {
      c.bad = "ctrl-input";
      return c;
    }
    c.kind = Ctrl::Kind::kInput;
    return c;
  }
  if (type == "resize") {
    uint64_t cols = 0, rows = 0;
    if (!fields({"cols", "rows"}) ||
        !uintIn("cols", th::kTermColsMin, th::kTermColsMax, cols) ||
        !uintIn("rows", th::kTermRowsMin, th::kTermRowsMax, rows)) {
      c.bad = "ctrl-resize";
      return c;
    }
    c.kind = Ctrl::Kind::kResize;
    c.cols = static_cast<uint32_t>(cols);
    c.rows = static_cast<uint32_t>(rows);
    return c;
  }
  if (type == "ack") {
    uint64_t seq = 0;
    if (!fields({"seq"}) || !uintIn("seq", 1, 0x7FFFFFFF, seq)) {
      c.bad = "ctrl-ack";
      return c;
    }
    c.kind = Ctrl::Kind::kAck;
    c.seq = seq;
    return c;
  }
  if (type == "pause") {
    if (!fields({})) return c;
    c.kind = Ctrl::Kind::kPause;
    return c;
  }
  if (type == "resume") {
    if (!fields({})) return c;
    c.kind = Ctrl::Kind::kResume;
    return c;
  }
  if (type == "stop") {
    if (!fields({})) return c;
    c.kind = Ctrl::Kind::kStop;
    return c;
  }
  return c;
}

void setProtocolBad(Sess& s, const char* code) {
  {
    AcquireSRWLockExclusive(&s.lock);
    if (!s.protocolBad) {
      s.protocolBad = true;
      s.protocolCode = code;
    }
    ReleaseSRWLockExclusive(&s.lock);
  }
  SetEvent(s.controlEv.get());
}

void dispatchCtrl(Sess& s, const Ctrl& c) {
  switch (c.kind) {
    case Ctrl::Kind::kInput: {
      bool overflow = false;
      {
        AcquireSRWLockExclusive(&s.lock);
        if (s.inputPending + c.bytes.size() <= kInputPendingMax) {
          s.inputPending += c.bytes.size();
          s.inputBlobs.emplace_back(c.bytes.begin(), c.bytes.end());
        } else {
          s.inputOverflow = true;
          overflow = true;
        }
        ReleaseSRWLockExclusive(&s.lock);
      }
      if (overflow)
        setProtocolBad(s, "input-overflow");
      else
        SetEvent(s.inputEv.get());
      break;
    }
    case Ctrl::Kind::kResize: {
      {
        AcquireSRWLockExclusive(&s.lock);
        s.resizePending = true;
        s.resizeNext.X = static_cast<SHORT>(c.cols);
        s.resizeNext.Y = static_cast<SHORT>(c.rows);
        ReleaseSRWLockExclusive(&s.lock);
      }
      SetEvent(s.controlEv.get());
      break;
    }
    case Ctrl::Kind::kAck: {
      bool badSeq = false;
      {
        AcquireSRWLockExclusive(&s.lock);
        while (!s.seqBytes.empty() && s.seqBytes.front().first <= c.seq) {
          s.unackedBytes -= s.seqBytes.front().second;
          s.seqBytes.pop_front();
        }
        if (c.seq > s.sentSeq) badSeq = true;  // ack for a frame never sent
        if (s.pausedCredit.load() && s.unackedBytes < kUnackedResume)
          s.pausedCredit.store(false, std::memory_order_release);
        ReleaseSRWLockExclusive(&s.lock);
      }
      SetEvent(s.resumeEv.get());
      if (badSeq) setProtocolBad(s, "ack-future");
      break;
    }
    case Ctrl::Kind::kPause:
      s.pausedExplicit.store(true, std::memory_order_release);
      break;
    case Ctrl::Kind::kResume:
      s.pausedExplicit.store(false, std::memory_order_release);
      SetEvent(s.resumeEv.get());
      break;
    case Ctrl::Kind::kStop: {
      {
        AcquireSRWLockExclusive(&s.lock);
        s.stopRequested = true;
        ReleaseSRWLockExclusive(&s.lock);
      }
      SetEvent(s.controlEv.get());
      break;
    }
    case Ctrl::Kind::kBad:
      setProtocolBad(s, c.bad);
      break;
  }
}

// ---- control reader (our stdin → lines → dispatch) -------------------------

unsigned __stdcall readerRun(void* raw) {
  auto* s = static_cast<Sess*>(raw);
  std::string buf;
  char tmp[8192];
  for (;;) {
    if (s->stopReaderF.load(std::memory_order_acquire)) {
      trace("reader-stop");
      return 0;
    }
    DWORD n = 0;
    if (!ReadFile(s->ourIn, tmp, sizeof tmp, &n, nullptr)) {
      const DWORD e = GetLastError();
      if (e == ERROR_OPERATION_ABORTED) {
        trace("reader-cancel");
        return 0;  // our cancel
      }
      {
        AcquireSRWLockExclusive(&s->lock);
        s->stdinEof = true;  // peer died or closed — owner stopped driving
        ReleaseSRWLockExclusive(&s->lock);
      }
      trace("reader-eof err=%lu", static_cast<unsigned long>(e));
      SetEvent(s->controlEv.get());
      return 0;
    }
    if (n == 0) {
      {
        AcquireSRWLockExclusive(&s->lock);
        s->stdinEof = true;
        ReleaseSRWLockExclusive(&s->lock);
      }
      trace("reader-eof");
      SetEvent(s->controlEv.get());
      return 0;
    }
    buf.append(tmp, n);
    for (;;) {
      const size_t pos = buf.find('\n');
      if (pos == std::string::npos) {
        if (buf.size() > kCtrlLineMax) {
          trace("reader-oversize");
          setProtocolBad(*s, "ctrl-line-size");
          return 0;
        }
        break;
      }
      const std::string line = buf.substr(0, pos);
      buf.erase(0, pos + 1);
      if (line.size() > kCtrlLineMax) {
        trace("reader-oversize");
        setProtocolBad(*s, "ctrl-line-size");
        return 0;
      }
      dispatchCtrl(*s, parseCtrl(line));
      {
        AcquireSRWLockShared(&s->lock);
        const bool bad = s->protocolBad;
        ReleaseSRWLockShared(&s->lock);
        if (bad) {
          trace("reader-protocol-stop");
          return 0;  // channel untrusted — stop reading
        }
      }
    }
  }
}

// ---- hpcon closer -----------------------------------------------------------
// ClosePseudoConsole may block on old builds while output drains — it runs
// on its own thread, bounded by join; a refusal is a hard exit 4, not an
// unwind past a live thread.
struct HpconClose {
  HPCON hpcon = nullptr;
  Handle th;
};

unsigned __stdcall hpconCloseRun(void* raw) {
  auto* c = static_cast<HpconClose*>(raw);
  trace("hpcon-close-begin");
  ClosePseudoConsole(c->hpcon);
  trace("hpcon-close-end");
  c->hpcon = nullptr;
  return 0;
}

}  // namespace

void runTerminalMode(std::string_view specJsonUtf8, bool traceEnabled) {
  g_traceT0 = GetTickCount64();
  g_traceOn = traceEnabled;
  {
    // Helper identity: binary SHA-256 proves WHICH binary ran; pid +
    // process-creation FILETIME prove WHICH instance (matches the
    // driver's launched.json ticks). No path/spec/env bytes — ever.
    FILETIME ct{}, et{}, kt{}, ut{};
    unsigned long long cticks = 0;
    if (GetProcessTimes(GetCurrentProcess(), &ct, &et, &kt, &ut))
      cticks = (static_cast<unsigned long long>(ct.dwHighDateTime) << 32) |
               ct.dwLowDateTime;
    trace("armed ver=%s pid=%lu cticks=%llu", th::kHelperVersion,
          static_cast<unsigned long>(GetCurrentProcessId()), cticks);
  }
  // Spec BEFORE any OS object — the same order as serve/run.
  std::string err;
  const std::optional<th::TerminalSpec> maybe =
      th::parseTerminalSpec(specJsonUtf8, err);
  if (!maybe) {
    diag("terminal spec rejected: %s", err.c_str());
    trace("spec-rejected");
    termExit(kTermInvalid);
  }
  const th::TerminalSpec spec = *maybe;
  trace("spec-accepted cols=%lu rows=%lu",
        static_cast<unsigned long>(spec.cols),
        static_cast<unsigned long>(spec.rows));

  Sess s;
  s.ourIn = GetStdHandle(STD_INPUT_HANDLE);
  s.ourOut = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!s.ourIn || s.ourIn == INVALID_HANDLE_VALUE || !s.ourOut ||
      s.ourOut == INVALID_HANDLE_VALUE) {
    diag("no usable stdio handles");
    termExit(kTermSetup);
  }
  trace("stdio-ok");

  s.controlEv.reset(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  s.outEv.reset(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  s.inputEv.reset(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  s.resumeEv.reset(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  s.drainDoneEv.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  s.ioFatalEv.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!s.controlEv || !s.outEv || !s.inputEv || !s.resumeEv ||
      !s.drainDoneEv || !s.ioFatalEv) {
    diag("CreateEventW failed %lu", GetLastError());
    termExit(kTermSetup);
  }
  trace("events-ok");

  // Protocol writer + control reader come up FIRST — every later failure
  // can then still be reported as a protocol frame before exit.
  s.thWriter = startWorkerThread(&writerRun, &s);
  if (s.thWriter) trace("worker-start writer");
  s.thReader = startWorkerThread(&readerRun, &s);
  if (s.thReader) trace("worker-start reader");
  if (!s.thWriter || !s.thReader) {
    diag("control thread creation failed %lu", GetLastError());
    // No channel worth reporting through — fail hard.
    termExit(kTermSetup);
  }

  // Bounded best-effort queue flush — used on fail paths so the final
  // protocol line has a real chance of reaching the parent.
  const auto flushQueue = [&](DWORD ms) {
    const DWORD deadline = GetTickCount() + ms;
    for (;;) {
      {
        AcquireSRWLockExclusive(&s.lock);
        const bool drained = s.outLines.empty() &&
                             !s.writerBusy.load(std::memory_order_acquire);
        ReleaseSRWLockExclusive(&s.lock);
        if (drained) return;
      }
      if (GetTickCount() >= deadline) return;
      Sleep(10);
    }
  };

  // Fail-path that still owns the channel: emit spawn-failed, flush the
  // queue bounded, then leave through the shared finalExit. A worker that
  // refuses to die still references session storage — the ONLY honest
  // exit is then a hard ExitProcess, never std::exit past live threads.
  const auto spawnFailExit = [&](const char* code, int cls) -> void {
    trace("spawn-fail code=%s", code);
    emitSpawnFailed(s, code);
    flushQueue(kWriterFlushMs);
    trace("failpath-flush-done");
    {
      AcquireSRWLockExclusive(&s.lock);
      s.stopWriterF.store(true, std::memory_order_release);
      ReleaseSRWLockExclusive(&s.lock);
    }
    SetEvent(s.outEv.get());
    const bool writerGone =
        stopThreadBounded(s.thWriter.h, s.stopWriterF, kWriterFlushMs) ==
        StopResult::kJoined;
    s.stopReaderF.store(true, std::memory_order_release);
    const bool readerGone =
        stopThreadBounded(s.thReader.h, s.stopReaderF, kThreadJoinMs) ==
        StopResult::kJoined;
    if (!writerGone || !readerGone) {
      diag("control thread refused to die on fail-path — hard exit");
      hardExit(cls);
    }
    termExit(cls);
  };

  // Owner identity BEFORE any session object.
  if (!openVerifiedOwner(spec.ownerPid, s.owner)) {
    diag("terminal owner identity unverifiable");
    spawnFailExit("owner-unverifiable", kTermSetup);
  }
  trace("owner-verified");

  // The shell is FIXED — system Windows PowerShell from the trusted
  // system directory, never from PATH or any spec/env value.
  wchar_t sysDir[MAX_PATH];
  const UINT sysN = GetSystemDirectoryW(sysDir, MAX_PATH);
  if (sysN == 0 || sysN >= MAX_PATH) {
    diag("GetSystemDirectoryW failed %lu", GetLastError());
    spawnFailExit("sysdir", kTermSetup);
  }
  std::wstring shellW(sysDir);
  shellW += L"\\WindowsPowerShell\\v1.0\\powershell.exe";
  {
    const DWORD attr = GetFileAttributesW(shellW.c_str());
    if (attr == INVALID_FILE_ATTRIBUTES ||
        (attr & FILE_ATTRIBUTE_DIRECTORY) != 0) {
      diag("system powershell.exe missing");
      spawnFailExit("shell-missing", kTermSetup);
    }
  }
  trace("shell-located");

  std::u16string env16;
  if (!th::buildEnvBlock(spec.env, env16, err)) {
    diag("terminal env block: %s", err.c_str());
    spawnFailExit("env-block", kTermSetup);
  }
  trace("env-block-ok bytes=%llu",
        static_cast<unsigned long long>(env16.size() * sizeof(char16_t)));
  std::u16string cwd16;
  if (!th::utf8ToUtf16(spec.cwd, cwd16)) {
    diag("terminal cwd encoding failure");
    spawnFailExit("cwd-encoding", kTermSetup);
  }
  const std::wstring cwdW = u16ToWide(cwd16);
  std::wstring cmdW = L"\"";
  cmdW += shellW;
  cmdW += L"\" -NoLogo -NoProfile";

  // Job + KILL_ON_JOB_CLOSE — the same boundary as serve/run.
  s.job.reset(CreateJobObjectW(nullptr, nullptr));
  if (!s.job) {
    diag("CreateJobObjectW failed %lu", GetLastError());
    spawnFailExit("job-create", kTermSetup);
  }
  {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim{};
    lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(s.job.get(), JobObjectExtendedLimitInformation,
                                 &lim, sizeof lim)) {
      diag("SetInformationJobObject failed %lu", GetLastError());
      spawnFailExit("job-limits", kTermSetup);
    }
  }
  trace("job-configured");

  // ConPTY pipes: inRd/inWr (we write → conpty) + outRd/outWr (conpty
  // writes → us). After CreatePseudoConsole our copies of the conpty
  // ends close; the console owns its references.
  HANDLE inRd = nullptr, outWr = nullptr;
  {
    HANDLE a = nullptr, b = nullptr;
    if (!CreatePipe(&a, &b, nullptr, 0)) {
      diag("conpty input pipe failed %lu", GetLastError());
      spawnFailExit("conpty-pipe", kTermSetup);
    }
    inRd = a;
    s.ptyInWr.reset(b);
  }
  {
    HANDLE a = nullptr, b = nullptr;
    if (!CreatePipe(&a, &b, nullptr, 0)) {
      CloseHandle(inRd);
      diag("conpty output pipe failed %lu", GetLastError());
      spawnFailExit("conpty-pipe", kTermSetup);
    }
    s.ptyOutRd.reset(a);
    outWr = b;
  }
  trace("pipes-created");
  const COORD size{static_cast<SHORT>(spec.cols),
                   static_cast<SHORT>(spec.rows)};
  // MS doc (creating-a-pseudoconsole-session) closes these AFTER the
  // child CreateProcess; ours close here — documented discrepancy, NOT
  // changed by this instrumentation round.
  trace("conpty-create-begin");
  const HRESULT hr = CreatePseudoConsole(size, inRd, outWr, 0, &s.hpcon);
  trace("conpty-create-end hr=0x%lx", static_cast<unsigned long>(hr));
  CloseHandle(inRd);
  CloseHandle(outWr);
  if (FAILED(hr) || !s.hpcon) {
    diag("CreatePseudoConsole failed 0x%lx", hr);
    spawnFailExit("conpty-create", kTermSetup);
  }
  // hpcon is closed explicitly on a dedicated thread after the Job is
  // proven empty — RAII is deliberately NOT used in the session path;
  // early exits before spawn close it directly below.

  const auto closeHpconNow = [&]() {
    if (!s.hpcon) return;
    HpconClose closer;
    closer.hpcon = s.hpcon;
    s.hpcon = nullptr;
    closer.th = startWorkerThread(&hpconCloseRun, &closer);
    if (!closer.th || !joinBounded(closer.th, kHpconJoinMs)) {
      diag("pre-spawn pseudoconsole close unproven");
      hardExit(kTermCleanup);
    }
  };

  // ONE attribute list carrying BOTH the pseudo console and the Job —
  // the shell's first thread starts inside the Job. A failure to combine
  // them is the documented blocker, never a fallback to plain spawn.
  HANDLE jobH = s.job.get();
  SIZE_T attrSize = 0;
  if (InitializeProcThreadAttributeList(nullptr, 2, 0, &attrSize) == FALSE &&
      GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    diag("attribute list sizing failed %lu", GetLastError());
    closeHpconNow();
    spawnFailExit("attr-list", kTermSetup);
  }
  if (attrSize == 0) {
    diag("attribute list sizing returned zero");
    closeHpconNow();
    spawnFailExit("attr-list", kTermSetup);
  }
  std::vector<uint8_t> attrBuf(attrSize);
  LPPROC_THREAD_ATTRIBUTE_LIST attrList =
      reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrBuf.data());
  if (!InitializeProcThreadAttributeList(attrList, 2, 0, &attrSize)) {
    diag("InitializeProcThreadAttributeList failed %lu", GetLastError());
    closeHpconNow();
    spawnFailExit("attr-list", kTermSetup);
  }
  trace("attr-list-init bytes=%llu",
        static_cast<unsigned long long>(attrSize));
  struct AttrGuard {
    LPPROC_THREAD_ATTRIBUTE_LIST l;
    ~AttrGuard() { if (l) DeleteProcThreadAttributeList(l); }
  } attrGuard{attrList};
  if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                 &jobH, sizeof(HANDLE), nullptr, nullptr)) {
    diag("UpdateProcThreadAttribute(job) failed %lu", GetLastError());
    closeHpconNow();
    spawnFailExit("attr-job", kTermSetup);
  }
  trace("attr-job-set");
  if (!UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                 s.hpcon, sizeof(HPCON), nullptr, nullptr)) {
    diag("UpdateProcThreadAttribute(pseudoconsole) failed %lu", GetLastError());
    closeHpconNow();
    spawnFailExit("attr-conpty", kTermSetup);
  }
  trace("attr-conpty-set");

  STARTUPINFOEXW siex{};
  siex.StartupInfo.cb = sizeof siex;
  // Match node-pty's ConPTY launch: do not carry the host's protocol stdio
  // into the shell. See docs/phase-2k-windows-terminal.md for the source.
  siex.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
  siex.StartupInfo.hStdInput = nullptr;
  siex.StartupInfo.hStdOutput = nullptr;
  siex.StartupInfo.hStdError = nullptr;
  siex.lpAttributeList = attrList;

  // Serialize cancellation with the creation commit. A stop already
  // observed by the control reader must not start a shell afterward.
  AcquireSRWLockExclusive(&s.lock);
  if (s.stopRequested || s.stdinEof || s.protocolBad || s.inputOverflow ||
      s.outOverflow.load() || s.writerDead.load()) {
    ReleaseSRWLockExclusive(&s.lock);
    closeHpconNow();
    spawnFailExit("cancelled-before-spawn", kTermSetup);
  }
  if (WaitForSingleObject(s.owner.get(), 0) != WAIT_TIMEOUT) {
    ReleaseSRWLockExclusive(&s.lock);
    diag("owner died before shell launch — refusing");
    closeHpconNow();
    spawnFailExit("owner-dead", kTermSetup);
  }

  PROCESS_INFORMATION pi{};
  // bInheritHandles FALSE: the pseudo console supplies the child's stdio;
  // no job/owner/pipe handle is inheritable. The child enters the Job via
  // the attribute list — assignment failure IS CreateProcessW failure.
  trace("createprocess-begin");
  if (!CreateProcessW(shellW.c_str(), cmdW.data(), nullptr, nullptr, FALSE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                      const_cast<char16_t*>(env16.data()), cwdW.c_str(),
                      &siex.StartupInfo, &pi)) {
    const DWORD e = GetLastError();
    ReleaseSRWLockExclusive(&s.lock);
    trace("createprocess-failed err=%lu", static_cast<unsigned long>(e));
    diag("CreateProcessW(conpty) failed %lu", e);
    closeHpconNow();
    spawnFailExit("create-process", kTermSpawn);
  }
  ReleaseSRWLockExclusive(&s.lock);
  trace("createprocess-end pid=%lu",
        static_cast<unsigned long>(pi.dwProcessId));
  s.hProcess.reset(pi.hProcess);
  CloseHandle(pi.hThread);  // the shell's handle is tracked by the Job

  {
    char buf[96];
    std::snprintf(buf, sizeof buf, "{\"type\":\"spawned\",\"pid\":%lu}",
                  pi.dwProcessId);
    enqueueLine(s, buf);
  }
  trace("spawned-enqueued");

  // Session workers — a creation failure here is post-launch: the shell
  // already runs, so the only honest path is the unified forced teardown.
  s.thDrain = startWorkerThread(&drainRun, &s);
  if (s.thDrain) trace("worker-start drain");
  s.thInput = startWorkerThread(&inputRun, &s);
  if (s.thInput) trace("worker-start input");
  if (!s.thDrain || !s.thInput) {
    diag("session worker creation failed %lu", GetLastError());
    emitCode(s, "error", "worker-create");
  }

  // ---- watch loop ----------------------------------------------------------
  enum class Why {
    kNone, kNatural, kOwnerDead, kStop, kEof, kProtocol, kCredit,
    kInputOverflow, kOutOverflow, kStallOut, kStallIn, kIoFatal, kDrainLost,
  };
  Why why = Why::kNone;
  DWORD shellExit = 0;
  bool shellCodeKnown = false;

  if (s.thDrain && s.thInput) {
    HANDLE waitSet[5] = {s.hProcess.get(), s.owner.get(), s.controlEv.get(),
                         s.ioFatalEv.get(), s.drainDoneEv.get()};
    trace("watch-entered");
    for (;;) {
      const DWORD r = WaitForMultipleObjects(5, waitSet, FALSE, kWatchSliceMs);
      if (r == WAIT_OBJECT_0) {
        why = Why::kNatural;
        shellCodeKnown =
            GetExitCodeProcess(s.hProcess.get(), &shellExit) != FALSE;
        break;
      }
      if (r == WAIT_OBJECT_0 + 1) { why = Why::kOwnerDead; break; }
      if (r == WAIT_OBJECT_0 + 3) { why = Why::kIoFatal; break; }
      if (r == WAIT_OBJECT_0 + 4) {
        // Drain ended first — output EOF is the NORMAL companion of a
        // shell exit (conhost tears the console down). If the shell is
        // already dead this is still a natural exit; a drain that ends
        // while the shell LIVES means conhost or the pipe died — the
        // session can no longer be observed and is torn down forced.
        if (WaitForSingleObject(s.hProcess.get(), 0) == WAIT_OBJECT_0) {
          why = Why::kNatural;
          shellCodeKnown =
              GetExitCodeProcess(s.hProcess.get(), &shellExit) != FALSE;
        } else {
          why = Why::kDrainLost;
        }
        break;
      }
      if (r == WAIT_FAILED) {
        diag("wait failed %lu", GetLastError());
        why = Why::kIoFatal;
        break;
      }
      // control event (or 100ms slice): drain pending actions + watchdogs
      {
        AcquireSRWLockExclusive(&s.lock);
        if (s.resizePending && s.hpcon) {
          const COORD next = s.resizeNext;
          s.resizePending = false;
          ReleaseSRWLockExclusive(&s.lock);
          // ResizePseudoConsole is advisory — a failure degrades, it does
          // not kill the session.
          if (FAILED(ResizePseudoConsole(s.hpcon, next)))
            emitCode(s, "error", "resize-failed");
        } else {
          ReleaseSRWLockExclusive(&s.lock);
        }
      }
      {
        AcquireSRWLockExclusive(&s.lock);
        if (s.protocolBad) {
          why = Why::kProtocol;
        } else if (s.inputOverflow) {
          why = Why::kInputOverflow;
        } else if (s.outOverflow) {
          why = Why::kOutOverflow;
        } else if (s.stopRequested) {
          why = Why::kStop;
        } else if (s.stdinEof) {
          why = Why::kEof;
        } else if (s.unackedBytes > kUnackedHard) {
          // Defense-in-depth: credit pause caps unacked debt near
          // kUnackedPause, so this bound is only reachable if the pause
          // accounting itself is broken. The reachable "ack debt never
          // returns" failure is bounded by the host's own no-ACK
          // teardown (service watchdog sends stop / closes stdin).
          why = Why::kCredit;
        }
        ReleaseSRWLockExclusive(&s.lock);
      }
      if (why == Why::kNone) {
        const uint64_t now = GetTickCount64();
        if (s.writerBusy.load(std::memory_order_acquire)) {
          const uint64_t t = s.writerTick.load(std::memory_order_relaxed);
          if (now >= t && now - t >= kPumpStallMs) why = Why::kStallOut;
        }
        if (why == Why::kNone && s.inputBusy.load(std::memory_order_acquire)) {
          const uint64_t t = s.inputTick.load(std::memory_order_relaxed);
          if (now >= t && now - t >= kPumpStallMs) why = Why::kStallIn;
        }
      }
      if (why != Why::kNone) break;
    }
  } else {
    // A session worker is missing — the shell runs uncontained by our
    // protocol; forced teardown without a live watch loop.
    trace("watch-skipped workers-missing");
    why = Why::kIoFatal;
  }
  trace("watch-exit why=%d", static_cast<int>(why));

  bool forced = why != Why::kNatural;

  // Surface the non-natural reason BEFORE teardown so the channel knows
  // why the session is ending.
  switch (why) {
    case Why::kOwnerDead: emitCode(s, "error", "owner-dead"); break;
    case Why::kStop: break;  // requested — no error
    case Why::kEof: emitCode(s, "error", "control-eof"); break;
    case Why::kProtocol:
      emitCode(s, "error", s.protocolCode.c_str()); break;
    case Why::kCredit: emitCode(s, "error", "credit-overflow"); break;
    case Why::kInputOverflow: emitCode(s, "error", "input-overflow"); break;
    case Why::kOutOverflow: emitCode(s, "error", "output-overflow"); break;
    case Why::kStallOut: emitCode(s, "error", "stdout-stall"); break;
    case Why::kStallIn: emitCode(s, "error", "input-stall"); break;
    case Why::kIoFatal: emitCode(s, "error", "io-fatal"); break;
    case Why::kDrainLost: emitCode(s, "error", "output-drain-lost"); break;
    default: break;
  }

  // ---- teardown ------------------------------------------------------------
  trace("teardown-begin forced=%d", forced ? 1 : 0);
  // 1. If forced (or forced becomes required by lingering members), the
  //    whole Job dies — including detached/new-group descendants.
  if (!forced) {
    DWORD active = 0;
    if (!jobActiveCount(s.job.get(), active)) {
      diag("job accounting query failed — cleanup unprovable");
      // Attempt the bounded teardown anyway before reporting failure.
      TerminateJobObject(s.job.get(), 1);
      forced = true;
    } else if (active > 0) {
      diag("shell exited with %lu job member(s) still live — terminating",
           static_cast<unsigned long>(active));
      forced = true;
    }
  }
  if (forced && !TerminateJobObject(s.job.get(), 1))
    diag("TerminateJobObject failed %lu — cleanup unprovable", GetLastError());

  // 2. Job-empty proof — bounded ActiveProcesses polling.
  DWORD elapsed = 0;
  bool jobEmpty = false;
  while (elapsed <= kJobEmptyWaitMs) {
    DWORD n = 0;
    if (!jobActiveCount(s.job.get(), n)) {
      diag("job accounting query failed — cleanup state unprovable");
      break;
    }
    if (n == 0) {
      jobEmpty = true;
      break;
    }
    if (forced && !TerminateJobObject(s.job.get(), 1))
      diag("TerminateJobObject retry failed %lu", GetLastError());
    Sleep(kJobEmptyPollMs);
    elapsed += kJobEmptyPollMs;
  }
  trace("job-empty empty=%d ms=%lu", jobEmpty ? 1 : 0,
        static_cast<unsigned long>(elapsed));

  // 3. Input side: stop the writer bounded, then close our write end so
  //    the console sees input EOF. The writer may be parked on its event
  //    (not cancelable by CancelSynchronousIo) — set the flag AND pulse
  //    the event so it wakes to observe the flag.
  if (s.thInput) {
    s.stopInputF.store(true, std::memory_order_release);
    SetEvent(s.inputEv.get());
    if (stopThreadBounded(s.thInput.h, s.stopInputF, kThreadJoinMs) ==
        StopResult::kRefused) {
      diag("input writer refused to die — aborting with live thread");
      hardExit(kTermCleanup);
    }
    s.thInput.reset();
  }
  s.ptyInWr.reset();

  // 4. exit message — emitted once the shell is provably gone (natural
  //    exit) or the Job teardown ran (forced). An unprovable exit code is
  //    null, never a guess.
  {
    DWORD code = shellExit;
    const bool codeProvable =
        forced ? (GetExitCodeProcess(s.hProcess.get(), &code) != FALSE)
               : shellCodeKnown;
    char buf[160];
    if (codeProvable) {
      std::snprintf(buf, sizeof buf,
                    "{\"type\":\"exit\",\"exitCode\":%lu,\"forced\":%s}",
                    static_cast<unsigned long>(code),
                    forced ? "true" : "false");
    } else {
      std::snprintf(buf, sizeof buf,
                    "{\"type\":\"exit\",\"exitCode\":null,\"forced\":%s}",
                    forced ? "true" : "false");
    }
    enqueueLine(s, buf);
    trace("exit-enqueued");
  }

  // 5. Close the pseudo console on a DEDICATED thread — old builds may
  //    block inside ClosePseudoConsole while output drains; the drain
  //    thread is still running and teardown ignores pause.
  s.teardown.store(true, std::memory_order_release);
  SetEvent(s.resumeEv.get());
  HpconClose closer;
  closer.hpcon = s.hpcon;
  s.hpcon = nullptr;
  closer.th = startWorkerThread(&hpconCloseRun, &closer);
  if (closer.th) trace("worker-start hpcon-close");
  if (!closer.th) {
    diag("hpcon-close thread creation failed — console left unclosed");
    // The handle leaks until process exit — a real cleanup gap: report
    // cleanup honestly and exit 4 after the drains finish below.
  }

  // 6. Drain ConPTY output to real EOF within the bound. The hpcon close
  //    runs concurrently — its close is what makes the output pipe EOF.
  bool drainClean = false;
  if (s.thDrain) {
    if (WaitForSingleObject(s.drainDoneEv.get(), kDrainWaitMs) !=
        WAIT_OBJECT_0) {
      diag("conpty output drain exceeded %lu ms — cancelling",
           static_cast<unsigned long>(kDrainWaitMs));
      if (stopThreadBounded(s.thDrain.h, s.stopDrainF, kThreadJoinMs) ==
          StopResult::kRefused) {
        diag("drain thread refused to die — aborting");
        hardExit(kTermCleanup);
      }
      s.thDrain.reset();
    } else if (!joinBounded(s.thDrain, kThreadJoinMs)) {
      diag("drain completion event preceded an unjoined worker");
      hardExit(kTermCleanup);
    }
    drainClean = s.drainWhy.load(std::memory_order_acquire) == 1;
  }

  // 7. ClosePseudoConsole bounded join — a refusal means the kernel-side
  //    console state is unprovable; storage is process-lifetime so the
  //    honest exit is a hard 4 after reporting.
  bool hpconClosed = true;
  if (closer.th) {
    if (!joinBounded(closer.th, kHpconJoinMs)) {
      diag("ClosePseudoConsole did not return within %lu ms",
           static_cast<unsigned long>(kHpconJoinMs));
      hpconClosed = false;
    }
  } else {
    hpconClosed = false;
  }

  // 8. cleanup message — reclamation and output completeness are SEPARATE
  //    claims: jobEmpty proves the tree is gone; outputComplete proves no
  //    produced byte was dropped or truncated.
  const bool outputComplete =
      drainClean && !s.outOverflow.load() && !s.inputDead.load() &&
      !s.writerDead.load();
  {
    char buf[192];
    std::snprintf(
        buf, sizeof buf,
        "{\"type\":\"cleanup\",\"jobEmpty\":%s,\"outputComplete\":%s}",
        jobEmpty ? "true" : "false", outputComplete ? "true" : "false");
    enqueueLine(s, buf);
    trace("cleanup-enqueued jobEmpty=%d outComplete=%d", jobEmpty ? 1 : 0,
          outputComplete ? 1 : 0);
  }

  // 9. Flush the protocol queue, then stop/join the remaining workers.
  //    The writer may be parked on its event or mid-WriteFile — pulse the
  //    event so it observes the flag; cancel covers the blocked write.
  {
    AcquireSRWLockExclusive(&s.lock);
    s.stopWriterF.store(true, std::memory_order_release);
    ReleaseSRWLockExclusive(&s.lock);
  }
  SetEvent(s.outEv.get());
  const bool protocolFlushed = joinBounded(s.thWriter, kWriterFlushMs) &&
                               !s.writerDead.load() && !s.outOverflow.load();
  if (!protocolFlushed &&
      stopThreadBounded(s.thWriter.h, s.stopWriterF, kThreadJoinMs) ==
          StopResult::kRefused) {
    diag("protocol writer refused to die — aborting");
    hardExit(kTermCleanup);
  }
  if (stopThreadBounded(s.thReader.h, s.stopReaderF, kThreadJoinMs) ==
      StopResult::kRefused) {
    diag("control reader refused to die — aborting");
    hardExit(kTermCleanup);
  }

  // ---- exit class ------------------------------------------------------------
  if (!protocolFlushed) {
    diag("terminal protocol did not flush completely");
    termExit(kTermCleanup);
  }
  if (!jobEmpty) {
    diag("job not proven empty — cleanup unclaimed");
    termExit(kTermCleanup);
  }
  if (!hpconClosed) {
    diag("pseudoconsole close unproven");
    termExit(kTermCleanup);
  }
  if (!forced && (!shellCodeKnown || !outputComplete)) {
    diag(!shellCodeKnown ? "shell exit code unprovable"
                         : "output incomplete on a natural exit");
    termExit(kTermCleanup);
  }
  if (forced) {
    diag("terminal session ended forced (reason-class recorded upstream)");
    termExit(kTermForced);
  }
  termExit(kTermOk);
}

}  // namespace tht
