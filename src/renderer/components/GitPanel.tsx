// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Read-only Git panel. The renderer talks in opaque ids only: overview and
// refresh carry a project id, diffs carry snapshot + entry ids — a path,
// revision or command can never cross the bridge. Refresh is an explicit
// user action; there is no watcher and no polling. Diff text is rendered
// as escaped plain text — never through the markdown path.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatThread,
  GitDiffResult,
  GitDiffSide,
  GitSnapshot,
  GitStatusEntry,
} from "../../shared/types";
import { api } from "../client";
import { useT } from "../locale";
import { GitActionsMenu } from "./GitActionsMenu";

type TFunc = ReturnType<typeof useT>;

/** Map a machine-level reason code to a user string — implementation
 *  detail stays out of the UI; unknown codes collapse to the generic. */
export function gitUnavailableText(t: TFunc, snap: GitSnapshot | GitDiffResult | null): string {
  const reason = snap?.reason ?? "";
  if (snap && "kind" in snap && snap.kind === "not-repository") return t("Not a Git repository");
  const table: [RegExp, string][] = [
    [/^no-snapshot$/, "Press refresh to load the repository state"],
    [/^no-git$/, "Git executable not found"],
    [/^git-config-invalid$/, "The configured Git executable is invalid"],
    [/^(git-containment|executor-)/, "Git is unavailable in this environment"],
    [/^grant-path-/, "The project folder path is not supported"],
    [/^(no-grant|workspace-)/, "Project folder unavailable"],
    [/^unsafe-ownership$/, "Git refused this repository's ownership"],
    [/^bare$/, "Bare repositories are not supported"],
    [/^(split-index|sparse-index|unsupported-index)/, "This index format is not supported yet"],
    [/^(object-format|ref-storage|topology-mismatch|objects-path-colon)/, "This repository format is not supported"],
    [/^timeout$/, "Git timed out"],
    [/^changed/, "Repository changed while reading — refresh again"],
    [/^stale$/, "The repository state changed — refresh again"],
    [/^not-diffable$/, "No diff for this entry"],
    [/^filters$/, "Filtered file — comparison disabled"],
    [/^unmerged$/, "Conflicted file — diff unavailable"],
  ];
  for (const [re, key] of table) if (re.test(reason)) return t(key);
  return t("Git is unavailable");
}

const KIND_BADGE: Record<string, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  unmerged: "!",
  untracked: "?",
};

interface Selection {
  entryId: string;
  side: GitDiffSide;
}

