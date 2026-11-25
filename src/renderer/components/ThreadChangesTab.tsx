// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Whole-thread changes capsule & popover (frozen ThreadChangesCapsule +
// DiffInspector): sits in the lean top bar as +/− numbers and opens the
// changes panel right below them on click or Cmd/Ctrl+D, instead of over
// the composer.

import { useEffect, useRef, useState } from "react";
import type { CheckpointDiffView } from "../../shared/types";
import { api, callApi } from "../client";
import { useT } from "../locale";

type Summary = {
  files: {
    path: string;
    additions: number;
    deletions: number;
    binary: boolean;
    reason?: string;
  }[];
  additions: number;
  deletions: number;
};

type DiffState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: CheckpointDiffView };

export function ThreadChangesTab(props: {
  threadId: string;
  toggleSeq?: number | undefined;
}): React.JSX.Element | null {
  const t = useT();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [open, setOpen] = useState(false);
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const gen = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const lastToggleSeq = useRef(props.toggleSeq ?? 0);
  const { threadId } = props;

  useEffect(() => {
    setSummary(null);
    setOpen(false);
    setDiffs({});
    const g = ++gen.current;
    const refetch = () => {
      const mine = g;
      callApi("checkpoints:changes", { threadId })
        .then((r) => {
          if (mine === gen.current) setSummary((r as Summary | null) ?? null);
        })
        .catch(() => {});
    };
    refetch();
    return api().onEvent((e) => {
      if (e.type === "checkpoints-changed" && e.threadId === threadId) refetch();
    });
  }, [threadId]);

  useEffect(() => {
    const seq = props.toggleSeq ?? 0;
    if (seq !== lastToggleSeq.current) {
      lastToggleSeq.current = seq;
      setOpen((o) => !o);
    }
  }, [props.toggleSeq]);

  // Outside-click and Escape close the popover, same as the other chat popovers.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasFiles = !!summary && summary.files.length > 0;
  if (!hasFiles && !open) return null;

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
    callApi("checkpoints:changes-diff", { threadId, path })
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
    );
  };

  const fileCountLabel = summary
    ? summary.files.length === 1
      ? t("1 file")
      : t("%@ files", String(summary.files.length))
    : null;
  const buttonAria = summary
    ? summary.files.length === 1
      ? t(
          "1 file changed, %@ lines added, %@ lines removed",
          String(summary.additions),
          String(summary.deletions),
        )
      : t(
          "%@ files changed, %@ lines added, %@ lines removed",
          String(summary.files.length),
          String(summary.additions),
          String(summary.deletions),
        )
    : t("Show this thread's changes");

  return (
    <div className="thread-changes in-topbar" ref={rootRef}>
      {hasFiles && summary && (
        <button
          type="button"
          className={`thread-changes-tab${open ? " active" : ""}`}
          aria-expanded={open}
          aria-label={buttonAria}
          title={t("Show this thread's changes")}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="tc-add">+{summary.additions}</span>
          <span className="tc-del">−{summary.deletions}</span>
        </button>
      )}
      {open && (
        <div
          className="thread-changes-pop"
          data-anchor="topbar"
          role="dialog"
          aria-label={t("Thread changes")}
        >
          <div className="tc-pop-head">
            <span className="tc-pop-title">{t("Changes in this thread")}</span>
            {hasFiles && summary && (
              <span className="tc-pop-meta">
                <span className="tc-count">{fileCountLabel}</span>
                <span className="tc-add">+{summary.additions}</span>
                <span className="tc-del">−{summary.deletions}</span>
              </span>
            )}
            <button
              type="button"
              className="icon-btn tc-pop-close"
              aria-label={t("Hide changes")}
              title={t("Hide changes")}
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          {!hasFiles || !summary ? (
            <div className="tc-empty">
              <div className="tc-empty-title">{t("No changes yet")}</div>
              <div className="tc-empty-detail">
                {t("Files the agent changes appear here after each turn.")}
              </div>
            </div>
          ) : (
            <ul className="tc-files">
              {summary.files.map((f) => (
                <li key={f.path} className="tc-file">
                  <button
                    type="button"
                    className="tc-file-row"
                    aria-expanded={!!diffs[f.path]}
                    onClick={() => toggleDiff(f.path)}
                  >
                    <code className="ckpt-path">{f.path}</code>
                    {f.reason ? (
                      <span className="tc-bin">
                        {t("diff n/a")}: {f.reason}
                      </span>
                    ) : f.binary ? (
                      <span className="tc-bin">{t("binary")}</span>
                    ) : (
                      <>
                        <span className="tc-add">+{f.additions}</span>
                        <span className="tc-del">−{f.deletions}</span>
                      </>
                    )}
                  </button>
                  {diffs[f.path] && <div className="ckpt-diff-wrap">{diffBody(diffs[f.path]!)}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
