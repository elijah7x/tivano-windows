// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F18/P2-54 MCP settings inside Settings > Connections:
// connected/saved servers on top, unconnected catalog servers as
// compact category-filterable chips with an inline detail panel, and
// adding a custom server as the last chip.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, tryCall } from "../client";
import { useT } from "../locale";
import { translateNotice } from "../i18n";
import type { McpProbeResult, McpServerConfig } from "../../shared/mcp";
import {
  MCP_CATALOG,
  MCP_CATEGORY_ORDER,
  catalogEntry,
  catalogNeedsInput,
  resolveCatalogEntry,
  type McpCatalogEntry,
  type McpCategory,
} from "../../shared/mcpCatalog";
import type { Settings } from "../../shared/types";
import { WorkingSpinner } from "./SpinnerCells";
import { playSettleChime } from "../settleChime";

const CATEGORY_TITLE: Record<McpCategory, string> = {
  developer: "Developer",
  browser: "Browser",
  search: "Search",
  work: "Work",
  data: "Data",
  cloud: "Cloud",
  knowledge: "Knowledge",
};

/** Shell-ish split: honors 'single' and "double" quotes, no expansion. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

function joinArgs(args: string[]): string {
  return args
    .map((a) => (/[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");
}

interface Row {
  result: McpProbeResult | "checking" | null;
  showTools: boolean;
}

export function McpSection(props: {
  settings: Settings;
  home: string;
}): React.JSX.Element {
  const t = useT();
  const servers = props.settings.mcpServers ?? [];
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [selectedCategory, setSelectedCategory] = useState<McpCategory | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showDetailTools, setShowDetailTools] = useState(false);
  const [adding, setAdding] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [url, setUrl] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);
  const mounted = useRef(true);
  const lastStatus = useRef(new Map<string, string>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setRow = (id: string, patch: Partial<Row>) =>
    setRows((r) => ({
      ...r,
      [id]: { result: null, showTools: false, ...r[id], ...patch },
    }));

  const save = (list: McpServerConfig[]) =>
    tryCall("settings:set", { mcpServers: list });

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
          result: {
            status: "error",
            reason: e instanceof Error ? e.message : String(e),
          },
        });
      lastStatus.current.set(s.id, "error");
    }
  };

  // Connected servers sort to the top; remaining saved/custom servers follow.
  const orderedServers = useMemo(() => {
    const isConn = (s: McpServerConfig) => {
      const r = rows[s.id]?.result;
      return r !== null && r !== undefined && r !== "checking" && r.status === "connected";
    };
    return [...servers].sort((a, b) => Number(isConn(b)) - Number(isConn(a)));
  }, [servers, rows]);

  const savedIds = useMemo(() => new Set(servers.map((s) => s.id)), [servers]);

  const sortedUnconnected = useMemo(
    () =>
      MCP_CATALOG.filter((e) => !savedIds.has(e.id)).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    [savedIds],
  );

  const availableCategories = useMemo(
    () =>
      MCP_CATEGORY_ORDER.filter((cat) =>
        sortedUnconnected.some((e) => e.category === cat),
      ),
    [sortedUnconnected],
  );

  const activeCategory =
    selectedCategory && availableCategories.includes(selectedCategory)
      ? selectedCategory
      : null;

  const visibleEntries = useMemo(
    () =>
      activeCategory
        ? sortedUnconnected.filter((e) => e.category === activeCategory)
        : sortedUnconnected,
    [sortedUnconnected, activeCategory],
  );

  const selectedEntry = useMemo(
    () => visibleEntries.find((e) => e.id === selectedId) ?? null,
    [visibleEntries, selectedId],
  );

  const selectEntry = (e: McpCatalogEntry) => {
    setAdding(false);
    setFormErr(null);
    if (selectedId === e.id) {
      setSelectedId(null);
      return;
    }
    setSelectedId(e.id);
    setShowDetailTools(false);
    setFieldValues({});
    if (e.keysURL) tryCall("links:open-external", { url: e.keysURL });
  };

  const browse = async (fieldKey: string) => {
    if (!selectedEntry) return;
    const r = (await api().invoke("mcp:pick", {
      dirs: selectedEntry.id === "filesystem",
    })) as { path: string | null };
    if (r.path) setFieldValues((v) => ({ ...v, [fieldKey]: r.path! }));
  };

  const saveCatalog = (entry: McpCatalogEntry) => {
    const server = resolveCatalogEntry(entry, fieldValues, props.home);
    if (!server) return;
    if (servers.some((s) => s.id === server.id))
      return setFormErr(t("A server named \"%@\" already exists.", entry.name));
    save([...servers, server]);
    void probe(server);
    setSelectedId(null);
    setFieldValues({});
    setFormErr(null);
    return undefined;
  };

  const addCustom = () => {
    const n = name.trim();
    const c = command.trim();
    const u = url.trim();
    if (n === "") return setFormErr(t("The server needs a name."));
    if (transport === "stdio" && c === "")
      return setFormErr(t("A stdio server needs a command."));
    if (transport === "http" && !/^https?:\/\/.+/.test(u))
      return setFormErr(t("An HTTP server needs an http(s) URL."));
    if (servers.some((s) => s.name === n))
      return setFormErr(t("A server named \"%@\" already exists.", n));
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

  const statusLine = (
    s: McpServerConfig,
  ): { text: string; cls: string; detail?: string | undefined } => {
    const r = rows[s.id]?.result;
    if (r === undefined || r === null)
      return { text: t("Not checked"), cls: "mcp-st" };
    if (r === "checking")
      return { text: t("Checking…"), cls: "mcp-st mcp-st-busy" };
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
              ? r.reason
                ? translateNotice(t, r.reason)
                : t("The endpoint isn't reachable.")
              : t("%@ isn't installed.", s.command),
          cls: "mcp-st mcp-st-bad",
        };
      case "exited":
        return {
          text:
            r.code === null
              ? t("The server quit.")
              : t("The server quit (exit %d).", String(r.code)),
          cls: "mcp-st mcp-st-bad",
          detail: r.stderr || undefined,
        };
      case "timedOut":
        return {
          text: t("The server didn't answer in time."),
          cls: "mcp-st mcp-st-bad",
        };
      case "malformed":
        return {
          text:
            r.reason === "invalid tool list"
              ? t("The server sent an invalid tool list.")
              : t(
                  "The server sent something unexpected: %@",
                  r.reason ? translateNotice(t, r.reason) : t("invalid reply"),
                ),
          cls: "mcp-st mcp-st-bad",
        };
      default:
        return {
          text: r.reason ? translateNotice(t, r.reason) : t("Check failed"),
          cls: "mcp-st mcp-st-bad",
        };
    }
  };

  return (
    <div className="mcp-section" data-testid="mcp-section">
      <div className="mcp-lead" data-testid="mcp-lead">
        <span className="mcp-lead-icon" aria-hidden="true">
          ✓
        </span>
        <div className="mcp-lead-text">
          <strong>{t("Connected servers take priority")}</strong>{" "}
          <span>
            {t(
              "Connect a server here and every chat can use it. Anything set up in a terminal or another app stays just as it is.",
            )}
          </span>
        </div>
      </div>

      {orderedServers.length > 0 && (
        <div className="mcp-connected-list" data-testid="mcp-connected-list">
          <h4 className="sub-head">{t("Connected")}</h4>
          {orderedServers.map((s) => {
            const st = statusLine(s);
            const res = rows[s.id]?.result;
            const tools =
              res !== null &&
              res !== undefined &&
              res !== "checking" &&
              res.status === "connected"
                ? res.tools
                : [];
            const cat = catalogEntry(s.id);
            const mark = cat
              ? `#${cat.color.toString(16).padStart(6, "0")}`
              : undefined;
            return (
              <div className="mcp-row" key={s.id} data-server={s.id}>
                <div className="mcp-row-main">
                  <div className="mcp-name">
                    {mark && (
                      <span
                        className={`mcp-cat-mark mcp-row-mark${cat?.monochrome ? " mcp-cat-mono" : ""}`}
                        style={{ background: mark }}
                      />
                    )}
                    {s.name}
                  </div>
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
                      type="button"
                      className="mcp-tools-toggle"
                      onClick={() =>
                        setRow(s.id, { showTools: !rows[s.id]?.showTools })
                      }
                    >
                      {rows[s.id]?.showTools
                        ? t("Hide tools")
                        : t("Show tools")}
                    </button>
                  )}
                  {rows[s.id]?.showTools && (
                    <ul className="mcp-tools">
                      {tools.map((tool) => (
                        <li key={tool.name} title={tool.description}>
                          <span className="mono">{tool.name}</span>
                          {tool.description && (
                            <span className="mcp-tool-desc">
                              {tool.description}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="mcp-row-ops">
                  <button
                    type="button"
                    className="choice mcp-check"
                    disabled={rows[s.id]?.result === "checking"}
                    onClick={() => void probe(s)}
                  >
                    {res === "checking" ? t("Checking…") : t("Check now")}
                  </button>
                  <button
                    type="button"
                    className="choice mcp-remove"
                    onClick={() => save(servers.filter((x) => x.id !== s.id))}
                  >
                    {t("Remove")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mcp-add-card" data-testid="mcp-add-card">
        <h4 className="sub-head">{t("Add a server")}</h4>
        <div
          className="mcp-cat-filters"
          role="group"
          aria-label={t("Add a server")}
        >
          <button
            type="button"
            className={`mcp-cat-chip${activeCategory === null ? " active" : ""}`}
            data-category="all"
            onClick={() => setSelectedCategory(null)}
          >
            {t("All")}
          </button>
          {availableCategories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`mcp-cat-chip${activeCategory === cat ? " active" : ""}`}
              data-category={cat}
              onClick={() =>
                setSelectedCategory((cur) => (cur === cat ? null : cat))
              }
            >
              {t(CATEGORY_TITLE[cat])}
            </button>
          ))}
        </div>

        <div className="mcp-chip-wall" data-testid="mcp-chip-wall">
          {visibleEntries.map((e) => {
            const oauth = e.transport.kind === "oauth";
            const mark = `#${e.color.toString(16).padStart(6, "0")}`;
            const isSelected = selectedEntry?.id === e.id && !adding;
            return (
              <button
                key={e.id}
                type="button"
                className={`mcp-chip${isSelected ? " selected" : ""}${oauth ? " mcp-chip-oauth" : ""}`}
                data-entry={e.id}
                title={t(e.summary)}
                aria-pressed={isSelected}
                onClick={() => selectEntry(e)}
              >
                <span
                  className={`mcp-cat-mark${e.monochrome ? " mcp-cat-mono" : ""}`}
                  style={{ background: mark }}
                />
                <span className="mcp-chip-text">
                  <span className="mcp-chip-name">{e.name}</span>
                  <span className="mcp-chip-summary">{t(e.summary)}</span>
                </span>
              </button>
            );
          })}
          <button
            type="button"
            className={`mcp-chip mcp-chip-custom mcp-add${adding ? " selected" : ""}`}
            data-testid="mcp-custom-chip"
            onClick={() => {
              setAdding((a) => !a);
              setSelectedId(null);
              setFormErr(null);
            }}
          >
            + {t("Custom")}
          </button>
        </div>

        {selectedEntry && !adding && (
          <div className="mcp-detail-panel" data-testid="mcp-detail-panel">
            <div className="mcp-detail-head">
              <span
                className={`mcp-cat-mark${selectedEntry.monochrome ? " mcp-cat-mono" : ""}`}
                style={{
                  background: `#${selectedEntry.color.toString(16).padStart(6, "0")}`,
                }}
              />
              <div className="mcp-detail-title">
                <strong>{selectedEntry.name}</strong>
                <span className="mcp-cat-vendor">{selectedEntry.vendor}</span>
              </div>
              <div className="mcp-detail-actions">
                <button
                  type="button"
                  className="mcp-cat-doc"
                  onClick={() =>
                    tryCall("links:open-external", {
                      url: selectedEntry.docsURL,
                    })
                  }
                >
                  {t("Docs")}
                </button>
                {selectedEntry.keysURL && (
                  <button
                    type="button"
                    className="mcp-cat-doc mcp-cat-keys"
                    onClick={() =>
                      tryCall("links:open-external", {
                        url: selectedEntry.keysURL!,
                      })
                    }
                  >
                    {t("Get a key")}
                  </button>
                )}
                {selectedEntry.transport.kind === "oauth" ? (
                  <button
                    type="button"
                    className="choice mcp-cat-oauth-btn"
                    disabled
                  >
                    {t("Needs sign-in")}
                  </button>
                ) : (selectedEntry.fields ?? []).length === 0 ? (
                  <button
                    type="button"
                    className="choice active mcp-cat-save"
                    onClick={() => saveCatalog(selectedEntry)}
                  >
                    {t("Connect")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="icon-btn mcp-detail-close"
                  aria-label={t("Close")}
                  onClick={() => setSelectedId(null)}
                >
                  ×
                </button>
              </div>
            </div>

            <p className="codex-note mcp-detail-summary">
              {t(selectedEntry.summary)}
            </p>

            {selectedEntry.sampleTools.length > 0 && (
              <div className="mcp-detail-tools-wrap">
                <button
                  type="button"
                  className="mcp-tools-toggle"
                  onClick={() => setShowDetailTools((v) => !v)}
                >
                  {showDetailTools ? t("Hide tools") : t("Show tools")}
                </button>
                {showDetailTools && (
                  <div className="mcp-detail-tools">
                    {selectedEntry.sampleTools.map((tool) => (
                      <span className="mcp-tool-pill mono" key={tool}>
                        {tool}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {selectedEntry.transport.kind === "oauth" ? (
              <p className="codex-note mcp-oauth-note">
                {t(
                  "This service signs in with a browser window — not supported in this build yet.",
                )}
              </p>
            ) : (selectedEntry.fields ?? []).length > 0 ? (
              <div className="mcp-cat-form" data-testid="mcp-cat-form">
                <div className="mcp-cat-steps">
                  {selectedEntry.keysURL ? (
                    <>
                      <div className="mcp-step">
                        <span className="mcp-step-n">1</span>
                        <span>
                          {t("The page is open in your browser")}
                          {" · "}
                          <button
                            type="button"
                            className="mcp-cat-doc"
                            onClick={() =>
                              tryCall("links:open-external", {
                                url: selectedEntry.keysURL!,
                              })
                            }
                          >
                            {t("Open it again")}
                          </button>
                        </span>
                      </div>
                      <div className="mcp-step">
                        <span className="mcp-step-n">2</span>
                        <span>
                          {t(
                            "Copy the %@",
                            selectedEntry.fields?.[0]?.label
                              ? t(selectedEntry.fields[0].label)
                              : t("key"),
                          )}
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
                          {t(
                            "Enter the %@",
                            selectedEntry.fields?.[0]?.label
                              ? t(selectedEntry.fields[0].label)
                              : t("value"),
                          )}
                        </span>
                      </div>
                      <div className="mcp-step">
                        <span className="mcp-step-n">2</span>
                        <span>{t("Save")}</span>
                      </div>
                    </>
                  )}
                </div>
                {(selectedEntry.fields ?? []).map((f) => (
                  <label className="wt-field" key={f.key}>
                    <span>
                      {t(f.label)}
                      {f.isRequired === false && (
                        <em className="mcp-cat-opt">{t("optional")}</em>
                      )}
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
                          setFieldValues((v) => ({
                            ...v,
                            [f.key]: e.target.value,
                          }))
                        }
                      />
                      {f.kind === "path" && (
                        <button
                          type="button"
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
                    {f.help && <span className="mcp-cat-help">{t(f.help)}</span>}
                  </label>
                ))}
                <p className="codex-note">
                  {t(
                    "Keys are stored in plain text in the local settings file.",
                  )}
                </p>
                {formErr && <p className="mcp-err">{formErr}</p>}
                <div className="mcp-form-ops">
                  <button
                    type="button"
                    className="choice active mcp-cat-save"
                    disabled={
                      catalogNeedsInput(selectedEntry) &&
                      (selectedEntry.fields ?? []).some(
                        (f) =>
                          f.isRequired !== false &&
                          (fieldValues[f.key] ?? f.defaultValue ?? "").trim() ===
                            "",
                      )
                    }
                    onClick={() => saveCatalog(selectedEntry)}
                  >
                    {t("Save and connect")}
                  </button>
                  <button
                    type="button"
                    className="choice"
                    onClick={() => setSelectedId(null)}
                  >
                    {t("Cancel")}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {adding && (
          <div className="mcp-form" data-testid="mcp-custom-form">
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
                  type="button"
                  className={`choice${transport === "stdio" ? " active" : ""}`}
                  onClick={() => setTransport("stdio")}
                >
                  {t("Stdio command")}
                </button>
                <button
                  type="button"
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
                {t(
                  "Variables are stored in plain text in the local settings file.",
                )}
              </p>
            )}
            {formErr && <p className="mcp-err">{formErr}</p>}
            <div className="mcp-form-ops">
              <button
                type="button"
                className="choice active mcp-f-save"
                onClick={addCustom}
              >
                {t("Add server")}
              </button>
              <button
                type="button"
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
        )}
      </div>

      <p className="codex-note">
        {t(
          "Connected servers reach every provider except Antigravity when a thread starts: the CLIs at launch, the API models through Tivano itself. Antigravity's CLI only reads its own global MCP settings.",
        )}
      </p>
    </div>
  );
}
