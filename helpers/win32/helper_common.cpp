// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// See helper_common.hpp for the contract. Portable; no Win32 headers.

#include "helper_common.hpp"

#include <algorithm>
#include <cctype>
#include <set>

#include "third_party/nlohmann/json.hpp"

namespace th {

namespace {

int b64val(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}

bool containsNul(std::string_view s) { return s.find('\0') != std::string_view::npos; }

// Absolute Windows path: "X:\" or "X:/" (drive) or "\\" (UNC). We accept
// '/' separators too — Windows does — but a bare "C:" drive-relative or a
// rooted-relative "\foo" path is rejected.
bool isAbsoluteWinPath(std::string_view s) {
  if (s.size() >= 3 &&
      ((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z')) &&
      s[1] == ':' && (s[2] == '\\' || s[2] == '/'))
    return true;
  if (s.size() >= 3 && s[0] == '\\' && s[1] == '\\' && s[2] != '\\' && s[2] != '/')
    return true;  // \\server\share — needs a server+share tail, checked by length
  return false;
}

// Only real executable images may be payloads. Scripts and shell wrappers
// are refused outright — this helper never invokes a shell.
bool hasExeExtension(std::string_view s) {
  auto lower = [](std::string_view v) {
    std::string r(v);
    for (auto& c : r) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return r;
  };
  const std::string ext = lower(s.size() >= 4 ? s.substr(s.size() - 4) : s);
  return ext == ".exe";
}

// Conventional environment key form. '=' can never appear (the block uses
// it as the separator); Windows also disallows a leading '='.
bool isValidEnvKey(std::string_view k) {
  if (k.empty() || k.size() > kMaxEnvKeyUtf8) return false;
  if (!(std::isalpha(static_cast<unsigned char>(k[0])) || k[0] == '_')) return false;
  for (char c : k)
    if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) return false;
  return true;
}

std::string lowerAscii(std::string_view s) {
  std::string r(s);
  for (auto& c : r) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return r;
}

// Windows case-insensitive ordering uses the uppercase ordinal table
// (CompareStringOrdinal(TRUE) semantics): '_' (0x5F) sorts AFTER 'Z'
// (0x5A), so folding to UPPERCASE — not lowercase — reproduces the
// documented GetEnvironmentVariable ordering for the ASCII key subset
// this spec accepts.
std::string upperAscii(std::string_view s) {
  std::string r(s);
  for (auto& c : r) {
    const unsigned char uc = static_cast<unsigned char>(c);
    c = static_cast<char>(std::toupper(uc));
  }
  return r;
}

// SAX pass that rejects duplicate object keys at ANY depth AND enforces
// a small nesting-depth bound BEFORE any DOM is constructed. nlohmann's
// DOM keeps only the last value of a duplicate key — a silently accepted
// duplicate in a launch spec is an ambiguity we refuse.
enum class ScanCode { kOk, kDuplicate, kTooDeep, kMalformed };

class DupKeySax {
 public:
  struct Error : std::exception {
    explicit Error(ScanCode c) : code(c) {}
    ScanCode code;
  };

  bool key(std::string& k) {
    if (stack_.empty() || !stack_.back().isObject) return true;
    if (!stack_.back().keys.insert(k).second) throw Error{ScanCode::kDuplicate};
    return true;
  }
  bool start_object(std::size_t) {
    if (stack_.size() >= kMaxSpecDepth) throw Error{ScanCode::kTooDeep};
    stack_.push_back({true, {}});
    return true;
  }
  bool end_object() { if (!stack_.empty()) stack_.pop_back(); return true; }
  bool start_array(std::size_t) {
    if (stack_.size() >= kMaxSpecDepth) throw Error{ScanCode::kTooDeep};
    stack_.push_back({false, {}});
    return true;
  }
  bool end_array() { if (!stack_.empty()) stack_.pop_back(); return true; }
  bool null() { return true; }
  bool boolean(bool) { return true; }
  bool number_integer(nlohmann::json::number_integer_t) { return true; }
  bool number_unsigned(nlohmann::json::number_unsigned_t) { return true; }
  bool number_float(nlohmann::json::number_float_t, const std::string&) { return true; }
  bool string(std::string&) { return true; }
  bool binary(nlohmann::json::binary_t&) { return true; }
  bool parse_error(std::size_t, const std::string&, const nlohmann::json::exception&) {
    throw Error{ScanCode::kMalformed};
  }

 private:
  struct Frame {
    bool isObject;
    std::set<std::string> keys;
  };
  std::vector<Frame> stack_;
};

ScanCode scanSpecJson(std::string_view jsonUtf8) {
  DupKeySax sax;
  try {
    if (!nlohmann::json::sax_parse(jsonUtf8.begin(), jsonUtf8.end(), &sax))
      return ScanCode::kMalformed;
    return ScanCode::kOk;
  } catch (const DupKeySax::Error& e) {
    return e.code;
  } catch (...) {
    return ScanCode::kMalformed;
  }
}

}  // namespace

bool jsonBoundedOk(std::string_view jsonUtf8) {
  return scanSpecJson(jsonUtf8) == ScanCode::kOk;
}

namespace {

// Strict UTF-8 validation used BEFORE trusting json-parsed strings (the
// spec arrives over our own base64url, but nothing may rely on the caller).
bool validUtf8Strict(std::string_view s) {
  size_t i = 0;
  while (i < s.size()) {
    const uint8_t c = static_cast<uint8_t>(s[i]);
    if (c < 0x80) { i++; continue; }
    uint32_t cp; size_t len;
    if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; len = 2; }
    else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; len = 3; }
    else if ((c & 0xF8) == 0xF0) { cp = c & 0x07; len = 4; }
    else return false;
    if (i + len > s.size()) return false;
    for (size_t j = 1; j < len; j++) {
      const uint8_t t = static_cast<uint8_t>(s[i + j]);
      if ((t & 0xC0) != 0x80) return false;
      cp = (cp << 6) | (t & 0x3F);
    }
    if (len == 2 && cp < 0x80) return false;                    // overlong
    if (len == 3 && cp < 0x800) return false;                   // overlong
    if (len == 4 && cp < 0x10000) return false;                 // overlong
    if (cp >= 0xD800 && cp <= 0xDFFF) return false;             // lone surrogate
    if (cp > 0x10FFFF) return false;
    i += len;
  }
  return true;
}

}  // namespace

