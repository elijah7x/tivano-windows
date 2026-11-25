// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-54 Settings > Storage: overview bar + Free up regenerable files,
// quick Find a chat (5 latest / 8 search matches -> full Archived chats),
// Worktrees summary with prefill cleanup-review chat (never auto-sends),
// and Advanced diagnostics/update storage rows.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatThread, Project, Settings } from "../../shared/types";
import {
  computeStorageMetrics,
  formatStorageBytes,
  type StorageCleanResult,
  type StorageUsageReport,
  type StorageWorktreeUsage,
} from "../../shared/storage";
import { useT } from "../locale";
import { api, clientStore, tryCall } from "../client";
import { ArchiveSection } from "./ArchiveSection";

function formatShortDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export function StorageSection(props: {
  threads: ChatThread[];
  projects: Project[];
  settings: Settings;
  worktreesDir: string;
  onClose?: () => void;
  initialUsage?: StorageUsageReport | null;
  initialShowAllArchived?: boolean;
}): React.JSX.Element {
  const t = useT();
  const [usage, setUsage] = useState<StorageUsageReport | null>(
    props.initialUsage ?? null,
  );
  const [measuring, setMeasuring] = useState(props.initialUsage === undefined);
  const [cleaning, setCleaning] = useState(false);
  const [cleanErr, setCleanErr] = useState<string | null>(null);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [includeIdle, setIncludeIdle] = useState(true);
  const [includeUpdates, setIncludeUpdates] = useState(true);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [includeActive, setIncludeActive] = useState(false);

  const [showingAllArchived, setShowingAllArchived] = useState(
    props.initialShowAllArchived === true,
  );
  const [quickQuery, setQuickQuery] = useState("");
  const [armedRowId, setArmedRowId] = useState<string | null>(null);

  const [showEachWorktree, setShowEachWorktree] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [armedWtId, setArmedWtId] = useState<string | null>(null);
  const [wtBusyId, setWtBusyId] = useState<string | null>(null);
  const [wtErr, setWtErr] = useState<string | null>(null);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [armedAdv, setArmedAdv] = useState<"diagnostics" | "updates" | null>(
    null,
  );

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setMeasuring(true);
    try {
      const next = (await api().invoke(
        "storage:measure",
        {},
      )) as StorageUsageReport;
      if (mounted.current) setUsage(next);
    } catch {
      /* keep prior snapshot if measure fails */
    } finally {
      if (mounted.current) setMeasuring(false);
    }
  }, []);

  useEffect(() => {
    if (props.initialUsage !== undefined) return;
    void refresh();
  }, [props.initialUsage, props.threads.length, refresh]);

  const metrics = useMemo(
    () => (usage ? computeStorageMetrics(usage) : null),
    [usage],
  );

  const selectedCleanBytes = metrics
    ? (includeIdle ? metrics.idleBuildBytes : 0) +
      (includeUpdates ? metrics.cleanableUpdatesBytes : 0) +
      (includeDiagnostics ? metrics.cleanableDiagnosticsBytes : 0) +
      (includeActive ? metrics.activeBuildBytes : 0)
    : 0;

  const archived = useMemo(
    () =>
      props.threads
        .filter((th) => th.isArchived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [props.threads],
  );
  const projectNames = useMemo(
    () => new Map(props.projects.map((p) => [p.id, p.name])),
    [props.projects],
  );

  const trimmedQuery = quickQuery.trim().toLowerCase();
  const quickMatch = useMemo(() => {
    if (trimmedQuery === "") {
      return {
        shown: archived.slice(0, 5),
        totalCount: archived.length,
        hasQuery: false,
      };
    }
    const matches = archived.filter((th) =>
      th.title.toLowerCase().includes(trimmedQuery),
    );
    return {
      shown: matches.slice(0, 8),
      totalCount: matches.length,
      hasQuery: true,
    };
  }, [archived, trimmedQuery]);

  const confirmDelete = props.settings.confirmBeforeDeleting !== false;

  const runClean = async (opts: {
    idleWorktrees: boolean;
    activeWorktrees: boolean;
    diagnostics: boolean;
    updates: boolean;
  }) => {
    setCleaning(true);
    setCleanErr(null);
    setCleanOpen(false);
    try {
      const res = (await api().invoke(
        "storage:clean",
        opts,
      )) as StorageCleanResult;
      if (!mounted.current) return;
      setUsage(res.usage);
      if (res.error) setCleanErr(res.error);
    } catch (e) {
      if (mounted.current)
        setCleanErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setCleaning(false);
    }
  };

  const runWorktreeAction = async (
    wt: StorageWorktreeUsage,
    buildFilesOnly: boolean,
  ) => {
    setWtBusyId(wt.id);
    setWtErr(null);
    setArmedWtId(null);
    try {
      const res = (await api().invoke("storage:remove-worktree", {
        id: wt.id,
        buildFilesOnly,
      })) as StorageCleanResult;
      if (mounted.current) setUsage(res.usage);
    } catch (e) {
      if (mounted.current)
        setWtErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setWtBusyId(null);
    }
  };

  const handleCopyPrompt = async () => {
    try {
      const res = (await api().invoke("storage:review-prompt", {})) as {
        text: string;
      };
      if (res?.text) {
        await navigator.clipboard?.writeText(res.text);
        if (mounted.current) {
          setCopiedPrompt(true);
          window.setTimeout(() => {
            if (mounted.current) setCopiedPrompt(false);
          }, 1500);
        }
      }
    } catch {
      /* ignore */
    }
  };

  const handleStartReviewChat = async () => {
    try {
      const made = (await api().invoke("storage:start-worktree-review", {})) as {
        threadId: string;
        text: string;
      };
      if (made?.threadId) {
        clientStore.setDraft(made.threadId, made.text);
        await api().invoke("threads:select", { id: made.threadId });
        props.onClose?.();
      }
    } catch (e) {
      if (mounted.current)
        setWtErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (showingAllArchived) {
    return (
      <div className="storage-section" data-testid="storage-section">
        <div className="storage-back-row">
          <button
            type="button"
            className="choice storage-back-btn"
            data-testid="storage-back"
            onClick={() => setShowingAllArchived(false)}
          >
            ← {t("Storage")}
          </button>
          <span className="storage-sub-title">{t("Archived chats")}</span>
        </div>
        <ArchiveSection
          threads={props.threads}
          projects={props.projects}
          settings={props.settings}
        />
      </div>
    );
  }

  const cleanBtnLabel = cleaning
    ? t("Cleaning up…")
    : metrics && metrics.defaultCleanableBytes > 0
      ? t("Free up %@…", formatStorageBytes(metrics.defaultCleanableBytes))
      : metrics && metrics.activeBuildBytes > 0
        ? t("Free up %@…", formatStorageBytes(metrics.activeBuildBytes))
        : t("Nothing to clean up");

  const canOpenClean =
    !measuring &&
    !cleaning &&
    !!metrics &&
    metrics.defaultCleanableBytes + metrics.activeBuildBytes > 0;

  const worktrees = usage?.worktrees ?? [];
  const worktreesTotal = worktrees.reduce((s, w) => s + w.sizeBytes, 0);
  const idleCount = worktrees.filter((w) => w.isIdle).length;
  const uncommittedCount = worktrees.filter(
    (w) => (w.changedFiles ?? 0) > 0,
  ).length;

  const shownParts = (metrics?.parts ?? []).filter((p) => p.bytes > 0);
  const barSum = Math.max(
    shownParts.reduce((s, p) => s + p.bytes, 0),
    1,
  );

  return (
    <div className="storage-section" data-testid="storage-section">
      {/* ---- Overview ("On this PC") ---- */}
      <div className="storage-card" data-testid="storage-overview">
        <div className="storage-head">
          <div>
            <div className="storage-total" data-testid="storage-total">
              {metrics ? formatStorageBytes(metrics.totalBytes) : t("Measuring…")}
            </div>
            <div className="storage-subtitle">{t("Tivano data")}</div>
          </div>
          <button
            type="button"
            className="choice"
            data-testid="storage-refresh"
            disabled={measuring || cleaning}
            onClick={() => void refresh()}
          >
            {t("Refresh")}
          </button>
        </div>

        <div className="storage-bar" aria-hidden="true">
          {shownParts.map((part) => (
            <span
              key={part.id}
              className={`storage-bar-seg tone-${part.tone}`}
              style={{
                width: `${Math.max(2, (part.bytes / barSum) * 100)}%`,
              }}
            />
          ))}
        </div>

        <div className="storage-legend">
          {(metrics?.parts ?? []).map((part) => (
            <div className="storage-part" key={part.id}>
              <span className="storage-part-label">
                <span className={`storage-dot tone-${part.tone}`} />
                <span>{t(part.title)}</span>
              </span>
              <span className="storage-part-bytes mono">
                {usage ? formatStorageBytes(part.bytes) : "—"}
              </span>
            </div>
          ))}
        </div>

        <div className="storage-clean-row">
          <div className="storage-clean-text">
            <strong>{t("Clean up regenerable files")}</strong>
            <p className="codex-note">
              {t(
                "Old diagnostic reports, obsolete update files, and dependencies and build output in idle worktrees. Chats, code and uncommitted changes are never touched.",
              )}
            </p>
          </div>
          <button
            type="button"
            className={`choice storage-free-btn${canOpenClean ? " active" : ""}`}
            data-testid="storage-free-up"
            disabled={!canOpenClean}
            onClick={() => {
              setIncludeIdle(true);
              setIncludeUpdates(true);
              setIncludeDiagnostics(true);
              setIncludeActive(false);
              setCleanOpen((o) => !o);
            }}
          >
            {cleanBtnLabel}
          </button>
        </div>

        {cleanOpen && metrics && (
          <div className="storage-clean-panel" data-testid="storage-clean-popover">
            <div className="storage-clean-panel-head">
              <strong>
                {t("Free up %@", formatStorageBytes(selectedCleanBytes))}
              </strong>
              <p className="codex-note">
                {t("These files come back on their own when needed.")}
              </p>
            </div>
            {metrics.idleBuildBytes > 0 && (
              <label className="storage-opt">
                <span>
                  <strong>
                    {t("Dependencies and build output in idle worktrees")}
                  </strong>
                  <small>
                    {t(
                      "%d worktrees · node_modules, build, dist, .venv and similar. The next install or build brings them back.",
                      String(metrics.idleWorktreeCount),
                    )}
                  </small>
                </span>
                <span className="storage-opt-right">
                  <span className="mono">
                    {formatStorageBytes(metrics.idleBuildBytes)}
                  </span>
                  <input
                    type="checkbox"
                    checked={includeIdle}
                    onChange={(e) => setIncludeIdle(e.target.checked)}
                  />
                </span>
              </label>
            )}
            {metrics.cleanableUpdatesBytes > 0 && (
              <label className="storage-opt">
                <span>
                  <strong>{t("Obsolete update files")}</strong>
                  <small>
                    {t("Keeps pending installations and rollback files.")}
                  </small>
                </span>
                <span className="storage-opt-right">
                  <span className="mono">
                    {formatStorageBytes(metrics.cleanableUpdatesBytes)}
                  </span>
                  <input
                    type="checkbox"
                    checked={includeUpdates}
                    onChange={(e) => setIncludeUpdates(e.target.checked)}
                  />
                </span>
              </label>
            )}
            {metrics.cleanableDiagnosticsBytes > 0 && (
              <label className="storage-opt">
                <span>
                  <strong>{t("Old diagnostic reports")}</strong>
                  <small>
                    {t("Keeps the latest hang report and current logs.")}
                  </small>
                </span>
                <span className="storage-opt-right">
                  <span className="mono">
                    {formatStorageBytes(metrics.cleanableDiagnosticsBytes)}
                  </span>
                  <input
                    type="checkbox"
                    checked={includeDiagnostics}
                    onChange={(e) => setIncludeDiagnostics(e.target.checked)}
                  />
                </span>
              </label>
            )}
            {metrics.activeBuildBytes > 0 && (
              <label className="storage-opt">
                <span>
                  <strong>
                    {t("Build output in worktrees chats are using")}
                  </strong>
                  <small>
                    {t("Off by default: an active chat may need it soon.")}
                  </small>
                </span>
                <span className="storage-opt-right">
                  <span className="mono">
                    {formatStorageBytes(metrics.activeBuildBytes)}
                  </span>
                  <input
                    type="checkbox"
                    checked={includeActive}
                    onChange={(e) => setIncludeActive(e.target.checked)}
                  />
                </span>
              </label>
            )}
            <p className="codex-note">
              {t(
                "Never deleted: chats, attachments, code and uncommitted changes in worktrees, branches and commits, recovery patches.",
              )}
            </p>
            <div className="storage-clean-ops">
              <button
                type="button"
                className="choice"
                onClick={() => setCleanOpen(false)}
              >
                {t("Cancel")}
              </button>
              <button
                type="button"
                className="choice active"
                data-testid="storage-clean-confirm"
                disabled={selectedCleanBytes === 0}
                onClick={() =>
                  void runClean({
                    idleWorktrees: includeIdle,
                    activeWorktrees: includeActive,
                    diagnostics: includeDiagnostics,
                    updates: includeUpdates,
                  })
                }
              >
                {t("Clean up")}
              </button>
            </div>
          </div>
        )}

        {cleanErr && (
          <p className="codex-note storage-err" role="alert">
            {t(
              "Cleanup did not finish. Some files may already have been removed. %@",
              cleanErr,
            )}
          </p>
        )}
      </div>

      {/* ---- Find a chat (Quick archive search + latest 5) ---- */}
      <div className="storage-card" data-testid="storage-find-chat">
        <h4 className="sub-head">{t("Find a chat")}</h4>
        {archived.length === 0 ? (
          <p className="codex-note">
            {t(
              "Chats you archive leave the sidebar and wait here. Nothing is archived yet.",
            )}
          </p>
        ) : (
          <>
            <input
              type="search"
              className="archive-search"
              placeholder={t("Search archived chats")}
              aria-label={t("Search archived chats")}
              value={quickQuery}
              onChange={(e) => setQuickQuery(e.target.value)}
            />
            {quickMatch.shown.length === 0 ? (
              <p className="archive-empty">{t("No matching chats")}</p>
            ) : (
              <div className="storage-quick-list">
                {quickMatch.shown.map((th) => {
                  const proj =
                    (th.projectId ? projectNames.get(th.projectId) : undefined) ??
                    t("No project");
                  return (
                    <div className="archive-row" key={th.id}>
                      <span className="archive-row-title" title={th.title}>
                        {th.title}
                        <span className="storage-row-sub">
                          {" · "}
                          {proj}
                          {" · "}
                          {formatShortDate(th.updatedAt)}
                        </span>
                      </span>
                      {armedRowId === th.id ? (
                        <button
                          type="button"
                          className="icon-btn danger-arm"
                          autoFocus
                          onBlur={() => setArmedRowId(null)}
                          onClick={() => {
                            setArmedRowId(null);
                            tryCall("threads:delete", { id: th.id });
                          }}
                        >
                          {t("Delete")}?
                        </button>
                      ) : (
                        <span className="row-actions">
                          <button
                            type="button"
                            className="icon-btn"
                            title={t("Restore thread")}
                            aria-label={`${t("Restore thread")}: ${th.title}`}
                            onClick={() =>
                              tryCall("threads:unarchive", { id: th.id })
                            }
                          >
                            ↺
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            title={t("Delete thread")}
                            aria-label={`${t("Delete thread")}: ${th.title}`}
                            onClick={() =>
                              confirmDelete
                                ? setArmedRowId(th.id)
                                : tryCall("threads:delete", { id: th.id })
                            }
                          >
                            ×
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              className="choice storage-show-all-btn"
              data-testid="storage-show-all-archived"
              onClick={() => setShowingAllArchived(true)}
            >
              {quickMatch.hasQuery
                ? t("Show all %d matches", String(quickMatch.totalCount))
                : t(
                    "Show all %d archived chats",
                    String(quickMatch.totalCount),
                  )}
            </button>
          </>
        )}
      </div>

      {/* ---- Worktrees summary ---- */}
      <div className="storage-card" data-testid="storage-worktrees">
        <h4 className="sub-head">{t("Worktrees")}</h4>
        <div className="storage-wt-metrics">
          <div>
            <strong>
              {t("%d worktrees", usage ? String(worktrees.length) : "—")}
            </strong>
            <div className="codex-note mono">
              {usage ? formatStorageBytes(worktreesTotal) : "—"}
            </div>
          </div>
          <div>
            <strong>
              {t(
                "%d not used by an active chat",
                usage ? String(idleCount) : "—",
              )}
            </strong>
          </div>
          <div>
            <strong>
              {t(
                "%d with uncommitted changes",
                usage ? String(uncommittedCount) : "—",
              )}
            </strong>
          </div>
        </div>

        <div className="storage-wt-review">
          <div className="storage-wt-review-text">
            <strong>
              {t("Not sure which to delete? Let an agent review them")}
            </strong>
            <p className="codex-note">
              {t(
                "Opens a new chat with a prompt and a list of these %d worktrees already written. Read it, then send it yourself. It only inspects and deletes nothing.",
                String(worktrees.length),
              )}
            </p>
          </div>
          <div className="storage-wt-review-ops">
            <button
              type="button"
              className="choice"
              data-testid="storage-copy-review-prompt"
              disabled={worktrees.length === 0}
              onClick={() => void handleCopyPrompt()}
            >
              {copiedPrompt ? t("Copied") : t("Copy prompt")}
            </button>
            <button
              type="button"
              className="choice active"
              data-testid="storage-start-review-chat"
              disabled={worktrees.length === 0}
              onClick={() => void handleStartReviewChat()}
            >
              {t("Start review chat")}
            </button>
          </div>
        </div>

        <button
          type="button"
          className="choice storage-fold-btn"
          data-testid="storage-show-worktrees"
          aria-expanded={showEachWorktree}
          onClick={() => setShowEachWorktree((v) => !v)}
        >
          {t("Show each worktree")} {showEachWorktree ? "▾" : "▸"}
        </button>

        {showEachWorktree && (
          <div className="storage-wt-list" data-testid="storage-wt-list">
            {props.worktreesDir !== "" && (
              <div className="forge-row forge-wt" data-cli="worktrees">
                <span className="forge-name">{t("Worktrees")}</span>
                <span
                  className="forge-state forge-wt-dir"
                  title={props.worktreesDir}
                >
                  {props.worktreesDir}
                </span>
                <button
                  type="button"
                  className="choice forge-wt-reveal"
                  data-testid="storage-worktrees-reveal"
                  onClick={() => void api().invoke("worktrees:reveal", {})}
                >
                  {t("Reveal")}
                </button>
              </div>
            )}
            {worktrees.map((wt) => {
              const detailParts = [
                wt.usedByThreadTitle
                  ? wt.usedByArchived
                    ? t("Used by archived chat “%@”", wt.usedByThreadTitle)
                    : t("Used by chat “%@”", wt.usedByThreadTitle)
                  : t(
                      wt.isRegistered
                        ? "Not used by any chat"
                        : "Leftover folder, not a worktree",
                    ),
                wt.buildFilesSizeBytes > 0
                  ? t(
                      "%@ (%@ build files)",
                      formatStorageBytes(wt.sizeBytes),
                      formatStorageBytes(wt.buildFilesSizeBytes),
                    )
                  : formatStorageBytes(wt.sizeBytes),
                ...(wt.changedFiles && wt.changedFiles > 0
                  ? [t("%d uncommitted changes", String(wt.changedFiles))]
                  : []),
                ...(wt.branch ? [wt.branch] : []),
              ];
              return (
                <div className="storage-wt-row" key={wt.id} data-wt={wt.id}>
                  <div className="storage-wt-info">
                    <div className="mcp-name">{wt.name}</div>
                    <div className="codex-note">{detailParts.join(" · ")}</div>
                  </div>
                  <div className="storage-wt-ops">
                    {wt.buildFilesSizeBytes > 0 && (
                      <button
                        type="button"
                        className="choice"
                        disabled={wtBusyId === wt.id}
                        onClick={() => void runWorktreeAction(wt, true)}
                      >
                        {t("Delete build files")}
                      </button>
                    )}
                    {wt.canRemove &&
                      (armedWtId === wt.id ? (
                        <button
                          type="button"
                          className="choice danger-arm"
                          disabled={wtBusyId === wt.id}
                          onClick={() => void runWorktreeAction(wt, false)}
                        >
                          {t("Delete worktree (%@)", formatStorageBytes(wt.sizeBytes))}?
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="choice"
                          disabled={wtBusyId === wt.id}
                          onClick={() => setArmedWtId(wt.id)}
                        >
                          {t("Delete worktree")}
                        </button>
                      ))}
                  </div>
                </div>
              );
            })}
            {wtErr && (
              <p className="codex-note storage-err" role="alert">
                {wtErr}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ---- Advanced ---- */}
      <div className="storage-card" data-testid="storage-advanced">
        <button
          type="button"
          className="choice storage-fold-btn"
          data-testid="storage-advanced-toggle"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {t("Diagnostics and update files")} {showAdvanced ? "▾" : "▸"}
        </button>
        {showAdvanced && (
          <div className="storage-adv-rows">
            <div className="storage-adv-row">
              <div>
                <strong>{t("Diagnostic files")}</strong>
                <p className="codex-note">
                  {t("Keeps the latest hang report and current logs.")}{" "}
                  {usage
                    ? t(
                        "Total: %@ · Cleanable: %@",
                        formatStorageBytes(usage.diagnostics.totalBytes),
                        formatStorageBytes(usage.diagnostics.cleanableBytes),
                      )
                    : t("Measuring…")}
                </p>
              </div>
              {armedAdv === "diagnostics" ? (
                <button
                  type="button"
                  className="choice danger-arm"
                  onClick={() => {
                    setArmedAdv(null);
                    void runClean({
                      idleWorktrees: false,
                      activeWorktrees: false,
                      diagnostics: true,
                      updates: false,
                    });
                  }}
                >
                  {t("Clean up diagnostic files?")}
                </button>
              ) : (
                <button
                  type="button"
                  className="choice"
                  disabled={!usage || usage.diagnostics.cleanableBytes === 0 || cleaning}
                  onClick={() => setArmedAdv("diagnostics")}
                >
                  {t("Clean up…")}
                </button>
              )}
            </div>
            <div className="storage-adv-row">
              <div>
                <strong>{t("Update files")}</strong>
                <p className="codex-note">
                  {t("Keeps pending installations and rollback files.")}{" "}
                  {usage
                    ? t(
                        "Total: %@ · Cleanable: %@",
                        formatStorageBytes(usage.updates.totalBytes),
                        formatStorageBytes(usage.updates.cleanableBytes),
                      )
                    : t("Measuring…")}
                </p>
              </div>
              {armedAdv === "updates" ? (
                <button
                  type="button"
                  className="choice danger-arm"
                  onClick={() => {
                    setArmedAdv(null);
                    void runClean({
                      idleWorktrees: false,
                      activeWorktrees: false,
                      diagnostics: false,
                      updates: true,
                    });
                  }}
                >
                  {t("Clean up update files?")}
                </button>
              ) : (
                <button
                  type="button"
                  className="choice"
                  disabled={!usage || usage.updates.cleanableBytes === 0 || cleaning}
                  onClick={() => setArmedAdv("updates")}
                >
                  {t("Clean up…")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
