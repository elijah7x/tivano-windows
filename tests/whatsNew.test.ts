// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-55: unit, Engine/Store integration, and React component tests for
// Settings > Version "Updated to" banner, expandable "What's new" row,
// CHANGELOG.md parsing, and persisted version tracking.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWhatsNewDigest,
  buildWhatsNewInfo,
  compareAppVersions,
  hasWhatsNewContent,
  isWhatsNewUnread,
  matchingChangelogEntries,
  parseAppVersion,
  parseChangelog,
  parseReleaseNotesDigest,
  recordWhatsNewLaunch,
  selectedReleaseNotes,
} from "../src/shared/whatsNew";
import type { AppInfo, Settings } from "../src/shared/types";
import { Store, defaultSettings, emptyStore } from "../src/main/store";
import { Engine } from "../src/main/engine";
import { MockProvider } from "../src/main/mockProvider";
import { LanguageContext } from "../src/renderer/locale";
import { translate } from "../src/renderer/i18n";
import { requestValidators } from "../src/shared/ipc";
import {
  VersionSection,
  WhatsNewBanner,
  WhatsNewRow,
} from "../src/renderer/components/WhatsNewViews";
import { SettingsModal } from "../src/renderer/components/SettingsModal";

const SAMPLE_CHANGELOG = `# Changelog

## [Unreleased]

### English

### New features

- Unreleased feature should never show.

## [0.4.0] - 2026-12-01

### English

### New features

- Future version should not show on 0.3.0.

## [0.3.0-preview.2] - 2026-11-20

### English

### New features

- Preview-only note.

## [0.3.0] - 2026-11-15

### English

### New features

- Added [What's new](https://example.com) in **Settings**.
- Added \`multi-version\` accumulation.

### Bug fixes

- Fixed duplicate bullet case.

### Refinements

- Polished version card spacing.

### Thanks

- Someone (@handle): thanks item should be excluded.

### 简体中文

### 新功能

- 在 **设置** 中新增[更新内容](https://example.com)展示。
- 支持 \`多版本\` 变更汇总。

### 问题修复

- 修复重复条目大小写去重。

### 优化改进

- 优化版本卡片间距。

## [0.2.0] - 2026-11-01

### English

### New features

- Added \`multi-version\` accumulation.
- Second version feature.

### Bug fixes

- Fixed duplicate bullet case.
- Fixed startup lock handling.

### 简体中文

### 新功能

- 支持 \`多版本\` 变更汇总。
- 第二版新功能。

### 问题修复

- 修复重复条目大小写去重。
- 修复启动锁处理。

## [0.1.0] - 2026-10-23

### English

### New features

- Initial release feature.
`;

const tempDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tivano-whatsnew-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseAppVersion & compareAppVersions", () => {
  it("parses valid versions with optional leading v and prereleases", () => {
    expect(parseAppVersion("3")).toEqual({
      components: [3, 0, 0],
      prerelease: [],
      isPrerelease: false,
    });
    expect(parseAppVersion("v0.1.0")).toEqual({
      components: [0, 1, 0],
      prerelease: [],
      isPrerelease: false,
    });
    expect(parseAppVersion("V3.0.0-preview.10")).toEqual({
      components: [3, 0, 0],
      prerelease: ["preview", "10"],
      isPrerelease: true,
    });
  });

  it("rejects malformed versions", () => {
    for (const bad of ["", "t", "1.2.3.4", "3.0.0-", "3.0.0-01", "1.2.a", "1..2"]) {
      expect(parseAppVersion(bad), bad).toBeNull();
    }
  });

  it("orders SemVer components and prereleases accurately", () => {
    const lt = (a: string, b: string) =>
      compareAppVersions(parseAppVersion(a)!, parseAppVersion(b)!) < 0;
    expect(lt("0.1.0", "0.2.0")).toBe(true);
    expect(lt("0.2.0", "0.10.0")).toBe(true);
    expect(lt("3.0.0-preview.8", "3.0.0-preview.10")).toBe(true);
    expect(lt("3.0.0-preview.10", "3.0.0")).toBe(true);
    expect(lt("3.0.0-1", "3.0.0-alpha")).toBe(true);
    expect(compareAppVersions(parseAppVersion("0.1")!, parseAppVersion("0.1.0")!)).toBe(0);
  });
});

