// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../helpers/win32/terminal_mode.cpp", import.meta.url), "utf8");

describe("ConPTY stdio isolation (source guard, not Windows acceptance)", () => {
  it("explicitly clears shell standard handles while retaining atomic Job attachment", () => {
    const setup = source.slice(source.indexOf("STARTUPINFOEXW siex{};"), source.indexOf('trace("createprocess-end'));
    expect(setup).toContain("siex.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;");
    for (const name of ["hStdInput", "hStdOutput", "hStdError"])
      expect(setup).toContain(`siex.StartupInfo.${name} = nullptr;`);
    expect(setup).toContain("siex.lpAttributeList = attrList;");
    expect(setup).toMatch(/CreateProcessW\(shellW\.c_str\(\), cmdW\.data\(\), nullptr, nullptr, FALSE,/);
    expect(setup).toContain("EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT");
    expect(source).toContain("PROC_THREAD_ATTRIBUTE_JOB_LIST");
    expect(source).toContain("PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE");
    expect(setup).not.toContain("STARTF_USEHOTKEY");
  });
});