bool b64urlDecode(std::string_view in, std::vector<uint8_t>& out) {
  if (in.empty() || in.size() > (kMaxSpecJsonBytes * 2)) return false;
  if (in.size() % 4 == 1) return false;  // impossible base64 length
  out.clear();
  out.reserve((in.size() / 4) * 3 + 3);
  uint32_t acc = 0;
  int bits = 0;
  for (char c : in) {
    if (c == '=') return false;  // padding not allowed in base64url spec arg
    const int v = b64val(c);
    if (v < 0) return false;
    acc = (acc << 6) | static_cast<uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<uint8_t>((acc >> bits) & 0xFF));
    }
  }
  return true;
}

bool utf8ToUtf16(std::string_view in, std::u16string& out) {
  if (!validUtf8Strict(in)) return false;
  out.clear();
  size_t i = 0;
  while (i < in.size()) {
    const uint8_t c = static_cast<uint8_t>(in[i]);
    uint32_t cp;
    if (c < 0x80) { cp = c; i += 1; }
    else if ((c & 0xE0) == 0xC0) {
      cp = ((c & 0x1F) << 6) | (static_cast<uint8_t>(in[i + 1]) & 0x3F); i += 2;
    } else if ((c & 0xF0) == 0xE0) {
      cp = ((c & 0x0F) << 12) | ((static_cast<uint8_t>(in[i + 1]) & 0x3F) << 6) |
           (static_cast<uint8_t>(in[i + 2]) & 0x3F); i += 3;
    } else {
      cp = ((c & 0x07) << 18) | ((static_cast<uint8_t>(in[i + 1]) & 0x3F) << 12) |
           ((static_cast<uint8_t>(in[i + 2]) & 0x3F) << 6) |
           (static_cast<uint8_t>(in[i + 3]) & 0x3F); i += 4;
    }
    if (cp > 0xFFFF) {
      cp -= 0x10000;
      out.push_back(static_cast<char16_t>(0xD800 + (cp >> 10)));
      out.push_back(static_cast<char16_t>(0xDC00 + (cp & 0x3FF)));
    } else {
      out.push_back(static_cast<char16_t>(cp));
    }
  }
  return true;
}

