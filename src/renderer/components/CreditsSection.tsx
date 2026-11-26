// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-27.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-11: Credits card on Settings › Version & About (upstream v3.0.0
// CreditsSettingsPage.swift layout: attribution + license row followed by a
// compact two-column list sourced strictly from THIRD_PARTY_NOTICES.md,
// without link buttons or anchors).

import { useT } from "../locale";

export interface CreditEntry {
  readonly name: string;
  readonly role: string;
}

/**
 * Compact project credits sourced strictly from THIRD_PARTY_NOTICES.md.
 * Windows replaces macOS SwiftTerm with xterm.js + node-pty + nlohmann/json
 * and omits unshipped voice/mark assets until those features ship.
 */
export const CREDIT_ENTRIES: readonly CreditEntry[] = [
  { name: "Zeron", role: "Working indicators" },
  { name: "xterm.js", role: "Built-in terminal" },
  { name: "node-pty", role: "Terminal PTY layer" },
  { name: "nlohmann/json", role: "Windows job-helper JSON parser" },
  { name: "T3 Code", role: "Where Droppy Code began" },
  { name: "Synara", role: "Responsive chat architecture" },
  { name: "mugen-markdown", role: "Streaming text fade" },
  { name: "anti-slop", role: "Writing guidance" },
  { name: "MonoCode", role: "Usage reset flow" },
];

export function CreditsSection(): React.JSX.Element {
  const t = useT();

  return (
    <section className="credits-section" aria-label={t("Credits")}>
      <h3>{t("Credits")}</h3>
      <div className="credits-card">
        <div className="credits-attribution">
          <div className="credits-origin">{t("Where Tivano began")}</div>
          <div className="credits-upstream">Droppy Code</div>
          <div className="credits-meta">
            Droppy Code by Jordy Spruit (Droppy),{" "}
            <span className="mono">https://getdroppycode.app</span>
          </div>
          <div className="credits-license">
            {t("Tivano is a fork of Droppy Code, under AGPL-3.0 with attribution terms.")}
          </div>
        </div>
        <div className="credits-entries">
          <div className="credits-grid">
            {CREDIT_ENTRIES.map((entry) => (
              <div key={entry.name} className="credits-entry">
                <div className="credits-entry-name">{entry.name}</div>
                <div className="credits-entry-role">{t(entry.role)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