describe("CHANGELOG parsing & release notes digest", () => {
  it("parses versioned sections and skips [Unreleased]", () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);
    expect(entries.map((e) => e.versionText)).toEqual([
      "0.4.0",
      "0.3.0-preview.2",
      "0.3.0",
      "0.2.0",
      "0.1.0",
    ]);
  });

  it("matches every stable version since previous and excludes prereleases on stable", () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);
    const matched = matchingChangelogEntries(
      entries,
      parseAppVersion("0.3.0")!,
      parseAppVersion("0.1.0")!,
    );
    expect(matched.map((e) => e.versionText)).toEqual(["0.3.0", "0.2.0"]);
  });

  it("includes prereleases when running a prerelease build", () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);
    const matched = matchingChangelogEntries(
      entries,
      parseAppVersion("0.3.0-preview.2")!,
      parseAppVersion("0.2.0")!,
    );
    expect(matched.map((e) => e.versionText)).toEqual(["0.3.0-preview.2"]);
  });

  it("does not mislabel older notes when no previous version is recorded", () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);
    // Current version 0.2.5 has no changelog entry; newest eligible is 0.2.0.
    expect(matchingChangelogEntries(entries, parseAppVersion("0.2.5")!, null)).toEqual([]);
    // Exact match returns only current version's own section.
    const exact = matchingChangelogEntries(entries, parseAppVersion("0.3.0")!, null);
    expect(exact.map((e) => e.versionText)).toEqual(["0.3.0"]);
  });

  it("selects English or zh-Hans, strips inline markdown, and excludes Thanks", () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);
    const entry030 = entries.find((e) => e.versionText === "0.3.0")!;
    const enDigest = parseReleaseNotesDigest(selectedReleaseNotes(entry030.body, "en"));
    expect(enDigest.newFeatures).toEqual([
      "Added What's new in Settings.",
      "Added multi-version accumulation.",
    ]);
    expect(enDigest.bugFixes).toEqual(["Fixed duplicate bullet case."]);
    expect(enDigest.refinements).toEqual(["Polished version card spacing."]);

    const zhDigest = parseReleaseNotesDigest(selectedReleaseNotes(entry030.body, "zh-Hans"));
    expect(zhDigest.newFeatures).toEqual([
      "在 设置 中新增更新内容展示。",
      "支持 多版本 变更汇总。",
    ]);

    // Chinese section with only headings falls back to English.
    const emptyZh = `### English\n### New features\n- English fallback\n### 简体中文\n### 新功能\n`;
    expect(selectedReleaseNotes(emptyZh, "zh-Hans")).toContain("English fallback");
  });

  it("accumulates and deduplicates bullets across versions since last run", () => {
    const digest = buildWhatsNewDigest(SAMPLE_CHANGELOG, "0.3.0", "0.1.0", "en");
    expect(digest).not.toBeNull();
    expect(digest!.versionCount).toBe(2);
    expect(digest!.oldestIncludedVersion).toBe("0.2.0");
    expect(digest!.categories.newFeatures).toEqual([
      "Added What's new in Settings.",
      "Added multi-version accumulation.",
      "Second version feature.",
    ]);
    expect(digest!.categories.bugFixes).toEqual([
      "Fixed duplicate bullet case.",
      "Fixed startup lock handling.",
    ]);
    expect(digest!.categories.refinements).toEqual(["Polished version card spacing."]);
  });
});

