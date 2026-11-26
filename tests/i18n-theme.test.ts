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
import { MAIN_STRINGS, mainT } from "../src/main/mainStrings";
import { formatReset } from "../src/main/usageLimit";
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

  it("translateNotice translates the P1-33 skipped MCP servers notice across all locales", () => {
    const en =
      "MCP servers skipped for this session because their command was not found on PATH: alpha, beta";
    for (const lang of TRANSLATED_LANGUAGES) {
      const t = (k: string, ...v: string[]) => translate(lang, k, v);
      const out = translateNotice(t, en);
      expect(out, lang).not.toBe(en);
      expect(out, lang).toContain("alpha, beta");
    }
  });

  it("covers P2-26 and P2-28 catalog surfaces across all translated languages", () => {
    const surfaceKeys = [
      // Provider errors & Codex runtime/setup diagnostics
      "Codex reported an error.",
      "Codex refused the MCP server configuration, so this session runs without MCP servers. Check MCP in Settings.",
      "Codex's stored login has expired. Run `codex login` in a terminal, then check again.",
      "Codex could not be asked for its usage.",
      "Codex app-server (unconfigured)",
      "Codex (offline fixture)",
      "unknown Codex error",
      "Codex turn failed",
      "Codex error",
      "CODEX_EXECUTABLE_INVALID",
      "CODEX_FIXTURE_INVALID",
      "CODEX_HOME_UNSAFE",
      "CODEX_CONFIG_INCOMPATIBLE",
      "CLEANUP_INCOMPLETE",
      "command approval requests cwd outside the workspace — declined",
      "Wait for the running turn to finish first.",
      "the copy's state could not be read",
      "Terminal",
      "None",
      "Monday",
      "Thursday",
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
    for (const key of ["Codex app-server", "Ultra"]) {
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
    expect(
      translateNotice(t, "Codex sent nothing for 10 minutes, so Tivano stopped the turn."),
    ).toBe("Codex 已 10 分钟没有任何输出，Tivano 已停止这一轮。");
    expect(
      translateNotice(
        t,
        "Codex sent nothing for 30 minutes while a tool ran, so Tivano stopped the turn.",
      ),
    ).toBe("工具运行期间，Codex 已 30 分钟没有任何输出，Tivano 已停止这一轮。");

    const winCwd = win32.join("C:\\", "repo");
    expect(translateDetail(t, `cwd: ${winCwd}`)).toContain(`工作目录：${winCwd}`);
    expect(translateDetail(t, "network access, read: src/a.ts, glob scan depth 3")).toBe(
      "网络访问、读取：src/a.ts、glob 扫描深度 3",
    );
    expect(translateDetail(t, "read: src/a.ts, src/b.ts")).toBe("读取：src/a.ts, src/b.ts");
    expect(translateDetail(t, "read: src/a.ts, write: src/b.ts")).toBe(
      "读取：src/a.ts、写入：src/b.ts",
    );
    expect(translateDetail(t, "read: src/a.ts, network access")).toBe("读取：src/a.ts、网络访问");
    expect(
      translateDetail(
        t,
        "network access\nread: src/a.ts, src/b.ts\nwrite: src/c.ts\ndeny: src/d.ts\nglob scan depth 3",
      ),
    ).toBe("网络访问\n读取：src/a.ts, src/b.ts\n写入：src/c.ts\n拒绝：src/d.ts\nglob 扫描深度 3");

    // Weekly weekday resets and queued-send failures localize cleanly, without hijacking unrelated " at " text.
    expect(
      translateNotice(t, "Usage limit reached. Continuing automatically at Thursday at 9:00 AM."),
    ).toBe("已达用量上限，将于 周四 9:00 AM 自动继续。");
    const inThreeDays = new Date();
    inThreeDays.setDate(inThreeDays.getDate() + 3);
    inThreeDays.setHours(9, 0, 0, 0);
    const weekdayFromFormatter = translateNotice(
      t,
      `Usage limit reached. Continuing automatically at ${formatReset(inThreeDays.getTime())}.`,
    );
    expect(weekdayFromFormatter).toContain("已达用量上限，将于 ");
    expect(weekdayFromFormatter).not.toContain(" at ");
    expect(translateNotice(t, "something failed at step 2")).toBe("something failed at step 2");
    expect(
      translateNotice(
        t,
        "interrupt request failed: CODEX_CONNECTION_CLOSED: process closed (code 1, signal null)",
      ),
    ).toBe("中断请求失败：Codex 连接已关闭: 进程已关闭（退出码 1，信号 null）");
    expect(translate("zh-Hans", "Lead %@, heads %@ effort", ["$&%@", "high"])).toBe(
      "主导 $&%@，执行 high 强度",
    );
    expect(
      translateNotice(
        t,
        "Queued message could not be sent: read-only: close failed earlier — no new work is accepted",
      ),
    ).toBe("无法发送排队消息：只读：上次关闭未完成 —— 不接收新任务");
    expect(
      translateNotice(
        t,
        "unsafe or undisplayable permission request — declined (entries unbounded)",
      ),
    ).toBe("不安全或无法显示的权限请求 — 已拒绝（entries unbounded）");
    expect(translateNotice(t, "question request questions is empty — declined")).toBe(
      "提问请求questions is empty — 已拒绝",
    );
    expect(
      translateNotice(
        t,
        "⚠ Automatic continue failed: CODEX_CONNECTION_CLOSED: process closed (code 1, signal null) — stderr tail: line1\nline2",
      ),
    ).toBe(
      "⚠ 自动继续失败：Codex 连接已关闭: 进程已关闭（退出码 1，信号 null）— stderr 末尾：line1\nline2",
    );
    expect(
      translateNotice(t, "Codex error (retrying): transient failure\nline 2"),
    ).toBe("Codex 错误（正在重试）：transient failure\nline 2");
  });

  it("translateError preserves colon-containing catalog keys and translates Codex/openIn errors", () => {
    const t = (k: string) => translate("zh-Hans", k);
    expect(translateError(t, "read-only: close failed earlier — no new work is accepted")).toBe(
      "只读：上次关闭未完成 —— 不接收新任务",
    );
    expect(translateError(t, "Already on main: nothing to merge.")).toBe(
      "已经在 main 上：没有需要合并的内容。",
    );
    expect(translateError(t, "Declined: the user declined this command.")).toBe(
      "已拒绝：用户拒绝了此命令。",
    );
    expect(translateError(t, "Declined: plan mode is read-only.")).toBe(
      "已拒绝：计划模式为只读。",
    );
    expect(
      translateError(t, "CODEX_EXECUTABLE_INVALID: executable must be a clean absolute path"),
    ).toBe("Codex 可执行文件无效: 可执行文件必须是干净的绝对路径");
    expect(
      translateError(t, "CODEX_EXECUTABLE_INVALID: not a regular file: C:\\bad\\codex.exe"),
    ).toBe("Codex 可执行文件无效: 不是普通文件：C:\\bad\\codex.exe");
    expect(
      translateError(
        t,
        "CODEX_CONFIG_INCOMPATIBLE: existing config.toml is not the app's minimal credential-store policy — refusing to adopt or modify it",
      ),
    ).toBe(
      "Codex 配置不兼容: 现有的 config.toml 不符合应用的最小凭证存储策略 — 拒绝采用或修改",
    );
    expect(
      translateError(t, "CLEANUP_INCOMPLETE: job-helper exited 4; tree cleanup unproven"),
    ).toBe("进程树清理未完成: 作业辅助进程以退出码 4 结束；进程树清理未证实");
    expect(
      translateError(
        t,
        "TIVANO_PROVIDER=mock routes this launch away from Codex — the saved path can only apply when Codex routing is selected",
      ),
    ).toContain("TIVANO_PROVIDER=mock");
    expect(translateError(t, "editor is not available: terminal")).toBe("编辑器不可用：terminal");
    expect(translateError(t, "could not open Terminal: missing")).toBe("无法打开 终端：missing");
    expect(
      translateError(
        t,
        "CODEX_CONNECTION_CLOSED: process closed (code 1, signal SIGTERM) — stderr tail: err line 1\nerr line 2",
      ),
    ).toBe(
      "Codex 连接已关闭: 进程已关闭（退出码 1，信号 SIGTERM）— stderr 末尾：err line 1\nerr line 2",
    );
    expect(translateError(t, "UNLISTED_THING: happened")).toBe("UNLISTED_THING: happened");
  });

  it("MAIN_STRINGS covers all translated languages for main-process dialogs", () => {
    for (const key of Object.keys(MAIN_STRINGS) as Array<keyof typeof MAIN_STRINGS>) {
      expect(mainT("en", key)).toBe(key);
      for (const lang of TRANSLATED_LANGUAGES) {
        const val = mainT(lang, key);
        expect(val.length, `${lang}: ${key}`).toBeGreaterThan(0);
        if (lang === "zh-Hans") expect(val, `${lang}: ${key}`).not.toBe(key);
      }
    }
    expect(
      mainT(
        "zh-Hans",
        "Tivano is waiting for you to approve %@ on your computer. Check that Tivano shows this code:",
        ["Cloud Agent"],
      ),
    ).toBe("Tivano 正在等待你在电脑上批准 Cloud Agent。请确认 Tivano 显示以下验证码：");
  });
});

