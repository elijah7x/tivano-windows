// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// See helper_win32.hpp — semantics identical to the implementations that
// previously lived in tivano-job-helper.cpp's anonymous namespace.

#include "helper_win32.hpp"

#include <cstdarg>
#include <cstdio>
#include <cstdlib>

// ---- Diag -------------------------------------------------------------------

bool Diag::start() {
  ev_.reset(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  if (!ev_) return false;
  th_ = startWorkerThread(&Diag::run, this);
  return th_.get() != nullptr;
}

void Diag::line(const std::string& s) {
  {
    AcquireSRWLockExclusive(&lock_);
    if (q_.size() < 64) {
      q_.push_back("tivano-job-helper: " + s);
    } else {
      dropped_.fetch_add(1, std::memory_order_relaxed);
    }
    ReleaseSRWLockExclusive(&lock_);
  }
  SetEvent(ev_.get());
}

void Diag::stop(DWORD joinMs) {
  const unsigned dropped = dropped_.load(std::memory_order_relaxed);
  if (dropped) {
    AcquireSRWLockExclusive(&lock_);
    q_.push_back("tivano-job-helper: diagnostics dropped");
    ReleaseSRWLockExclusive(&lock_);
  }
  stopping_.store(true, std::memory_order_release);
  SetEvent(ev_.get());
  if (!th_) return;
  if (WaitForSingleObject(th_.get(), joinMs) == WAIT_OBJECT_0) {
    CloseHandle(th_.release());
  }
  // else: writer still blocked — caller must NOT touch q_/lock_ again and
  // the exit path must be a hard ExitProcess, not stack unwind.
}

unsigned __stdcall Diag::run(void* self) {
  auto* d = static_cast<Diag*>(self);
  const HANDLE out = GetStdHandle(STD_ERROR_HANDLE);
  for (;;) {
    WaitForSingleObject(d->ev_.get(), INFINITE);
    for (;;) {
      std::string s;
      {
        AcquireSRWLockExclusive(&d->lock_);
        if (!d->q_.empty()) {
          s = std::move(d->q_.front());
          d->q_.pop_front();
        }
        const bool done = d->stopping_.load(std::memory_order_acquire);
        ReleaseSRWLockExclusive(&d->lock_);
        if (s.empty() && done) return 0;
        if (s.empty()) break;
      }
      s.push_back('\n');
      DWORD off = 0;
      while (out && out != INVALID_HANDLE_VALUE &&
             off < static_cast<DWORD>(s.size())) {
        DWORD w = 0;
        if (!WriteFile(out, s.data() + off,
                       static_cast<DWORD>(s.size()) - off, &w, nullptr) ||
            w == 0)
          break;  // full/broken pipe — errors just drop the line
        off += w;
      }
    }
    if (d->stopping_.load(std::memory_order_acquire)) {
      AcquireSRWLockExclusive(&d->lock_);
      const bool drained = d->q_.empty();
      ReleaseSRWLockExclusive(&d->lock_);
      if (drained) return 0;
    }
  }
}

Diag g_diag;
void diag(const char* fmt, ...) {
  char buf[448];
  va_list ap;
  va_start(ap, fmt);
  const int n = std::vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  buf[sizeof buf - 1] = '\0';
  g_diag.line(buf);
}

[[noreturn]] void finalExit(int code) {
  g_diag.stop(500);
  if (g_diag.writerStuck()) ExitProcess(code);
  std::exit(code);
}

// ---- threads ----------------------------------------------------------------

Handle startWorkerThread(unsigned(__stdcall* fn)(void*), void* arg) {
  unsigned tid = 0;
  return Handle(reinterpret_cast<HANDLE>(
      _beginthreadex(nullptr, 0, fn, arg, 0, &tid)));
}

StopResult stopThreadBounded(HANDLE& th, std::atomic<bool>& stop, DWORD joinMs) {
  stop.store(true, std::memory_order_release);
  if (!th) return StopResult::kJoined;
  const DWORD slice = joinMs < 4 ? 1 : joinMs / 4;
  for (int i = 0; i < 4; i++) {
    if (WaitForSingleObject(th, 0) == WAIT_OBJECT_0) {
      CloseHandle(th);
      th = nullptr;  // handle consumed — never double-close
      return StopResult::kJoined;
    }
    CancelSynchronousIo(th);  // only THIS thread's sync I/O
    if (WaitForSingleObject(th, slice) == WAIT_OBJECT_0) {
      CloseHandle(th);
      th = nullptr;
      return StopResult::kJoined;
    }
  }
  return StopResult::kRefused;
}

bool joinBounded(Handle& th, DWORD ms) {
  if (!th) return true;
  if (WaitForSingleObject(th.get(), ms) != WAIT_OBJECT_0) return false;
  th.reset();
  return true;
}

// ---- pipes / owner / job ----------------------------------------------------

bool isPeerClosedError(DWORD e) {
  return e == ERROR_BROKEN_PIPE || e == ERROR_NO_DATA ||
         e == ERROR_PIPE_NOT_CONNECTED;
}

bool makePipePair(Handle& parentEnd, Handle& childEnd, bool parentReads) {
  HANDLE a = nullptr, b = nullptr;
  if (!CreatePipe(&a, &b, nullptr, 0)) return false;  // non-inheritable
  if (parentReads) {
    parentEnd.reset(a);
    childEnd.reset(b);
  } else {
    parentEnd.reset(b);
    childEnd.reset(a);
  }
  return SetHandleInformation(childEnd.get(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) != 0;
}

bool actualParentPid(uint32_t& pidOut) {
  Handle snap(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snap) return false;
  PROCESSENTRY32W pe{};
  pe.dwSize = sizeof pe;
  if (!Process32FirstW(snap.get(), &pe)) return false;
  const DWORD self = GetCurrentProcessId();
  do {
    if (pe.th32ProcessID == self) {
      pidOut = pe.th32ParentProcessID;
      return pidOut != 0;
    }
  } while (Process32NextW(snap.get(), &pe));
  return false;
}

bool openVerifiedOwner(uint32_t claimedPid, Handle& owner) {
  uint32_t parent = 0;
  if (!actualParentPid(parent)) return false;
  if (claimedPid != parent || claimedPid == 0 ||
      claimedPid == GetCurrentProcessId())
    return false;
  Handle h(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                       FALSE, claimedPid));
  if (!h) return false;
  FILETIME ownerCt{}, exitT{}, kern{}, user{};
  FILETIME selfCt{};
  if (!GetProcessTimes(h.get(), &ownerCt, &exitT, &kern, &user))
    return false;
  if (!GetProcessTimes(GetCurrentProcess(), &selfCt, &exitT, &kern, &user))
    return false;
  if (CompareFileTime(&ownerCt, &selfCt) > 0)
    return false;  // "owner" younger than us → pid reuse, not our parent
  if (WaitForSingleObject(h.get(), 0) != WAIT_TIMEOUT)
    return false;  // already dead — nothing is driving the session
  owner = std::move(h);
  return true;
}

bool jobActiveCount(HANDLE job, DWORD& count) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
  if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                 &info, sizeof info, nullptr))
    return false;
  count = static_cast<DWORD>(info.ActiveProcesses);
  return true;
}

std::wstring u16ToWide(const std::u16string& s) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t), "Windows wchar_t must be 16-bit");
  return std::wstring(reinterpret_cast<const wchar_t*>(s.data()), s.size());
}
