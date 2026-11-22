// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-46 (frozen previews .1/.32): reply tables wrap long cells so only a
// genuinely too-wide table scrolls, and the spacing around turns, lines,
// lists, quote bars, table dividers and code scales with font size (em).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../src/renderer/styles.css"), "utf8");

describe("P2-46 table fit", () => {
  it("keeps every table inside a horizontal scroll wrap", () => {
    expect(css).toContain(".msg .md-table-wrap");
    expect(css).toContain("overflow-x: auto;");
  });
  it("lets long cells wrap instead of stretching the table", () => {
    expect(css).toContain("overflow-wrap: anywhere;");
  });
});

describe("P2-46 spacing rhythm", () => {
  it("spaces blocks in em units that scale with font size", () => {
    expect(css).toMatch(/\.msg p \{\r?\n  margin: 0\.55em 0;/);
    expect(css).toMatch(/\.msg ul,\r?\n\.msg ol \{\r?\n  margin: 0\.45em 0;/);
    expect(css).toContain("padding: 0.4em 0.65em;");
    expect(css).toContain("padding: 0.7em 0.85em;");
  });
  it("balances nested lists and gives turns more room", () => {
    expect(css).toContain(".msg li ul,");
    expect(css).toMatch(/\.timeline \{[^}]*gap: 14px;/s);
  });
});
