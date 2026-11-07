// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// helper-selftest — PORTABLE checks for helper_common (no Win32 anywhere).
// This validates ONLY the platform-independent core: base64url decoding,
// spec schema validation, Windows-CRT quoting and env-block serialization.
// It says nothing about Job Objects, pipes or CreateProcess — those are
// proven by the Windows-only harness (tests/windows/helper-harness.mjs).
//
// Build (any C++17 compiler):  c++ -std=c++17 helper_common.cpp
//                              helper-selftest.cpp -o helper-selftest
// Prints "HELPER-SELFTEST PASS <n>" on success, exits nonzero on failure.

#include <cstdio>
#include <cstring>
#include <string>

#include "helper_common.hpp"

namespace {

int checks = 0;
int failures = 0;

void check(bool cond, const char* name) {
  checks++;
  if (!cond) {
    failures++;
    std::fprintf(stderr, "FAIL %s\n", name);
  }
}

std::string specJson(const char* extra = "") {
  return std::string(
      "{\"v\":1,\"ownerPid\":4242,"
      "\"executable\":\"D:\\\\tools\\\\payload.exe\","
      "\"args\":[\"app-server\",\"--flag\"],"
      "\"cwd\":\"D:\\\\work\","
      "\"env\":{\"CODEX_HOME\":\"D:\\\\home\"}") +
      extra + "}";
}

std::u16string q(const char* s) { return th::quoteArgUtf16(s); }

}  // namespace

