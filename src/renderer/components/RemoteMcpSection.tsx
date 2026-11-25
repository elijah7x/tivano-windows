// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-25: Remote MCP settings rows under Settings > Connections (outside Alpha).

import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteMcpStatus, Settings } from "../../shared/types";
import { api, tryCall } from "../client";
import { useT } from "../locale";

function formatRelative(ts: number, lang: string): string {
  const sec = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(sec);
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
    if (abs < 60) return rtf.format(sec, "second");
    const min = Math.round(sec / 60);
    if (Math.abs(min) < 60) return rtf.format(min, "minute");
    const hr = Math.round(min / 60);
    if (Math.abs(hr) < 24) return rtf.format(hr, "hour");
    return rtf.format(Math.round(hr / 24), "day");
  } catch {
    return new Date(ts).toLocaleString();
  }
}

export function RemoteMcpSection(props: { settings: Settings }): React.JSX.Element {
  const t = useT();
  const { settings } = props;
  const [status, setStatus] = useState<RemoteMcpStatus | null>(null);
  const [addressDraft, setAddressDraft] = useState(settings.remoteMCPPublicURL ?? "");
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);

  const refreshStatus = useCallback(async () => {
    try {
      const s = (await api().invoke("remoteMcp:status", {})) as RemoteMcpStatus | null;
      if (mounted.current && s) setStatus(s);
    } catch {
      /* remoteMcp unavailable in non-hosted test contexts */
    }
  }, []);

  useEffect(() => {
    setAddressDraft(settings.remoteMCPPublicURL ?? "");
  }, [settings.remoteMCPPublicURL]);

  useEffect(() => {
    mounted.current = true;
    void refreshStatus();
    const detach = api().onEvent((e) => {
      if (e.type === "remote-mcp-changed" && mounted.current) setStatus(e.status);
    });
    return () => {
      mounted.current = false;
      detach();
    };
  }, [refreshStatus]);

  useEffect(() => {
    void refreshStatus();
  }, [settings.remoteMCPEnabled, settings.remoteMCPPublicURL, settings.remoteMCPPort, refreshStatus]);

  const port = status?.port ?? settings.remoteMCPPort ?? 0;
  const mcpUrl = status?.mcpUrl ?? (port > 0 ? `http://127.0.0.1:${port}/mcp` : "");
  const enabled = settings.remoteMCPEnabled === true;
  const listening = status?.listening === true;
  const publicValid = status?.publicUrlValid ?? true;

  const commitPublicUrl = () => {
    const cur = settings.remoteMCPPublicURL ?? "";
    if (addressDraft !== cur) {
      tryCall("settings:set", { remoteMCPPublicURL: addressDraft });
    }
  };

  const statusText = !enabled
    ? t("Disabled")
    : listening
      ? t("Listening on 127.0.0.1:%d", String(port))
      : status?.failure
        ? t("Remote MCP could not start. Retry after freeing the port.")
        : "";

  const addressDetail = !publicValid
    ? t("Enter an HTTPS address, or leave it empty for this computer only.")
    : t(
        "Your tunnel's HTTPS address, forwarding to http://127.0.0.1:%d. Leave empty to allow only this computer.",
        String(port),
      );

  return (
    <div className="remote-mcp-section" data-testid="remote-mcp-section">
      <h4 className="sub-head">{t("Remote MCP")}</h4>
      <div className="choice-row">
        <button
          role="switch"
          aria-checked={enabled}
          data-testid="remote-mcp-toggle"
          className={`choice${enabled ? " active" : ""}`}
          onClick={() => tryCall("settings:set", { remoteMCPEnabled: !enabled })}
        >
          {t("Remote MCP")}
        </button>
      </div>
      <p className="codex-note">
        {t(
          "Let cloud agents such as Muse or Grok Bot control this edition of Tivano over MCP, through a tunnel you run. Each agent needs your approval here once. Approvals and questions in chats still wait in Tivano.",
        )}
      </p>

      <div className="choice-row">
        <button
          role="switch"
          aria-checked={settings.remoteMCPFullAccess === true}
          data-testid="remote-mcp-full-access-toggle"
          className={`choice${settings.remoteMCPFullAccess === true ? " active" : ""}`}
          onClick={() =>
            tryCall("settings:set", {
              remoteMCPFullAccess: settings.remoteMCPFullAccess !== true,
            })
          }
        >
          {t("Run remote chats without approval")}
        </button>
      </div>
      <p className="codex-note">
        {t(
          "Chats that cloud agents create start in Full access: commands and file changes run without asking. Chats created while this is off, and your own chats, keep their permissions. Questions still wait in Tivano.",
        )}
      </p>

      <label className="wt-field remote-mcp-url-field">
        <span>{t("Public address")}</span>
        <input
          className="wt-input mono"
          data-testid="remote-mcp-public-url"
          value={addressDraft}
          placeholder={t("Paste your tunnel's HTTPS address")}
          spellCheck={false}
          onChange={(e) => setAddressDraft(e.target.value)}
          onBlur={commitPublicUrl}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      <p className="codex-note" data-testid="remote-mcp-address-detail">
        {addressDetail}
      </p>

      <div className="kv control-status" data-testid="remote-mcp-server-url">
        <span>{t("Server URL")}</span>
        <span className="remote-mcp-url-row">
          <span className="mono">{mcpUrl}</span>
          <button
            type="button"
            className="choice"
            aria-label={t("Copy server URL")}
            title={t("Copy server URL")}
            onClick={() => {
              if (!mcpUrl) return;
              void navigator.clipboard?.writeText(mcpUrl);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? "✓" : t("Copy")}
          </button>
        </span>
      </div>

      <div className="kv control-status" data-testid="remote-mcp-status">
        <span>{t("Remote MCP status")}</span>
        <span>
          {statusText}
          {enabled && !listening && status?.failure && (
            <button
              type="button"
              className="choice control-retry"
              aria-label={t("Retry remote MCP")}
              title={t("Retry remote MCP")}
              onClick={() =>
                void api()
                  .invoke("remoteMcp:retry", {})
                  .then((s) => {
                    if (mounted.current && s) setStatus(s as RemoteMcpStatus);
                  })
                  .catch(() => {})
              }
            >
              {t("Retry")}
            </button>
          )}
        </span>
      </div>

      {(status?.grants ?? []).map((g) => {
        const scopeLabel = g.scopes.includes("tivano.write")
          ? t("Full control")
          : t("Read only");
        const detail =
          g.lastUsedAt !== undefined
            ? `${scopeLabel} · ${t("Last used %@", formatRelative(g.lastUsedAt, settings.language))}`
            : scopeLabel;
        return (
          <div className="remote-mcp-grant" key={g.id} data-grant={g.id}>
            <div className="mcp-row-main">
              <div className="mcp-name">{g.clientName}</div>
              <div className="mcp-st">{detail}</div>
            </div>
            <div className="mcp-row-ops">
              <button
                type="button"
                className="choice remote-mcp-revoke"
                onClick={() =>
                  void api()
                    .invoke("remoteMcp:revoke", { id: g.id })
                    .then((s) => {
                      if (mounted.current && s) setStatus(s as RemoteMcpStatus);
                    })
                    .catch(() => {})
                }
              >
                {t("Revoke access")}
              </button>
            </div>
          </div>
        );
      })}

      {(status?.grants.length ?? 0) >= 2 && (
        <div className="choice-row">
          <button
            type="button"
            className="choice"
            onClick={() =>
              void api()
                .invoke("remoteMcp:revoke-all", {})
                .then((s) => {
                  if (mounted.current && s) setStatus(s as RemoteMcpStatus);
                })
                .catch(() => {})
            }
          >
            {t("Revoke all")}
          </button>
        </div>
      )}
    </div>
  );
}
