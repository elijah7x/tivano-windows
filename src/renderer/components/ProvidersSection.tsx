// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-12-14.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-39/P2-19 (frozen SettingsIconRail + ProvidersSettingsPage): a compact
// provider list that collapses to an icon rail and floats out an expanded
// card on hover, an "All providers" overview, per-provider cards whose
// choosing happens inside the card, card-top switches, and status dots
// (ready / needs attention / not installed). This build ships one provider
// (Codex) and has no provider-account rows — the folded-accounts row is a
// documented bound, and CLI update checks have no engine yet (the switch
// renders honestly disabled).

import { useMemo, useState } from "react";
import type { CodexSetupState } from "../../shared/types";
import { useT } from "../locale";

export type ProviderListStatus = "ready" | "attention" | "notInstalled";

/** Frozen ProviderListStatus mapping against this build's Codex CLI state:
 *  installed → ready; repair/foreign → needs attention; absent/unavailable
 *  → not installed. Nothing fabricated — unknown states stay unmarked. */
export function providerListStatus(cliState: string | undefined): ProviderListStatus | null {
  switch (cliState) {
    case "installed":
      return "ready";
    case "repair":
    case "foreign":
      return "attention";
    case "absent":
    case "unavailable":
      return "notInstalled";
    default:
      return null;
  }
}

export const PROVIDER_LIST_STATUSES: ProviderListStatus[] = [
  "ready",
  "attention",
  "notInstalled",
];

export function providerStatusTitle(t: (k: string) => string, s: ProviderListStatus): string {
  switch (s) {
    case "ready":
      return t("Ready");
    case "attention":
      return t("Needs attention");
    case "notInstalled":
      return t("Not installed");
  }
}

interface ProviderRow {
  id: string;
  label: string;
  status: ProviderListStatus | null;
}

export function ProvidersSection(props: {
  codex: CodexSetupState | null;
  cliState: string | undefined;
  /** Provider route shown under its name on the first card (frozen). */
  codexRoute: string;
  /** The provider card's real content; `executablePath` mirrors the
   *  card-top switch so editing surfaces gate on it. */
  renderCodexCard: (switches: { executablePath: boolean }) => React.JSX.Element;
}): React.JSX.Element {
  const t = useT();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  // Card-top switches (frozen: both default off). A saved custom path
  // already acts as an on-switch, so the toggle starts effectively on.
  const [executablePathOn, setExecutablePathOn] = useState(false);
  const executablePath = executablePathOn || props.codex?.savedExecutable != null;

  const providers = useMemo<ProviderRow[]>(() => {
    const q = search.trim().toLowerCase();
    const rows: ProviderRow[] = [
      { id: "codex", label: t("Codex"), status: providerListStatus(props.cliState) },
    ];
    return q === "" ? rows : rows.filter((r) => r.label.toLowerCase().includes(q));
  }, [search, props.cliState, t]);

  const sel = selected && providers.some((p) => p.id === selected) ? selected : null;
  const statusLabel = (p: ProviderRow) =>
    p.status ? `${p.label}: ${providerStatusTitle(t, p.status)}` : p.label;

  const codexCard = (
    <section className="prov-card" aria-label={t("Codex")}>
      <div className="prov-card-head">
        <span className="prov-name">{t("Codex")}</span>
        <span className="prov-route dim">{props.codexRoute}</span>
      </div>
      <div className="prov-switches">
        <label className="prov-switch" title={t("CLI update checks are not available in this build")}>
          <input type="checkbox" disabled />
          <span>{t("Check for updates")}</span>
          <span className="dim">{t("unavailable in this build")}</span>
        </label>
        <label className="prov-switch">
          <input
            type="checkbox"
            checked={executablePath}
            onChange={(e) => setExecutablePathOn(e.target.checked)}
          />
          <span>{t("Custom executable path")}</span>
        </label>
      </div>
      {props.renderCodexCard({ executablePath })}
    </section>
  );

  return (
    <>
      <div className="prov-head">
        <h3>{t("Providers")}</h3>
        <input
          className="prov-search"
          type="search"
          placeholder={t("Search providers")}
          aria-label={t("Search providers")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="prov-cols">
        <div className="prov-rail" role="listbox" aria-label={t("Providers")}>
          <button
            type="button"
            className={`prov-rail-btn${sel === null ? " sel" : ""}`}
            title={t("All providers")}
            aria-label={t("All providers")}
            aria-selected={sel === null}
            onClick={() => setSelected(null)}
          >
            <span className="prov-glyph" aria-hidden="true">
              ⊞
            </span>
          </button>
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`prov-rail-btn${sel === p.id ? " sel" : ""}`}
              title={statusLabel(p)}
              aria-label={statusLabel(p)}
              aria-selected={sel === p.id}
              onClick={() => setSelected(p.id)}
            >
              <span className="prov-glyph" aria-hidden="true">
                ⌘
              </span>
              {p.status && (
                <span className={`prov-dot ${p.status}`} title={providerStatusTitle(t, p.status)} />
              )}
            </button>
          ))}
          {/* Frozen SettingsIconRail: the expanded list floats out over the
              page on hover without scrolling it. */}
          <div className="prov-rail-expand" role="presentation">
            <button
              type="button"
              className={`prov-expand-row${sel === null ? " sel" : ""}`}
              onClick={() => setSelected(null)}
            >
              {t("All providers")}
            </button>
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`prov-expand-row${sel === p.id ? " sel" : ""}`}
                onClick={() => setSelected(p.id)}
              >
                <span className="grow">{p.label}</span>
                {p.status && (
                  <span
                    className={`prov-dot ${p.status}`}
                    title={providerStatusTitle(t, p.status)}
                  />
                )}
              </button>
            ))}
            {providers.length === 0 && (
              <span className="prov-expand-row dim">{t("No matching providers")}</span>
            )}
          </div>
        </div>
        <div className="prov-detail">
          {providers.length === 0 ? <p className="dim">{t("No matching providers")}</p> : codexCard}
        </div>
      </div>
    </>
  );
}