std::optional<Spec> parseSpec(std::string_view jsonUtf8, std::string& err) {
  auto fail = [&err](const char* code) -> std::optional<Spec> {
    err = code;
    return std::nullopt;
  };
  if (jsonUtf8.empty() || jsonUtf8.size() > kMaxSpecJsonBytes)
    return fail("spec-size");
  if (!validUtf8Strict(jsonUtf8)) return fail("spec-utf8");
  const ScanCode scan = scanSpecJson(jsonUtf8);
  if (scan == ScanCode::kTooDeep) return fail("spec-depth");
  if (scan != ScanCode::kOk) return fail("spec-duplicate-field");

  nlohmann::json doc;
  try {
    doc = nlohmann::json::parse(jsonUtf8);
  } catch (...) {
    return fail("spec-json");
  }
  if (!doc.is_object()) return fail("spec-shape");
  // Exact top-level field set — nothing extra is tolerated.
  const std::set<std::string> allowed = {"v", "ownerPid", "executable", "args", "cwd", "env"};
  for (auto& [k, _] : doc.items())
    if (!allowed.count(k)) return fail("spec-field");

  if (!doc.contains("v") || !doc["v"].is_number_unsigned() ||
      doc["v"].get<uint64_t>() != kSpecVersion)
    return fail("spec-version");
  if (!doc.contains("ownerPid") || !doc["ownerPid"].is_number_unsigned())
    return fail("spec-ownerpid");
  const uint64_t pid = doc["ownerPid"].get<uint64_t>();
  if (pid == 0 || pid > 0x7FFFFFFF) return fail("spec-ownerpid");

  Spec s;
  s.ownerPid = static_cast<uint32_t>(pid);

  auto getStr = [&](const char* field, size_t maxLen, std::string& out) -> const char* {
    if (!doc.contains(field) || !doc[field].is_string()) return "spec-field-type";
    const std::string v = doc[field].get<std::string>();
    if (v.empty() || v.size() > maxLen || containsNul(v) || !validUtf8Strict(v))
      return "spec-field-value";
    out = v;
    return nullptr;
  };
  if (const char* e = getStr("executable", kMaxPathUtf8, s.exe)) return fail(e);
  if (const char* e = getStr("cwd", kMaxPathUtf8, s.cwd)) return fail(e);
  if (!isAbsoluteWinPath(s.exe) || !hasExeExtension(s.exe)) return fail("spec-executable");
  if (!isAbsoluteWinPath(s.cwd)) return fail("spec-cwd");

  if (!doc.contains("args") || !doc["args"].is_array() ||
      doc["args"].size() > kMaxArgs)
    return fail("spec-args");
  for (auto& a : doc["args"]) {
    if (!a.is_string()) return fail("spec-args");
    const std::string v = a.get<std::string>();
    if (v.size() > kMaxArgUtf8 || containsNul(v) || !validUtf8Strict(v))
      return fail("spec-args");
    s.args.push_back(v);
  }

  if (!doc.contains("env") || !doc["env"].is_object() ||
      doc["env"].size() > kMaxEnvEntries)
    return fail("spec-env");
  {
    std::set<std::string> lowered;
    for (auto& [k, val] : doc["env"].items()) {
      if (!isValidEnvKey(k) || containsNul(k) || !val.is_string()) return fail("spec-env-key");
      const std::string v = val.get<std::string>();
      if (v.size() > kMaxEnvValueUtf8 || containsNul(v) || !validUtf8Strict(v))
        return fail("spec-env-value");
      if (!lowered.insert(lowerAscii(k)).second) return fail("spec-env-duplicate");
      s.env.emplace_back(k, v);
    }
  }
  return s;
}

