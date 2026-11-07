// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// terminal-fixture — Windows-only TEST payload for the ConPTY terminal
// harness (tests/windows/terminal-harness.mjs). NEVER shipped. The
// terminal helper launches a FIXED system shell; this fixture is what the
// harness types into that shell to prove Job membership, isolation and
// console attachment — each command is launched BY the interactive shell
// inside the Job, so what it observes is real descendant state.
//
// Subcommands (Unicode console text; redirected text uses UTF-8):
//   marker <file>              → append "PID:<pid>:<creationQuad>:INJOB:<0|1>:PARENT:<ppid>"
//                                — IsProcessInJob(self,NULL) is the
//                                controlled native membership query; a
//                                job-fixture marker line alone only
//                                proves identity, this line proves it.
//   marker-linger <file> <ms>  → marker first, then Sleep(ms) — the live
//                                descendant that must die with the Job.
//   parent                     → "PPID:<parent-pid>" (Toolhelp snapshot)
//   console                    → "CONSOLE:<pid>" per GetConsoleProcessList
//                                entry — which processes share OUR
//                                pseudoconsole (shell + this fixture).
//   getenv <name>              → value or "<absent>"
//   cwd                        → physical current directory
//   echo                       → byte-copy stdin→stdout until EOF
//   exit <code>                → ExitProcess(code)
//   unicode                    → one fixed UTF-8 line (CJK + accent +
//                                emoji + combining) for the codec check
//   canary <file> <ms>         → heartbeat "TICK:<n>" every 100 ms for ms —
//                                run OUTSIDE the session by the harness:
//                                a survivor proves no stray kill
//   waitfile <file> <ms>       → poll until <file> exists (release gate)
//   breakaway <file>           → attempt CreateProcessW(self "marker
//                                <file>") with CREATE_BREAKAWAY_FROM_JOB.
//                                Prints BREAKAWAY:DENIED:<code> when the
//                                Job refuses (expected — the terminal
//                                Job is not breakaway-permissive) or
//                                BREAKAWAY:ALLOWED when it went through;
//                                an allowed child's own INJOB marker is
//                                the definitive containment evidence.
//
// Exit codes: 0 ok · 64 usage · 65 marker/file failure · 66 write failure
// · 69 waitfile timeout.

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
#include <tlhelp32.h>

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

bool writeAll(HANDLE h, const char* data, DWORD n) {
  DWORD off = 0;
  while (off < n) {
    DWORD w = 0;
    if (!WriteFile(h, data + off, n - off, &w, nullptr) || w == 0) return false;
    off += w;
  }
  return true;
}

bool out(const char* fmt, ...) {
  char buf[1024];
  va_list ap;
  va_start(ap, fmt);
  const int n = std::vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (n <= 0) return false;
  const DWORD len = static_cast<DWORD>(
      n < static_cast<int>(sizeof buf) ? n : static_cast<int>(sizeof buf) - 1);
  return writeAll(GetStdHandle(STD_OUTPUT_HANDLE), buf, len);
}

bool wout(const std::wstring& s) {
  if (s.empty()) return true;
  const HANDLE handle = GetStdHandle(STD_OUTPUT_HANDLE);
  DWORD mode = 0;
  // Console byte writes use the active OEM code page, not ConPTY's UTF-8
  // transport. WriteConsoleW avoids changing the shared console code page.
  // https://learn.microsoft.com/en-us/windows/console/writeconsole
  if (GetConsoleMode(handle, &mode)) {
    size_t offset = 0;
    while (offset < s.size()) {
      const size_t remaining = s.size() - offset;
      const DWORD count = static_cast<DWORD>(remaining < 4096 ? remaining : 4096);
      DWORD written = 0;
      if (!WriteConsoleW(handle, s.data() + offset, count, &written, nullptr) ||
          written == 0 || written > count) return false;
      offset += written;
    }
    return true;
  }
  const int need = WideCharToMultiByte(CP_UTF8, 0, s.data(),
                                       static_cast<int>(s.size()), nullptr, 0,
                                       nullptr, nullptr);
  if (need <= 0) return false;
  std::vector<char> buf(static_cast<size_t>(need));
  if (WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                          buf.data(), need, nullptr, nullptr) != need)
    return false;
  return writeAll(GetStdHandle(STD_OUTPUT_HANDLE), buf.data(),
                  static_cast<DWORD>(buf.size()));
}

DWORD parentPid() {
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W pe{};
  pe.dwSize = sizeof pe;
  DWORD parent = 0;
  const DWORD self = GetCurrentProcessId();
  if (Process32FirstW(snap, &pe)) {
    do {
      if (pe.th32ProcessID == self) {
        parent = pe.th32ParentProcessID;
        break;
      }
    } while (Process32NextW(snap, &pe));
  }
  CloseHandle(snap);
  return parent;
}

