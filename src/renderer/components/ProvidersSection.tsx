// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Settings › Providers: registered providers list, ZCode discovery/setup,
// Z.ai region selector, and write-only GLM Coding Plan API key slot.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CodexChooseResult,
  CodexWriteResult,
  RegisteredProviderSummary,
  ZCodeSetupState,
} from "../../shared/types";
import { ZAI_REGIONS, type ZaiRegion } from "../../shared/providers";
import { useT } from "../locale";
import { api, tryCall } from "../client";

function zcodeSourceLabel(t: (k: string) => string, s: ZCodeSetupState): string {
  switch (s.effectiveSource) {
    case "fixture":
      return t("offline fixture (synthetic)");
    case "environment":
      return t("environment variable");
    case "saved":
      return t("saved setting");
    case "default":
      return t("default location");
    case "none":
      return t("not configured");
    default:
      return s.launchProvider === "zcode" ? t("unknown") : t("not a ZCode launch");
  }
}

export function ProvidersSection(props: {
  region: ZaiRegion;
  activeLabel: string;
}): React.JSX.Element {
  const t = useT();
  const [providers, setProviders] = useState<RegisteredProviderSummary[]>([]);
  const [zcode, setZcode] = useState<ZCodeSetupState | null>(null);
  const [zcodeErr, setZcodeErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    "load" | "refresh" | "choose" | "save" | "clear" | "key" | null
  >(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState<string | null>(null);
  const mounted = useRef(true);

  const loadAll = useCallback(async () => {
    try {
      const [list, state] = await Promise.all([
        api().invoke("providers:list", {}) as Promise<RegisteredProviderSummary[]>,
        api().invoke("zcode:setup-state", {}) as Promise<ZCodeSetupState>,
      ]);
      if (!mounted.current) return;
      if (Array.isArray(list)) setProviders(list);
      setZcode(state);
    } catch (e) {
      if (mounted.current) setZcodeErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadAll();
    return () => {
      mounted.current = false;
    };
  }, [loadAll, props.region]);

  const runZCodeOp = async (
    op: "refresh" | "choose" | "save" | "clear",
    invoke: () => Promise<unknown>,
  ) => {
    if (busy !== null) return;
    setBusy(op);
    setZcodeErr(null);
    try {
      const r = (await invoke()) as CodexChooseResult | CodexWriteResult | ZCodeSetupState;
      if (!mounted.current) return;
      if ("status" in r) {
        if (r.status === "invalid" || r.status === "unavailable") setZcodeErr(r.reason);
        else if (r.status === "error") setZcodeErr(r.error);
        else if (r.status === "superseded") setZcodeErr("Selection was superseded by a newer action");
        else if (r.status === "busy") {
          setZcodeErr("The program chooser is already open. Close it, then refresh status.");
        }
      }
      await loadAll();
    } catch (e) {
      if (mounted.current) setZcodeErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const submitApiKey = async (value: string | null) => {
    if (busy !== null) return;
    setBusy("key");
    setZcodeErr(null);
    setKeyStatus(null);
    try {
      const r = (await api().invoke("zcode:set-api-key", {
        apiKey: value,
      })) as CodexWriteResult;
      if (!mounted.current) return;
      if (r.status === "error") {
        setZcodeErr(r.error);
      } else {
        setApiKeyInput("");
        setKeyStatus(
          r.status === "cleared" ? t("API key cleared") : t("API key saved"),
        );
      }
      await loadAll();
    } catch (e) {
      if (mounted.current) setZcodeErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const canWrite = !!zcode?.mutable && busy === null && !zcode.chooserBusy;

  return (
    <div className="providers-section" data-testid="providers-section">
      <h3>{t("Providers")}</h3>
      <div className="about codex-setup" data-testid="registered-providers">
        {providers.map((p) => (
          <div className="kv" key={p.id} data-provider={p.id}>
            <span>
              <strong>{t(p.displayName)}</strong>
              {p.active ? ` (${t("Active")})` : ""}
            </span>
            <span>
              {p.installed
                ? `${t("Installed")}${p.version && p.version !== "unknown" ? ` · ${p.version}` : ""}`
                : t("Not installed")}
              {" · "}
              {p.auth === "signedIn"
                ? p.authDetail
                  ? `${t("Signed in")} (${t(p.authDetail)})`
                  : t("Signed in")
                : p.auth === "signedOut"
                  ? t("Not signed in")
                  : t("Unknown")}
              {p.models.length > 0
                ? ` · ${p.models.map((m) => m.name).join(", ")}`
                : ""}
            </span>
          </div>
        ))}
      </div>

      <h4 className="sub-head">{t("ZCode")}</h4>
      <div className="about codex-setup" aria-busy={busy !== null} data-testid="zcode-setup">
        <div className="kv">
          <span>{t("This launch")}</span>
          <span>
            {t(props.activeLabel)}
            {zcode ? ` — ${zcodeSourceLabel(t, zcode)}` : ""}
          </span>
          <span>{t("Sign-in status")}</span>
          <span>
            {zcode
              ? zcode.auth === "signedIn"
                ? `${t("Signed in")}${zcode.authDetail ? ` (${t(zcode.authDetail)})` : ""}`
                : zcode.auth === "signedOut"
                  ? t("Not signed in")
                  : t("Not installed")
              : t("Loading")}
          </span>
          {zcode?.authMessage && (
            <>
              <span>{t("Notice")}</span>
              <span>{t(zcode.authMessage)}</span>
            </>
          )}
          {zcode?.effectiveEntry && (
            <>
              <span>{t("Entry in use")}</span>
              <span className="mono">{zcode.effectiveEntry}</span>
            </>
          )}
          <span>{t("Saved program")}</span>
          <span className="mono">
            {zcode ? zcode.savedExecutable ?? t("None saved") : t("Loading")}
          </span>
          {zcode?.savedInvalidReason && (
            <>
              <span>{t("Saved path status")}</span>
              <span className="mono">{zcode.savedInvalidReason}</span>
            </>
          )}
          {zcode && zcode.savedEffect !== "none" && (
            <>
              <span>{t("Saved effect")}</span>
              <span>
                {zcode.savedEffect === "active"
                  ? t("In effect for this launch")
                  : zcode.savedEffect === "pending-restart"
                    ? t("Takes effect on next launch")
                    : zcode.savedBlockReason ?? t("Blocked by an explicit override")}
              </span>
            </>
          )}
          {zcode?.pendingExecutable && (
            <>
              <span>{t("Selected, not saved")}</span>
              <span className="mono">{zcode.pendingExecutable}</span>
            </>
          )}
          <span>{t("Models")}</span>
          <span>
            {zcode && zcode.models.length > 0
              ? zcode.models.map((m) => m.name).join(", ")
              : t("No models reported")}
          </span>
        </div>

        <h4>{t("Region")}</h4>
        <div className="choice-row" role="radiogroup" aria-label={t("Region")}>
          {(["global", "china"] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={props.region === r}
              className={`choice${props.region === r ? " active" : ""}`}
              onClick={() => tryCall("settings:set", { zaiRegion: r })}
            >
              {t(ZAI_REGIONS[r].title)} ({ZAI_REGIONS[r].host})
            </button>
          ))}
        </div>
        <p className="codex-note">
          {t("Where your key was issued. Global uses api.z.ai, China uses open.bigmodel.cn.")}
        </p>

        <h4>{t("GLM Coding Plan key")}</h4>
        <div className="choice-row">
          <input
            className="wt-input mono"
            type={showKey ? "text" : "password"}
            value={apiKeyInput}
            placeholder={t("GLM Coding Plan key")}
            aria-label={t("GLM Coding Plan key")}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setApiKeyInput(e.target.value)}
          />
          <button
            type="button"
            className="choice"
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? t("Hide") : t("Show")}
          </button>
          <button
            type="button"
            className="choice"
            disabled={!canWrite || apiKeyInput.trim().length === 0}
            onClick={() => void submitApiKey(apiKeyInput.trim())}
          >
            {t("Save key")}
          </button>
          <button
            type="button"
            className="choice"
            disabled={!canWrite || !zcode?.hasApiKey}
            onClick={() => void submitApiKey(null)}
          >
            {t("Clear key")}
          </button>
        </div>
        <p className="codex-note">
          {zcode?.apiKeySource === "settings"
            ? t("A GLM Coding Plan key is stored in OS credential encryption.")
            : zcode?.apiKeySource === "environment"
              ? t("Using ZAI_API_KEY from your environment.")
              : t(
                  "ZCode signs in with your GLM Coding Plan key. Add it in Settings › Providers › Z.ai.",
                )}
        </p>
        {keyStatus && <p className="codex-note">{keyStatus}</p>}
        {zcodeErr && (
          <p className="codex-setup-error" role="alert">
            {t(zcodeErr)}
          </p>
        )}

        <div className="choice-row">
          <button
            type="button"
            className="choice"
            disabled={!canWrite}
            onClick={() => void runZCodeOp("choose", () => api().invoke("zcode:choose", {}))}
          >
            {busy === "choose" || zcode?.chooserBusy ? t("Choosing…") : t("Choose program…")}
          </button>
          <button
            type="button"
            className="choice"
            disabled={!canWrite || !zcode?.pendingExecutable}
            onClick={() => void runZCodeOp("save", () => api().invoke("zcode:save", {}))}
          >
            {busy === "save" ? t("Saving…") : t("Save")}
          </button>
          <button
            type="button"
            className="choice"
            disabled={!canWrite || (!zcode?.savedExecutable && !zcode?.pendingExecutable)}
            onClick={() => void runZCodeOp("clear", () => api().invoke("zcode:clear", {}))}
          >
            {busy === "clear" ? t("Clearing…") : t("Clear")}
          </button>
          <button
            type="button"
            className="choice"
            disabled={busy !== null}
            onClick={() => void runZCodeOp("refresh", () => api().invoke("zcode:refresh", {}))}
          >
            {busy === "refresh" ? t("Loading") : t("Refresh status")}
          </button>
          {zcode && !zcode.installed && (
            <button
              type="button"
              className="choice"
              onClick={() =>
                void api().invoke("links:open-external", {
                  url: "https://zcode.z.ai",
                })
              }
            >
              {t("Get ZCode")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