std::optional<TerminalSpec> parseTerminalSpec(std::string_view jsonUtf8,
                                              std::string& err) {
  auto fail = [&err](const char* code) -> std::optional<TerminalSpec> {
    err = code;
    return std::nullopt;
  };
  if (jsonUtf8.empty() || jsonUtf8.size() > kMaxSpecJsonBytes)
    return fail("tspec-size");
  if (!validUtf8Strict(jsonUtf8)) return fail("tspec-utf8");
  const ScanCode scan = scanSpecJson(jsonUtf8);
  if (scan == ScanCode::kTooDeep) return fail("tspec-depth");
  if (scan != ScanCode::kOk) return fail("tspec-duplicate-field");

  nlohmann::json doc;
  try {
    doc = nlohmann::json::parse(jsonUtf8);
  } catch (...) {
    return fail("tspec-json");
  }
  if (!doc.is_object()) return fail("tspec-shape");
  const std::set<std::string> allowed = {"v", "ownerPid", "cols", "rows", "cwd", "env"};
  for (auto& [k, _] : doc.items())
    if (!allowed.count(k)) return fail("tspec-field");

  if (!doc.contains("v") || !doc["v"].is_number_unsigned() ||
      doc["v"].get<uint64_t>() != kTerminalSpecVersion)
    return fail("tspec-version");
  if (!doc.contains("ownerPid") || !doc["ownerPid"].is_number_unsigned())
    return fail("tspec-ownerpid");
  const uint64_t pid = doc["ownerPid"].get<uint64_t>();
  if (pid == 0 || pid > 0x7FFFFFFF) return fail("tspec-ownerpid");

  auto dim = [&](const char* field, uint32_t lo, uint32_t hi,
                 uint32_t& out) -> const char* {
    if (!doc.contains(field) || !doc[field].is_number_unsigned())
      return "tspec-dim";
    const uint64_t v = doc[field].get<uint64_t>();
    if (v < lo || v > hi) return "tspec-dim";
    out = static_cast<uint32_t>(v);
    return nullptr;
  };
  TerminalSpec s;
  s.ownerPid = static_cast<uint32_t>(pid);
  if (const char* e = dim("cols", kTermColsMin, kTermColsMax, s.cols)) return fail(e);
  if (const char* e = dim("rows", kTermRowsMin, kTermRowsMax, s.rows)) return fail(e);

  if (!doc.contains("cwd") || !doc["cwd"].is_string()) return fail("tspec-cwd");
  s.cwd = doc["cwd"].get<std::string>();
  if (s.cwd.empty() || s.cwd.size() > kMaxPathUtf8 || containsNul(s.cwd) ||
      !validUtf8Strict(s.cwd))
    return fail("tspec-cwd");
  if (!isAbsoluteWinPath(s.cwd)) return fail("tspec-cwd");

  if (!doc.contains("env") || !doc["env"].is_object() ||
      doc["env"].size() > kMaxEnvEntries)
    return fail("tspec-env");
  {
    std::set<std::string> lowered;
    for (auto& [k, val] : doc["env"].items()) {
      if (!isValidEnvKey(k) || containsNul(k) || !val.is_string())
        return fail("tspec-env-key");
      const std::string v = val.get<std::string>();
      if (v.size() > kMaxEnvValueUtf8 || containsNul(v) || !validUtf8Strict(v))
        return fail("tspec-env-value");
      if (!lowered.insert(lowerAscii(k)).second) return fail("tspec-env-duplicate");
      s.env.emplace_back(k, v);
    }
  }
  return s;
}

std::u16string quoteArgUtf16(std::string_view utf8Arg) {
  // Windows CRT rule (CommandLineToArgvW): wrap in quotes; backslashes are
  // literal EXCEPT a run directly before a quote or the closing quote,
  // which must be doubled; a literal quote becomes \".
  std::u16string in;
  if (!utf8ToUtf16(utf8Arg, in)) return u"\"\"";
  std::u16string out;
  out.reserve(in.size() + 4);
  out.push_back(u'"');
  size_t i = 0;
  while (i < in.size()) {
    size_t slashes = 0;
    while (i < in.size() && in[i] == u'\\') { slashes++; i++; }
    if (i == in.size()) {
      out.append(slashes * 2, u'\\');  // run before closing quote
    } else if (in[i] == u'"') {
      out.append(slashes * 2 + 1, u'\\');
      out.push_back(u'"');
      i++;
    } else {
      out.append(slashes, u'\\');      // literal run
      out.push_back(in[i]);
      i++;
    }
  }
  out.push_back(u'"');
  return out;
}

bool buildCommandLine(const Spec& spec, std::u16string& out, std::string& err) {
  out = quoteArgUtf16(spec.exe);
  for (const auto& a : spec.args) {
    out.push_back(u' ');
    out += quoteArgUtf16(a);
    if (out.size() > kMaxCommandLineChars) {
      err = "command-line-size";
      return false;
    }
  }
  return true;
}

