// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Settings surface (P2-53): consolidated into fewer, clearer pages with a
// left navigation rail, no search field, unified regular button sizing (and
// smaller secondary-line actions), plus the Codex CLI setup block and the
// About block carrying the AGPL attribution this derivative owes upstream.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LANGUAGE_IDS,
  LANGUAGE_LABELS,
  WEATHER_WINDOW_MODES,
  type AppInfo,
  type ChatThread,
  type CodexSetupState,
  type CodexChooseResult,
  type CodexWriteResult,
  type LanguageId,
  type Project,
  type Settings,
} from "../../shared/types";
import {
  WEATHER_WINDOW_DETAIL,
  WEATHER_WINDOW_LABEL,
  resolveWeatherWindowMode,
} from "../../shared/skylight";
import { WeatherWindowThumbnail } from "./Skylight";
import { useT } from "../locale";
import { translateError } from "../i18n";
import { api, tryCall } from "../client";
import { playFinishChime } from "../finishChime";
import { AppearanceSplitCircleButton, ThemePicker } from "./ThemePicker";
import { TokenActivitySection } from "./TokenActivitySection";
import { ShortcutsSection } from "./ShortcutsSection";
import { HydraSection } from "./HydraSection";
import { McpSection } from "./McpSection";
import { RemoteMcpSection } from "./RemoteMcpSection";
import { ForgeSection } from "./ForgeSection";
import { WallpaperSection } from "./WallpaperSection";
import { ModelListSettings } from "./ModelListSettings";
import { TextGenerationPicker } from "./TextGenerationPicker";
import { ArchiveSection } from "./ArchiveSection";
import { VersionSection } from "./WhatsNewViews";
import {
  RUNTIME_MODES,
  RUNTIME_MODE_TITLE,
  RUNTIME_MODE_SUMMARY,
} from "./RuntimeModePicker";
import {
  fontSizesAreDefault,
  resolveFontSizes,
  TYPE_DEFAULT,
  TYPE_RANGE,
} from "../../shared/typeScale";

export type SettingsPageId =
  | "appearance"
  | "conversation"
  | "models"
  | "hydra"
  | "connections"
  | "shortcuts"
  | "storage"
  | "about";

export const SETTINGS_PAGES: readonly { id: SettingsPageId; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "conversation", label: "Conversation" },
  { id: "models", label: "Models & Providers" },
  { id: "hydra", label: "Hydra" },
  { id: "connections", label: "Connections" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "storage", label: "Storage" },
  { id: "about", label: "Version & About" },
];

/** P1-39: frozen per-mode Workspace summaries (upstream verbatim). */
const WORKSPACE_MODE_SUMMARY = {
  auto: "Edits your project folder directly, and creates a Git worktree when another chat is already active there.",
  local: "Edits files directly in your project folder.",
  worktree:
    "Isolates each chat in its own Git worktree copy. Non-Git folders stay local.",
} as const;

/** Human-readable launch source: what produced this run's codex runtime. */
function sourceLabel(
  t: (k: string) => string,
  s: CodexSetupState,
): string {
  switch (s.effectiveSource) {
    case "fixture":
      return t("offline fixture (synthetic)");
    case "environment":
      return t("environment variable");
    case "saved":
      return t("saved setting");
    case "none":
      return t("not configured");
    default:
      return s.launchProvider === "codex" ? t("unknown") : t("not a Codex launch");
  }
}

/** F33 CLI install state reported by main — real fs state, no caching. */
type CliState = {
  state: "unavailable" | "absent" | "foreign" | "installed" | "repair" | string;
  dir?: string;
  path?: string;
  target?: string;
};