describe("recordWhatsNewLaunch & Store/Engine persistence", () => {
  it("marks fresh installs as seen so the one-time banner stays hidden", () => {
    const s: Settings = defaultSettings();
    expect(recordWhatsNewLaunch(s, "0.3.0", false)).toBe(true);
    expect(s.whatsNewInstalledVersion).toBe("0.3.0");
    expect(s.whatsNewPreviousVersion).toBeUndefined();
    expect(s.whatsNewSeenVersion).toBe("0.3.0");

    const digest = buildWhatsNewDigest(SAMPLE_CHANGELOG, "0.3.0", s.whatsNewPreviousVersion, "en");
    expect(hasWhatsNewContent(digest)).toBe(true);
    expect(isWhatsNewUnread(digest, s)).toBe(false);
  });

  it("shows one-time banner when an existing user upgrades onto a build with What's new", () => {
    const s: Settings = defaultSettings();
    expect(recordWhatsNewLaunch(s, "0.3.0", true)).toBe(true);
    expect(s.whatsNewInstalledVersion).toBe("0.3.0");
    expect(s.whatsNewPreviousVersion).toBeUndefined();
    expect(s.whatsNewSeenVersion).toBeUndefined();

    const digest = buildWhatsNewDigest(SAMPLE_CHANGELOG, "0.3.0", s.whatsNewPreviousVersion, "en");
    expect(isWhatsNewUnread(digest, s)).toBe(true);
  });

  it("tracks silent upgrades across restarts and persists seen state", () => {
    const root = freshDir();
    // Pre-seed store as if user previously ran 0.1.0.
    const initial = emptyStore();
    initial.settings.whatsNewInstalledVersion = "0.1.0";
    initial.settings.whatsNewSeenVersion = "0.1.0";
    writeFileSync(join(root, "store.json"), JSON.stringify(initial));

    const store1 = new Store(root);
    store1.open();
    expect(store1.hadStoreFileOnOpen).toBe(true);
    const engine1 = new Engine(store1, new MockProvider({ tickMs: 1 }), root, "0.3.0", undefined, SAMPLE_CHANGELOG);
    const info1 = engine1.info;
    expect(info1.whatsNew?.en.versionCount).toBe(2);
    expect(info1.whatsNew?.en.oldestIncludedVersion).toBe("0.2.0");
    expect(info1.whatsNew?.["zh-Hans"].categories.newFeatures[0]).toContain("更新内容");

    const snap1 = engine1.snapshot();
    expect(snap1.settings.whatsNewInstalledVersion).toBe("0.3.0");
    expect(snap1.settings.whatsNewPreviousVersion).toBe("0.1.0");
    expect(isWhatsNewUnread(info1.whatsNew?.en, snap1.settings)).toBe(true);

    // Relaunch before dismissing -> banner remains unread and previousVersion stays 0.1.0.
    engine1.shutdown();
    store1.close();

    const store2 = new Store(root);
    store2.open();
    const engine2 = new Engine(store2, new MockProvider({ tickMs: 1 }), root, "0.3.0", undefined, SAMPLE_CHANGELOG);
    expect(engine2.snapshot().settings.whatsNewPreviousVersion).toBe("0.1.0");
    expect(isWhatsNewUnread(engine2.info.whatsNew?.en, engine2.snapshot().settings)).toBe(true);

    // User clicks View or Dismiss -> seenVersion is persisted and banner hides.
    engine2.setSettings({ whatsNewSeenVersion: "0.3.0" });
    expect(isWhatsNewUnread(engine2.info.whatsNew?.en, engine2.snapshot().settings)).toBe(false);
    engine2.shutdown();
    store2.close();

    const store3 = new Store(root);
    store3.open();
    const engine3 = new Engine(store3, new MockProvider({ tickMs: 1 }), root, "0.3.0", undefined, SAMPLE_CHANGELOG);
    expect(engine3.snapshot().settings.whatsNewSeenVersion).toBe("0.3.0");
    expect(engine3.snapshot().settings.whatsNewPreviousVersion).toBe("0.1.0");
    expect(isWhatsNewUnread(engine3.info.whatsNew?.en, engine3.snapshot().settings)).toBe(false);
    expect(hasWhatsNewContent(engine3.info.whatsNew?.en)).toBe(true);
    engine3.shutdown();
    store3.close();
  });

  it("fresh install via Engine marks current version seen and reads repo CHANGELOG.md", () => {
    const root = freshDir();
    const store = new Store(root);
    store.open();
    expect(store.hadStoreFileOnOpen).toBe(false);
    const engine = new Engine(store, new MockProvider({ tickMs: 1 }), root, "0.1.0");
    const snap = engine.snapshot();
    expect(snap.settings.whatsNewInstalledVersion).toBe("0.1.0");
    expect(snap.settings.whatsNewSeenVersion).toBe("0.1.0");
    expect(snap.info.whatsNew?.en.displayVersion).toBe("0.1.0");
    expect(isWhatsNewUnread(snap.info.whatsNew?.en, snap.settings)).toBe(false);
    expect(hasWhatsNewContent(snap.info.whatsNew?.en)).toBe(true);
    engine.shutdown();
    store.close();
  });
});

