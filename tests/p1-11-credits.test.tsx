// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-27.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-11: Credits section on Settings › Version & About (v3.0.0 compact
// CreditsSettingsPage layout, entries strictly from THIRD_PARTY_NOTICES.md,
// no link buttons or anchors, localized across all translated languages).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSettings } from "../src/main/store";
import { CREDIT_ENTRIES, CreditsSection } from "../src/renderer/components/CreditsSection";
import { SettingsModal } from "../src/renderer/components/SettingsModal";
import { TRANSLATED_LANGUAGES, translate } from "../src/renderer/i18n";
import { LanguageContext } from "../src/renderer/locale";
import type { AppInfo, LanguageId } from "../src/shared/types";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const prevWindow = (globalThis as { window?: unknown }).window;

afterEach(() => {
  if (prevWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});

function renderInLang(lang: LanguageId, el: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(LanguageContext.Provider, { value: lang }, el),
  );
}

describe("P1-11 CreditsSection", () => {
  it("renders the v3.0.0 compact Credits card with attribution and no link buttons or anchors", () => {
    const html = renderInLang("en", createElement(CreditsSection));
    expect(html).toContain("Credits");
    expect(html).toContain("Where Tivano began");
    expect(html).toContain("Droppy Code by Jordy Spruit (Droppy)");
    expect(html).toContain("https://getdroppycode.app");
    expect(html).toContain(
      "Tivano is a fork of Droppy Code, under AGPL-3.0 with attribution terms.",
    );
    for (const entry of CREDIT_ENTRIES) {
      expect(html).toContain(entry.name);
      expect(html).toContain(entry.role);
    }
    expect(html).toContain("Synara");
    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toMatch(/<button\b/i);
  });

  it("sources every credit entry from THIRD_PARTY_NOTICES.md", () => {
    const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
    const sectionAliases: Record<string, string> = {
      "anti-slop": "## Anti-slop guidance",
    };
    for (const entry of CREDIT_ENTRIES) {
      const heading = sectionAliases[entry.name] ?? `## ${entry.name}`;
      expect(notices, entry.name).toContain(heading);
    }
  });

  it("mounts inside Settings › Version & About while keeping the required attribution block intact", () => {
    (globalThis as { window?: unknown }).window = {
      tivano: {
        platform: "win32",
        invoke: async () => ({}),
        onEvent: () => () => {},
      },
    };
    const info: AppInfo = {
      appVersion: "0.1.0",
      baselineTag: "v3.0.0",
      baselineCommit: "15e03374f077343e500e8e5e3574c8c598162171",
      providerId: "mock",
      providerLabel: "Mock Provider (synthetic — no real model, tools or commands)",
      mock: true,
      mode: "mock",
      realCli: { status: "not-configured" },
      home: "C:\\synthetic\\home",
      worktreesDir: "C:\\synthetic\\data\\worktrees",
      dataRoot: "C:\\synthetic\\tivano-data",
    };
    const html = renderInLang(
      "en",
      createElement(SettingsModal, {
        settings: defaultSettings(),
        info,
        threads: [],
        projects: [],
        tokenActivity: {},
        initialPage: "about",
        onClose: () => {},
      }),
    );
    expect(html).toContain("Original work:");
    expect(html).toContain(
      "Licensed under AGPL-3.0 with the section-7 attribution terms; see LICENSE and THIRD_PARTY_NOTICES.md.",
    );
    expect(html).toContain("credits-section");
    expect(html).toContain("Synara");
  });

  it("localizes Credits strings across all translated languages", () => {
    const keys = [
      "Credits",
      "Where Tivano began",
      "Tivano is a fork of Droppy Code, under AGPL-3.0 with attribution terms.",
      ...CREDIT_ENTRIES.map((e) => e.role),
    ];
    for (const lang of TRANSLATED_LANGUAGES) {
      for (const k of keys) {
        const translated = translate(lang, k);
        expect(translated.length, `${lang}: ${k}`).toBeGreaterThan(0);
        expect(translated, `${lang}: ${k}`).not.toBe(k);
      }
      const html = renderInLang(lang, createElement(CreditsSection));
      expect(html).toContain(translate(lang, "Credits"));
      expect(html).toContain(translate(lang, "Responsive chat architecture"));
    }
  });
});