export function SettingsModal(props: {
  settings: Settings;
  info: AppInfo;
  threads: ChatThread[];
  projects: Project[];
  tokenActivity: Record<string, number>;
  initialPage?: SettingsPageId;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const { settings, info } = props;
  const [page, setPage] = useState<SettingsPageId>(props.initialPage ?? "appearance");
  const paneRef = useRef<HTMLDivElement>(null);
  const [codex, setCodex] = useState<CodexSetupState | null>(null);
  const [codexErr, setCodexErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "choose" | "save" | "clear" | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [control, setControl] = useState<{
    enabled: boolean;
    listening: boolean;
    failure: string | null;
  } | null>(null);
  const [cli, setCli] = useState<CliState | null>(null);
  const [cliErr, setCliErr] = useState<string | null>(null);
  const mounted = useRef(false);
  const operationLocked = useRef(false);
  const requestId = useRef(0);

  const refresh = useCallback(async (id: number) => {
    if (!mounted.current || requestId.current !== id) return;
    try {
      const next = (await api().invoke("codex:setup-state", {})) as CodexSetupState;
      if (!mounted.current || requestId.current !== id) return;
      setCodex(next);
      setLoadErr(null);
    } catch (e) {
      if (!mounted.current || requestId.current !== id) return;
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const run = useCallback(async (
    op: "load" | "choose" | "save" | "clear",
    invoke?: () => Promise<unknown>,
  ) => {
    if (!mounted.current || operationLocked.current) return;
    operationLocked.current = true;
    const id = ++requestId.current;
    const current = () => mounted.current && requestId.current === id;
    setBusy(op);
    setCodexErr(null);
    try {
      if (invoke) {
        const r = (await invoke()) as CodexChooseResult | CodexWriteResult;
        if (!current()) return;
        if (r.status === "invalid" || r.status === "unavailable") setCodexErr(r.reason);
        else if (r.status === "error") setCodexErr(r.error);
        else if (r.status === "superseded") setCodexErr("Selection was superseded by a newer action");
        else if (r.status === "busy") setCodexErr("The program chooser is already open. Close it, then refresh status.");
      }
    } catch (e) {
      if (current()) setCodexErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (current()) await refresh(id);
      if (current()) {
        operationLocked.current = false;
        setBusy(null);
      }
    }
  }, [refresh]);

  // F33: real socket status — read on open and refreshed whenever settings change.
  const refreshControl = useCallback(async () => {
    try {
      const s = (await api().invoke("control:status", {})) as {
        enabled: boolean;
        listening: boolean;
        failure: string | null;
      };
      if (mounted.current) setControl(s);
    } catch {
      if (mounted.current) setControl(null);
    }
  }, []);

  // F33: CLI install state — real filesystem state from main.
  const refreshCli = useCallback(async () => {
    try {
      const s = (await api().invoke("cli:status", {})) as CliState;
      if (mounted.current) setCli(s);
    } catch {
      if (mounted.current) setCli(null);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    operationLocked.current = false;
    void run("load");
    void refreshControl();
    void refreshCli();
    return () => {
      mounted.current = false;
      ++requestId.current;
      operationLocked.current = false;
    };
  }, [run, refreshControl, refreshCli]);

  useEffect(() => {
    void refreshControl();
  }, [settings.externalControlEnabled, refreshControl]);

  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [page]);

  const close = () => {
    mounted.current = false;
    ++requestId.current;
    props.onClose();
  };

  const setTheme = (theme: Settings["theme"]) => tryCall("settings:set", { theme });
  const setAppearanceMode = (appearanceMode: NonNullable<Settings["appearanceMode"]>) =>
    tryCall("settings:set", { appearanceMode });
  const setLanguage = (language: LanguageId) => tryCall("settings:set", { language });
  const [osDark, setOsDark] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (typeof mq.addEventListener !== "function") return;
    const onChange = () => setOsDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const canWrite = !!codex?.mutable && !loadErr && !busy && !codex.chooserBusy;

  const renderPage = (): React.JSX.Element => {
    switch (page) {
      case "appearance":
        return (
          <>
            <h3>{t("Language")}</h3>
            <div className="choice-row" role="radiogroup" aria-label={t("Language")}>
              {LANGUAGE_IDS.map((l) => (
                <button
                  key={l}
                  role="radio"
                  aria-checked={settings.language === l}
                  className={`choice${settings.language === l ? " active" : ""}`}
                  onClick={() => setLanguage(l)}
                >
                  {LANGUAGE_LABELS[l]}
                </button>
              ))}
            </div>

            <h3>{t("Appearance & accent")}</h3>
            <div className="theme-line">
              <AppearanceSplitCircleButton
                mode={settings.appearanceMode ?? "system"}
                onChange={setAppearanceMode}
              />
              <ThemePicker
                value={settings.theme}
                appearanceMode={settings.appearanceMode ?? "system"}
                osDark={osDark}
                systemAccentHex={info.systemAccentColor ?? null}
                onChange={setTheme}
              />
            </div>
            <p className="codex-note">{t("Colors controls and highlighted text.")}</p>
            <h3>{t("Weather window")}</h3>
            {(() => {
              const weatherMode = resolveWeatherWindowMode(settings);
              return (
                <>
                  <div
                    className="choice-row weather-picker"
                    role="radiogroup"
                    aria-label={t("Weather window")}
                  >
                    {WEATHER_WINDOW_MODES.map((mode) => {
                      const active = weatherMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          data-weather-mode={mode}
                          className={`choice weather-choice${active ? " active" : ""}`}
                          onClick={() => tryCall("settings:set", { weatherWindowMode: mode })}
                        >
                          <WeatherWindowThumbnail mode={mode} />
                          <span>{t(WEATHER_WINDOW_LABEL[mode])}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="codex-note">{t(WEATHER_WINDOW_DETAIL[weatherMode])}</p>
                </>
              );
            })()}

            {/* F26: frozen WallpaperCard + Transparency slider — opaque window, honest semantics. */}
            <WallpaperSection settings={settings} />

            <div className="fs-head">
              <h3>{t("Font sizes")}</h3>
              <button
                className="choice fs-reset"
                disabled={fontSizesAreDefault(settings.fontSizes)}
                onClick={() =>
                  tryCall("settings:set", {
                    fontSizes: {
                      ui: TYPE_DEFAULT.ui,
                      content: TYPE_DEFAULT.content,
                      code: TYPE_DEFAULT.code,
                    },
                  })
                }
              >
                {t("Reset font sizes")}
              </button>
            </div>
            {(
              [
                ["ui", "Interface font size", "Adjust Tivano's base font size"],
                ["content", "Content font size", "Adjust the base font size of conversations"],
                ["code", "Code font size", "Adjust the base font size of code in chat and diff views"],
              ] as const
            ).map(([cat, title, detail]) => {
              const value = resolveFontSizes(settings.fontSizes)[cat];
              const range = TYPE_RANGE[cat];
              return (
                <div className="fs-row" key={cat} data-cat={cat}>
                  <div className="fs-text">
                    <div className="fs-title">{t(title)}</div>
                    <div className="fs-detail">{t(detail)}</div>
                  </div>
                  <div className="fs-stepper" role="group" aria-label={t(title)}>
                    <button
                      className="choice fs-step"
                      aria-label={t("Decrease font size")}
                      disabled={value <= range.min}
                      onClick={() => tryCall("settings:set", { fontSizes: { [cat]: value - 1 } })}
                    >
                      −
                    </button>
                    <span className="fs-value" title={`${range.min}–${range.max}`}>
                      {value} pt
                    </span>
                    <button
                      className="choice fs-step"
                      aria-label={t("Increase font size")}
                      disabled={value >= range.max}
                      onClick={() => tryCall("settings:set", { fontSizes: { [cat]: value + 1 } })}
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        );

      case "conversation":
        return (
          <>
            <TokenActivitySection daily={props.tokenActivity} />

            <h3>{t("New threads")}</h3>
            <div
              className="choice-row"
              role="radiogroup"
              aria-label={t("Default location")}
            >
              {(
                [
                  ["recent", "Follow the latest chat"],
                  ["standalone", "Tasks (no project)"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={(settings.newThreadLocation ?? "recent") === value}
                  className={`choice${(settings.newThreadLocation ?? "recent") === value ? " active" : ""}`}
                  onClick={() => tryCall("settings:set", { newThreadLocation: value })}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            <p className="codex-note">
              {t("By default, follow the latest chat's location, including Tasks. Applies only to ordinary new chats; creating a chat from a project still places it in that project.")}
            </p>
            <div
              className="choice-row"
              role="radiogroup"
              aria-label={t("Permissions")}
            >
              {RUNTIME_MODES.map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={(settings.defaultRuntimeMode ?? "fullAccess") === m}
                  className={`choice${(settings.defaultRuntimeMode ?? "fullAccess") === m ? " active" : ""}`}
                  title={t(RUNTIME_MODE_SUMMARY[m])}
                  onClick={() => tryCall("settings:set", { defaultRuntimeMode: m })}
                >
                  {t(RUNTIME_MODE_TITLE[m])}
                </button>
              ))}
            </div>
            <p className="codex-note">
              {t(RUNTIME_MODE_SUMMARY[settings.defaultRuntimeMode ?? "fullAccess"])}
            </p>
            <div
              className="choice-row"
              role="radiogroup"
              aria-label={t("Workspace")}
            >
              {(
                [
                  ["auto", "Auto"],
                  ["local", "Local"],
                  ["worktree", "New worktree"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  role="radio"
                  aria-checked={(settings.defaultWorkspaceMode ?? "auto") === value}
                  className={`choice${(settings.defaultWorkspaceMode ?? "auto") === value ? " active" : ""}`}
                  onClick={() => tryCall("settings:set", { defaultWorkspaceMode: value })}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            <p className="codex-note">
              {t(WORKSPACE_MODE_SUMMARY[settings.defaultWorkspaceMode ?? "auto"])}
            </p>

            <h3>{t("Conversation")}</h3>
            <div className="choice-row">
              <button
                role="switch"
                aria-checked={settings.showReasoning === true}
                className={`choice${settings.showReasoning === true ? " active" : ""}`}
                title={t("The working line opens to the agent's thinking")}
                onClick={() =>
                  tryCall("settings:set", { showReasoning: settings.showReasoning !== true })
                }
              >
                {t("Show thinking")}
              </button>
            </div>
            <div
              className="choice-row"
              role="radiogroup"
              aria-label={t("Working line")}
            >
              {(
                [
                  [true, "Card"],
                  [false, "Line"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={label}
                  role="radio"
                  aria-checked={(settings.showsWorkingCard !== false) === value}
                  className={`choice${(settings.showsWorkingCard !== false) === value ? " active" : ""}`}
                  onClick={() => tryCall("settings:set", { showsWorkingCard: value })}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            <p className="codex-note">
              {t("A card with the turn's progress bar, or a plain line")}
            </p>
            <label className="wt-field settings-field-gap">
              <span>{t("Auto-shelve projects")}</span>
              <div
                className="choice-row"
                role="radiogroup"
                aria-label={t("Auto-shelve projects")}
              >
                {(
                  [
                    [0, "Never"],
                    [3, "3 days"],
                    [7, "7 days"],
                    [14, "14 days"],
                  ] as const
                ).map(([days, label]) => (
                  <button
                    key={days}
                    role="radio"
                    aria-checked={(settings.autoShelveDays ?? 0) === days}
                    className={`choice${(settings.autoShelveDays ?? 0) === days ? " active" : ""}`}
                    onClick={() => tryCall("settings:set", { autoShelveDays: days })}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
            </label>
            <p className="codex-note">
              {t("Shelve a project when its latest chat is idle for this long. A project with a running, unread or open chat is never shelved.")}
            </p>

            <h3>{t("Notifications")}</h3>
            <div className="choice-row">
              <button
                role="switch"
                aria-checked={settings.recentDownloadsPicker !== false}
                className={`choice${settings.recentDownloadsPicker !== false ? " active" : ""}`}
                title={t("The attach button offers recent downloads first")}
                onClick={() =>
                  tryCall("settings:set", {
                    recentDownloadsPicker: settings.recentDownloadsPicker === false,
                  })
                }
              >
                {t("Recent downloads")}
              </button>
            </div>
            <div className="choice-row">
              <button
                role="switch"
                aria-checked={settings.chimeWhenFinished !== false}
                className={`choice${settings.chimeWhenFinished !== false ? " active" : ""}`}
                title={t("A soft chime, whether or not the thread is in view")}
                onClick={() => {
                  if (settings.chimeWhenFinished === false) playFinishChime();
                  tryCall("settings:set", {
                    chimeWhenFinished: settings.chimeWhenFinished === false,
                  });
                }}
              >
                {t("Chime when a turn finishes")}
              </button>
            </div>
            <div className="choice-row">
              <button
                role="switch"
                aria-checked={settings.confirmBeforeDeleting !== false}
                className={`choice${settings.confirmBeforeDeleting !== false ? " active" : ""}`}
                onClick={() =>
                  tryCall("settings:set", {
                    confirmBeforeDeleting: settings.confirmBeforeDeleting === false,
                  })
                }
              >
                {t("Confirm before deleting threads")}
              </button>
            </div>
            <div className="choice-row">
              <button
                role="switch"
                aria-checked={settings.autoContinueAfterLimit === true}
                className={`choice${settings.autoContinueAfterLimit === true ? " active" : ""}`}
                onClick={() =>
                  tryCall("settings:set", {
                    autoContinueAfterLimit: settings.autoContinueAfterLimit !== true,
                  })
                }
              >
                {t("Continue after the usage limit resets")}
              </button>
            </div>

            <h3>{t("Sleep")}</h3>
            <div
              className="choice-row"
              role="radiogroup"
              aria-label={t("Prevent sleep while tasks are running")}
            >
              {(
                [
                  ["off", "Off"],
                  ["system", "Keep computer awake"],
                  ["display", "Keep computer and screen awake"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  role="radio"
                  aria-checked={(settings.taskSleepMode ?? "off") === mode}
                  className={`choice${(settings.taskSleepMode ?? "off") === mode ? " active" : ""}`}
                  onClick={() => tryCall("settings:set", { taskSleepMode: mode })}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            <p className="codex-note">
              {t(
                "While tasks run, the computer won't doze off. Keep computer awake lets the screen turn off on its own; Keep computer and screen awake leaves it lit too, which helps when an agent needs to see a front end. Manual sleep and closing the lid still work.",
              )}
            </p>
            <p className="codex-note">
              {t("When a provider's usage limit stops a turn, wait for the advertised reset and send the continue message itself — a real request that spends from the account.")}
            </p>

            <h3>{t("Text generation")}</h3>
            <TextGenerationPicker settings={settings} providerMode={info.mode} />
            <label className="wt-field settings-field-gap">
              <span>{t("Thread titles")}</span>
              <div className="choices" role="radiogroup">
                {(
                  [
                    ["once", "Name once"],
                    ["updated", "Keep updated"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    role="radio"
                    aria-checked={(settings.threadTitles ?? "once") === mode}
                    className={`choice${(settings.threadTitles ?? "once") === mode ? " active" : ""}`}
                    disabled={(settings.textGeneration ?? "automatic") === "off"}
                    onClick={() => tryCall("settings:set", { threadTitles: mode })}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
            </label>
          </>
        );

      case "models":
        return (
          <>
            <h3>{t("Codex CLI")}</h3>
            <div className="about codex-setup" aria-busy={busy !== null}>
              <div className="kv">
                <span>{t("This launch")}</span>
                <span>
                  {t(info.providerLabel)}
                  {codex ? ` — ${sourceLabel(t, codex)}` : ""}
                </span>
                {codex?.runtime && (
                  <>
                    <span>{t("Runtime status")}</span>
                    <span className="mono">
                      {codex.runtime.state === "fixture"
                        ? t("offline fixture (synthetic)")
                        : codex.runtime.state === "configured-unverified"
                          ? t("configured — unverified")
                          : codex.runtime.state === "unsupported"
                            ? t("unsupported")
                            : t("unconfigured")}
                    </span>
                    {codex.runtime.reason && (
                      <>
                        <span>{t("Runtime reason")}</span>
                        <span className="mono">{translateError(t, codex.runtime.reason)}</span>
                      </>
                    )}
                  </>
                )}
                {codex?.effectiveExecutable && (
                  <>
                    <span>{t("Executable in use")}</span>
                    <span className="mono">{codex.effectiveExecutable}</span>
                  </>
                )}
                <span>{t("Saved program")}</span>
                <span className="mono">
                  {codex ? codex.savedExecutable ?? t("None saved") : t(loadErr ? "Failed to load" : "Loading")}
                </span>
                {codex?.savedInvalidReason && (
                  <>
                    <span>{t("Saved path status")}</span>
                    <span className="mono">{translateError(t, codex.savedInvalidReason)}</span>
                  </>
                )}
                {codex && codex.savedEffect !== "none" && (
                  <>
                    <span>{t("Saved effect")}</span>
                    <span>
                      {codex.savedEffect === "active"
                        ? t("In effect for this launch")
                        : codex.savedEffect === "pending-restart"
                          ? t("Takes effect on next launch")
                          : codex.savedBlockReason
                            ? translateError(t, codex.savedBlockReason)
                            : t("Blocked by an explicit override")}
                    </span>
                  </>
                )}
                {codex && codex.savedExecutable === null && (
                  <>
                    <span>{t("After restart")}</span>
                    <span>{t("No saved program will be used. Explicit provider and environment settings still apply; without them, the default provider is used. This launch is unchanged.")}</span>
                  </>
                )}
                {codex?.pendingExecutable && (
                  <>
                    <span>{t("Selected, not saved")}</span>
                    <span className="mono">{codex.pendingExecutable}</span>
                  </>
                )}
              </div>
              <p>
                {t(
                  "Choosing only selects a candidate. Saving or clearing changes the saved setting, not this launch, and never starts the program. On restart, explicit provider and environment settings take priority. A saved path is not installed or verified.",
                )}
              </p>
              {codexErr && (
                <p className="codex-setup-error" role="alert">
                  {translateError(t, codexErr)}
                </p>
              )}
              {loadErr && <p className="codex-setup-error" role="alert">{translateError(t, loadErr)}</p>}
              <div className="choice-row">
                <button
                  className="choice"
                  disabled={!canWrite}
                  onClick={() => void run("choose", () => api().invoke("codex:choose", {}))}
                >
                  {busy === "choose" || codex?.chooserBusy ? t("Choosing…") : t("Choose program…")}
                </button>
                <button
                  className="choice"
                  disabled={!canWrite || !codex?.pendingExecutable}
                  onClick={() => void run("save", () => api().invoke("codex:save", {}))}
                >
                  {busy === "save" ? t("Saving…") : t("Save")}
                </button>
                <button
                  className="choice danger"
                  disabled={
                    !canWrite || (!codex?.savedExecutable && !codex?.pendingExecutable)
                  }
                  onClick={() => void run("clear", () => api().invoke("codex:clear", {}))}
                >
                  {busy === "clear" ? t("Clearing…") : t("Clear")}
                </button>
                <button className="choice" disabled={busy !== null} onClick={() => void run("load")}>
                  {busy === "load" ? t("Loading") : t(loadErr ? "Retry" : "Refresh status")}
                </button>
              </div>
            </div>

            <h3>{t("Models")}</h3>
            <ModelListSettings />
          </>
        );

      case "hydra":
        return <HydraSection settings={settings} />;

      case "connections":
        return (
          <div className="connections-section" data-testid="connections-section">
            <h3>{t("Connections")}</h3>
            <McpSection settings={settings} home={info.home} />

            <div className="local-control-section" data-testid="local-control-section">
              <h4 className="sub-head">{t("Local control")}</h4>
              <div className="choice-row">
                <button
                  role="switch"
                  aria-checked={settings.externalControlEnabled === true}
                  data-testid="local-control-toggle"
                  className={`choice${settings.externalControlEnabled === true ? " active" : ""}`}
                  onClick={() =>
                    tryCall("settings:set", {
                      externalControlEnabled: settings.externalControlEnabled !== true,
                    })
                  }
                >
                  {t("Local control")}
                </button>
              </div>
              <p className="codex-note" data-testid="local-control-detail">
                {t("Let a command-line client control this running edition of Tivano. Other processes in your account can use this access. Approvals stay in Tivano. No network listener or automatic app launch.")}
              </p>
              <div className="kv control-status" data-testid="local-control-status">
                <span>{t("Local control status")}</span>
                <span>
                  {!control || !control.enabled
                    ? t("Disabled")
                    : control.listening
                      ? t("Listening for this account only")
                      : t("Local control could not start. Retry after resolving the socket or permission conflict.")}
                  {control?.enabled && !control.listening && (
                    <button
                      className="choice control-retry settings-btn-compact"
                      onClick={() =>
                        void api()
                          .invoke("control:retry", {})
                          .then(() => refreshControl())
                      }
                    >
                      {t("Retry")}
                    </button>
                  )}
                </span>
              </div>

              <h4 className="sub-head">{t("CLI command")}</h4>
              <p className="codex-note" data-testid="cli-detail">
                {t("Install the command in a user-owned bin directory on your request only. Installation never enables local control. Add that directory to PATH yourself if needed; Tivano does not edit shell configuration.")}
              </p>
              <div className="kv control-status" data-testid="cli-status">
                <span>{t("CLI command")}</span>
                <span>
                  {!cli || cli.state === "unavailable"
                    ? t("unavailable in this build")
                    : cli.state === "absent"
                      ? t("Not installed")
                      : cli.state === "foreign"
                        ? t("Another tivano command exists — Tivano will not replace it")
                        : cli.state === "repair"
                          ? t("Installed, but it points to an older copy of Tivano. Repair it to use this one.")
                          : t("Installed")}
                  {cli?.dir && cli.state !== "unavailable" && (
                    <span className="mono dim"> {cli.dir}</span>
                  )}
                </span>
              </div>
              <div className="choice-row">
                <button
                  className="choice"
                  data-testid="cli-install"
                  onClick={() =>
                    void api()
                      .invoke("cli:install", {})
                      .then((r) => {
                        if (mounted.current) setCli(r as CliState);
                        if ((r as { state?: string }).state !== "installed")
                          setCliErr(t("Could not change the CLI command"));
                      })
                      .catch(async () => {
                        if (!mounted.current) return;
                        setCliErr(t("Could not change the CLI command"));
                        await refreshCli();
                      })
                  }
                >
                  {cli?.state === "installed"
                    ? t("Reinstall CLI")
                    : cli?.state === "repair"
                      ? t("Repair CLI")
                      : t("Install CLI")}
                </button>
                <button
                  className="choice danger"
                  data-testid="cli-uninstall"
                  disabled={!cli || (cli.state !== "installed" && cli.state !== "repair")}
                  onClick={() =>
                    void api()
                      .invoke("cli:uninstall", {})
                      .then((r) => {
                        if (mounted.current) setCli(r as CliState);
                      })
                      .catch(async () => {
                        if (!mounted.current) return;
                        setCliErr(t("Could not change the CLI command"));
                        await refreshCli();
                      })
                  }
                >
                  {t("Uninstall CLI")}
                </button>
              </div>
              {cliErr && (
                <p className="codex-note" data-testid="cli-error">{cliErr}</p>
              )}
            </div>

            <RemoteMcpSection settings={settings} />
            <ForgeSection worktreesDir={info.worktreesDir} />
          </div>
        );

      case "shortcuts":
        return (
          <ShortcutsSection
            shortcuts={settings.shortcuts}
            quickChatEnabled={settings.quickChatEnabled === true}
          />
        );

      case "storage":
        return (
          <>
            <h3>{t("Archive")}</h3>
            <ArchiveSection
              threads={props.threads}
              projects={props.projects}
              settings={settings}
            />
          </>
        );

      case "about":
        return (
          <>
            <VersionSection
              appVersion={info.appVersion}
              settings={settings}
              whatsNew={info.whatsNew}
            />

            <h3>{t("About")}</h3>
            <div className="about">
              <p>
                <strong>{t("Tivano Windows")}</strong> — {t("An independent derivative of Tivano.")}{" "}
                ({t("Baseline")} {info.baselineTag}, commit{" "}
                <span className="mono">{info.baselineCommit.slice(0, 12)}</span>,{" "}
                {t("modified %@", "2026-10-23")}).{" "}
                {t("Not affiliated with or endorsed by Droppy or Jordy Spruit.")}
              </p>
              <p>
                {t("Original work:")}{" "}
                <strong>Droppy Code by Jordy Spruit (Droppy)</strong>,{" "}
                <span className="mono">https://getdroppycode.app</span>.{" "}
                {t(
                  "Licensed under AGPL-3.0 with the section-7 attribution terms; see LICENSE and THIRD_PARTY_NOTICES.md.",
                )}
              </p>
              <div className="kv">
                <span>{t("Version")}</span>
                <span className="mono">{info.appVersion}</span>
                <span>{t("Provider")}</span>
                <span>{t(info.providerLabel)}</span>
                {info.codex && (
                  <>
                    <span>{t("Codex")}</span>
                    <span className="mono">
                      {info.codex.state === "fixture"
                        ? t("offline fixture (synthetic)")
                        : info.codex.state === "configured-unverified"
                          ? t("configured — unverified")
                          : info.codex.state === "unsupported"
                            ? t("unsupported")
                            : t("unconfigured")}
                    </span>
                    <span>{t("Protocol pin")}</span>
                    <span className="mono">{info.codex.protocolPin}</span>
                    {info.codex.executable && (
                      <>
                        <span>{t("Codex executable")}</span>
                        <span className="mono">{info.codex.executable}</span>
                      </>
                    )}
                    {info.codex.reason && (
                      <>
                        <span>{t("Codex status")}</span>
                        <span className="mono">{translateError(t, info.codex.reason)}</span>
                      </>
                    )}
                  </>
                )}
                {info.syntheticRuntime && (
                  <>
                    <span>{t("Runtime")}</span>
                    <span className="mono">
                      {info.syntheticRuntime.executable} ({info.syntheticRuntime.version})
                    </span>
                  </>
                )}
                <span>{t("Data directory")}</span>
                <span className="mono">{info.dataRoot}</span>
                {info.recoveredFrom && (
                  <>
                    <span>{t("Recovered store")}</span>
                    <span className="mono">{info.recoveredFrom}</span>
                  </>
                )}
              </div>
              {info.recoveredFrom && (
                <p>{t("A previous store file was unreadable and was preserved aside.")}</p>
              )}
            </div>
          </>
        );
    }
  };

  return (
    <div
      className="modal-veil"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => e.key === "Escape" && close()}
    >
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("Settings")}
      >
        <div className="settings-head">
          <h2>{t("Settings")}</h2>
        </div>

        <div className="settings-body">
          <nav
            className="settings-nav"
            role="tablist"
            aria-orientation="vertical"
            aria-label={t("Settings pages")}
          >
            {SETTINGS_PAGES.map((item, idx) => (
              <button
                key={item.id}
                id={`settings-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={page === item.id}
                aria-controls={`settings-panel-${item.id}`}
                tabIndex={page === item.id ? 0 : -1}
                data-settings-page={item.id}
                className={`settings-nav-item${page === item.id ? " active" : ""}`}
                onClick={() => setPage(item.id)}
                onKeyDown={(e) => {
                  let nextIdx: number | null = null;
                  if (e.key === "ArrowDown") nextIdx = (idx + 1) % SETTINGS_PAGES.length;
                  else if (e.key === "ArrowUp")
                    nextIdx = (idx - 1 + SETTINGS_PAGES.length) % SETTINGS_PAGES.length;
                  else if (e.key === "Home") nextIdx = 0;
                  else if (e.key === "End") nextIdx = SETTINGS_PAGES.length - 1;
                  if (nextIdx === null) return;
                  e.preventDefault();
                  const nextPage = SETTINGS_PAGES[nextIdx]!;
                  setPage(nextPage.id);
                  const nav = e.currentTarget.parentElement;
                  nav?.querySelector<HTMLButtonElement>(`#settings-tab-${nextPage.id}`)?.focus();
                }}
              >
                {t(item.label)}
              </button>
            ))}
          </nav>

          <div
            ref={paneRef}
            id={`settings-panel-${page}`}
            className="settings-pane"
            role="tabpanel"
            aria-labelledby={`settings-tab-${page}`}
            data-page={page}
          >
            {renderPage()}
          </div>
        </div>

        <div className="modal-actions">
          <button className="primary" onClick={close}>
            {t("Close")}
          </button>
        </div>
      </div>
    </div>
  );
}
