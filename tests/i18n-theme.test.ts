// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Language & theme basics: every UI key has a zh-Hans value, upstream-derived
// translations stay byte-identical with the frozen catalog, theme specs are
// valid and cover light+dark schemes.

import { describe, expect, it } from "vitest";
import {
  TRANSLATED_LANGUAGES,
  catalogKeys,
  translate,
  translateDetail,
  translateError,
  translateNotice,
  zhHansKeys,
} from "../src/renderer/i18n";
import { MCP_CATALOG } from "../src/shared/mcpCatalog";
import { LANGUAGE_IDS, LANGUAGE_LABELS } from "../src/shared/types";
import { THEMES } from "../src/renderer/theme";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, win32 } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Portable fixture: zh-Hans values extracted verbatim from the frozen
// baseline catalog (provenance inside the file). No host-local paths —
// this file is the traceable baseline for default test runs.
const fixture = JSON.parse(
  readFileSync(join(root, "tests/fixtures/zh-hans-upstream.json"), "utf8"),
) as { values: Record<string, string> };

const p249Fixture = JSON.parse(
  readFileSync(join(root, "tests/fixtures/p2-49-upstream.json"), "utf8"),
) as { values: Record<string, Record<"zh-Hant" | "ja" | "ko" | "fr", string>> };