bool buildEnvBlock(const std::vector<std::pair<std::string, std::string>>& in,
                   std::u16string& out, std::string& err) {
  std::vector<std::pair<std::string, std::string>> env = in;
  // Sort case-insensitive-ordinal (CreateProcess convention for its env
  // block: uppercase-insensitive order, '=' never first — our key form
  // already guarantees that).
  std::sort(env.begin(), env.end(), [](const auto& a, const auto& b) {
    // Case-insensitive ordinal order = uppercase-folded byte order.
    const std::string la = upperAscii(a.first), lb = upperAscii(b.first);
    if (la != lb) return la < lb;
    return a.first < b.first;  // deterministic tie-break for mixed case
  });
  out.clear();
  for (const auto& [k, v] : env) {
    std::u16string kv;
    if (!utf8ToUtf16(k + "=" + v, kv)) {
      err = "env-utf16";
      return false;
    }
    out += kv;
    out.push_back(u'\0');
  }
  out.push_back(u'\0');  // block terminator
  return true;
}

bool buildEnvBlock(const Spec& spec, std::u16string& out, std::string& err) {
  return buildEnvBlock(spec.env, out, err);
}

int b64std(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

std::string b64Encode(std::string_view bytes) {
  static const char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((bytes.size() + 2) / 3) * 4);
  size_t i = 0;
  while (i + 3 <= bytes.size()) {
    const uint32_t v = (static_cast<uint32_t>(static_cast<uint8_t>(bytes[i])) << 16) |
                       (static_cast<uint32_t>(static_cast<uint8_t>(bytes[i + 1])) << 8) |
                       static_cast<uint8_t>(bytes[i + 2]);
    out.push_back(kAlphabet[(v >> 18) & 63]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
    out.push_back(kAlphabet[(v >> 6) & 63]);
    out.push_back(kAlphabet[v & 63]);
    i += 3;
  }
  const size_t rem = bytes.size() - i;
  if (rem == 1) {
    const uint32_t v = static_cast<uint32_t>(static_cast<uint8_t>(bytes[i])) << 16;
    out.push_back(kAlphabet[(v >> 18) & 63]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
    out += "==";
  } else if (rem == 2) {
    const uint32_t v = (static_cast<uint32_t>(static_cast<uint8_t>(bytes[i])) << 16) |
                       (static_cast<uint32_t>(static_cast<uint8_t>(bytes[i + 1])) << 8);
    out.push_back(kAlphabet[(v >> 18) & 63]);
    out.push_back(kAlphabet[(v >> 12) & 63]);
    out.push_back(kAlphabet[(v >> 6) & 63]);
    out.push_back('=');
  }
  return out;
}

bool b64Decode(std::string_view in, std::vector<uint8_t>& out) {
  out.clear();
  if (in.empty()) return true;
  // '=' padding may only appear as the final one or two characters.
  size_t pad = 0;
  while (pad < in.size() && in[in.size() - 1 - pad] == '=') pad++;
  if (pad > 2) return false;
  const size_t body = in.size() - pad;
  if (body % 4 == 1) return false;
  if (pad != 0 &&
      (in.size() % 4 != 0 ||
       (body % 4 == 2 ? pad != 2 : body % 4 == 3 ? pad != 1 : true)))
    return false;
  out.reserve((body / 4) * 3 + 3);
  uint32_t acc = 0;
  int bits = 0;
  for (size_t i = 0; i < body; i++) {
    const int v = b64std(in[i]);
    if (v < 0) return false;
    acc = (acc << 6) | static_cast<uint32_t>(v);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<uint8_t>((acc >> bits) & 0xFF));
    }
  }
  // Leftover bits (body%4 in {2,3}) must be zero — canonical encoding only.
  if (bits > 0 && (acc & ((1u << bits) - 1u)) != 0) return false;
  return true;
}

size_t utf8TailBytes(std::string_view s) {
  const size_t n = s.size();
  for (size_t back = 1; back <= 4 && back <= n; back++) {
    const uint8_t c = static_cast<uint8_t>(s[n - back]);
    if ((c & 0x80) == 0) return 0;           // ASCII — sequence complete
    if ((c & 0xC0) == 0x80) continue;        // continuation — look back further
    size_t need = 0;
    if ((c & 0xE0) == 0xC0) need = 2;
    else if ((c & 0xF0) == 0xE0) need = 3;
    else if ((c & 0xF8) == 0xF0) need = 4;
    else return 0;                            // invalid lead — not a prefix
    return back < need ? back : 0;
  }
  return 0;
}

}  // namespace th
