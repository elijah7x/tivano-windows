// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Checkpoint preview dialog: a non-mutating analysis of what a turn's
// checkpoint pair WOULD restore, plus a per-path read-only diff of the
// turn's recorded base→end bytes. In-place restore itself is disabled
// service-side (A17 security) — nothing here can write the worktree.

import { useEffect, useRef, useState } from "react";
import type { CheckpointDiffView, CheckpointPreviewView } from "../../shared/types";
import { callApi } from "../client";
import { useT } from "../locale";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: CheckpointPreviewView };

type DiffState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: CheckpointDiffView };

export function CheckpointPreviewDialog(props: {
  threadId: string;
  turnId: string;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  // A late response must never overwrite a different selection: the
  // generation is captured at open and checked before landing.
  const gen = useRef(0);
  const { threadId, turnId } = props;

  useEffect(() => {
    const g = ++gen.current;
    setState({ kind: "loading" });
    setDiffs({});
    callApi("checkpoints:preview", { threadId, turnId })
      .then((r) => {
        if (g !== gen.current) return;
        setState({ kind: "ready", view: r as CheckpointPreviewView });
      })
      .catch((e) => {
        if (g !== gen.current) return;
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
  }, [threadId, turnId]);

  const toggleDiff = (path: string): void => {
    if (diffs[path]) {
      setDiffs((d) => {
        const n = { ...d };
        delete n[path];
        return n;
      });
      return;
    }
    const g = gen.current;
    setDiffs((d) => ({ ...d, [path]: { kind: "loading" } }));
    callApi("checkpoints:diff", { threadId, turnId, path })
      .then((r) => {
        if (g !== gen.current) return;
        setDiffs((d) => ({ ...d, [path]: { kind: "ready", view: r as CheckpointDiffView } }));
      })
      .catch((e) => {
        if (g !== gen.current) return;
        setDiffs((d) => ({
          ...d,
          [path]: { kind: "error", message: e instanceof Error ? e.message : String(e) },
        }));
      });
  };

  const actionLabel = (a: string): string =>
    a === "restore"
      ? t("Would restore")
      : a === "remove"
        ? t("Would delete")
        : a === "noop"
          ? t("No change needed")
          : t("Kept unchanged");

  const diffBody = (d: DiffState): React.JSX.Element => {
    if (d.kind === "loading") return <p className="ckpt-note">{t("Loading diff…")}</p>;
    if (d.kind === "error")
      return (
        <p className="ckpt-note error" role="alert">
          {t("Diff unavailable")}: {d.message}
        </p>
      );
    const v = d.view;
    if (v.kind === "unavailable")
      return (
        <p className="ckpt-note" role="status">
          {t("Diff unavailable")}: {v.reason}
        </p>
      );
    if (v.kind === "empty")
      return <p className="ckpt-note">{t("No recorded change for this file.")}</p>;
    if (v.kind === "binary")
      return <p className="ckpt-note">{t("Binary file — no text diff")}</p>;
    if (v.kind === "oversized")
      return <p className="ckpt-note">{t("Diff is too large to display")}</p>;
    if (v.kind !== "text") return <></>;
    return (
      <div role="region" aria-label={t("Turn diff")}>
        <pre className="git-patch ckpt-diff">
          {v.patch.split("\n").map((line, i) => (
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
      </div>
    );
  };

  // In-place restore is disabled service-side (A17 security): no
  // apply action is offered — the preview is read-only by design.
  const restorable =
    state.kind === "ready" && state.view.kind === "ready"
      ? state.view.entries.filter((e) => e.action === "restore" || e.action === "remove")
      : [];

  return (
    <div
      className="modal-veil"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
      onKeyDown={(e) => e.key === "Escape" && props.onClose()}
    >
      <div
        className="modal ckpt-preview"
        role="dialog"
        aria-modal="true"
        aria-label={t("Checkpoint preview")}
      >
        <h2>{t("Checkpoint preview")}</h2>
        <div className="banner" role="status">
          {t("NO FILES HAVE BEEN CHANGED")} —{" "}
          {t(
            "this preview only proposes what restoring this turn's checkpoint would do; in-place restore is temporarily unavailable and nothing can be written here.",
          )}
        </div>

        {state.kind === "loading" && <p className="ckpt-note">{t("Loading preview…")}</p>}
        {state.kind === "error" && (
          <p className="ckpt-note error" role="alert">
            {t("Preview unavailable")}: {state.message}
          </p>
        )}
        {state.kind === "ready" && state.view.kind === "unavailable" && (
          <p className="ckpt-note" role="status">
            {t("Preview unavailable")}: {state.view.reason ?? t("unknown")}
          </p>
        )}
        {state.kind === "ready" && state.view.kind === "ready" && (
          <>
            {state.view.entries.length === 0 ? (
              <p className="ckpt-note">{t("No attributed file changes for this turn.")}</p>
            ) : (
              <ul className="ckpt-entries">
                {state.view.entries.map((e) => (
                  <li key={e.path} className={`ckpt-entry a-${e.action}`}>
                    <span className="ckpt-action">{actionLabel(e.action)}</span>
                    <code className="ckpt-path">{e.path}</code>
                    {e.reason && <span className="ckpt-reason">{e.reason}</span>}
                    <button
                      className="ckpt-diff-btn"
                      onClick={() => toggleDiff(e.path)}
                      aria-expanded={!!diffs[e.path]}
                    >
                      {diffs[e.path] ? t("Hide diff") : t("View diff")}
                    </button>
                    {diffs[e.path] && (
                      <div className="ckpt-diff-wrap">{diffBody(diffs[e.path]!)}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {state.view.limitations.length > 0 && (
              <p className="ckpt-note">
                {t("Limitations")}: {state.view.limitations.join(", ")}
              </p>
            )}
          </>
        )}

        <div className="modal-actions">
          {state.kind === "ready" && state.view.kind === "ready" && restorable.length > 0 && (
            <span className="ckpt-restore-off" role="note">
              {t("In-place restore is temporarily unavailable")}
            </span>
          )}
          <button onClick={props.onClose}>{t("Close")}</button>
        </div>
      </div>
    </div>
  );
}