export function GitPanel(props: { thread: ChatThread; readOnly: boolean }): React.JSX.Element {
  const t = useT();
  const projectId = props.thread.projectId ?? null;
  const [snap, setSnap] = useState<GitSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Selection | null>(null);
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const gen = useRef(0);
  const diffGen = useRef(0);
  const eventEpoch = useRef(0);
  const projectRef = useRef(projectId);
  const snapRef = useRef<GitSnapshot | null>(null);
  projectRef.current = projectId;

  const acceptSnapshot = useCallback((next: GitSnapshot): void => {
    if (snapRef.current?.snapshotId === next.snapshotId && next.snapshotId) return;
    snapRef.current = next;
    diffGen.current++;
    setSnap(next);
    setSel(null);
    setDiff(null);
    setDiffBusy(false);
  }, []);

  const unavailable = (id: string): GitSnapshot => ({
    projectId: id, snapshotId: "", capturedAt: 0,
    kind: "unavailable", entries: [], limitations: [], reason: "request-failed",
  });

  // Subscribe before hydration; a cached response cannot replace a newer event.
  useEffect(() => {
    const g = ++gen.current;
    diffGen.current++;
    snapRef.current = null;
    setSnap(null);
    setSel(null);
    setDiff(null);
    setBusy(false);
    setDiffBusy(false);
    const valid = (): boolean => gen.current === g && projectRef.current === projectId;
    const off = projectId ? api().onEvent((e) => {
      if (projectRef.current !== projectId || e.type !== "git-snapshot" || e.snapshot.projectId !== projectId) return;
      eventEpoch.current++;
      acceptSnapshot(e.snapshot);
    }) : () => {};
    if (projectId) {
      const epoch = eventEpoch.current;
      void api().invoke("git:overview", { projectId })
        .then((s) => {
          if (valid() && eventEpoch.current === epoch) acceptSnapshot(s as GitSnapshot);
        })
        .catch(() => {
          if (valid() && eventEpoch.current === epoch) acceptSnapshot(unavailable(projectId));
        });
    }
    return () => {
      off();
      gen.current++;
      diffGen.current++;
    };
  }, [projectId, acceptSnapshot]);

  const refresh = (): void => {
    if (!projectId || busy || props.readOnly) return;
    const g = ++gen.current;
    const epoch = eventEpoch.current;
    setBusy(true);
    void api().invoke("git:refresh", { projectId })
      .then((s) => {
        if (gen.current !== g || projectRef.current !== projectId) return;
        const next = s as GitSnapshot;
        if (eventEpoch.current === epoch || snapRef.current?.snapshotId === next.snapshotId) acceptSnapshot(next);
      })
      .catch(() => {
        if (gen.current === g && projectRef.current === projectId && eventEpoch.current === epoch) acceptSnapshot(unavailable(projectId));
      })
      .finally(() => {
        if (gen.current === g && projectRef.current === projectId) setBusy(false);
      });
  };

  const loadDiff = (entry: GitStatusEntry, side: GitDiffSide): void => {
    const current = snapRef.current;
    if (!current || current.projectId !== projectId) return;
    const request = ++diffGen.current;
    const selection: Selection = { entryId: entry.id, side };
    const failure = (reason: string): GitDiffResult => ({
      snapshotId: current.snapshotId, entryId: entry.id, side, kind: "unavailable", reason,
    });
    setSel(selection);
    setDiff(null);
    if (props.readOnly) {
      setDiff(failure("read-only"));
      setDiffBusy(false);
      return;
    }
    setDiffBusy(true);
    const valid = (): boolean => diffGen.current === request && projectRef.current === current.projectId && snapRef.current?.snapshotId === current.snapshotId;
    void api().invoke("git:diff", {
      projectId: current.projectId, snapshotId: current.snapshotId, entryId: entry.id, side,
    }).then((d) => {
      if (!valid()) return;
      const result = d as GitDiffResult;
      if (result.snapshotId !== current.snapshotId || result.entryId !== entry.id || result.side !== side) {
        setDiff(failure("stale"));
      } else if (result.kind === "text" && (result.patch!.length > 2 * 1024 * 1024 || result.patch!.split("\n", 10001).length > 10000)) {
        setDiff({ snapshotId: current.snapshotId, entryId: entry.id, side, kind: "oversized" });
      } else {
        setDiff(result);
      }
    }).catch(() => {
      if (valid()) setDiff(failure("request-failed"));
    }).finally(() => {
      if (valid()) setDiffBusy(false);
    });
  };

  const pickEntry = (entry: GitStatusEntry, hint: GitDiffSide): void => {
    const can = (s: GitDiffSide): boolean =>
      s === "staged" ? entry.canDiffStaged : entry.canDiffWorktree;
    const side: GitDiffSide = can(hint)
      ? hint
      : entry.canDiffStaged
        ? "staged"
        : "worktree";
    if (sel?.entryId === entry.id && sel.side === side) {
      loadDiff(entry, side);
      return;
    }
    if (!entry.canDiffStaged && !entry.canDiffWorktree) {
      diffGen.current++;
      setDiffBusy(false);
      setSel({ entryId: entry.id, side: "staged" });
      setDiff({
        snapshotId: snap?.snapshotId ?? "",
        entryId: entry.id,
        side: "staged",
        kind: "unavailable",
        reason: entry.untracked ? "not-diffable" : "unmerged",
      });
      return;
    }
    loadDiff(entry, side);
  };

  const groups: {
    key: string;
    label: string;
    hint: GitDiffSide;
    rows: GitStatusEntry[];
  }[] = [];
  if (snap?.kind === "ready") {
    const by = (f: (e: GitStatusEntry) => boolean): GitStatusEntry[] =>
      snap.entries.filter(f);
    for (const [key, label, hint, f] of [
      ["conflicts", t("Conflicts"), "staged" as GitDiffSide, (e: GitStatusEntry) => e.unmerged],
      ["staged", t("Staged"), "staged" as GitDiffSide, (e: GitStatusEntry) => !e.unmerged && !e.untracked && e.staged !== "."],
      [
        "unstaged",
        t("Unstaged"),
        "worktree" as GitDiffSide,
        (e: GitStatusEntry) => !e.unmerged && !e.untracked && e.unstaged !== ".",
      ],
      ["untracked", t("Untracked"), "worktree" as GitDiffSide, (e: GitStatusEntry) => e.untracked],
    ] as const) {
      const rows = by(f);
      if (rows.length) groups.push({ key, label, hint, rows });
    }
  }

  const branchText = (() => {
    const b = snap?.branch;
    if (!b) return null;
    if (b.detached) return `${t("detached")} ${b.oid?.slice(0, 8) ?? ""}`.trim();
    if (b.unborn) return `${b.name ?? "HEAD"} ${t("(unborn)")}`;
    return b.name ?? "HEAD";
  })();

  const selectedEntry = sel ? snap?.entries.find((e) => e.id === sel.entryId) : undefined;

  return (
    <section className="git-panel" aria-label={t("Git")}>
      <header className="git-head">
        <strong>{t("Git")}</strong>
        {branchText && (
          <span
            className="badge git-branch"
            title={snap?.branch?.upstream ? snap.branch.upstream : undefined}
          >
            {branchText}
            {snap?.branch?.ahead ? ` ↑${snap.branch.ahead}` : ""}
            {snap?.branch?.behind ? ` ↓${snap.branch.behind}` : ""}
          </span>
        )}
        {snap?.limitations.includes("filters") && (
          <span className="badge" title={t("Content filters are disabled; affected working-tree comparisons may be unavailable")}>
            {t("filters")}
          </span>
        )}
        {snap?.limitations.includes("entries-truncated") && (
          <span className="badge" title={t("Entry list truncated at the display limit")}>
            {t("truncated")}
          </span>
        )}
        <span className="grow" />
        {snap?.capturedAt ? (
          <span className="git-captured">{new Date(snap.capturedAt).toLocaleTimeString()}</span>
        ) : null}
        <button
          className="git-refresh"
          onClick={refresh}
          disabled={!projectId || busy || props.readOnly}
          title={t("Refresh Git status")}
        >
          {busy ? <span className="dots" aria-hidden="true" /> : "⟳"} {t("Refresh")}
        </button>
        {projectId && (
          <GitActionsMenu
            projectId={projectId}
            snap={snap}
            readOnly={props.readOnly}
            onChanged={refresh}
          />
        )}
      </header>

      {!projectId && (
        <div className="center-state">
          <p>{t("This thread isn't bound to a project — bind one to see Git status")}</p>
        </div>
      )}
      {projectId && !snap && (
        <div className="center-state" role="status"><p className="dots">{t("Loading")}</p></div>
      )}
      {projectId && snap && snap.kind !== "ready" && (
        <div className="center-state">
          <p>{gitUnavailableText(t, snap)}</p>
        </div>
      )}
      {projectId && snap?.kind === "ready" && (
        <div className="git-body">
          <div className="git-list" role="list">
            {groups.length === 0 && (
              <div className="center-state">
                <p>{t("No changes")}</p>
              </div>
            )}
            {groups.map((g) => (
              <div key={g.key} className="git-group">
                <div className="git-group-label">{g.label}</div>
                {g.rows.map((e) => (
                  <button
                    key={`${g.key}:${e.id}`}
                    role="listitem"
                    className={`git-row ${sel?.entryId === e.id && sel?.side === g.hint ? "on" : ""}`}
                    onClick={() => pickEntry(e, g.hint)}
                    title={e.origPath ? `${e.origPath} → ${e.path}` : e.path}
                  >
                    <span className={`git-badge k-${e.kind}`}>
                      {KIND_BADGE[e.kind] ?? "?"}
                    </span>
                    <span className="git-path">
                      {e.origPath ? `${e.origPath} → ${e.path}` : e.path}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="git-diff">
            {selectedEntry && (
              <div className="git-diff-head">
                <span className="git-path" title={selectedEntry.path}>
                  {selectedEntry.path}
                </span>
                <span className="grow" />
                <div className="git-sides" role="tablist">
                  {(["staged", "worktree"] as const).map((side) => {
                    const ok =
                      side === "staged"
                        ? selectedEntry.canDiffStaged
                        : selectedEntry.canDiffWorktree;
                    return (
                      <button
                        key={side}
                        role="tab"
                        aria-selected={sel?.side === side}
                        className={sel?.side === side ? "on" : ""}
                        disabled={!ok || props.readOnly}
                        onClick={() => loadDiff(selectedEntry, side)}
                      >
                        {side === "staged" ? t("Staged") : t("Worktree")}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {!selectedEntry && groups.length > 0 && (
              <div className="center-state">
                <p>{t("Select a file to see its diff")}</p>
              </div>
            )}
            {selectedEntry && diffBusy && (
              <div className="center-state" role="status">
                <p className="dots">{t("Loading")}</p>
              </div>
            )}
            {selectedEntry && !diffBusy && diff && (
              <>
                {diff.kind === "text" && (
                  <pre className="git-patch">
                    {diff.patch!.split("\n").map((line, i) => (
                      <div
                        key={i}
                        className={
                          line.startsWith("+") && !line.startsWith("+++")
                            ? "pl"
                            : line.startsWith("-") && !line.startsWith("---")
                              ? "mi"
                              : line.startsWith("@@")
                                ? "hn"
                                : "ctx"
                        }
                      >
                        {line || " "}
                      </div>
                    ))}
                  </pre>
                )}
                {diff.kind === "binary" && (
                  <div className="center-state">
                    <p>{t("Binary file — no text diff")}</p>
                  </div>
                )}
                {diff.kind === "oversized" && (
                  <div className="center-state">
                    <p>{t("Diff is too large to display")}</p>
                  </div>
                )}
                {diff.kind === "empty" && (
                  <div className="center-state">
                    <p>{t("No diff — content unchanged")}</p>
                  </div>
                )}
                {diff.kind === "unavailable" && (
                  <div className="center-state">
                    <p>{gitUnavailableText(t, diff)}</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
