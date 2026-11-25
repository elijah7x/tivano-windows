// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-50: First-launch page (frozen WelcomeView + ProviderChecklist +
// NoThreadView in RootView.swift). Offers two ways to start — Work in a
// project or Just chat — with ready providers folded into one expandable
// line; with no ready provider it lists what to install and Start a chat
// waits until one is ready. Bounded: folder drag-and-drop onto the window
// is not ported because directory grants are strictly main-dialog-owned.

import { useEffect, useState } from "react";
import { effectiveChord } from "../../shared/shortcuts";
import type { AppInfo, CodexSetupState, Settings } from "../../shared/types";
import { api, callApi, clientStore, tryCall } from "../client";
import { translateError } from "../i18n";
import { useT } from "../locale";
import type { SettingsPageId } from "./SettingsModal";

export const CODEX_INSTALL_URL = "https://developers.openai.com/codex/cli";

export interface WelcomeProviderStatus {
  id: string;
  name: string;
  /** Optional unlocalized CLI prefix (e.g. "Codex CLI") before routeKey. */
  routePrefix?: string;
  /** Localized key describing the route/account ("ChatGPT plan or API key", etc.). */
  routeKey: string;
  /** Status summary key or error string ("Ready", "not configured", etc.). */
  statusSummary: string;
  isChecking: boolean;
  isInstalled: boolean;
  auth: "signedIn" | "signedOut";
  installURL?: string;
  settingsPage?: SettingsPageId;
}

export function isProviderReady(provider: WelcomeProviderStatus): boolean {
  return !provider.isChecking && provider.isInstalled && provider.auth !== "signedOut";
}

/**
 * Derive honest provider readiness from the current launch's AppInfo and
 * optional Codex setup state. Never probes PATH or guesses unverified CLIs.
 */
export function resolveWelcomeProviders(
  info: Pick<AppInfo, "mode" | "providerId" | "providerLabel" | "codex">,
  codexSetup?: CodexSetupState | null,
): WelcomeProviderStatus[] {
  const codexPendingRestart = codexSetup?.savedEffect === "pending-restart";
  if (info.mode === "codex") {
    const state = info.codex?.state ?? "unconfigured";
    const ready = state === "fixture" || state === "configured-unverified";
    const statusSummary =
      state === "fixture"
        ? "offline fixture (synthetic)"
        : state === "configured-unverified"
          ? "configured — unverified"
          : state === "unsupported"
            ? info.codex?.reason || "unsupported"
            : codexPendingRestart
              ? "Takes effect on next launch"
              : "not configured";
    return [
      {
        id: "codex",
        name: "Codex",
        routePrefix: "Codex CLI",
        routeKey: "ChatGPT plan or API key",
        statusSummary,
        isChecking: false,
        isInstalled: ready,
        auth: ready ? "signedIn" : "signedOut",
        installURL: CODEX_INSTALL_URL,
        settingsPage: "models",
      },
    ];
  }

  const activeEntry: WelcomeProviderStatus = {
    id: info.providerId || info.mode,
    name: info.providerLabel,
    routeKey: info.mode === "mock" ? "Synthetic provider" : "Synthetic stdio",
    statusSummary: "Ready",
    isChecking: false,
    isInstalled: true,
    auth: "signedIn",
    settingsPage: "models",
  };
  const codexEntry: WelcomeProviderStatus = {
    id: "codex",
    name: "Codex",
    routePrefix: "Codex CLI",
    routeKey: "ChatGPT plan or API key",
    statusSummary: codexPendingRestart ? "Takes effect on next launch" : "not configured",
    isChecking: false,
    isInstalled: false,
    auth: "signedOut",
    installURL: CODEX_INSTALL_URL,
    settingsPage: "models",
  };
  return [activeEntry, codexEntry];
}

