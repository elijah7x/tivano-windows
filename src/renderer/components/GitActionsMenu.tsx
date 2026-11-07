// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F13 git actions menu (frozen GitActionsMenu): Commit… / Push / Create
// pull request / Open repository, gated on the LIVE snapshot — never on
// assumptions. Pull requests are honestly unavailable in this build.

import { useEffect, useRef, useState } from "react";
import type { GitPushResult, GitSnapshot } from "../../shared/types";
import { callApi } from "../client";
import { useT } from "../locale";
import { CommitDialog } from "./CommitDialog";

export function GitActionsMenu(props: {
  projectId: string;
  snap: GitSnapshot | null;
  readOnly?: boolean;
  /** Refresh the panel snapshot after a mutation (frozen git.refresh). */
  onChanged: () => void;
}): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Outside click / Escape dismiss the menu — same convention as dialogs.
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

  const ready = props.snap?.kind === "ready";
  const changed = ready ? (props.snap?.entries.length ?? 0) : 0;
  const branch =
    ready && props.snap?.branch && !props.snap.branch.detached
      ? (props.snap.branch.name ?? undefined)
      : undefined;
  // Frozen `Open repository` only appears when remoteURL parses as a URL —
  // the external-open channel only accepts http(s), so ssh-style remotes
  // hide the item the same way frozen hides unparseable ones.
  const remoteUrl = ready ? props.snap?.remoteUrl : undefined;
  const remoteHttp = remoteUrl && /^https?:\/\//i.test(remoteUrl) ? remoteUrl : null;

  const push = (): void => {
    setBusy(true);
    setNote(null);
    callApi("git:push", { projectId: props.projectId })
      .then((r) => {
        const res = r as GitPushResult;
        if (res.kind === "pushed") {
          setNote({ kind: "ok", text: t("Pushed") });
          props.onChanged();
        } else setNote({ kind: "err", text: `${t("Push failed")}: ${res.reason}` });
      })
      .catch((e) =>
        setNote({
          kind: "err",
          text: `${t("Push failed")}: ${e instanceof Error ? e.message : String(e)}`,
        }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="git-actions" ref={rootRef}>
      <button
        className="git-menu-btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          changed === 0
            ? t("Commit, push and open pull requests")
            : t("%d changed files", String(changed))
        }
        disabled={props.readOnly === true || !ready}
        onClick={() => {
          setNote(null);
          setOpen((o) => !o);
        }}
      >
        ⎇ ▾
      </button>
      {open && (
        <div className="git-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={changed === 0}
            onClick={() => {
              setOpen(false);
              setSheet(true);
            }}
          >
            {t("Commit…")}
          </button>
          <button type="button" role="menuitem" disabled={!branch || busy} onClick={push}>
            {busy ? `${t("Pushing")}…` : t("Push")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled
            title={t("Pull requests are not available in this build")}
          >
            {t("Create pull request")}
          </button>
          {remoteHttp && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void callApi("links:open-external", { url: remoteHttp }).catch(() => {});
              }}
            >
              {t("Open repository")}
            </button>
          )}
          {note && (
            <p className={`git-menu-note ${note.kind}`} role={note.kind === "err" ? "alert" : "status"}>
              {note.text}
            </p>
          )}
        </div>
      )}
      {sheet && (
        <CommitDialog
          projectId={props.projectId}
          snap={props.snap}
          onClose={() => setSheet(false)}
          onCommitted={props.onChanged}
        />
      )}
    </div>
  );
}