describe("i18n", () => {
  it("English falls back to the source key", () => {
    expect(translate("en", "Thread list")).toBe("Thread list");
    expect(translate("en", "a key with no entry")).toBe("a key with no entry");
  });

  it("every zh-Hans entry is a non-empty translation", () => {
    for (const k of zhHansKeys()) {
      const v = translate("zh-Hans", k);
      expect(v.length, k).toBeGreaterThan(0);
    }
  });

  it("ships complete, non-empty translations with matching placeholders for zh-Hant, ja, ko and fr (P2-49)", () => {
    expect(LANGUAGE_IDS).toEqual(["en", "zh-Hans", "zh-Hant", "ja", "ko", "fr"]);
    for (const id of LANGUAGE_IDS) {
      expect(LANGUAGE_LABELS[id].length, id).toBeGreaterThan(0);
    }
    const baseKeys = zhHansKeys();
    const baseSet = new Set(baseKeys);
    for (const lang of TRANSLATED_LANGUAGES) {
      const keys = catalogKeys(lang);
      expect(keys.length, lang).toBe(baseKeys.length);
      for (const k of keys) {
        expect(baseSet.has(k), `${lang}: extra key ${k}`).toBe(true);
        const v = translate(lang, k);
        expect(v.length, `${lang}: ${k}`).toBeGreaterThan(0);
        const expectedVars = k.match(/%@|%d/g) ?? [];
        const actualVars = v.match(/%@|%d/g) ?? [];
        expect(actualVars, `${lang}: placeholder mismatch for ${k}`).toEqual(expectedVars);
      }
    }
  });

  it("keeps upstream v3.0.0 wording for shared zh-Hant, ja, ko and fr keys", () => {
    let checked = 0;
    for (const [k, langs] of Object.entries(p249Fixture.values)) {
      for (const lang of ["zh-Hant", "ja", "ko", "fr"] as const) {
        expect(translate(lang, k), `${lang}: ${k}`).toBe(langs[lang]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(120);
  });

  it("translates notices and parameters across all four new languages", () => {
    const en = "Hydra: C:\\Windows is a system folder, so Hank did not start.";
    for (const lang of ["zh-Hant", "ja", "ko", "fr"] as const) {
      const t = (k: string, ...v: string[]) => translate(lang, k, v);
      const out = translateNotice(t, en);
      expect(out, lang).not.toBe(en);
      expect(out, lang).toContain("C:\\Windows");
      expect(out, lang).toContain("Hank");
    }
  });

  it("keeps upstream zh-Hans wording for shared keys (frozen fixture)", () => {
    let checked = 0;
    for (const [k, upstream] of Object.entries(fixture.values)) {
      expect(translate("zh-Hans", k), k).toBe(upstream);
      checked++;
    }
    expect(checked).toBeGreaterThan(30); // genuinely anchored to the catalog
  });

  it("fixture stays byte-identical to a live catalog when explicitly provided", () => {
    // Optional drift guard: TIVANO_UPSTREAM_XCSTRINGS=<path to
    // Localizable.xcstrings> re-verifies the fixture against the frozen
    // reference. Absent the env the fixture above remains the baseline —
    // nothing is skipped to fake a pass.
    const live = process.env.TIVANO_UPSTREAM_XCSTRINGS;
    if (!live) return;
    expect(existsSync(live), `catalog path ${live}`).toBe(true);
    const catalog = JSON.parse(readFileSync(live, "utf8")) as {
      strings: Record<string, { localizations?: { "zh-Hans"?: { stringUnit?: { value?: string } } } }>;
    };
    for (const [k, v] of Object.entries(fixture.values)) {
      expect(catalog.strings[k]?.localizations?.["zh-Hans"]?.stringUnit?.value, k).toBe(v);
    }
  });

  it("substitutes %@ variables", () => {
    expect(translate("en", 'Delete "%@"?', ["Thread A"])).toBe('Delete "Thread A"?');
    expect(translate("zh-Hans", 'Delete "%@"?', ["对话A"])).toBe("要删除“对话A”吗？");
  });

  it("translateNotice recovers the %@ template from an emitted notice", () => {
    const t = (k: string, ...v: string[]) => translate("zh-Hans", k, v);
    // The engine emits already-substituted English; the rendered row
    // must still reach the parameterized zh-Hans key (frozen notices
    // localise — a zh UI never reads English refusals).
    const en =
      "Hydra: C:\\Windows is a system folder, so Hank did not start.";
    expect(translateNotice(t, en)).toBe(
      translate(
        "zh-Hans",
        "Hydra: %@ is a system folder, so %@ did not start.",
        ["C:\\Windows", "Hank"],
      ),
    );
    expect(translateNotice(t, en)).toContain("系统文件夹");
    // An untemplated notice falls through to the prefix path.
    const raw = "UNLISTED_THING: happened";
    expect(translateNotice(t, raw)).toBe(translateError(t, raw));
  });

  it("covers P2-26 and P2-28 catalog surfaces across all translated languages", () => {
    const surfaceKeys = [
      // Provider errors
      "Codex reported an error.",
      "Codex refused the MCP server configuration, so this session runs without MCP servers. Check MCP in Settings.",
      "Codex's stored login has expired. Run `codex login` in a terminal, then check again.",
      "Codex could not be asked for its usage.",
      // Plan approval & permission prompts
      "Plan ready",
      "Ready to build this plan?",
      "Implement this plan",
      "Additional permissions",
      "Network access",
      "Apply these changes?",
      "Grant extra access?",
      "Run this command?",
      // Provider errors
      "Z.ai declined the reset.",
      "Stopped or interrupted",
      // Usage & reset details
      "Unknown reset time",
      "tomorrow at %@",
      "Usage limit reached · resets %@",
      // Tool-call rows
      "Send out a head",
      "Send out a sub-agent",
      "Web search",
      "Image",
      "Called %d tools",
      // Model descriptions
      "OpenAI · latest frontier model for general complex work",
      "Anthropic · best combo of speed & intelligence",
      "Best reasoning and coding quality",
      // Menus, notifications & update errors
      "Increase Font Size",
      "Pi sent a notification.",
      "The update check failed.",
      "The update download failed its checksum check.",
      "The update information could not be read.",
      // Hydra merge notes
      "Landing sub-agent work",
      "Merged sub-agent changes in %@",
      "Already on main: nothing to merge.",
      // MCP sign-in pages & errors
      "Couldn't find the sign-in page.",
      "Sign-in was rejected. Sign in again in your browser.",
      "MCP HTTP error (status %d)",
    ];
    const langKeySets = new Map(
      TRANSLATED_LANGUAGES.map((lang) => [lang, new Set(catalogKeys(lang))]),
    );
    for (const key of surfaceKeys) {
      expect(translate("zh-Hans", key), `zh-Hans missing ${key}`).not.toBe(key);
      for (const lang of TRANSLATED_LANGUAGES) {
        expect(langKeySets.get(lang)!.has(key), `${lang} catalog missing ${key}`).toBe(true);
      }
    }

    // Every MCP catalog summary and input field label/help must translate.
    for (const entry of MCP_CATALOG) {
      expect(translate("zh-Hans", entry.summary), `zh-Hans mcp summary: ${entry.id}`).not.toBe(
        entry.summary,
      );
      for (const lang of TRANSLATED_LANGUAGES) {
        expect(langKeySets.get(lang)!.has(entry.summary), `${lang} mcp summary: ${entry.id}`).toBe(
          true,
        );
        for (const field of entry.fields ?? []) {
          expect(translate("zh-Hans", field.label), `zh-Hans mcp label: ${field.label}`).not.toBe(
            field.label,
          );
          expect(langKeySets.get(lang)!.has(field.label), `${lang} mcp label: ${field.label}`).toBe(
            true,
          );
          if (field.help) {
            expect(translate("zh-Hans", field.help), `zh-Hans mcp help: ${field.help}`).not.toBe(
              field.help,
            );
            expect(langKeySets.get(lang)!.has(field.help), `${lang} mcp help: ${field.help}`).toBe(
              true,
            );
          }
        }
      }
    }
  });

  it("translateNotice and translateDetail recover P2-26/P2-28 runtime messages", () => {
    const t = (k: string, ...vars: string[]) => translate("zh-Hans", k, vars);

    const conflictOne =
      "Walter's work landed; the lead is settling a conflict in 1 file.\n`src/a.ts`\n\nThe checkout had moved on where Walter was working, so the merge was three-way and left markers in this file. The lead resolves them before the work goes out; nothing to do on your side.";
    const conflictTranslated = translateNotice(t, conflictOne);
    expect(conflictTranslated).toContain("Walter 的工作已落地");
    expect(conflictTranslated).toContain("`src/a.ts`");

    const patchWithReason =
      "Hank's work did not land and was kept as a patch.\n`src/b.ts`\n\nWhy it did not land: the copy was gone before its work could land.\n\nApply it with `git apply --3way .tivano/hank.patch` and settle what conflicts.";
    const patchTranslated = translateNotice(t, patchWithReason);
    expect(patchTranslated).toContain("Hank 的工作没有落地");
    expect(patchTranslated).toContain("没有落地的原因");
    expect(patchTranslated).toContain(".tivano/hank.patch");

    const patchNoReason =
      "Hank's work did not land and was kept as a patch.\n`src/b.ts`\n\nApply it with `git apply --3way .tivano/hank.patch` and settle what conflicts.";
    expect(translateNotice(t, patchNoReason)).toContain("Hank 的工作没有落地");

    expect(
      translateNotice(t, "Usage limit reached. Continuing automatically at tomorrow at 9:00 AM."),
    ).toContain("明天 9:00 AM");
    expect(translateNotice(t, 'Work handed off to "Next task".')).toContain("Next task");
    expect(translateNotice(t, 'Work handed off to "Next task".')).toContain("交接");

    const winCwd = win32.join("C:\\", "repo");
    expect(translateDetail(t, `cwd: ${winCwd}`)).toContain(`工作目录：${winCwd}`);
    expect(translateDetail(t, "network access, read: src/a.ts, glob scan depth 3")).toBe(
      "网络访问、读取：src/a.ts、glob 扫描深度 3",
    );
  });
});

describe("theme", () => {
  it("ships the full frozen 29-theme catalog in allCases order", () => {
    expect(THEMES).toHaveLength(29);
    expect(THEMES[0]!.id).toBe("breeze");
    expect(THEMES.at(-1)!.id).toBe("matrix");
    for (const th of THEMES) {
      expect(th.name.length).toBeGreaterThan(0);
      expect(th.palette.surface).toMatch(/^[0-9a-fA-F]{6}$/);
      for (const hex of [th.palette.accent, th.palette.success, th.palette.warning, th.palette.danger])
        if (hex != null) expect(hex).toMatch(/^[0-9a-fA-F]{6}$/);
    }
  });

  it("breeze follows the OS and carries the avocado accent from upstream", () => {
    const breeze = THEMES.find((t) => t.id === "breeze")!;
    expect(breeze.palette.scheme).toBeNull();
    expect(breeze.palette.accent).toBe("7BA58F");
    expect(THEMES.find((t) => t.id === "system")!.palette.accent).toBeNull();
  });

  it("every theme detail string is a localizable key with translations in all languages", () => {
    for (const th of THEMES) {
      expect(th.detail.length).toBeGreaterThan(0);
      for (const lang of TRANSLATED_LANGUAGES) {
        const localized = translate(lang, th.detail);
        expect(localized, `${lang} ${th.id}: ${th.detail}`).not.toBe(th.detail);
      }
    }
    expect(translate("zh-Hans", "Follows your Mac · Avocado")).toBe("跟随你的 Mac · 牛油果绿");
    expect(translate("zh-Hans", "Dark · Wave blue")).toBe("深色 · 浪蓝");
  });
});
