// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// codex-launcher — Windows-only TEST payload for the packaged job-helper
// application test (scripts/windows/packaged-job-test.mjs). NEVER shipped:
// it is the Codex app-server protocol fixture reimplemented as a native
// executable so the REAL packaged path — Electron → provider → job-helper
// → Job Object → payload — can be exercised offline, byte-for-byte, with
// no Node runtime inside the launched process.
//
// Wire contract (identical to tests/fixtures/codex-app-server.mjs):
//   stdio JSONL, no "jsonrpc" member, typed int ids for client requests,
//   server requests carry ids 9000+, notifications have no id.
//   The packaged app launches it as `codex.exe -c <policy> app-server`
//   (basename is what the runtime validator pins; argv content is ignored
//   here — the fixture serves unconditionally).
//
// Prompt-driven scenarios (the ones the packaged test needs):
//   (default)      → turn/started + agentMessage deltas + completed
//   "approval"     → item/commandExecution/requestApproval; the turn
//                    completes only after the client's answer
//   "sleep"        → never completes until turn/interrupt arrives
//   "slow"         → deltas spread over ~600 ms (interrupt window)
//   "descendant"   → re-execs TWO grandchildren (--grandchild <marker>)
//                    that append "PID:<pid>:<creationQuad>" to the marker
//                    file and sleep; the turn completes with descendants
//                    STILL ALIVE — the Job, not the payload, must reap
//                    them on teardown
//   "die"          → ExitProcess(2) mid-turn (payload abnormal exit)
//   "elsewhere"    → approval resolved server-side (card must expire)
//   "badjson"      → one malformed line, then completes normally
//
// Modes:
//   codex-launcher.exe                      → serve the JSONL protocol
//   codex-launcher.exe --grandchild <file>  → append identity, sleep
//
// Marker files (liveness/identity evidence the test reads): the launcher
// writes %CODEX_HOME%\fixture-state\markers\launcher.json at startup and
// each grandchild appends one line to %CODEX_HOME%\fixture-state\markers\
// descendants.txt — CODEX_HOME is the only env the whitelisted payload
// environment guarantees, so all evidence lives under the app-private
// home. Every identity records pid + creation FILETIME so a reused pid
// is provably a different process.
//
// All stdout/stderr bytes are explicit UTF-8; no CRT locale assumptions.

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
#include <atomic>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "third_party/nlohmann/json.hpp"