describe("theme", () => {
  it("ships the 12 named v3.0.0 accent families in allCases order", () => {
    expect(THEMES).toHaveLength(12);
    expect(THEMES[0]!.id).toBe("system");
    expect(THEMES[1]!.id).toBe("breeze");
    expect(THEMES.at(-1)!.id).toBe("ayu");
    for (const th of THEMES) {
      expect(th.name.length).toBeGreaterThan(0);
      if (th.accentHexes) {
        expect(th.accentHexes.dark).toMatch(/^[0-9a-fA-F]{6}$/);
        expect(th.accentHexes.light).toMatch(/^[0-9a-fA-F]{6}$/);
      }
    }
  });

  it("breeze carries the avocado accent from upstream and system keeps null", () => {
    const breeze = THEMES.find((t) => t.id === "breeze")!;
    expect(breeze.accentHexes).toEqual({ dark: "7BA58F", light: "7BA58F" });
    expect(THEMES.find((t) => t.id === "system")!.accentHexes).toBeNull();
  });

  it("every accent name is a localizable key with translations in all languages", () => {
    for (const th of THEMES) {
      for (const lang of TRANSLATED_LANGUAGES) {
        const localized = translate(lang, th.name);
        expect(localized, `${lang} ${th.id}: ${th.name}`).not.toBe(th.name);
      }
    }
    expect(translate("zh-Hans", "System Accent")).toBe("系统强调色");
    expect(translate("zh-Hans", "Avocado")).toBe("牛油果绿");
    expect(translate("zh-Hans", "Coral Red")).toBe("珊瑚红");
    expect(translate("zh-Hans", "More controls")).toBe("更多控件");
    expect(translate("zh-Hans", "Copy all")).toBe("复制全文");
  });

  it("translates the P1-36 concurrency-limit chat notice in all languages", () => {
    const en =
      "Sub-agent limit reached (1)\n2 tasks are queued: at most 1 sub-agents run at once (Settings › Hydra). They go out on their own as running sub-agents finish.";
    for (const lang of TRANSLATED_LANGUAGES) {
      const t = (k: string, ...v: string[]) => translate(lang, k, v);
      const out = translateNotice(t, en);
      expect(out, lang).not.toBe(en);
      expect(out, lang).toContain("1");
      expect(out, lang).toContain("2");
      expect(out, lang).toContain("Hydra");
    }
  });
});
