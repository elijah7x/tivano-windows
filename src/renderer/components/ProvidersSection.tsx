// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-39/P2-19 (frozen SettingsIconRail + ProvidersSettingsPage): a compact
// provider list that collapses to an icon rail and floats out an expanded
// card on hover, an "All providers" overview, in-card provider choosing,
// per-provider cards with card-top switches, folded accounts, and status
// dots (ready / needs attention / not installed). This build ships one
// provider (Codex). The account row is the Codex CLI's implicit sign-in:
// account metadata, plan balances, adding and switching accounts have no
// honest source here yet, and CLI update checks have no engine yet (that
// switch renders honestly disabled).

import { useMemo, useState } from "react";
import type { CodexInfo, CodexSetupState } from "../../shared/types";
import { useT } from "../locale";

export type ProviderListStatus = "ready" | "attention" | "notInstalled";

/** Frozen ProviderListStatus mapping against the Codex PROVIDER's own
 *  runtime state (never Tivano's CLI shim): a configured or fixture
 *  runtime is ready, an unsupported configuration needs attention, an
 *  unconfigured provider is not installed. Nothing fabricated — a
 *  non-Codex launch (runtime null) stays unmarked. */
export function providerListStatus(
  runtimeState: CodexInfo["state"] | null | undefined,
): ProviderListStatus | null {
  switch (runtimeState) {
    case "fixture":
    case "configured-unverified":
      return "ready";
    case "unsupported":
      return "attention";
    case "unconfigured":
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

function ProviderAccountsRow(props: { codex: CodexSetupState | null }): React.JSX.Element {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const runtimeState = props.codex?.runtime?.state;
  const active = runtimeState === "fixture" || runtimeState === "configured-unverified";
  const authState = runtimeState === "fixture"
    ? t("offline fixture (synthetic)")
    : runtimeState === "configured-unverified"
      ? t("configured — unverified")
      : null;
  const title = active ? t("Codex CLI sign-in") : t("No Codex account information");
  return (
    <div className="prov-accounts" data-testid="provider-accounts">
      <button
        type="button"
        className="prov-accounts-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="prov-accounts-title">{t("Accounts")}</span>
        <span className="prov-accounts-summary">
          {title}
          {authState ? ` · ${authState}` : ""}
          {" · "}
          {t("Usage unavailable in this build")}
        </span>
        <span className="prov-accounts-chevron" aria-hidden="true">
          {expanded ? "⌃" : "⌄"}
        </span>
      </button>
      {expanded && (
        <div className="prov-account-row">
          <div className="prov-account-main">
            <span>
              {t("Codex CLI sign-in")}
              {authState ? ` · ${authState}` : ""}
            </span>
            <span className="dim">
              {t(
                "Tivano cannot verify the Codex CLI sign-in or read the account name, plan, or usage in this build.",
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProvidersSection(props: {
  codex: CodexSetupState | null;
  /** Frozen provider choosing: whether Codex appears in Providers and
   *  model surfaces (default true). */
  codexProviderEnabled: boolean;
  onCodexProviderEnabled: (enabled: boolean) => void;
  /** Persisted card-top switch (frozen, default off): shows the
   *  executable-path surfaces inside the provider card. */
  executablePathVisible: boolean;
  onExecutablePathVisible: (visible: boolean) => void;
  /** Provider route shown under its name on the first card (frozen). */
  codexRoute: string;
  /** The provider card's real content; `executablePath` mirrors the
   *  card-top switch so editing surfaces gate on it. */
  renderCodexCard: (switches: { executablePath: boolean }) => React.JSX.Element;
}): React.JSX.Element {
  const t = useT();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const executablePath = props.executablePathVisible;

  const providers = useMemo<ProviderRow[]>(() => {
    const q = search.trim().toLowerCase();
    const rows: ProviderRow[] = props.codexProviderEnabled
      ? [
          {
            id: "codex",
            label: t("Codex"),
            status: providerListStatus(props.codex?.runtime?.state),
          },
        ]
      : [];
    return q === "" ? rows : rows.filter((r) => r.label.toLowerCase().includes(q));
  }, [search, props.codexProviderEnabled, props.codex?.runtime?.state, t]);

  const sel = selected && providers.some((p) => p.id === selected) ? selected : null;
  const statusLabel = (p: ProviderRow) =>
    p.status ? `${p.label}: ${providerStatusTitle(t, p.status)}` : p.label;

  const codexCard = (
    <section className="prov-card" aria-label={t("Codex")}>
      <div className="prov-card-head">
        <span className="prov-name">{t("Codex")}</span>
        <span className="prov-route dim">{props.codexRoute}</span>
      </div>
      <ProviderAccountsRow codex={props.codex} />
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
      <div className="prov-active-card" data-testid="active-providers-card">
        <div className="prov-active-row">
          <div className="prov-active-text">
            <strong>{t("Choose your providers")}</strong>
            <span className="dim">
              {t("Show only the providers you use in Settings and the model picker.")}
            </span>
          </div>
          <button type="button" className="prov-small-btn" onClick={() => setChoosing((v) => !v)}>
            {choosing ? t("Done") : t("Choose providers")}
          </button>
        </div>
        {choosing && (
          <div className="prov-choice-area">
            <p className="dim">{t("Click a provider to show or hide it. Your settings are kept.")}</p>
            <button
              type="button"
              className={`prov-choice-tile${props.codexProviderEnabled ? " sel" : ""}`}
              aria-pressed={props.codexProviderEnabled}
              onClick={() => props.onCodexProviderEnabled(!props.codexProviderEnabled)}
            >
              <span className="prov-glyph" aria-hidden="true">
                ⌘
              </span>
              <span>{t("Codex")}</span>
              <span className="dim">
                {props.codexProviderEnabled ? t("Active") : t("Hidden")}
              </span>
            </button>

          </div>
        )}
        <div className="prov-switches">
          <label className="prov-switch" title={t("CLI update checks are not available in this build")}>
            <input type="checkbox" disabled />
            <span>{t("Check for updates")}</span>
            <span className="dim">{t("unavailable in this build")}</span>
          </label>
          <label className="prov-switch">
            <input
              type="checkbox"
              checked={props.executablePathVisible}
              onChange={(e) => props.onExecutablePathVisible(e.target.checked)}
            />
            <span>{t("Custom executable path")}</span>
          </label>
        </div>
      </div>
      {props.codexProviderEnabled && (
      <div className="prov-cols">
        <div className="prov-rail" role="listbox" aria-label={t("Providers")}>
          <button
            type="button"
            role="option"
            className={`prov-rail-btn${sel === null ? " sel" : ""}`}
            title={t("All providers")}
            aria-label={t("All providers")}
            aria-selected={sel === null}
            onClick={() => setSelected(null)}
          >
            <span className="prov-glyph" aria-hidden="true">⊞</span>
          </button>
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              className={`prov-rail-btn${sel === p.id ? " sel" : ""}`}
              title={statusLabel(p)}
              aria-label={statusLabel(p)}
              aria-selected={sel === p.id}
              onClick={() => setSelected(p.id)}
            >
              <span className="prov-glyph" aria-hidden="true">⌘</span>
              {p.status && (
                <span className={`prov-dot ${p.status}`} title={providerStatusTitle(t, p.status)} />
              )}
            </button>
          ))}
          {/* Frozen SettingsIconRail: the expanded list floats out over the
              page on hover without scrolling it. */}
          <div className="prov-rail-expand" role="presentation" aria-hidden="true">
            <button
              type="button"
              tabIndex={-1}
              className={`prov-expand-row${sel === null ? " sel" : ""}`}
              onClick={() => setSelected(null)}
            >
              {t("All providers")}
            </button>
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                tabIndex={-1}
                className={`prov-expand-row${sel === p.id ? " sel" : ""}`}
                onClick={() => setSelected(p.id)}
              >
                <span className="grow">{p.label}</span>
                {p.status && (
                  <span className={`prov-dot ${p.status}`} title={providerStatusTitle(t, p.status)} />
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
      )}
    </>
  );
}
