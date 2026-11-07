// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// helper_win32 — shared Win32-only utilities used by EVERY helper mode
// (--serve, --run, --terminal): the RAII handle, the bounded diagnostics
// writer, verified-owner opening, job-empty accounting, pipe creation and
// bounded thread-stop discipline. Semantics are IDENTICAL to the code that
// lived in tivano-job-helper.cpp's anonymous namespace; extraction gives
// the terminal mode the same proven primitives instead of a second copy.
//
// NOT portable — requires windows.h. The portable schema/encoding layer
// stays in helper_common.
//
#pragma once

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

#include <atomic>
#include <cstdint>
#include <deque>
#include <string>

// ---- RAII handle ------------------------------------------------------------
struct Handle {
  HANDLE h = nullptr;
  Handle() = default;
  explicit Handle(HANDLE v) : h(v) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& o) noexcept : h(o.h) { o.h = nullptr; }
  Handle& operator=(Handle&& o) noexcept {
    reset();
    h = o.h;
    o.h = nullptr;
    return *this;
  }
  void reset(HANDLE v = nullptr) {
    if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h);
    h = v;
  }
  HANDLE get() const { return h; }
  explicit operator bool() const { return h != nullptr && h != INVALID_HANDLE_VALUE; }
  HANDLE release() {
    HANDLE v = h;
    h = nullptr;
    return v;
  }
};

// ---- diagnostics ------------------------------------------------------------
// Blocking WriteFile to an inherited stderr pipe must never stall the
// lifecycle thread. Diag lines (<=512 chars, <=64 queued, drops counted)
// go to a dedicated writer thread; lifecycle only enqueues.
class Diag {
 public:
  bool start();
  void line(const std::string& s);
  // Enqueue a final line, wait briefly for the writer to flush, then stop.
  // If the writer is blocked on a full stderr pipe it keeps running; the
  // caller's hard-exit path (or process teardown) reclaims it — storage
  // must outlive it, so `this` is never destructed before join-or-exit.
  void stop(DWORD joinMs);
  bool writerStuck() const { return th_.get() != nullptr; }

 private:
  static unsigned __stdcall run(void* self);

  SRWLOCK lock_ = SRWLOCK_INIT;
  std::deque<std::string> q_;
  std::atomic<unsigned> dropped_{0};
  std::atomic<bool> stopping_{false};
  Handle ev_;
  Handle th_;
};

extern Diag g_diag;
void diag(const char* fmt, ...);

// Uniform exit: flush diagnostics bounded; if the writer is still stuck
// on a full stderr pipe the ONLY honest exit is ExitProcess — returning
// would destruct queue/lock storage a live thread still uses.
[[noreturn]] void finalExit(int code);

// ---- threads ----------------------------------------------------------------
enum class StopResult { kJoined, kRefused };

// Spawn a CRT worker on its own thread. Empty Handle = creation failed —
// never detach-and-hope.
Handle startWorkerThread(unsigned(__stdcall* fn)(void*), void* arg);

// Bounded stop: set the caller's stop flag, then RETRY
// CancelSynchronousIo on OUR OWN thread handle — one cancel can race the
// worker entering its NEXT blocking I/O, so it is re-issued until the
// worker is observed dead or the total bound expires. kRefused means the
// thread still owns its handle — storage it touches must never be
// destructed; the caller turns this into a hard-exit failure.
StopResult stopThreadBounded(HANDLE& th, std::atomic<bool>& stop, DWORD joinMs);

// Bounded join with no cancel — for workers expected to end on their own
// (e.g. a drain that already reached EOF, the hpcon-close thread).
bool joinBounded(Handle& th, DWORD ms);

// ---- pipes / owner / job ----------------------------------------------------
// A CLOSED PEER is EOF-class; ERROR_INVALID_HANDLE is a real error — a
// handle we still own being invalid is a lifecycle bug, never EOF.
bool isPeerClosedError(DWORD e);

// Non-inheritable parent end + inheritable child end. parentReads=true →
// parentEnd is the read side (output pipes); false → write side (input).
bool makePipePair(Handle& parentEnd, Handle& childEnd, bool parentReads);

// Owner identity: spec.ownerPid must equal OUR REAL PARENT in the kernel
// process table (the process whose death means nobody is driving the
// session). The opened handle pins the process OBJECT so later PID reuse
// cannot redirect the wait. Both creation stamps are used: an "owner"
// created after this helper is a reused pid, not the launcher; an owner
// already dead/signaled is no driver.
bool actualParentPid(uint32_t& pidOut);
bool openVerifiedOwner(uint32_t claimedPid, Handle& owner);

// Job-empty proof via ActiveProcesses — bounded query, no process-ID
// list sizing problem, definitive count.
bool jobActiveCount(HANDLE job, DWORD& count);

// char16_t → wchar_t (static_assert'ed identical width on Windows).
std::wstring u16ToWide(const std::u16string& s);
