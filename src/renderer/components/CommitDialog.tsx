// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F13 commit sheet (frozen CommitSheet): shows `status --short`, edits a
// commit message, can draft one through the configured text engine, and
// commits `add -A` + `commit -F` with an optional `push -u origin HEAD`.
// Generation is an explicit IPC the engine refuses when text generation
// is off or no adapter supports it — the draft is only ever a draft.

import { useEffect, useRef, useState } from "react";
import type {
  GitCommitMessageResult,
  GitCommitResult,
  GitSnapshot,
  GitWorkingChanges,
} from "../../shared/types";
import { callApi } from "../client";
import { useT } from "../locale";

export function CommitDialog(props: {
  projectId: string;
  snap: GitSnapshot | null;
  onClose: () => void;
  /** Refresh the panel snapshot after a mutation (frozen git.refresh). */
  onCommitted: () => void;
}): React.JSX.Element {
  const t = useT();
  const [summary, setSummary] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genCapable, setGenCapable] = useState(true);
  const [pushAfter, setPushAfter] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dead = useRef(false);

  const branch =
    props.snap?.kind === "ready" && props.snap.branch && !props.snap.branch.detached
      ? (props.snap.branch.name ?? undefined)
      : undefined;

  const generate = (): void => {
    setGenerating(true);
    callApi("git:commit-message", { projectId: props.projectId })
      .then((r) => {
        if (dead.current) return;
        const res = r as GitCommitMessageResult;
        if (res.kind === "ok") setMessage(res.message);
        else if (res.reason === "no-engine" || res.reason === "text-generation-off")
          setGenCapable(false);
        else setError(res.reason);
      })
      .catch((e) => {
        if (!dead.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!dead.current) setGenerating(false);
      });
  };

  // Frozen .task: load the working changes, then auto-draft when the
  // message is still empty — the engine's own gate decides whether a
  // provider can actually be asked.
  useEffect(() => {
    dead.current = false;
    callApi("git:working-changes", { projectId: props.projectId })
      .then((r) => {
        if (dead.current) return;
        const res = r as GitWorkingChanges;
        if (res.kind === "ok") {
          setSummary(res.summary);
          generate();
        } else setLoadError(res.reason);
      })
      .catch((e) => {
        if (!dead.current) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      dead.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId]);

  const commit = (): void => {
    setCommitting(true);
    setError(null);
    callApi("git:commit", {
      projectId: props.projectId,
      message: message.trim(),
      pushAfter: pushAfter && !!branch,
    })
      .then((r) => {
        if (dead.current) return;
        const res = r as GitCommitResult;
        if (res.kind === "unavailable") {
          // Frozen stays open on failure — the error is surfaced, not hidden.
          setError(res.reason);
          return;
        }
        props.onCommitted();
        if (res.pushError) {
          // Committed but push failed — report the push part honestly and
          // keep the sheet open like the frozen AppAlert does.
          setError(`${t("Push failed")}: ${res.pushError}`);
        } else props.onClose();
      })
      .catch((e) => {
        if (!dead.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!dead.current) setCommitting(false);
      });
  };

  return (
    <div
      className="modal-veil"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => e.key === "Escape" && props.onClose()}
    >
      <div className="modal commit-dialog" role="dialog" aria-modal="true" aria-label={t("Commit changes")}>
        <h2>{t("Commit changes")}</h2>
        {summary === null && !loadError && (
          <p className="ckpt-note dots">{t("Loading")}</p>
        )}
        {loadError && (
          <p className="ckpt-note error" role="alert">
            {loadError}
          </p>
        )}
        {summary !== null && (
          <pre className="commit-summary" aria-label={t("Changes")}>
            {summary || t("No changes to commit")}
          </pre>
        )}
        <div className="commit-editor">
          <textarea
            className="wt-input commit-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={generating ? t("Writing a message…") : t("Commit message")}
            disabled={committing}
            aria-label={t("Commit message")}
            spellCheck={false}
          />
        </div>
        {error && (
          <p className="ckpt-note error" role="alert">
            {error}
          </p>
        )}
        <div className="commit-actions">
          <button
            className="commit-generate"
            disabled={generating || committing || !genCapable}
            title={
              genCapable
                ? t("Write a commit message from these changes")
                : t("Turn on text generation in Settings > Source control")
            }
            onClick={generate}
          >
            {generating ? <span className="dots" aria-hidden="true" /> : "✦ "}
            {t("Write for me")}
          </button>
          <label className="commit-push" title={t("Push after committing")}>
            <input
              type="checkbox"
              checked={pushAfter}
              disabled={!branch || committing}
              onChange={(e) => setPushAfter(e.target.checked)}
            />
            {t("Push after committing")}
          </label>
          <span className="grow" />
          <button onClick={props.onClose} disabled={committing}>
            {t("Cancel")}
          </button>
          <button
            className="primary"
            disabled={!message.trim() || committing || summary === null}
            onClick={commit}
          >
            {committing ? t("Committing") : t("Commit")}
          </button>
        </div>
      </div>
    </div>
  );
}