function FolderSvg({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        d="M2 4.8A1.5 1.5 0 0 1 3.5 3.3h3.6L8.5 5H14.5A1.5 1.5 0 0 1 16 6.5v7A1.5 1.5 0 0 1 14.5 15h-11A1.5 1.5 0 0 1 2 13.5V4.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderPlusSvg({ size = 15 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M1.5 4.2A1.3 1.3 0 0 1 2.8 2.9h3.2L7.3 4.3h5.9a1.3 1.3 0 0 1 1.3 1.3v6.2a1.3 1.3 0 0 1-1.3 1.3H2.8a1.3 1.3 0 0 1-1.3-1.3V4.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.8v4M6 8.8h4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChatBubbleSvg({ size = 18 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        d="M3 4.8A1.8 1.8 0 0 1 4.8 3h8.4A1.8 1.8 0 0 1 15 4.8v6.1a1.8 1.8 0 0 1-1.8 1.8H7.2L4 15.2v-2.5H4.8A1.8 1.8 0 0 1 3 10.9V4.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ProviderGlyph({ id, size = 16 }: { id: string; size?: number }): React.JSX.Element {
  if (id === "codex") {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect
          x="2"
          y="2.5"
          width="12"
          height="11"
          rx="2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        <path
          d="M5 6.3 7.2 8 5 9.7M8.5 9.8H11"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  );
}

export function ProviderChecklist(props: {
  providers: WelcomeProviderStatus[];
  onOpenSettings?: ((page?: SettingsPageId) => void) | undefined;
}): React.JSX.Element {
  const t = useT();
  return (
    <div className="welcome-checklist" role="list" aria-label={t("Provider checklist")}>
      {props.providers.map((p) => {
        const routeSummary = p.routePrefix
          ? `${p.routePrefix} · ${t(p.routeKey)}`
          : t(p.routeKey);
        const statusText = p.isChecking
          ? t("Checking…")
          : translateError(t, t(p.statusSummary));
        return (
          <div
            key={p.id}
            className="welcome-provider-row"
            role="listitem"
            data-provider-id={p.id}
            data-ready={isProviderReady(p) ? "true" : "false"}
          >
            <span className="welcome-provider-icon">
              <ProviderGlyph id={p.id} size={18} />
            </span>
            <div className="welcome-provider-meta">
              <div className="welcome-provider-name">{t(p.name)}</div>
              <div className="welcome-provider-detail">
                {routeSummary} · {statusText}
              </div>
            </div>
            <div className="welcome-provider-actions">
              {p.isChecking ? (
                <span className="welcome-provider-checking dots">{t("Checking…")}</span>
              ) : !p.isInstalled ? (
                <>
                  {p.installURL && (
                    <button
                      type="button"
                      className="choice settings-btn-compact"
                      data-testid={`welcome-install-${p.id}`}
                      onClick={() => tryCall("links:open-external", { url: p.installURL! })}
                    >
                      {t("Install")}
                    </button>
                  )}
                  {p.settingsPage && props.onOpenSettings && (
                    <button
                      type="button"
                      className="choice settings-btn-compact"
                      onClick={() => props.onOpenSettings!(p.settingsPage)}
                    >
                      {t("Manage")}
                    </button>
                  )}
                </>
              ) : p.auth === "signedOut" ? (
                p.settingsPage && props.onOpenSettings ? (
                  <button
                    type="button"
                    className="choice settings-btn-compact"
                    onClick={() => props.onOpenSettings!(p.settingsPage)}
                  >
                    {t("Manage")}
                  </button>
                ) : null
              ) : (
                <span
                  className="welcome-provider-ready-mark"
                  role="img"
                  aria-label={t("Ready")}
                >
                  ✓
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function WelcomeView(props: {
  info: Pick<AppInfo, "mode" | "providerId" | "providerLabel" | "codex">;
  readOnly?: boolean | undefined;
  settingsOpen?: boolean | undefined;
  onOpenSettings?: ((page?: SettingsPageId) => void) | undefined;
  /** Test seam / override for provider readiness states. */
  providers?: WelcomeProviderStatus[] | undefined;
  /** Test seam for initial expanded state of the provider strip. */
  defaultExpanded?: boolean | undefined;
}): React.JSX.Element {
  const t = useT();
  const [expanded, setExpanded] = useState(props.defaultExpanded === true);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [codexSetup, setCodexSetup] = useState<CodexSetupState | null>(null);

  useEffect(() => {
    if (props.providers !== undefined || props.settingsOpen) return;
    let live = true;
    void api()
      .invoke("codex:setup-state", {})
      .then((res) => {
        if (live && res && typeof res === "object" && "launchProvider" in res) {
          setCodexSetup(res as CodexSetupState);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [props.providers, props.settingsOpen, props.info.mode, props.info.codex?.state]);

  const providers =
    props.providers ?? resolveWelcomeProviders(props.info, codexSetup);
  const readyProviders = providers.filter(isProviderReady);
  const isCheckingAny = providers.some((p) => p.isChecking);
  const noProviders = readyProviders.length === 0 && !isCheckingAny;

  const readyLabel =
    readyProviders.length === 0 && isCheckingAny
      ? t("Checking…")
      : readyProviders.length === 1
        ? t("1 provider ready")
        : t("%lld providers ready").replace("%lld", String(readyProviders.length));

  const openProjectFolder = () => {
    setOpeningFolder(true);
    callApi("projects:open-directory", {})
      .then((r) => {
        const res = r as { errors?: string[] } | undefined;
        if (res?.errors?.length) clientStore.reportError(res.errors.join("\n"));
      })
      .catch(() => {
        /* callApi already surfaced the banner */
      })
      .finally(() => setOpeningFolder(false));
  };

  return (
    <div className="welcome-scroll" data-testid="welcome-view">
      <div className="welcome-wrap">
        <h1 className="welcome-title">{t("Where shall we begin today?")}</h1>

        <div className="welcome-cards">
          <section className="welcome-card" aria-label={t("Work in a project")}>
            <span className="welcome-card-icon">
              <FolderSvg size={20} />
            </span>
            <h2 className="welcome-card-title">{t("Work in a project")}</h2>
            <p className="welcome-card-desc">
              {t("Agents read and edit this folder, and can run in parallel worktrees.")}
            </p>
            <div className="welcome-card-footer">
              <button
                type="button"
                className="welcome-card-btn"
                data-testid="welcome-add-project"
                disabled={openingFolder || props.readOnly === true}
                aria-busy={openingFolder || undefined}
                onClick={openProjectFolder}
              >
                <FolderPlusSvg size={15} />
                <span>{openingFolder ? t("Opening…") : t("Add a project folder")}</span>
              </button>
            </div>
          </section>

          <section className="welcome-card" aria-label={t("Just chat")}>
            <span className="welcome-card-icon">
              <ChatBubbleSvg size={20} />
            </span>
            <h2 className="welcome-card-title">{t("Just chat")}</h2>
            <p className="welcome-card-desc">
              {t("No project folder needed. Good for questions and drafts.")}
            </p>
            <div className="welcome-card-footer">
              <button
                type="button"
                className="welcome-card-btn"
                data-testid="welcome-start-chat"
                disabled={readyProviders.length === 0 || props.readOnly === true}
                onClick={() => tryCall("threads:create", { projectId: null })}
              >
                <ChatBubbleSvg size={15} />
                <span>{t("Start a chat")}</span>
              </button>
            </div>
          </section>
        </div>

        {noProviders ? (
          <section
            className="welcome-providers-section"
            aria-label={t("Install a coding agent first")}
          >
            <h2 className="welcome-section-title">{t("Install a coding agent first")}</h2>
            <ProviderChecklist
              providers={providers}
              onOpenSettings={props.onOpenSettings}
            />
          </section>
        ) : (
          <div className="welcome-provider-strip">
            <div className="welcome-strip-card">
              <button
                type="button"
                className="welcome-strip-toggle"
                data-testid="welcome-provider-toggle"
                aria-expanded={expanded}
                aria-controls="welcome-provider-checklist"
                aria-label={`${readyLabel} (${t(expanded ? "Expanded" : "Collapsed")})`}
                onClick={() => setExpanded((v) => !v)}
              >
                <span className="welcome-strip-icons" aria-hidden="true">
                  {readyProviders.map((p) => (
                    <ProviderGlyph key={p.id} id={p.id} size={14} />
                  ))}
                </span>
                <span className="welcome-strip-label">{readyLabel}</span>
                <span
                  className={`welcome-strip-chev${expanded ? " open" : ""}`}
                  aria-hidden="true"
                >
                  ▸
                </span>
              </button>
              <span className="welcome-strip-divider" aria-hidden="true" />
              <button
                type="button"
                className="welcome-strip-manage"
                data-testid="welcome-manage-providers"
                onClick={() => props.onOpenSettings?.("models")}
              >
                {t("Manage")}
              </button>
            </div>

            {expanded && (
              <div id="welcome-provider-checklist" className="welcome-checklist-wrap">
                <ProviderChecklist
                  providers={providers}
                  onOpenSettings={props.onOpenSettings}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Shown when no thread is selected, once at least one project or thread
 * already exists (frozen NoThreadView in RootView.swift).
 */
export function NoThreadView(props: {
  readOnly?: boolean | undefined;
  settings?: Settings | undefined;
}): React.JSX.Element {
  const t = useT();
  const isDarwin =
    typeof window !== "undefined" &&
    (window as { tivano?: { platform?: string } }).tivano?.platform === "darwin";
  const chord = effectiveChord(
    "newThread",
    props.settings?.shortcuts,
    isDarwin,
  );
  const chordLabel = chord
    ? [
        chord.ctrl ? "Ctrl" : null,
        chord.alt ? "Alt" : null,
        chord.shift ? "Shift" : null,
        chord.mod ? (isDarwin ? "Cmd" : "Ctrl") : null,
        chord.key.replace(/^Key/, "").replace(/^Digit/, ""),
      ]
        .filter(Boolean)
        .join("+")
    : null;

  return (
    <div className="center-state no-thread-state" data-testid="no-thread-view">
      <span className="no-thread-icon" aria-hidden="true">
        <ChatBubbleSvg size={40} />
      </span>
      <p className="no-thread-title">{t("Pick a thread or start a new one")}</p>
      <button
        type="button"
        className="primary no-thread-btn"
        data-testid="no-thread-new-btn"
        disabled={props.readOnly === true}
        onClick={() => tryCall("threads:create", { projectId: null })}
      >
        {t("New thread")}
      </button>
      {chordLabel && <span className="no-thread-shortcut">{chordLabel}</span>}
    </div>
  );
}
