// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
//
// helper_common — PORTABLE core of tivano-job-helper: base64url decoding,
// SpawnSpec JSON schema validation, Windows-CRT command-line quoting and
// the sorted UTF-16 environment block. This file has NO Win32 dependency
// (no windows.h, no wchar_t width assumptions): all wide output uses
// char16_t so the exact same bytes are testable off Windows. The Win32
// launcher (tivano-job-helper.cpp) is a thin OS layer on top.
//
// SpawnSpec wire contract (versioned, see docs/phase-2c-windows-helper.md):
//   {"v":1,"ownerPid":<int>,"executable":"<abs .exe>","args":[..],
//    "cwd":"<abs dir>","env":{"K":"V"}}
// Everything not listed is rejected. The contract changed vs the P2b draft
// (added v + ownerPid); the Node encoder and this validator version together.
//
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace th {

// Bounds — every limit is documented, checked before any OS object exists.
inline constexpr size_t kMaxSpecJsonBytes = 32768;
inline constexpr size_t kMaxPathUtf8 = 1024;
inline constexpr size_t kMaxArgs = 64;
inline constexpr size_t kMaxArgUtf8 = 2048;
inline constexpr size_t kMaxEnvEntries = 128;
inline constexpr size_t kMaxEnvKeyUtf8 = 128;
inline constexpr size_t kMaxEnvValueUtf8 = 4096;
// Small nesting-depth bound enforced during the SAX pass, before any DOM
// exists — deep JSON must not reach allocator/recursion limits first.
inline constexpr size_t kMaxSpecDepth = 32;
// CreateProcessW lpCommandLine is documented at 32767 characters max.
inline constexpr size_t kMaxCommandLineChars = 32700;
inline constexpr uint32_t kSpecVersion = 1;

// Helper identity — emitted by --version and by opt-in startup traces.
// Kept beside the spec versions it versions-with; changing the contract
// means changing this.
inline constexpr char kHelperVersion[] = "1.3.1";

// TerminalSpec wire contract (independent version from SpawnSpec):
//   {"v":1,"ownerPid":<int>,"cols":2..500,"rows":2..200,
//    "cwd":"<abs dir>","env":{"K":"V"}}
// The shell is NEVER in the spec — the helper launches a fixed system
// Windows PowerShell; a spec-supplied executable would be a shell picker.
inline constexpr uint32_t kTerminalSpecVersion = 1;
inline constexpr uint32_t kTermColsMin = 2;
inline constexpr uint32_t kTermColsMax = 500;
inline constexpr uint32_t kTermRowsMin = 2;
inline constexpr uint32_t kTermRowsMax = 200;

struct Spec {
  uint32_t ownerPid = 0;
  std::string exe;  // UTF-8, absolute, .exe only
  std::vector<std::string> args;
  std::string cwd;  // UTF-8, absolute directory
  std::vector<std::pair<std::string, std::string>> env;  // insertion order
};

struct TerminalSpec {
  uint32_t ownerPid = 0;
  uint32_t cols = 0;
  uint32_t rows = 0;
  std::string cwd;  // UTF-8, absolute directory
  std::vector<std::pair<std::string, std::string>> env;  // insertion order
};

/** base64url decode (no padding required). false = malformed input. */
bool b64urlDecode(std::string_view in, std::vector<uint8_t>& out);

/**
 * STRICT UTF-8 → UTF-16. Rejects lone surrogates (incl. the UTF-16 range a
 * permissive decoder might smuggle through), overlongs and > U+10FFFF.
 */
bool utf8ToUtf16(std::string_view in, std::u16string& out);

/**
 * Parse + fully validate a SpawnSpec. On failure `err` carries a stable
 * reason code — NEVER a copy of the offending value, path or env content.
 * Returns nullopt on any violation; a partially populated Spec never leaks.
 */
std::optional<Spec> parseSpec(std::string_view jsonUtf8, std::string& err);

/** Same contract as parseSpec for a TerminalSpec (v == 1). */
std::optional<TerminalSpec> parseTerminalSpec(std::string_view jsonUtf8, std::string& err);

/** Bounded JSON pre-scan (nesting ≤ kMaxSpecDepth, no duplicate keys at
 *  any depth). Every JSON entry point — launch specs AND terminal
 *  control lines — must pass this before DOM construction: nlohmann's
 *  recursive DOM parser can stack-overflow on deep nesting that fits
 *  inside a size-bounded line. */
bool jsonBoundedOk(std::string_view jsonUtf8);

/** Windows-CRT quoting of ONE argument (CommandLineToArgvW rules). */
std::u16string quoteArgUtf16(std::string_view utf8Arg);

/**
 * Full lpCommandLine image: quoted exe + each quoted arg. Rejects the
 * result over kMaxCommandLineChars before any child exists.
 */
bool buildCommandLine(const Spec& spec, std::u16string& out, std::string& err);

/**
 * Double-NUL-terminated UTF-16 environment block built ONLY from the
 * spec's env pairs, sorted by the case-insensitive ordinal order
 * CreateProcess expects. Duplicate keys were already rejected
 * case-insensitively at parse time.
 */
bool buildEnvBlock(const Spec& spec, std::u16string& out, std::string& err);
bool buildEnvBlock(const std::vector<std::pair<std::string, std::string>>& env,
                   std::u16string& out, std::string& err);

/** base64 ENCODE (standard alphabet, '=' padding). */
std::string b64Encode(std::string_view bytes);

/** base64 decode (standard alphabet; optional '=' padding, no whitespace). */
bool b64Decode(std::string_view in, std::vector<uint8_t>& out);

/**
 * How many trailing bytes of `s` are the incomplete head of a UTF-8
 * multi-byte sequence (0..3). Data frames cut raw ConPTY output on UTF-8
 * boundaries only; a caller emits s[..size-tail] now and prepends the
 * tail bytes to the next chunk. Invalid lead bytes are NOT treated as a
 * pending prefix — they pass through and the strict consumer rejects.
 */
size_t utf8TailBytes(std::string_view s);

}  // namespace th
