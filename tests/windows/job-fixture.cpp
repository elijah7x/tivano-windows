// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// job-fixture — Windows-only TEST payload for the job-helper harness
// (tests/windows/helper-harness.mjs). NEVER shipped: it exists so the
// harness can prove tree cleanup, quoting, env isolation and backpressure
// against real descendants. Every line it prints is deterministic.
//
// All stdout/stderr bytes are EXPLICIT UTF-8 (WideCharToMultiByte +
// complete writes) — no CRT locale assumptions; the Node harness decodes
// UTF-8.
//
// Subcommands:
//   pid                        → "PID:<pid>" then exit 0
//   echo                       → byte-copy stdin→stdout until EOF
//   args                       → "ARG<i>=<arg>" per argv[i≥1]
//   printenv                   → every env var "K=V" sorted, one per line
//   getenv <name>              → value or "<absent>"
//   cwd                        → physical current directory, one line
//   exit <code>                → ExitProcess(code)
//   ignore-stdin <ms>          → never touch stdin; print ticks for <ms>
//   flood <bytes>              → <bytes> to stdout AND <bytes> to stderr
//   linger <ms> [marker]       → "PID:<pid>", Sleep(ms), exit 0
//   spawn <depth> [marker]     → CreateProcessW(self depth-1); print
//                                "SPAWNED:<pid>"; linger until child exits
//   spawn-breakaway <depth> [m]→ same but with breakaway/detached flags —
//                                inside a no-breakaway Job this MUST fail;
//                                prints "REFUSED:<err>" or "SPAWNED:<pid>"
//   spawn-and-exit <depth> [m] → spawn child then exit immediately,
//                                leaving live descendants in the Job.
//   spawn-gate <depth> <marker> <releaseFile>
//                              → like spawn (waits on the child chain)
//                                but the root polls <releaseFile> (100ms,
//                                up to 60s): when the file EXISTS the
//                                root exits 0 — deterministic "tree
//                                ready THEN root exits" for the
//                                payload-exits-descendants-live case.
//   envraw                     → GetEnvironmentStrings in BLOCK ORDER
//                                (no resort) — proves the exact ordering
//                                the launcher's env block delivered.
//   Every spawn-mode process appends "PID:<pid>:<creationTimeQuadPart>"
//   to the optional marker file AT ITS OWN START — before spawning any
//   child — so the marker count is itself the readiness signal and each
//   identity carries its creation stamp for PID-reuse-safe liveness
//   checks. Descendants have no usable stdio: the file is the only way
//   the harness learns their identities.

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

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

std::wstring selfPath() {
  wchar_t buf[4096];
  DWORD n = GetModuleFileNameW(nullptr, buf, 4096);
  return n ? std::wstring(buf, n) : std::wstring();
}

std::wstring quoteArg(const std::wstring& a) {
  std::wstring out = L"\"";
  size_t i = 0;
  while (i < a.size()) {
    size_t s = 0;
    while (i < a.size() && a[i] == L'\\') { s++; i++; }
    if (i == a.size()) out.append(s * 2, L'\\');
    else if (a[i] == L'"') { out.append(s * 2 + 1, L'\\'); out += L'"'; i++; }
    else { out.append(s, L'\\'); out += a[i]; i++; }
  }
  out += L'"';
  return out;
}

DWORD spawnSelf(const std::wstring& args, DWORD extraFlags, HANDLE& proc) {
  std::wstring cmd = quoteArg(selfPath()) + L" " + args;
  STARTUPINFOW si{};
  si.cb = sizeof si;
  PROCESS_INFORMATION pi{};
  DWORD flags = CREATE_UNICODE_ENVIRONMENT | extraFlags;
  if (!CreateProcessW(selfPath().c_str(), cmd.data(), nullptr, nullptr, FALSE,
                      flags, nullptr, nullptr, &si, &pi))
    return GetLastError();
  CloseHandle(pi.hThread);
  proc = pi.hProcess;
  return 0;
}