int main() {
  // ---- base64url ----------------------------------------------------------
  {
    std::vector<uint8_t> out;
    check(th::b64urlDecode("aGVsbG8", out) && std::string(out.begin(), out.end()) == "hello",
          "b64 basic");
    check(!th::b64urlDecode("aGVsbG8=", out), "b64 padding refused");
    check(!th::b64urlDecode("a*VsbG8", out), "b64 bad char");
    check(!th::b64urlDecode("a", out), "b64 impossible length");
    check(!th::b64urlDecode("", out), "b64 empty");
  }

  // ---- spec validation: accepts -------------------------------------------
  {
    std::string err;
    auto s = th::parseSpec(specJson(), err);
    check(s.has_value(), "valid spec accepted");
    check(s && s->ownerPid == 4242 && s->args.size() == 2, "spec fields parsed");
    check(s && s->env.size() == 1 && s->env[0].first == "CODEX_HOME", "spec env parsed");
  }

  // ---- spec validation: rejects -------------------------------------------
  {
    std::string err;
    auto bad = [&](const std::string& j) { return !th::parseSpec(j, err).has_value(); };
    check(bad(""), "empty spec");
    check(bad("{}"), "missing fields");
    check(bad(specJson(",\"extra\":1")), "unknown field");
    check(bad("{\"v\":2,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{}}"),
          "wrong version");
    check(bad("{\"v\":1,\"ownerPid\":0,\"executable\":\"D:\\\\a.exe\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{}}"),
          "ownerPid zero");
    check(bad("{\"v\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{}}"),
          "missing ownerPid");
    check(bad("{\"v\":1,\"ownerPid\":1,\"executable\":\"payload.exe\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{}}"),
          "relative executable");
    check(bad("{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.bat\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{}}"),
          ".bat refused");
    check(bad("{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.cmd\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{}}"),
          ".cmd refused");
    check(bad("{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{}}"),
          "extensionless refused");
    check(bad("{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[],\"cwd\":\"work\",\"env\":{}}"),
          "relative cwd");
    check(bad("{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[\"a\\u0000b\"],\"cwd\":\"D:\\\\\",\"env\":{}}"),
          "NUL in arg");
    check(bad("{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{\"BAD=K\":\"v\"}}"),
          "env key with =");
    check(bad("{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{\"1BAD\":\"v\"}}"),
          "env key digit-leading");
    check(bad("{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{\"A\":\"x\",\"a\":\"y\"}}"),
          "case-insensitive env dup");
    check(bad("{\"v\":1,\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{}}"),
          "duplicate top-level field");
    check(bad("{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[\"x\"],\"cwd\":\"D:\\\\\",\"env\":{\"K\":\"a\",\"K\":\"b\"}}"),
          "duplicate nested field");
    // oversized
    {
      std::string big = "{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[\"";
      big.append(40000, 'x');
      big += "\"],\"cwd\":\"D:\\\\\",\"env\":{}}";
      check(bad(big), "oversized spec");
    }
    // UNC executable allowed
    {
      std::string e2;
      auto s2 = th::parseSpec(
          "{\"v\":1,\"ownerPid\":9,\"executable\":\"\\\\\\\\srv\\\\share\\\\a.exe\",\"args\":[],\"cwd\":\"\\\\\\\\srv\\\\share\",\"env\":{}}",
          e2);
      check(s2.has_value(), "UNC executable accepted");
    }
    // non-.exe script via /c path still refused even with .exe elsewhere
    check(bad("{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\\\\evil.bat\",\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{}}"),
          "embedded backslash segment");
  }

  // ---- CRT quoting ---------------------------------------------------------
  {
    check(q("plain") == u"\"plain\"", "quote plain");
    check(q("") == u"\"\"", "quote empty");
    check(q("a b") == u"\"a b\"", "quote space");
    check(q("a\"b") == u"\"a\\\"b\"", "quote embedded quote");
    check(q("trail\\") == u"\"trail\\\\\"", "quote trailing backslash");
    check(q("a\\b") == u"\"a\\b\"", "interior backslash literal");
    check(q("a\\\"b") == u"\"a\\\\\\\"b\"", "backslash before quote");
    check(q("&|%<>^") == u"\"&|%<>^\"", "metacharacters quoted verbatim");
    check(q("\\\\") == u"\"\\\\\\\\\"", "two trailing backslashes quadruple");
  }

  // ---- command line --------------------------------------------------------
  {
    std::string err;
    auto s = th::parseSpec(specJson(), err);
    std::u16string cmd;
    check(th::buildCommandLine(*s, cmd, err), "cmdline built");
    const std::u16string expect =
        u"\"D:\\tools\\payload.exe\" \"app-server\" \"--flag\"";
    check(cmd == expect, "cmdline content");
    // Over-limit command line refused
    th::Spec big = *s;
    for (int i = 0; i < 60; i++) big.args.push_back(std::string(600, 'x'));
    std::u16string cmd2;
    check(!th::buildCommandLine(big, cmd2, err), "oversized cmdline refused");
  }

  // ---- env block ------------------------------------------------------------
  {
    std::string err;
    auto s = th::parseSpec(
        "{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[],"
        "\"cwd\":\"D:\\\\\",\"env\":{\"beta\":\"2\",\"Alpha\":\"1\",\"_Z\":\"z\"}}",
        err);
    std::u16string blk;
    check(th::buildEnvBlock(*s, blk, err), "env block built");
    // Uppercase-folded ordinal (CompareStringOrdinal(TRUE) semantics):
    // '_'(0x5F) > 'Z'(0x5A) — expected order Alpha, beta, _Z.
    const std::u16string expectBlock(u"Alpha=1\0beta=2\0_Z=z\0\0", sizeof(u"Alpha=1\0beta=2\0_Z=z\0\0") / sizeof(char16_t) - 1);
    check(blk == expectBlock, "env block sorted + terminated");
    // empty env → just the terminator
    auto s0 = th::parseSpec(
        "{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\",\"args\":[],"
        "\"cwd\":\"D:\\\\\",\"env\":{}}",
        err);
    std::u16string blk0;
    check(th::buildEnvBlock(*s0, blk0, err) && blk0 == std::u16string(1, u'\0'),
          "empty env block is a lone terminator");
  }

  // ---- nesting depth bound (SAX-level, before DOM) ---------------------------
  {
    std::string err;
    // Build {"env":{"k":[ [["..." depth N ...]] ]}}-style deep nesting.
    auto deep = [](size_t n) {
      std::string s = "{\"v\":1,\"ownerPid\":1,\"executable\":\"D:\\\\a.exe\","
                      "\"args\":[],\"cwd\":\"D:\\\\\",\"env\":{\"k\":";
      for (size_t i = 0; i < n; i++) s += "[";
      for (size_t i = 0; i < n; i++) s += "]";
      s += "}}";
      return s;
    };
    // Over the bound → the SAX depth gate rejects with its own code.
    auto s34 = th::parseSpec(deep(34), err);
    check(!s34 && err == "spec-depth", "deep nesting rejected pre-DOM");
    // Just under the bound reaches schema validation (env value must be a
    // string) and fails there — not at the depth gate.
    auto s8 = th::parseSpec(deep(8), err);
    check(!s8 && err != "spec-depth" && !err.empty(),
          "under-depth doc rejected by schema, not depth gate");
  }

  // ---- TerminalSpec validation --------------------------------------------
  {
    std::string err;
    auto tj = [](const char* body) {
      return std::string(
          "{\"v\":1,\"ownerPid\":4242,\"cols\":120,\"rows\":30,"
          "\"cwd\":\"D:\\\\work\",\"env\":{\"TERM_PROGRAM\":\"Tivano\"}") +
          body + "}";
    };
    auto ok = th::parseTerminalSpec(tj(""), err);
    check(ok && ok->ownerPid == 4242 && ok->cols == 120 && ok->rows == 30 &&
              ok->cwd == "D:\\work" && ok->env.size() == 1 &&
              ok->env[0].first == "TERM_PROGRAM",
          "terminal spec accepted");
    check(!th::parseTerminalSpec(tj(",\"v\":2"), err) && err == "tspec-duplicate-field",
          "terminal spec duplicate key refused");
    check(!th::parseTerminalSpec(
              tj("").replace(tj("").find("\"v\":1"), 5, "\"v\":2"), err) &&
              err == "tspec-version",
          "terminal spec wrong version refused");
    check(!th::parseTerminalSpec(
              "{\"v\":1,\"ownerPid\":1,\"cols\":1,\"rows\":30,"
              "\"cwd\":\"D:\\\\w\",\"env\":{}}",
              err) &&
              err == "tspec-dim",
          "terminal spec cols below bound refused");
    check(!th::parseTerminalSpec(
              "{\"v\":1,\"ownerPid\":1,\"cols\":501,\"rows\":30,"
              "\"cwd\":\"D:\\\\w\",\"env\":{}}",
              err) &&
              err == "tspec-dim",
          "terminal spec cols above bound refused");
    check(!th::parseTerminalSpec(
              "{\"v\":1,\"ownerPid\":1,\"cols\":80,\"rows\":1,"
              "\"cwd\":\"D:\\\\w\",\"env\":{}}",
              err) &&
              err == "tspec-dim",
          "terminal spec rows below bound refused");
    check(!th::parseTerminalSpec(
              "{\"v\":1,\"ownerPid\":1,\"cols\":80,\"rows\":201,"
              "\"cwd\":\"D:\\\\w\",\"env\":{}}",
              err) &&
              err == "tspec-dim",
          "terminal spec rows above bound refused");
    check(!th::parseTerminalSpec(
              "{\"v\":1,\"ownerPid\":1,\"cols\":80,\"rows\":30,"
              "\"cwd\":\"relative\\\\dir\",\"env\":{}}",
              err) &&
              err == "tspec-cwd",
          "terminal spec relative cwd refused");
    check(!th::parseTerminalSpec(
              "{\"v\":1,\"ownerPid\":1,\"cols\":80,\"rows\":30,"
              "\"cwd\":\"D:\\\\w\",\"env\":{},"
              "\"executable\":\"D:\\\\evil.exe\"}",
              err) &&
              err == "tspec-field",
          "terminal spec executable field refused (shell is helper-fixed)");
    check(!th::parseTerminalSpec(
              "{\"v\":1,\"ownerPid\":1,\"cols\":80,\"rows\":30,"
              "\"cwd\":\"D:\\\\w\",\"env\":{\"BAD KEY\":\"x\"}}",
              err) &&
              err == "tspec-env-key",
          "terminal spec bad env key refused");
    check(!th::parseTerminalSpec(
              "{\"v\":1,\"ownerPid\":1,\"cols\":80,\"rows\":30,"
              "\"cwd\":\"D:\\\\w\",\"env\":{\"PATH\":\"x\",\"Path\":\"y\"}}",
              err) &&
              err == "tspec-env-duplicate",
          "terminal spec case-duplicate env refused");
    check(!th::parseTerminalSpec("", err), "terminal spec empty refused");
    // env block shared with SpawnSpec ordering
    std::u16string blk;
    check(th::buildEnvBlock(ok->env, blk, err) &&
              blk == std::u16string(u"TERM_PROGRAM=Tivano\0\0",
                                    sizeof(u"TERM_PROGRAM=Tivano\0\0") /
                                        sizeof(char16_t) -
                                        1),
          "terminal env block built");
  }

  // ---- standard base64 + utf8 framing -------------------------------------
  {
    const std::string bytes("\x00\x01\x02\xfe\xff", 5);
    const std::string enc = th::b64Encode(bytes);
    check(enc == "AAEC/v8=", "b64 encode value");
    std::vector<uint8_t> dec;
    check(th::b64Decode(enc, dec) && std::string(dec.begin(), dec.end()) == bytes,
          "b64 roundtrip");
    check(th::b64Decode("aGk=", dec) && dec.size() == 2 && dec[0] == 'h' &&
              dec[1] == 'i',
          "b64 one-pad decode");
    check(th::b64Decode("aGk", dec) && dec.size() == 2, "b64 unpadded decode");
    check(!th::b64Decode("a==", dec), "b64 bad pad refused");
    check(!th::b64Decode("aA=", dec), "b64 missing required padding refused");
    check(!th::b64Decode("aGk==", dec), "b64 excess required padding refused");
    check(!th::b64Decode("AAAA==", dec), "b64 padding after full quartet refused");
    check(!th::b64Decode("=", dec), "b64 padding without data refused");
    check(!th::b64Decode("aGk= extra", dec), "b64 whitespace refused");
    check(!th::b64Decode("aGk$", dec), "b64 bad char refused");
    check(!th::b64Decode("a", dec), "b64 impossible length refused");
    check(th::b64Decode("", dec) && dec.empty(), "b64 empty decodes empty");
    // Non-canonical trailing bits refused (encoders never produce these).
    check(!th::b64Decode("aGl=", dec), "b64 non-canonical tail bits refused");

    // utf8TailBytes — frame cuts never split a sequence
    const std::string zh = "\xE4\xB8\xAD\xE6\x96\x87";  // 中文
    check(th::utf8TailBytes(zh) == 0, "utf8 complete tail");
    check(th::utf8TailBytes(zh.substr(0, 4)) == 1, "utf8 1-of-3 tail held");
    check(th::utf8TailBytes(zh.substr(0, 5)) == 2, "utf8 2-of-3 tail held");
    const std::string emoji = "\xF0\x9F\x98\x80";  // 😀
    check(th::utf8TailBytes(emoji.substr(0, 2)) == 2, "utf8 2-of-4 tail held");
    check(th::utf8TailBytes(emoji.substr(0, 3)) == 3, "utf8 3-of-4 tail held");
    check(th::utf8TailBytes("abc") == 0, "ascii tail none");
    check(th::utf8TailBytes("a\xFF") == 0, "invalid lead not a prefix");
    check(th::utf8TailBytes("") == 0, "empty tail none");
  }

  if (failures == 0) {
    std::printf("HELPER-SELFTEST PASS %d checks\n", checks);
    return 0;
  }
  std::printf("HELPER-SELFTEST FAIL %d/%d\n", failures, checks);
  return 1;
}
