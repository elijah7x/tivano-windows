// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F11 BranchMenu (frozen ChatView.BranchMenu): the button wears the
// current branch (or "Detached"); the popover lists up to 25 local
// branches for switching, then New branch…, and — for worktree-bound
// threads only — Rename branch…. Naming is inline (Electron has no
// window.prompt/alert); a pushed branch's rename asks first, matching
// the frozen confirm. All ops run in main against the thread's resolved
// execution directory — the renderer never names a path.

import { useEffect, useRef, useState } from "react";
import type { BranchListResult, BranchOpResult, GitBranchRow } from "../../shared/types";
import { callApi } from "../client";
import { useT } from "../locale";

type Naming = "none" | "create" | "rename";

/** Frozen rejection messages, keyed by the service's reason codes. */
function rejectionText(t: (k: string) => string, reason: string): string {
  switch (reason) {
    case "branch-name-too-long":
      return t("Branch names can be up to %lld characters.").replace("%lld", "60");
    case "branch-name-chars":
      return t("Branch names can use letters, numbers and - _ . / only.");
    case "branch-name-invalid":
      return t("That is not a valid branch name.");
    case "branch-name-exists":
      return t("A branch with that name already exists.");
    case "branch-name-op-in-progress":
      return t("Finish or abort the merge, rebase or cherry-pick in progress, then rename the branch.");
    default:
      return reason;
  }
}

export function BranchMenu(props: {
  threadId: string;
  /** worktree-bound thread → the frozen Rename row appears. */
  worktree: boolean;
  /** A live turn freezes switch/create (frozen `!runtime.isRunning`). */
  running: boolean;
  readOnly?: boolean;
}): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<GitBranchRow[]>([]);
  const [detached, setDetached] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [naming, setNaming] = useState<Naming>("none");
  const [nameText, setNameText] = useState("");
  const [pushed, setPushed] = useState<{ name: string; upstream: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  // Branch rows are fetched on mount (the button wears the current name)
  // and again on each open — like the frozen live git refresh.
  const refresh = (): void => {
    callApi("git:branches", { threadId: props.threadId })
      .then((r) => {
        const res = r as BranchListResult;
        if (res.kind === "ready") {
          setRows(res.branches);
          setDetached(res.detached);
        } else {
          setRows([]);
          setDetached(true);
        }
        setLoaded(true);
      })
      .catch(() => {
        setRows([]);
        setDetached(true);
        setLoaded(true);
      });
  };
  useEffect(refresh, [props.threadId]);
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const current = rows.find((b) => b.isCurrent)?.name;
  const label = detached ? t("Detached") : (current ?? "…");

  const fail = (title: string, res: BranchOpResult): void => {
    if (res.kind === "rejected") {
      // Frozen: an empty/unchanged name closes quietly, no alert.
      setNote(res.reason === "" ? null : rejectionText(t, res.reason));
    } else if (res.kind === "unavailable") {
      setNote(`${title}: ${res.reason}`);
    }
  };

  const doSwitch = (name: string): void => {
    setNote(null);
    callApi("git:switch-branch", { threadId: props.threadId, name })
      .then((r) => {
        const res = r as BranchOpResult;
        if (res.kind === "ok") {
          setOpen(false);
          refresh();
        } else fail(t("Could not switch branch"), res);
      })
      .catch((e) => setNote(`${t("Could not switch branch")}: ${e instanceof Error ? e.message : e}`));
  };

  const doCreate = (): void => {
    setNote(null);
    callApi("git:create-branch", { threadId: props.threadId, name: nameText })
      .then((r) => {
        const res = r as BranchOpResult;
        if (res.kind === "ok") {
          setOpen(false);
          setNaming("none");
          refresh();
        } else fail(t("Could not create branch"), res);
      })
      .catch((e) => setNote(`${t("Could not create branch")}: ${e instanceof Error ? e.message : e}`));
  };

  const doRename = (confirmedPushed: boolean, name: string): void => {
    setNote(null);
    callApi("git:rename-branch", { threadId: props.threadId, name, confirmedPushed })
      .then((r) => {
        const res = r as BranchOpResult;
        if (res.kind === "ok") {
          setOpen(false);
          setNaming("none");
          setPushed(null);
          refresh();
        } else if (res.kind === "pushed") {
          setPushed({ name: res.name, upstream: res.upstream });
        } else fail(t("Could not rename branch"), res);
      })
      .catch((e) => setNote(`${t("Could not rename branch")}: ${e instanceof Error ? e.message : e}`));
  };

  return (
    <div className="openin branch-menu" ref={rootRef}>
      <button
        className="openin-btn branch-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("Branch")}
        aria-label={t("Branch")}
        disabled={props.readOnly === true}
        onClick={() => {
          setNote(null);
          setNaming("none");
          setPushed(null);
          setOpen((o) => !o);
        }}
      >
        ⎇ {label} ▾
      </button>
      {open && (
        <div className="openin-menu" role="menu" aria-label={t("Branch")}>
          <div className="openin-section">{t("Switch branch")}</div>
          {!loaded && (
            <button type="button" role="menuitem" disabled>
              …
            </button>
          )}
          {rows.slice(0, 25).map((b) => (
            <button
              key={b.name}
              type="button"
              role="menuitem"
              className="branch-row"
              disabled={b.isCurrent || props.running}
              onClick={() => doSwitch(b.name)}
            >
              <span className="branch-check">{b.isCurrent ? "✓" : ""}</span>
              <span className="branch-name">{b.name}</span>
            </button>
          ))}
          <div className="openin-divider" aria-hidden="true" />
          {naming === "none" && pushed === null && (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={props.running}
                onClick={() => {
                  setNameText("");
                  setNaming("create");
                }}
              >
                {t("New branch…")}
              </button>
              {props.worktree && current !== undefined && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setNameText(current);
                    setNaming("rename");
                  }}
                >
                  {t("Rename branch…")}
                </button>
              )}
            </>
          )}
          {naming !== "none" && pushed === null && (
            <div className="branch-naming">
              <div className="openin-section">
                {naming === "create" ? t("New branch") : t("Rename branch")}
              </div>
              <input
                className="branch-input"
                type="text"
                autoFocus
                value={nameText}
                placeholder={t("Branch name")}
                aria-label={t("Branch name")}
                onChange={(e) => setNameText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") naming === "create" ? doCreate() : doRename(false, nameText);
                }}
              />
              <div className="branch-naming-actions">
                <button
                  type="button"
                  role="menuitem"
                  className="primary"
                  onClick={() => (naming === "create" ? doCreate() : doRename(false, nameText))}
                >
                  {naming === "create" ? t("Create") : t("Rename")}
                </button>
                <button type="button" role="menuitem" onClick={() => setNaming("none")}>
                  {t("Cancel")}
                </button>
              </div>
            </div>
          )}
          {pushed !== null && (
            <div className="branch-naming">
              <div className="openin-section">{t("Rename a pushed branch?")}</div>
              <div className="branch-pushed-detail">
                {t(
                  "This branch is pushed as %@. Only the local name changes: the remote branch and any pull request keep the old name, and pushing may need its upstream set again.",
                ).replace("%@", pushed.upstream)}
              </div>
              <div className="branch-naming-actions">
                <button
                  type="button"
                  role="menuitem"
                  className="primary"
                  onClick={() => doRename(true, pushed.name)}
                >
                  {t("Rename")}
                </button>
                <button type="button" role="menuitem" onClick={() => setPushed(null)}>
                  {t("Cancel")}
                </button>
              </div>
            </div>
          )}
          {note && <div className="openin-note" role="alert">{note}</div>}
        </div>
      )}
    </div>
  );
}
