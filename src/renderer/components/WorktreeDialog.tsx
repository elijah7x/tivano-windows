// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Thread worktree dialog (F11): create an app-owned git worktree for
// this thread (`git worktree add -b <branch>` under the data root) or
// remove it. The directory is always main-chosen; the renderer only
// suggests a branch name, which git itself re-validates.

import { useState } from "react";
import type { ChatThread, WorktreeResult } from "../../shared/types";
import { callApi } from "../client";
import { useT } from "../locale";

export function WorktreeDialog(props: {
  thread: ChatThread;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { thread } = props;
  const bound = thread.worktreeDir;

  const run = (channel: "threads:create-worktree" | "threads:remove-worktree", payload: object) => {
    setBusy(true);
    setError(null);
    callApi(channel, payload)
      .then((r) => {
        const res = r as WorktreeResult;
        if (res.kind === "unavailable") setError(res.reason);
        else props.onClose();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div
      className="modal-veil"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => e.key === "Escape" && props.onClose()}
    >
      <div
        className="modal wt-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("Thread worktree")}
      >
        <h2>{t("Thread worktree")}</h2>
        {bound ? (
          <>
            <p className="ckpt-note">
              {t("This thread runs in its own worktree:")}{" "}
              <code className="ckpt-path">{bound}</code>
            </p>
            <p className="ckpt-note">
              {t(
                "Turns execute there instead of the project directory. Checkpoints are skipped while a worktree is bound.",
              )}
            </p>
          </>
        ) : (
          <>
            <p className="ckpt-note">
              {t(
                "Create a separate git worktree for this thread — turns will run there instead of the project directory.",
              )}
            </p>
            <label className="wt-field">
              <span>{t("New branch name")}</span>
              <input
                className="wt-input"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder={t("optional — defaults to wt-<thread>")}
                disabled={busy}
                spellCheck={false}
              />
            </label>
          </>
        )}
        {error && (
          <p className="ckpt-note error" role="alert">
            {t("Worktree unavailable")}: {error}
          </p>
        )}
        <div className="modal-actions">
          {bound ? (
            <button
              className="danger"
              disabled={busy}
              onClick={() => run("threads:remove-worktree", { threadId: thread.id })}
            >
              {busy ? t("Removing worktree…") : t("Remove worktree")}
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run("threads:create-worktree", {
                  threadId: thread.id,
                  ...(branch.trim() ? { branch: branch.trim() } : {}),
                })
              }
            >
              {busy ? t("Creating worktree…") : t("Create worktree")}
            </button>
          )}
          <button onClick={props.onClose}>{t("Close")}</button>
        </div>
      </div>
    </div>
  );
}
