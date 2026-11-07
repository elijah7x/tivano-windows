// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F18 bounded slice: MCP settings — stdio + streamable-HTTP servers. A
// server here is a saved configuration plus an on-demand real probe
// (spawn/POST → initialize → tools/list). Saved servers ride into Codex
// sessions as config.mcp_servers at thread start; other providers never
// see them, and OAuth/session resumption stay out — all stated plainly.

import { useEffect, useRef, useState } from "react";
import { api, tryCall } from "../client";
import { useT } from "../locale";
import type { McpProbeResult, McpServerConfig } from "../../shared/mcp";
import {
  MCP_CATEGORY_ORDER,
  catalogByCategory,
  catalogNeedsInput,
  resolveCatalogEntry,
  type McpCatalogEntry,
} from "../../shared/mcpCatalog";
import type { Settings } from "../../shared/types";
import { WorkingSpinner } from "./SpinnerCells";
import { playSettleChime } from "../settleChime";

/** Shell-ish split: honors 'single' and "double" quotes, no expansion. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

function joinArgs(args: string[]): string {
  return args.map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

interface Row {
  result: McpProbeResult | "checking" | null;
  showTools: boolean;
}

export function McpSection(props: { settings: Settings; home: string }): React.JSX.Element {
  const t = useT();
  const servers = props.settings.mcpServers ?? [];
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [adding, setAdding] = useState(false);
  // A73 catalog picker: closed → list → per-entry field form.
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [picked, setPicked] = useState<McpCatalogEntry | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);
  const mounted = useRef(true);
  /** Last resolved probe status per server — the settle chime fires only
   *  on a real not-connected → connected transition (frozen onChange). */
  const lastStatus = useRef(new Map<string, string>());
  // StrictMode replays mount effects — the reset must live in setup,
  // not just the initial ref value, or late probe resolves drop dead.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setRow = (id: string, patch: Partial<Row>) =>
    setRows((r) => ({ ...r, [id]: { result: null, showTools: false, ...r[id], ...patch } }));

  const save = (list: McpServerConfig[]) => tryCall("settings:set", { mcpServers: list });

  const add = () => {
    const n = name.trim();
    const c = command.trim();
    const u = url.trim();
    if (n === "") return setFormErr(t("The server needs a name."));
    if (transport === "stdio" && c === "")
      return setFormErr(t("A stdio server needs a command."));
    if (transport === "http" && !/^https?:\/\/.+/.test(u))
      return setFormErr(t("An HTTP server needs an http(s) URL."));
    if (servers.some((s) => s.name === n))
      return setFormErr(t('A server named "%@" already exists.', n));
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const s = line.trim();
      if (s === "") continue;
      const eq = s.indexOf("=");
      if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.slice(0, eq)))
        return setFormErr(t("Environment lines must look like KEY=value."));
      env[s.slice(0, eq)] = s.slice(eq + 1);
    }
    const server: McpServerConfig =
      transport === "http"
        ? {
            id: globalThis.crypto.randomUUID(),
            name: n,
            transport: "http",
            command: "",
            args: [],
            url: u,
          }
        : {
            id: globalThis.crypto.randomUUID(),
            name: n,
            transport: "stdio",
            command: c,
            args: splitArgs(args),
            env,
          };
    save([...servers, server]);
    setAdding(false);
    setName("");
    setTransport("stdio");
    setCommand("");
    setUrl("");
    setArgs("");
    setEnvText("");
    setFormErr(null);
    return undefined;
  };

  /** A74 frozen MCPKeyPanel: picking a keyed entry opens its keysURL in
   *  the browser as the form appears — the steps below say it did. */
  const pick = (e: McpCatalogEntry) => {
    setPicked(e);
    setFieldValues({});
    if (e.keysURL) tryCall("links:open-external", { url: e.keysURL });
  };

  /** A74 frozen pickPath: a path-kind field's browse button — the
   *  filesystem entry chooses a folder, every other path field a file. */
  const browse = async (fieldKey: string) => {
    if (!picked) return;
    const r = (await api().invoke("mcp:pick", {
      dirs: picked.id === "filesystem",
    })) as { path: string | null };
    if (r.path) setFieldValues((v) => ({ ...v, [fieldKey]: r.path! }));
  };

  /** A73: resolve the picked catalog entry with the typed field values
   *  and save it as a regular server — the row then probes exactly like
   *  a manual one. Frozen MCPKeyPanel's "Save and connect" probes right
   *  away, so save kicks the same probe. */
  const saveCatalog = () => {
    if (!picked) return;
    const server = resolveCatalogEntry(picked, fieldValues, props.home);
    if (!server) return;
    if (servers.some((s) => s.id === server.id))
      return setFormErr(t('A server named "%@" already exists.', picked.name));
    save([...servers, server]);
    void probe(server);
    setPicked(null);
    setFieldValues({});
    setFormErr(null);
    return undefined;
  };

  const probe = async (s: McpServerConfig) => {
    const wasConnected = lastStatus.current.get(s.id) === "connected";
    lastStatus.current.set(s.id, "checking");
    setRow(s.id, { result: "checking", showTools: false });
    try {
      const r = (await api().invoke("mcp:probe", {
        transport: s.transport ?? "stdio",
        command: s.command,
        args: s.args,
        env: s.env,
        ...(s.url ? { url: s.url } : {}),
        ...(s.headers ? { headers: s.headers } : {}),
      })) as McpProbeResult;
      if (mounted.current) {
        // Frozen MCPSettingsPage: a server newly landing in connected
        // gets the quiet settle tick — gated by reduce-motion like the
        // frozen onChange guard.
        if (
          r.status === "connected" &&
          !wasConnected &&
          !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        )
          playSettleChime();
        setRow(s.id, { result: r });
      }
      lastStatus.current.set(s.id, r.status);
    } catch (e) {
      if (mounted.current)
        setRow(s.id, {
          result: { status: "error", reason: e instanceof Error ? e.message : String(e) },
        });
      lastStatus.current.set(s.id, "error");
    }
  };

  const statusLine = (
    s: McpServerConfig,
  ): { text: string; cls: string; detail?: string | undefined } => {
    const r = rows[s.id]?.result;
    if (r === undefined || r === null) return { text: t("Not checked"), cls: "mcp-st" };
    if (r === "checking") return { text: t("Checking…"), cls: "mcp-st mcp-st-busy" };
    switch (r.status) {
      case "connected":
        return {
          text: t("Connected · %d tools", String(r.tools.length)),
          cls: "mcp-st mcp-st-ok",
          detail: r.serverName
            ? `${r.serverName}${r.serverVersion ? ` ${r.serverVersion}` : ""}`
            : undefined,
        };
      case "missing":
        return {
          text:
            s.transport === "http"
              ? (r.reason ?? t("The endpoint isn't reachable."))
              : t("%@ isn't installed.", s.command),
          cls: "mcp-st mcp-st-bad",
        };
      case "exited":
        return {
          text:
            r.code === null ? t("The server quit.") : t("The server quit (exit %d).", String(r.code)),
          cls: "mcp-st mcp-st-bad",
          detail: r.stderr || undefined,
        };
      case "timedOut":
        return { text: t("The server didn't answer in time."), cls: "mcp-st mcp-st-bad" };
      case "malformed":
        return {
          text:
            r.reason === "invalid tool list"
              ? t("The server sent an invalid tool list.")
              : t("The server sent something unexpected: %@", r.reason ?? "invalid reply"),
          cls: "mcp-st mcp-st-bad",
        };
      default:
        return { text: r.reason ?? t("Check failed"), cls: "mcp-st mcp-st-bad" };
    }
  };

  return (
    <div className="mcp-section">
      <h3>MCP</h3>
      <p className="codex-note">
        {t(
          "Servers of your own: a command that runs on this computer, or a streamable-HTTP endpoint. Check runs a real JSON-RPC handshake and lists the tools the server actually reported; saved servers ride into Codex sessions when a thread starts — other providers never see them.",
        )}
      </p>

      {servers.length === 0 && !adding && (
        <div className="kv">
          <span>{t("No tools listed yet.")}</span>
          <span>{t("Add a stdio or HTTP server to check what it offers.")}</span>
        </div>
      )}

      {servers.map((s) => {
        const st = statusLine(s);
        const res = rows[s.id]?.result;
        const tools = res !== null && res !== undefined && res !== "checking" && res.status === "connected" ? res.tools : [];
        return (
          <div className="mcp-row" key={s.id} data-server={s.id}>
            <div className="mcp-row-main">
              <div className="mcp-name">{s.name}</div>
              <div
                className="mcp-cmd mono"
                title={
                  s.transport === "http"
                    ? (s.url ?? "")
                    : `${s.command} ${joinArgs(s.args)}`.trim()
                }
              >
                {s.transport === "http"
                  ? (s.url ?? "")
                  : `${s.command} ${joinArgs(s.args)}`.trim()}
              </div>
              <div className={st.cls} title={st.detail}>
                {res === "checking" && (
                  <span className="mcp-spin" aria-hidden="true">
                    <WorkingSpinner cellSize={3} />
                  </span>
                )}
                {st.text}
              </div>
              {tools.length > 0 && (
                <button
                  className="mcp-tools-toggle"
                  onClick={() => setRow(s.id, { showTools: !rows[s.id]?.showTools })}
                >
                  {rows[s.id]?.showTools ? t("Hide tools") : t("Show tools")}
                </button>
              )}
              {rows[s.id]?.showTools && (
                <ul className="mcp-tools">
                  {tools.map((tool) => (
                    <li key={tool.name} title={tool.description}>
                      <span className="mono">{tool.name}</span>
                      {tool.description && <span className="mcp-tool-desc">{tool.description}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mcp-row-ops">
              <button
                className="choice mcp-check"
                disabled={rows[s.id]?.result === "checking"}
                onClick={() => void probe(s)}
              >
                {res === "checking" ? t("Checking…") : t("Check now")}
              </button>
              <button
                className="choice mcp-remove"
                onClick={() => save(servers.filter((x) => x.id !== s.id))}
              >
                {t("Remove")}
              </button>
            </div>
          </div>
        );
      })}

      {catalogOpen && !picked && (
        <div className="mcp-catalog" data-testid="mcp-catalog">
          {catalogByCategory().map((g) => (
            <div className="mcp-cat-group" key={g.category}>
              <div className="mcp-cat-head">{t(g.category)}</div>
              {g.entries.map((e) => {
                const needsFields = catalogNeedsInput(e);
                const oauth = e.transport.kind === "oauth";
                const mark = `#${e.color.toString(16).padStart(6, "0")}`;
                return (
                  <button
                    key={e.id}
                    className={`mcp-cat-row${oauth ? " mcp-cat-oauth" : ""}`}
                    data-entry={e.id}
                    disabled={oauth}
                    title={
                      oauth
                        ? t("This service signs in with a browser window — not supported in this build yet.")
                        : undefined
                    }
                    onClick={() => {
                      if (oauth) return;
                      if (needsFields) {
                        pick(e);
                      } else {
                        const server = resolveCatalogEntry(e, {}, props.home);
                        if (server && !servers.some((s) => s.id === server.id))
                          save([...servers, server]);
                      }
                    }}
                  >
                    <span
                      className={`mcp-cat-mark${e.monochrome ? " mcp-cat-mono" : ""}`}
                      style={{ background: mark }}
                    />
                    <span className="mcp-cat-main">
                      <span className="mcp-cat-name">
                        {e.name}
                        <span className="mcp-cat-vendor">{e.vendor}</span>
                      </span>
                      <span className="mcp-cat-summary">{e.summary}</span>
                      <span className="mcp-cat-tools">
                        {e.sampleTools.slice(0, 3).join(" · ")}
                      </span>
                    </span>
                    <span className="mcp-cat-side">
                      {oauth ? t("Needs sign-in") : needsFields ? t("Needs a key") : t("Add")}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {picked && (
        <div className="mcp-form mcp-cat-form" data-testid="mcp-cat-form">
          <div className="mcp-cat-form-head">
            <strong>{picked.name}</strong>
            <button
              className="mcp-cat-doc"
              onClick={() => tryCall("links:open-external", { url: picked.docsURL })}
            >
              {t("Docs")}
            </button>
            {picked.keysURL && (
              <button
                className="mcp-cat-doc mcp-cat-keys"
                onClick={() => tryCall("links:open-external", { url: picked.keysURL! })}
              >
                {t("Get a key")}
              </button>
            )}
          </div>
          <p className="codex-note">{picked.summary}</p>
          <div className="mcp-cat-steps">
            {picked.keysURL ? (
              <>
                <div className="mcp-step">
                  <span className="mcp-step-n">1</span>
                  <span>
                    {t("The page is open in your browser")}
                    {" · "}
                    <button
                      className="mcp-cat-doc"
                      onClick={() =>
                        tryCall("links:open-external", { url: picked.keysURL! })
                      }
                    >
                      {t("Open it again")}
                    </button>
                  </span>
                </div>
                <div className="mcp-step">
                  <span className="mcp-step-n">2</span>
                  <span>
                    {t("Copy the %@", picked.fields?.[0]?.label ?? t("key"))}
                  </span>
                </div>
                <div className="mcp-step">
                  <span className="mcp-step-n">3</span>
                  <span>{t("Paste it below and save")}</span>
                </div>
              </>
            ) : (
              <>
                <div className="mcp-step">
                  <span className="mcp-step-n">1</span>
                  <span>
                    {t("Enter the %@", picked.fields?.[0]?.label ?? t("value"))}
                  </span>
                </div>
                <div className="mcp-step">
                  <span className="mcp-step-n">2</span>
                  <span>{t("Save")}</span>
                </div>
              </>
            )}
          </div>
          {(picked.fields ?? []).map((f) => (
            <label className="wt-field" key={f.key}>
              <span>
                {f.label}
                {f.isRequired === false && <em className="mcp-cat-opt">{t("optional")}</em>}
              </span>
              <span className="mcp-cat-fieldrow">
                <input
                  className="wt-input mono"
                  data-field={f.key}
                  type={f.kind === "secret" ? "password" : "text"}
                  value={fieldValues[f.key] ?? ""}
                  placeholder={f.placeholder}
                  spellCheck={false}
                  onChange={(e) =>
                    setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))
                  }
                />
                {f.kind === "path" && (
                  <button
                    className="choice mcp-cat-browse"
                    title={t("Choose a file or folder")}
                    aria-label={t("Choose a file or folder")}
                    onClick={(e) => {
                      e.preventDefault();
                      void browse(f.key);
                    }}
                  >
                    📁
                  </button>
                )}
              </span>
              {f.help && <span className="mcp-cat-help">{f.help}</span>}
            </label>
          ))}
          <p className="codex-note">
            {t("Keys are stored in plain text in the local settings file.")}
          </p>
          {formErr && <p className="mcp-err">{formErr}</p>}
          <div className="mcp-form-ops">
            <button
              className="choice active mcp-cat-save"
              disabled={
                (picked.fields ?? []).some(
                  (f) =>
                    f.isRequired !== false &&
                    (fieldValues[f.key] ?? f.defaultValue ?? "").trim() === "",
                )
              }
              onClick={saveCatalog}
            >
              {t("Save and connect")}
            </button>
            <button className="choice" onClick={() => setPicked(null)}>
              {t("Cancel")}
            </button>
          </div>
        </div>
      )}

      {adding ? (
        <div className="mcp-form">
          <label className="wt-field">
            <span>{t("Name")}</span>
            <input
              className="wt-input mcp-f-name"
              value={name}
              placeholder={t("My server")}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="wt-field mcp-f-transport">
            <span>{t("Transport")}</span>
            <div className="mcp-transport">
              <button
                className={`choice${transport === "stdio" ? " active" : ""}`}
                onClick={() => setTransport("stdio")}
              >
                {t("Stdio command")}
              </button>
              <button
                className={`choice${transport === "http" ? " active" : ""}`}
                onClick={() => setTransport("http")}
              >
                {t("Streamable HTTP")}
              </button>
            </div>
          </div>
          {transport === "http" ? (
            <label className="wt-field">
              <span>{t("URL")}</span>
              <input
                className="wt-input mcp-f-url mono"
                value={url}
                placeholder="https://localhost:3000/mcp"
                spellCheck={false}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
          ) : (
            <label className="wt-field">
              <span>{t("Command")}</span>
              <input
                className="wt-input mcp-f-command mono"
                value={command}
                placeholder="npx"
                spellCheck={false}
                onChange={(e) => setCommand(e.target.value)}
              />
            </label>
          )}
          {transport === "stdio" && (
          <label className="wt-field">
            <span>{t("Arguments")}</span>
            <input
              className="wt-input mcp-f-args mono"
              value={args}
              placeholder="-y @modelcontextprotocol/server-everything"
              spellCheck={false}
              onChange={(e) => setArgs(e.target.value)}
            />
          </label>
          )}
          {transport === "stdio" && (
          <label className="wt-field">
            <span>{t("Environment")}</span>
            <textarea
              className="wt-input mcp-f-env mono"
              value={envText}
              placeholder={"KEY=value\nONE_PER_LINE=1"}
              spellCheck={false}
              rows={3}
              onChange={(e) => setEnvText(e.target.value)}
            />
          </label>
          )}
          {transport === "stdio" && (
            <p className="codex-note">
              {t("Variables are stored in plain text in the local settings file.")}
            </p>
          )}
          {formErr && <p className="mcp-err">{formErr}</p>}
          <div className="mcp-form-ops">
            <button className="choice active mcp-f-save" onClick={add}>
              {t("Add server")}
            </button>
            <button
              className="choice"
              onClick={() => {
                setAdding(false);
                setFormErr(null);
              }}
            >
              {t("Cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mcp-addrow">
          <button
            className="choice mcp-add"
            onClick={() => {
              setAdding(true);
              setCatalogOpen(false);
              setPicked(null);
            }}
          >
            {t("Add server")}
          </button>
          <button
            className={`choice mcp-browse${catalogOpen ? " active" : ""}`}
            onClick={() => {
              setCatalogOpen((o) => !o);
              setPicked(null);
              setFormErr(null);
            }}
          >
            {t("Browse catalog")}
          </button>
        </div>
      )}
    </div>
  );
}