describe("VersionSection, WhatsNewBanner, WhatsNewRow, and SettingsModal components", () => {
  const whatsNew = buildWhatsNewInfo(SAMPLE_CHANGELOG, "0.3.0", "0.1.0")!;

  const renderInLang = (lang: "en" | "zh-Hans", node: React.ReactElement) =>
    renderToStaticMarkup(createElement(LanguageContext.Provider, { value: lang }, node));

  it("renders unread banner + collapsed What's new row in English and zh-Hans", () => {
    const settings: Settings = {
      ...defaultSettings(),
      language: "en",
      whatsNewInstalledVersion: "0.3.0",
      whatsNewPreviousVersion: "0.1.0",
    };

    const enHtml = renderInLang(
      "en",
      createElement(VersionSection, {
        appVersion: "0.3.0",
        settings,
        whatsNew,
      }),
    );
    expect(enHtml).toContain("Updated to 0.3.0");
    expect(enHtml).toContain("2 versions · 3 new features · 2 fixes · 1 refinement");
    expect(enHtml).toContain("View");
    expect(enHtml).toContain("What&#x27;s new in 0.3.0");
    expect(enHtml).toContain('aria-expanded="false"');
    expect(enHtml).not.toContain("All release notes");

    const zhHtml = renderInLang(
      "zh-Hans",
      createElement(VersionSection, {
        appVersion: "0.3.0",
        settings: { ...settings, language: "zh-Hans" },
        whatsNew,
      }),
    );
    expect(zhHtml).toContain("已更新到 0.3.0");
    expect(zhHtml).toContain("2 个版本 · 3 项新功能 · 2 项修复 · 1 项优化");
    expect(zhHtml).toContain("查看");
    expect(zhHtml).toContain("0.3.0 更新内容");
  });

  it("hides banner once seen while keeping the expandable What's new row", () => {
    const settings: Settings = {
      ...defaultSettings(),
      language: "en",
      whatsNewInstalledVersion: "0.3.0",
      whatsNewPreviousVersion: "0.1.0",
      whatsNewSeenVersion: "0.3.0",
    };

    const html = renderInLang(
      "en",
      createElement(VersionSection, {
        appVersion: "0.3.0",
        settings,
        whatsNew,
        initialExpanded: true,
      }),
    );
    expect(html).not.toContain("Updated to 0.3.0");
    expect(html).toContain("What&#x27;s new in 0.3.0");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("New features");
    expect(html).toContain("Bug fixes");
    expect(html).toContain("Refinements");
    expect(html).toContain("Added What&#x27;s new in Settings.");
    expect(html).toContain("Fixed startup lock handling.");
    expect(html).toContain("Includes 2 versions since 0.2.0");
    expect(html).toContain("All release notes");
  });

  it("renders expanded Chinese bullets and footer when expanded in zh-Hans", () => {
    const html = renderInLang(
      "zh-Hans",
      createElement(WhatsNewRow, {
        digest: whatsNew["zh-Hans"],
        expanded: true,
        onToggle: () => {},
        onOpenReleases: () => {},
      }),
    );
    expect(html).toContain("新功能");
    expect(html).toContain("问题修复");
    expect(html).toContain("优化改进");
    expect(html).toContain("在 设置 中新增更新内容展示。");
    expect(html).toContain("包含 2 个版本（自 0.2.0 起）");
    expect(html).toContain("全部发行说明");
  });

  it("renders VersionSection inside SettingsModal without disturbing About attribution", () => {
    const info: AppInfo = {
      appVersion: "0.3.0",
      baselineTag: "v3.0.0",
      baselineCommit: "15e03374f077343e500e8e5e3574c8c598162171",
      dataRoot: "C:\\synthetic\\data",
      providerId: "mock",
      providerLabel: "Mock Provider",
      mock: true,
      mode: "mock",
      realCli: { status: "not-configured" },
      home: "C:\\synthetic\\home",
      worktreesDir: "C:\\synthetic\\data\\worktrees",
      whatsNew,
    };
    const settings: Settings = {
      ...defaultSettings(),
      language: "en",
      whatsNewInstalledVersion: "0.3.0",
      whatsNewPreviousVersion: "0.1.0",
    };

    const prevWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      tivano: {
        platform: "win32",
        invoke: async () => ({}),
        onEvent: () => () => {},
      },
    };
    let html = "";
    try {
      html = renderInLang(
        "en",
        createElement(SettingsModal, {
          settings,
          info,
          threads: [],
          projects: [],
          tokenActivity: {},
          onClose: () => {},
        }),
      );
    } finally {
      if (prevWindow === undefined) delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = prevWindow;
    }
    expect(html).toContain("Updated to 0.3.0");
    expect(html).toContain("What&#x27;s new in 0.3.0");
    expect(html).toContain("Droppy Code by Jordy Spruit");
    expect(requestValidators["settings:set"]({ whatsNewSeenVersion: "0.3.0" }).whatsNewSeenVersion).toBe("0.3.0");
  });

  it("translates all new P2-55 keys into non-empty zh-Hans strings", () => {
    const keys = [
      "Version information",
      "Version %@",
      "Updated to %@",
      "What's new in %@",
      "View",
      "New features",
      "Bug fixes",
      "Refinements",
      "%d versions",
      "1 new feature",
      "%d new features",
      "1 fix",
      "%d fixes",
      "1 refinement",
      "%d refinements",
      "Includes %d versions since %@",
      "All release notes",
      "View all releases on GitHub",
      "Expanded",
      "Collapsed",
    ];
    for (const k of keys) {
      expect(translate("zh-Hans", k, ["2", "0.1.0"]), k).not.toBe(k);
    }
    const changelog = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");
    expect(changelog).toContain("## [0.1.0]");
  });

  it("WhatsNewBanner renders singular counts cleanly", () => {
    const single = buildWhatsNewDigest(
      "## [0.1.0]\n\n### New features\n- Only one\n",
      "0.1.0",
      undefined,
      "en",
    )!;
    const html = renderInLang(
      "en",
      createElement(WhatsNewBanner, {
        digest: single,
        onView: () => {},
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("Updated to 0.1.0");
    expect(html).toContain("1 new feature");
    expect(html).not.toContain("versions");
  });
});