// "PID:<pid>:<creationQuad>:INJOB:<0|1>:PARENT:<ppid>" — creation stamp
// for pid-reuse-safe liveness PLUS the controlled membership query.
bool writeMarker(const wchar_t* path) {
  HANDLE f = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                         OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  FILETIME created{}, exitT{}, kern{}, user{};
  ULARGE_INTEGER ct{};
  bool ok = GetProcessTimes(GetCurrentProcess(), &created, &exitT, &kern, &user) != FALSE;
  ct.LowPart = created.dwLowDateTime;
  ct.HighPart = created.dwHighDateTime;
  BOOL inJob = FALSE;
  // NULL job handle = "is this process a member of ANY job" — the
  // controlled native query the harness requires for descendant proof.
  const BOOL jobOk = IsProcessInJob(GetCurrentProcess(), nullptr, &inJob);
  char line[160];
  const int n = std::snprintf(
      line, sizeof line, "PID:%lu:%llu:INJOB:%d:PARENT:%lu\n",
      GetCurrentProcessId(), static_cast<unsigned long long>(ct.QuadPart),
      (jobOk && inJob) ? 1 : 0, parentPid());
  ok = ok && n > 0;
  if (ok) {
    DWORD w;
    ok = WriteFile(f, line, static_cast<DWORD>(n), &w, nullptr) &&
         w == static_cast<DWORD>(n);
  }
  CloseHandle(f);
  return ok;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return 64;
  const std::wstring mode = argv[1];

  if (mode == L"marker" && argc >= 3)
    return writeMarker(argv[2]) ? 0 : 65;

  if (mode == L"marker-linger" && argc >= 4) {
    if (!writeMarker(argv[2])) return 65;
    Sleep(static_cast<DWORD>(_wtoi(argv[3])));
    return 0;
  }

  if (mode == L"parent") {
    return out("PPID:%lu\n", parentPid()) ? 0 : 66;
  }

  if (mode == L"console") {
    // Which processes share OUR console — on ConPTY this is the shell
    // and this fixture, attached to the pseudoconsole, nothing else.
    DWORD pids[64];
    const DWORD n = GetConsoleProcessList(pids, 64);
    if (n == 0) return 65;
    for (DWORD i = 0; i < n && i < 64; i++)
      if (!out("CONSOLE:%lu\n", pids[i])) return 66;
    return 0;
  }

  if (mode == L"getenv" && argc == 3) {
    wchar_t buf[8192];
    const DWORD n = GetEnvironmentVariableW(argv[2], buf, 8192);
    if (n == 0) return out("<absent>\n") ? 0 : 66;
    if (n >= 8192) return 65;
    return (wout(std::wstring(buf, n)) && wout(L"\n")) ? 0 : 66;
  }

  if (mode == L"cwd") {
    wchar_t buf[4096];
    const DWORD n = GetCurrentDirectoryW(4096, buf);
    if (n == 0 || n >= 4096) return 65;
    return (wout(std::wstring(buf, n)) && wout(L"\n")) ? 0 : 66;
  }

  if (mode == L"echo") {
    char buf[8192];
    DWORD n;
    while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), buf, sizeof buf, &n,
                    nullptr) && n) {
      if (!writeAll(GetStdHandle(STD_OUTPUT_HANDLE), buf, n)) return 66;
    }
    return 0;
  }

  if (mode == L"exit" && argc == 3) return _wtoi(argv[2]);

  if (mode == L"unicode") {
    // The harness checks rendered CJK and ASCII; ConPTY may normalize
    // combining/astral cells, so byte identity is not required.
    return wout(L"ascii-ok e\u0301 \u4e2d\u6587\U0001F31F\n") ? 0 : 66;
  }

  if (mode == L"canary" && argc >= 4) {
    const DWORD ms = static_cast<DWORD>(_wtoi(argv[3]));
    DWORD t = 0, tick = 0;
    while (t < ms) {
      HANDLE f = CreateFileW(argv[2], FILE_APPEND_DATA, FILE_SHARE_READ,
                             nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                             nullptr);
      if (f == INVALID_HANDLE_VALUE) return 65;
      char line[32];
      const int n = std::snprintf(line, sizeof line, "TICK:%lu\n", tick++);
      DWORD w;
      WriteFile(f, line, static_cast<DWORD>(n), &w, nullptr);
      CloseHandle(f);
      Sleep(100);
      t += 100;
    }
    return 0;
  }

  if (mode == L"waitfile" && argc >= 4) {
    const DWORD ms = static_cast<DWORD>(_wtoi(argv[3]));
    for (DWORD waited = 0; waited < ms; waited += 100) {
      if (GetFileAttributesW(argv[2]) != INVALID_FILE_ATTRIBUTES) return 0;
      Sleep(100);
    }
    return 69;
  }

  if (mode == L"breakaway" && argc >= 3) {
    // Attempt to spawn THIS binary's marker mode with
    // CREATE_BREAKAWAY_FROM_JOB. A Job without BREAKAWAY_OK denies the
    // flag outright; if it were silently honoured the child's own INJOB
    // marker would read 0 — either way the evidence is explicit.
    wchar_t self[MAX_PATH];
    const DWORD selfChars = GetModuleFileNameW(nullptr, self, MAX_PATH);
    if (selfChars == 0 || selfChars >= MAX_PATH) return 65;
    std::wstring cmd = L"\"";
    cmd += self;
    cmd += L"\" marker \"";
    cmd += argv[2];
    cmd += L"\"";
    STARTUPINFOW si{};
    si.cb = sizeof si;
    PROCESS_INFORMATION pi{};
    const BOOL ok = CreateProcessW(self, cmd.data(), nullptr, nullptr,
                                   FALSE, CREATE_BREAKAWAY_FROM_JOB,
                                   nullptr, nullptr, &si, &pi);
    if (!ok) {
      const DWORD e = GetLastError();
      return out("BREAKAWAY:DENIED:%lu\n", e) ? 0 : 66;
    }
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return out("BREAKAWAY:ALLOWED\n") ? 0 : 66;
  }

  return 64;
}