// Write ALL bytes — WriteFile is not guaranteed to take the whole buffer.
bool writeAll(HANDLE h, const char* data, DWORD n) {
  DWORD off = 0;
  while (off < n) {
    DWORD w = 0;
    if (!WriteFile(h, data + off, n - off, &w, nullptr) || w == 0) return false;
    off += w;
  }
  return true;
}

// ASCII printf → stdout (format content is ASCII-only).
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

// Wide string → UTF-8 bytes → stdout. The ONLY way wide content (args,
// env values, paths) reaches the harness — the default C locale is never
// trusted to encode anything.
bool wout(const std::wstring& s) {
  if (s.empty()) return true;
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

bool woutLine(const std::wstring& s) {
  return wout(s) && wout(L"\n");
}

// "PID:<pid>:<creation-quadpart>" appended to the marker file. Creation
// identity is recorded at OUR OWN start — before anything else — so the
// harness never depends on an arbitrary sleep for readiness. A marker
// write that cannot land is a FIXTURE FAILURE (return 65): a missed
// record must never masquerade as "not yet spawned".
bool writeMarker(const wchar_t* path) {
  HANDLE f = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                         OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return false;
  FILETIME created{}, exitT{}, kern{}, user{};
  ULARGE_INTEGER ct{};
  if (!GetProcessTimes(GetCurrentProcess(), &created, &exitT, &kern, &user)) {
    CloseHandle(f);
    return false;
  }
  ct.LowPart = created.dwLowDateTime;
  ct.HighPart = created.dwHighDateTime;
  char line[96];
  const int n = std::snprintf(line, sizeof line, "PID:%lu:%llu\n",
                              GetCurrentProcessId(),
                              static_cast<unsigned long long>(ct.QuadPart));
  bool ok = n > 0;
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
  if (mode == L"pid") {
    out("PID:%lu\n", GetCurrentProcessId());
    return 0;
  }
  if (mode == L"echo") {
    char buf[8192];
    DWORD n;
    while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), buf, sizeof buf, &n, nullptr) && n) {
      if (!writeAll(GetStdHandle(STD_OUTPUT_HANDLE), buf, n)) return 66;
    }
    return 0;
  }
  if (mode == L"args") {
    for (int i = 2; i < argc; i++) {
      wchar_t head[32];
      std::swprintf(head, 32, L"ARG%d=", i - 2);
      if (!wout(head) || !wout(argv[i]) || !wout(L"\n")) return 66;
    }
    return 0;
  }
  if (mode == L"printenv") {
    LPWCH env = GetEnvironmentStringsW();
    if (!env) return 65;
    std::vector<std::wstring> lines;
    for (LPWCH p = env; *p; p += wcslen(p) + 1) lines.emplace_back(p);
    FreeEnvironmentStringsW(env);
    std::sort(lines.begin(), lines.end());
    for (auto& l : lines) {
      if (!wout(l) || !wout(L"\n")) return 66;
    }
    return 0;
  }
  if (mode == L"getenv" && argc == 3) {
    wchar_t buf[8192];
    DWORD n = GetEnvironmentVariableW(argv[2], buf, 8192);
    if (n == 0) out("<absent>\n");
    else woutLine(std::wstring(buf, n));
    return 0;
  }
  if (mode == L"envraw") {
    // The environment block in DELIVERED order — no re-sorting: this is
    // what the launcher's serialized block actually handed the process.
    LPWCH env = GetEnvironmentStringsW();
    if (!env) return 65;
    bool ok = true;
    for (LPWCH p = env; *p && ok; p += wcslen(p) + 1)
      ok = wout(p) && wout(L"\n");
    FreeEnvironmentStringsW(env);
    return ok ? 0 : 66;
  }
  if (mode == L"cwd") {
    wchar_t buf[4096];
    DWORD n = GetCurrentDirectoryW(4096, buf);
    if (n == 0) return 65;
    woutLine(std::wstring(buf, n));
    return 0;
  }
  if (mode == L"exit" && argc == 3) return _wtoi(argv[2]);
  if (mode == L"ignore-stdin" && (argc == 3 || argc == 4)) {
    if (argc == 4 && !writeMarker(argv[3])) return 65;
    const DWORD ms = static_cast<DWORD>(_wtoi(argv[2]));
    out("PID:%lu\n", GetCurrentProcessId());
    DWORD t = 0;
    while (t < ms) { out("tick\n"); Sleep(50); t += 50; }
    return 0;
  }
  if (mode == L"flood" && (argc == 3 || argc == 4)) {
    if (argc == 4 && !writeMarker(argv[3])) return 65;
    const size_t total = static_cast<size_t>(_wtoll(argv[2]));
    std::vector<char> chunk(16384, 'x');
    HANDLE o = GetStdHandle(STD_OUTPUT_HANDLE), e = GetStdHandle(STD_ERROR_HANDLE);
    size_t sent = 0;
    while (sent < total) {
      DWORD want = static_cast<DWORD>(std::min(chunk.size(), total - sent));
      if (!writeAll(o, chunk.data(), want)) return 66;
      if (!writeAll(e, chunk.data(), want)) return 67;
      sent += want;
    }
    return 0;
  }
  if (mode == L"linger" && argc >= 3) {
    out("PID:%lu\n", GetCurrentProcessId());
    Sleep(static_cast<DWORD>(_wtoi(argv[2])));
    return 0;
  }
  if (mode == L"marker" && argc >= 3) {
    if (!writeMarker(argv[2])) return 65;
    const DWORD ms = argc >= 4 ? static_cast<DWORD>(_wtoi(argv[3])) : 30000;
    out("PID:%lu\n", GetCurrentProcessId());
    Sleep(ms);
    return 0;
  }
  if (mode == L"spawn-gate" && argc >= 5) {
    // Readiness-and-release handshake: record our marker, spawn the
    // ordinary waiting chain, then poll the release file — the harness
    // touches it only AFTER every descendant marker exists.
    if (!writeMarker(argv[3])) return 65;
    out("PID:%lu\n", GetCurrentProcessId());
    const int depth = _wtoi(argv[2]);
    if (depth > 0) {
      HANDLE child = nullptr;
      const DWORD err = spawnSelf(
          L"spawn " + std::to_wstring(depth - 1) + L" " + quoteArg(argv[3]),
          0, child);
      if (err) { out("REFUSED:%lu\n", err); return 68; }
      out("SPAWNED:%lu\n", GetProcessId(child));
      CloseHandle(child);  // handle not needed — the Job owns it
    }
    out("READY\n");
    for (DWORD waited = 0; waited < 60000; waited += 100) {
      if (GetFileAttributesW(argv[4]) != INVALID_FILE_ATTRIBUTES) return 0;
      Sleep(100);
    }
    return 69;  // release file never arrived — honest timeout
  }
  if (mode == L"spawn" || mode == L"spawn-breakaway" || mode == L"spawn-and-exit") {
    const int depth = argc >= 3 ? _wtoi(argv[2]) : 0;
    // Marker FIRST — our own start is the readiness signal; only then
    // announce ourselves on stdout and descend.
    if (argc >= 4 && !writeMarker(argv[3])) return 65;
    out("PID:%lu\n", GetCurrentProcessId());
    if (depth <= 0) return 0;
    DWORD flags = 0;
    std::wstring childArgs;
    const std::wstring tail = argc >= 4 ? (L" " + quoteArg(argv[3])) : L"";
    if (mode == L"spawn-breakaway") {
      flags = CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
      childArgs = L"spawn-breakaway " + std::to_wstring(depth - 1) + tail;
    } else {
      // "spawn" waits for its child; "spawn-and-exit" leaves it live.
      childArgs = depth > 1 ? L"spawn " + std::to_wstring(depth - 1) + tail
                          : (argc >= 4 ? L"marker " + quoteArg(argv[3])
                                       : L"linger 30000");
    }
    HANDLE child = nullptr;
    const DWORD err = spawnSelf(childArgs, flags, child);
    if (err) { out("REFUSED:%lu\n", err); return 68; }
    out("SPAWNED:%lu\n", GetProcessId(child));
    if (mode == L"spawn-and-exit") { CloseHandle(child); return 0; }
    WaitForSingleObject(child, INFINITE);
    CloseHandle(child);
    return 0;
  }
  return 64;
}