namespace {

using nlohmann::json;

// ---- UTF-8 <-> UTF-16 -------------------------------------------------------

std::wstring utf8ToWide(const std::string& in) {
  if (in.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, in.data(), (int)in.size(), nullptr, 0);
  if (n <= 0) return L"";
  std::wstring out((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, in.data(), (int)in.size(), out.data(), n);
  return out;
}

std::string wideToUtf8(const std::wstring& in) {
  if (in.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, in.data(), (int)in.size(), nullptr, 0,
                            nullptr, nullptr);
  if (n <= 0) return "";
  std::string out((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, in.data(), (int)in.size(), out.data(), n,
                      nullptr, nullptr);
  return out;
}

// Byte-exact stdout write — the protocol channel. All sends run on the
// main thread; this never interleaves.
void writeOut(const std::string& s) {
  DWORD written = 0;
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  const char* p = s.data();
  DWORD left = (DWORD)s.size();
  while (left > 0) {
    if (!WriteFile(h, p, left, &written, nullptr) || written == 0) ExitProcess(4);
    p += written;
    left -= written;
  }
}

// ---- identity evidence ------------------------------------------------------

uint64_t creationQuadOf(HANDLE h) {
  FILETIME c, e, k, u;
  if (!GetProcessTimes(h, &c, &e, &k, &u)) return 0;
  return ((uint64_t)c.dwHighDateTime << 32) | c.dwLowDateTime;
}

std::wstring selfPath() {
  wchar_t buf[4096];
  DWORD n = GetModuleFileNameW(nullptr, buf, 4096);
  return n ? std::wstring(buf, n) : std::wstring();
}

std::wstring markerDir() {
  // CODEX_HOME is guaranteed by the whitelisted payload environment;
  // without it there is no evidence root and we simply emit none.
  wchar_t buf[4096];
  DWORD n = GetEnvironmentVariableW(L"CODEX_HOME", buf, 4096);
  if (n == 0 || n >= 4096) return L"";
  std::wstring dir(buf, n);
  dir += L"\\fixture-state\\markers";
  // Build each level — CreateDirectory tolerates existing dirs.
  for (size_t i = 3; i < dir.size(); ++i)
    if (dir[i] == L'\\' || dir[i] == L'/')
      CreateDirectoryW(dir.substr(0, i).c_str(), nullptr);
  CreateDirectoryW(dir.c_str(), nullptr);
  return dir;
}

bool appendMarkerLine(const std::wstring& file, const std::string& line) {
  HANDLE h = CreateFileW(file.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                         OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return false;
  std::string bytes = line + "\n";
  DWORD w = 0;
  const bool ok =
      WriteFile(h, bytes.data(), (DWORD)bytes.size(), &w, nullptr) &&
      w == (DWORD)bytes.size();
  CloseHandle(h);
  return ok;
}

void writeLauncherMarker() {
  const std::wstring dir = markerDir();
  if (dir.empty()) return;
  json m;
  m["pid"] = (uint64_t)GetCurrentProcessId();
  m["ppid"] = 0; // parent is the helper — kernel table holds the truth
  // As STRING: FILETIME quads exceed 2^53 — a JSON number would truncate.
  m["creationTimeQuad"] = std::to_string(creationQuadOf(GetCurrentProcess()));
  m["exe"] = wideToUtf8(selfPath());
  wchar_t cwd[4096];
  DWORD n = GetCurrentDirectoryW(4096, cwd);
  m["cwd"] = n ? wideToUtf8(std::wstring(cwd, n)) : "";
  m["kind"] = "launcher";
  HANDLE h = CreateFileW((dir + L"\\launcher.json").c_str(), GENERIC_WRITE, 0,
                         nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return;
  std::string bytes = m.dump() + "\n";
  DWORD w = 0;
  WriteFile(h, bytes.data(), (DWORD)bytes.size(), &w, nullptr);
  CloseHandle(h);
}

// ---- grandchild mode --------------------------------------------------------

int runGrandchild(const std::wstring& markerFile) {
  // Append our identity FIRST — the marker count is the readiness signal.
  // A marker write that cannot land is a FIXTURE FAILURE (65): a missed
  // record must never masquerade as "not yet spawned".
  uint64_t quad = creationQuadOf(GetCurrentProcess());
  if (!appendMarkerLine(markerFile,
                        "PID:" +
                            std::to_string((uint64_t)GetCurrentProcessId()) +
                            ":" + std::to_string(quad)))
    return 65;
  // Stay alive until the Job tears us down. No stdio use at all.
  for (;;) Sleep(60 * 1000);
  return 0;
}

// ---- JSONL protocol server --------------------------------------------------
// A reader thread owns stdin (blocking ReadFile on a byte pipe), the main
// thread owns stdout plus the timer queue. One mutex, one wake event.

std::mutex g_mutex;
std::deque<std::string> g_lines;
HANDLE g_wake = nullptr;
std::atomic<bool> g_stdinEof{false};

DWORD WINAPI readerMain(LPVOID) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  std::string buf;
  buf.reserve(4096);
  char chunk[4096];
  for (;;) {
    DWORD got = 0;
    if (!ReadFile(in, chunk, sizeof(chunk), &got, nullptr) || got == 0) {
      g_stdinEof = true;
      SetEvent(g_wake);
      return 0;
    }
    buf.append(chunk, got);
    size_t pos;
    while ((pos = buf.find('\n')) != std::string::npos) {
      std::string line = buf.substr(0, pos);
      buf.erase(0, pos + 1);
      {
        std::lock_guard<std::mutex> lk(g_mutex);
        g_lines.push_back(std::move(line));
      }
      SetEvent(g_wake);
    }
    if (buf.size() > 4 * 1024 * 1024) {
      // Unterminated flood — never grow without bound.
      ExitProcess(4);
    }
  }
}

struct Due {
  uint64_t at; // GetTickCount64 ms
  std::function<void()> run;
};
std::vector<Due> g_due;

uint64_t nowMs() { return GetTickCount64(); }

void schedule(std::function<void()> fn, uint64_t delayMs) {
  g_due.push_back({nowMs() + delayMs, std::move(fn)});
  std::sort(g_due.begin(), g_due.end(),
            [](const Due& a, const Due& b) { return a.at < b.at; });
  SetEvent(g_wake);
}

void send(const json& obj) { writeOut(obj.dump() + "\n"); }
void respond(const json& id, const json& result) { send({{"id", id}, {"result", result}}); }
void respondError(const json& id, int code, const std::string& msg) {
  send({{"id", id}, {"error", {{"code", code}, {"message", msg}}}});
}
void notify(const std::string& method, const json& params) {
  send({{"method", method}, {"params", params}});
}

int g_seq = 0;
int g_srvSeq = 0;
uint64_t epochSec() { return (uint64_t)(time(nullptr)); }

json serverRequest(const std::string& method, const json& params) {
  json id = 9000 + ++g_srvSeq;
  send({{"id", id}, {"method", method}, {"params", params}});
  return id;
}

// Cross-instance synthetic identity — same scheme as the mjs fixture:
// one file per thread under CODEX_HOME\fixture-state\thread-*.json so a
// restarted fixture still knows prior synthetic threads.
std::map<std::string, std::string> g_threads; // id -> cwd
std::string g_instance;

std::wstring stateDir() {
  wchar_t buf[4096];
  DWORD n = GetEnvironmentVariableW(L"CODEX_HOME", buf, 4096);
  if (n == 0 || n >= 4096) return L"";
  std::wstring d(buf, n);
  d += L"\\fixture-state";
  CreateDirectoryW(d.c_str(), nullptr);
  return d;
}

void loadThreads() {
  const std::wstring dir = stateDir();
  if (dir.empty()) return;
  WIN32_FIND_DATAW fd;
  HANDLE fh = FindFirstFileW((dir + L"\\thread-*.json").c_str(), &fd);
  if (fh == INVALID_HANDLE_VALUE) return;
  do {
    HANDLE h = CreateFileW((dir + L"\\" + fd.cFileName).c_str(), GENERIC_READ,
                           FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) continue;
    char buf[8192];
    DWORD got = 0;
    std::string raw;
    while (ReadFile(h, buf, sizeof(buf), &got, nullptr) && got > 0)
      raw.append(buf, got);
    CloseHandle(h);
    try {
      json t = json::parse(raw);
      if (t.value("id", "").size() && t.value("cwd", "").size())
        g_threads[t["id"]] = t["cwd"];
    } catch (...) { /* partial tmp write — ignored */ }
  } while (FindNextFileW(fh, &fd));
  FindClose(fh);
}

void persistThread(const std::string& id, const std::string& cwd) {
  const std::wstring dir = stateDir();
  if (dir.empty()) return;
  const std::wstring p = dir + L"\\" + utf8ToWide(id) + L".json";
  const std::wstring tmp = p + L".tmp-" + utf8ToWide(g_instance);
  json t = {{"id", id}, {"cwd", cwd}};
  std::string bytes = t.dump();
  HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                         FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return;
  DWORD w = 0;
  WriteFile(h, bytes.data(), (DWORD)bytes.size(), &w, nullptr);
  CloseHandle(h);
  MoveFileExW(tmp.c_str(), p.c_str(), MOVEFILE_REPLACE_EXISTING);
}

json fakeThread(const std::string& id, const std::string& cwd) {
  return {
      {"id", id},
      {"sessionId", "sess-" + id},
      {"forkedFromId", nullptr},
      {"parentThreadId", nullptr},
      {"preview", "fixture"},
      {"ephemeral", false},
      {"section", nullptr},
      {"sectionEnteredAt", nullptr},
      {"projectId", nullptr},
      {"historyMode", "full"},
      {"modelProvider", "fixture"},
      {"model", "fixture-model"},
      {"reasoningEffort", nullptr},
      {"createdAt", epochSec()},
      {"updatedAt", epochSec()},
      {"recencyAt", nullptr},
      {"status", {{"type", "idle"}}},
      {"path", nullptr},
      {"cwd", cwd},
      {"cliVersion", "fixture-0.164.0"},
      {"originator", "tivano-win-launcher"},
      {"source", "vscode"},
      {"threadSource", nullptr},
      {"agentNickname", nullptr},
      {"agentRole", nullptr},
      {"gitInfo", nullptr},
      {"name", "fixture-thread"},
      {"turns", json::array()},
  };
}

json fakeTurn(const std::string& id) {
  return {
      {"id", id},
      {"rootTurnId", nullptr},
      {"items", json::array()},
      {"itemsView", {{"kind", "all"}}},
      {"status", "inProgress"},
      {"error", nullptr},
      {"startedAt", epochSec()},
      {"completedAt", nullptr},
      {"durationMs", nullptr},
  };
}

struct ActiveTurn {
  std::string turnId;
  std::string threadId;
  json pendingApproval; // server request id awaiting client answer (or null)
};
ActiveTurn* g_turn = nullptr;

void completeTurn(const std::string& status, const std::string& err = "") {
  if (!g_turn) return;
  ActiveTurn t = *g_turn;
  delete g_turn;
  g_turn = nullptr;
  json turn = fakeTurn(t.turnId);
  turn["status"] = status;
  turn["completedAt"] = epochSec();
  if (!err.empty())
    turn["error"] = {{"message", err},
                     {"codexErrorInfo", "other"},
                     {"additionalDetails", nullptr},
                     {"misalignment", nullptr}};
  notify("turn/completed", {{"threadId", t.threadId}, {"turn", turn}});
}

void scheduleTurn(std::function<void()> fn, uint64_t delayMs) {
  // Guarded by the (unique) turn id: a queued step silently drops once
  // its turn has ended — pointer reuse can never re-arm a stale step.
  const std::string mine = g_turn ? g_turn->turnId : "";
  schedule([mine, fn = std::move(fn)]() {
    if (g_turn && g_turn->turnId == mine) fn();
  }, delayMs);
}

std::string lowerOf(const std::string& s) {
  std::string o = s;
  std::transform(o.begin(), o.end(), o.begin(),
                 [](unsigned char c) { return (char)tolower(c); });
  return o;
}

std::wstring quoteArg(const std::wstring& a) {
  std::wstring out = L"\"";
  for (size_t i = 0; i < a.size(); ++i) {
    unsigned bs = 0;
    while (i < a.size() && a[i] == L'\\') { ++bs; ++i; }
    if (i == a.size()) { out.append(bs * 2, L'\\'); break; }
    if (a[i] == L'"') { out.append(bs * 2 + 1, L'\\'); out += L'"'; }
    else { out.append(bs, L'\\'); out += a[i]; }
  }
  out += L'"';
  return out;
}

void spawnGrandchildren(unsigned count) {
  const std::wstring dir = markerDir();
  if (dir.empty()) return;
  const std::wstring marker = dir + L"\\descendants.txt";
  const std::wstring self = selfPath();
  for (unsigned i = 0; i < count; ++i) {
    std::wstring cmd = quoteArg(self) + L" --grandchild " + quoteArg(marker);
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
      continue; // a failed spawn is absence of evidence — never fake it
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
}

void runTurn(const std::string& threadId, const std::string& turnId,
             const std::string& prompt) {
  g_turn = new ActiveTurn{turnId, threadId, json(nullptr)};
  notify("turn/started", {{"threadId", threadId}, {"turn", fakeTurn(turnId)}});
  const std::string lower = lowerOf(prompt);
  const std::string agentItem = "item-agent-" + turnId;

  if (lower.find("die") != std::string::npos) {
    schedule([] { ExitProcess(2); }, 10);
    return;
  }

  auto begin = [threadId, turnId, agentItem, prompt]() {
    notify("item/started",
           {{"threadId", threadId},
            {"turnId", turnId},
            {"startedAtMs", nowMs()},
            {"item",
             {{"type", "agentMessage"},
              {"id", agentItem},
              {"text", ""},
              {"phase", nullptr},
              {"memoryCitation", nullptr},
              {"delivery", nullptr},
              {"questions", nullptr}}}});
    const std::string text =
        "launcher response: " + prompt.substr(0, 80);
    // "slow" spreads chunks over ~600 ms so an interrupt can land mid-turn.
    const bool slow = lowerOf(prompt).find("slow") != std::string::npos;
    std::vector<std::string> chunks;
    if (slow) {
      for (size_t i = 0; i + 4 <= text.size(); i += 4)
        chunks.push_back(text.substr(i, 4));
      if (text.size() % 4) chunks.push_back(text.substr(text.size() / 4 * 4));
    } else {
      chunks.push_back(text);
    }
    const uint64_t interval = slow ? 40 : 10;
    for (size_t i = 0; i < chunks.size(); ++i) {
      const std::string delta = chunks[i];
      scheduleTurn([threadId, turnId, agentItem, delta] {
        notify("item/agentMessage/delta",
               {{"threadId", threadId},
                {"turnId", turnId},
                {"itemId", agentItem},
                {"delta", delta}});
      }, interval * (i + 1));
    }
    scheduleTurn([threadId, turnId, agentItem, text, prompt] {
      notify("item/completed",
             {{"threadId", threadId},
              {"turnId", turnId},
              {"completedAtMs", nowMs()},
              {"item",
               {{"type", "agentMessage"},
                {"id", agentItem},
                {"text", text},
                {"phase", nullptr},
                {"memoryCitation", nullptr},
                {"delivery", nullptr},
                {"questions", nullptr}}}});
      if (lowerOf(prompt).find("badjson") != std::string::npos)
        writeOut("{\"method\":\"turn/completed\", BROKEN\n");
      completeTurn("completed");
    }, interval * (chunks.size() + 2));
  };

  const bool wantApproval = lower.find("approval") != std::string::npos;
  const bool wantElsewhere = lower.find("elsewhere") != std::string::npos;
  const bool wantDescendant = lower.find("descendant") != std::string::npos;

  if (wantApproval) {
    const std::string cwd =
        g_threads.count(threadId) ? g_threads[threadId] : "/";
    json id = serverRequest(
        "item/commandExecution/requestApproval",
        {{"kind", "command"},
         {"threadId", threadId},
         {"turnId", turnId},
         {"itemId", "item-cmd"},
         {"startedAtMs", nowMs()},
         {"environmentId", nullptr},
         {"reason", "launcher wants to run a command"},
         {"command", "echo launcher-command"},
         {"cwd", cwd}});
    g_turn->pendingApproval = id;
    if (wantElsewhere) {
      // Server-side resolution: the card must expire without an answer.
      scheduleTurn([id, threadId, begin = std::move(begin)]() mutable {
        g_turn->pendingApproval = nullptr;
        notify("serverRequest/resolved",
               {{"threadId", threadId}, {"requestId", id}});
        begin();
      }, 15);
    }
    return;
  }

  if (wantDescendant) {
    // Spawn grandchildren NOW; the turn completes with them STILL ALIVE —
    // Job teardown (not the payload) is what must reap them later.
    spawnGrandchildren(2);
    scheduleTurn([begin = std::move(begin)]() mutable { begin(); }, 300);
    return;
  }

  if (lower.find("sleep") != std::string::npos) return; // waits for interrupt
  scheduleTurn([begin = std::move(begin)]() mutable { begin(); }, 10);
}

void onClientAnswer(const json& msg) {
  if (!g_turn) return;
  const json id = msg.value("id", json(nullptr));
  if (id != g_turn->pendingApproval) return;
  g_turn->pendingApproval = nullptr;
  if (msg.contains("error")) {
    completeTurn("completed");
    return;
  }
  const json r = msg.value("result", json::object());
  const std::string decision =
      r.is_object() && r.contains("decision") && r["decision"].is_string()
          ? r["decision"].get<std::string>()
          : "";
  if (decision == "decline" || decision == "cancel") {
    completeTurn("completed");
    return;
  }
  const std::string threadId = g_turn->threadId;
  const std::string turnId = g_turn->turnId;
  const std::string agentItem = "item-agent-" + turnId;
  scheduleTurn([threadId, turnId, agentItem] {
    notify("item/agentMessage/delta",
           {{"threadId", threadId},
            {"turnId", turnId},
            {"itemId", agentItem},
            {"delta", "granted — proceeding"}});
    notify("item/completed",
           {{"threadId", threadId},
            {"turnId", turnId},
            {"completedAtMs", nowMs()},
            {"item",
             {{"type", "agentMessage"},
              {"id", agentItem},
              {"text", "granted — proceeding"},
              {"phase", nullptr},
              {"memoryCitation", nullptr},
              {"delivery", nullptr},
              {"questions", nullptr}}}});
    completeTurn("completed");
  }, 10);
}

void onMessage(const std::string& line) {
  json msg;
  try {
    msg = json::parse(line);
  } catch (...) {
    return; // malformed inbound — bounded ignore
  }
  if (!msg.is_object()) return;
  const json id = msg.value("id", json(nullptr));
  const std::string method = msg.value("method", "");
  if (method.empty()) {
    onClientAnswer(msg);
    return;
  }
  const json params = msg.value("params", json::object());

  if (method == "initialize") {
    wchar_t buf[4096];
    DWORD n = GetEnvironmentVariableW(L"CODEX_HOME", buf, 4096);
    respond(id,
            {{"userAgent", "codex-app-server-launcher/0.164.0 (windows)"},
             {"codexHome", n ? wideToUtf8(std::wstring(buf, n)) : ""},
             {"platformFamily", "windows"},
             {"platformOs", "windows"}});
  } else if (method == "initialized") {
    // notification — no response
  } else if (method == "thread/start") {
    const std::string tid =
        "thread-" + g_instance + "-" + std::to_string(++g_seq);
    const std::string cwd =
        params.is_object() && params.contains("cwd") && params["cwd"].is_string()
            ? params["cwd"].get<std::string>()
            : "";
    g_threads[tid] = cwd;
    persistThread(tid, cwd);
    respond(id, {{"thread", fakeThread(tid, cwd)}});
  } else if (method == "thread/resume") {
    const std::string tid =
        params.is_object() && params.contains("threadId") &&
                params["threadId"].is_string()
            ? params["threadId"].get<std::string>()
            : "";
    if (!g_threads.count(tid)) {
      respondError(id, -32000, "thread not found: " + tid);
      return;
    }
    respond(id, {{"thread", fakeThread(tid, g_threads[tid])}});
  } else if (method == "turn/start") {
    const std::string tid =
        params.is_object() && params.contains("threadId") &&
                params["threadId"].is_string()
            ? params["threadId"].get<std::string>()
            : "";
    if (!g_threads.count(tid)) {
      respondError(id, -32000, "unknown thread: " + tid);
      return;
    }
    if (g_turn) {
      respondError(id, -32000, "a turn is already in progress");
      return;
    }
    std::string prompt;
    if (params.contains("input") && params["input"].is_array()) {
      for (const auto& i : params["input"])
        if (i.value("type", "") == "text") {
          if (!prompt.empty()) prompt += "\n";
          prompt += i.value("text", "");
        }
    }
    const std::string turnId =
        "turn-" + g_instance + "-" + std::to_string(++g_seq);
    respond(id, {{"turn", fakeTurn(turnId)}});
    runTurn(tid, turnId, prompt);
  } else if (method == "turn/interrupt") {
    respond(id, json::object());
    completeTurn("interrupted");
  } else {
    if (!id.is_null()) respondError(id, -32601, "unknown method: " + method);
  }
}

int serve() {
  writeLauncherMarker();
  loadThreads();
  g_instance = std::to_string((uint64_t)GetCurrentProcessId());
  g_wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  CloseHandle(CreateThread(nullptr, 0, readerMain, nullptr, 0, nullptr));

  for (;;) {
    // Drain every due timer, then every queued line, then sleep until
    // whichever arrives first. Single-threaded sends — no interleave.
    while (!g_due.empty() && g_due.front().at <= nowMs()) {
      auto fn = std::move(g_due.front().run);
      g_due.erase(g_due.begin());
      fn();
    }
    for (;;) {
      std::string line;
      {
        std::lock_guard<std::mutex> lk(g_mutex);
        if (g_lines.empty()) break;
        line = std::move(g_lines.front());
        g_lines.pop_front();
      }
      onMessage(line);
      // A handler may have queued due work — run it before sleeping.
      while (!g_due.empty() && g_due.front().at <= nowMs()) {
        auto fn = std::move(g_due.front().run);
        g_due.erase(g_due.begin());
        fn();
      }
    }
    bool linesEmpty;
    { std::lock_guard<std::mutex> lk(g_mutex); linesEmpty = g_lines.empty(); }
    if (g_stdinEof && linesEmpty) {
      completeTurn("interrupted");
      return 0;
    }
    uint64_t wait = INFINITE;
    if (!g_due.empty()) {
      uint64_t delta = g_due.front().at > nowMs() ? g_due.front().at - nowMs() : 0;
      wait = delta > (uint64_t)INFINITE - 1 ? INFINITE - 1 : (DWORD)delta;
    }
    WaitForSingleObject(g_wake, (DWORD)wait);

  }
}

} // namespace

int wmain(int argc, wchar_t** argv) {
  // Test control only: validate creation identity and terminate through
  // the SAME kernel handle, eliminating a check-then-kill PID reuse race.
  // https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess
  if (argc == 4 && std::wstring(argv[1]) == L"--kill-known") {
    wchar_t* end = nullptr;
    unsigned long pid = wcstoul(argv[2], &end, 10);
    if (!pid || !end || *end) return 64;
    uint64_t expected = _wcstoui64(argv[3], &end, 10);
    if (!expected || !end || *end) return 64;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE,
                           FALSE, static_cast<DWORD>(pid));
    if (!h) return 65;
    if (creationQuadOf(h) != expected) { CloseHandle(h); return 66; }
    bool requested = TerminateProcess(h, 137) != FALSE;
    bool exited = requested && WaitForSingleObject(h, 5000) == WAIT_OBJECT_0;
    CloseHandle(h);
    return exited ? 0 : 67;
  }
  // `--grandchild <markerFile>` — descendant mode (never serves).
  if (argc >= 3 && std::wstring(argv[1]) == L"--grandchild")
    return runGrandchild(argv[2]);
  // Any other argv (e.g. `-c <policy> app-server`) is accepted and ignored:
  // the fixture serves unconditionally, mirroring the mjs fixture which is
  // likewise launched with a fixed script argv.
  return serve();
}
