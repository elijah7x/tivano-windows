// Tivano Windows - derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P1-41 Toolbox (v3.0.26 UtilityChestPanel Outputs tab): a top-bar button
// opening a fixed-size floating panel over the chat — it never resizes the
// timeline — that lists the documents, webpages, images and videos this
// chat produced. Rows open in the default app, reveal in the system file
// manager, or reference the file in the composer with @. Main resolves every
// row id; the renderer never names a path to open.

import { useEffect, useRef, useState } from "react";
import { ARTIFACT_KINDS, type ArtifactKind, type ThreadArtifactItem } from "../../shared/threadArtifacts";
import { api, callApi, clientStore } from "../client";
import { useT } from "../locale";
import { translateError } from "../i18n";

type T = (k: string, ...vars: string[]) => string;

export type ToolboxState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: ThreadArtifactItem[] };

const KIND_LABEL: Record<ArtifactKind, string> = {
  document: "Documents",
  webpage: "Webpages",
  image: "Images",
  video: "Videos",
};
const KIND_GLYPH: Record<ArtifactKind, string> = {
  document: "📄",
  webpage: "🌐",
  image: "🖼",
  video: "🎞",
};

/** Append `@path ` to a draft, separated from existing text by one space. */
export function appendMention(draft: string, mentionPath: string): string {
  const sep = draft === "" || /\s$/.test(draft) ? "" : " ";
  return `${draft}${sep}@${mentionPath} `;
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function artifactSubtitle(t: T, item: ThreadArtifactItem): string {
  const parts = [item.displayPath];
  if (item.turnIndex !== undefined) parts.push(t("Turn %d", String(item.turnIndex + 1)));
  if (item.size !== undefined) parts.push(fmtSize(item.size));
  return parts.join(" · ");
}

export function ToolboxOutputs(props: {
  t: T;
  state: ToolboxState;
  filter: ArtifactKind | null;
  revealLabel: string;
  actionError?: string | undefined;
  onFilter(kind: ArtifactKind | null): void;
  onOpen(item: ThreadArtifactItem): void;
  onReveal(item: ThreadArtifactItem): void;
  onReference(item: ThreadArtifactItem): void;
}): React.JSX.Element {
  const { t, state, filter } = props;
  const items = state.kind === "ready" ? state.items : [];
  const shown = filter === null ? items : items.filter((i) => i.kind === filter);
  const count = (k: ArtifactKind | null) => (k === null ? items.length : items.filter((i) => i.kind === k).length);
  const pill = (k: ArtifactKind | null) => (
    <button
      key={k ?? "all"}
      type="button"
      className={`toolbox-filter${filter === k ? " on" : ""}`}
      aria-pressed={filter === k}
      onClick={() => props.onFilter(k)}
    >
      {t(k === null ? "All" : KIND_LABEL[k])} <span className="toolbox-count">{count(k)}</span>
    </button>
  );
  return (
    <div className="toolbox-outputs">
      <div className="toolbox-filters" role="toolbar">
        {pill(null)}
        {ARTIFACT_KINDS.map(pill)}
      </div>
      {props.actionError && (
        <div className="toolbox-error" role="alert">
          {props.actionError}
        </div>
      )}
      {state.kind === "loading" && <div className="toolbox-empty">{t("Loading")}</div>}
      {state.kind === "error" && (
        <div className="toolbox-empty" role="alert">
          <strong>{t("Couldn't load outputs")}</strong>
          <span>{state.message}</span>
        </div>
      )}
      {state.kind === "ready" && shown.length === 0 && (
        <div className="toolbox-empty">
          <strong>{t("No outputs yet")}</strong>
          <span>{t("Documents, webpages, images and videos created in this chat appear here.")}</span>
        </div>
      )}
      {shown.length > 0 && (
        <ul className="toolbox-list">
          {shown.map((item) => (
            <li key={item.id} className="toolbox-row" data-kind={item.kind}>
              <button type="button" className="toolbox-open" title={item.displayPath} onClick={() => props.onOpen(item)}>
                <span className="toolbox-glyph" aria-hidden="true">
                  {KIND_GLYPH[item.kind]}
                </span>
                <span className="toolbox-text">
                  <span className="toolbox-name">{item.name}</span>
                  <span className="toolbox-sub">{artifactSubtitle(t, item)}</span>
                </span>
              </button>
              {item.mentionPath !== undefined && (
                <button
                  type="button"
                  className="head-action toolbox-action"
                  title={t("Reference in chat")}
                  aria-label={t("Reference in chat")}
                  onClick={() => props.onReference(item)}
                >
                  @
                </button>
              )}
              <button
                type="button"
                className="head-action toolbox-action"
                title={props.revealLabel}
                aria-label={props.revealLabel}
                onClick={() => props.onReveal(item)}
              >
                ↗
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ToolboxPanel(props: {
  threadId: string;
  /** Changes whenever the timeline grows or a turn settles. */
  refreshKey: string;
  readOnly?: boolean;
}): React.JSX.Element {
  const t = useT();
  const { threadId } = props;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ToolboxState>({ kind: "loading" });
  const [filter, setFilter] = useState<ArtifactKind | null>(null);
  const [actionError, setActionError] = useState<string | undefined>();
  const rootRef = useRef<HTMLDivElement>(null);
  const gen = useRef(0);

  useEffect(() => {
    setOpen(false);
    setFilter(null);
    setState({ kind: "loading" });
  }, [threadId]);

  useEffect(() => {
    if (!open) return;
    const load = () => {
      const g = ++gen.current;
      callApi("artifacts:list", { threadId })
        .then((r) => {
          if (g === gen.current) setState({ kind: "ready", items: r as ThreadArtifactItem[] });
        })
        .catch((e: unknown) => {
          if (g === gen.current)
            setState({ kind: "error", message: translateError(t, e instanceof Error ? e.message : String(e)) });
        });
    };
    load();
    return api().onEvent((e) => {
      if (e.type === "checkpoints-changed" && e.threadId === threadId) load();
    });
  }, [open, threadId, props.refreshKey, t]);

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

  const act = (channel: "artifacts:open" | "artifacts:reveal", item: ThreadArtifactItem) => {
    setActionError(undefined);
    callApi(channel, { threadId, id: item.id }).catch((e: unknown) =>
      setActionError(translateError(t, e instanceof Error ? e.message : String(e))),
    );
  };
  const revealLabel = api().platform === "win32" ? t("Reveal in File Explorer") : t("Reveal in Finder");

  return (
    <div className="toolbox" ref={rootRef}>
      <button
        type="button"
        className={`head-action toolbox-btn${open ? " active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("Toolbox")}
        title={t("Toolbox")}
        disabled={props.readOnly === true}
        onClick={() => {
          setActionError(undefined);
          setOpen((o) => !o);
        }}
      >
        ▦
      </button>
      {open && (
        <div className="toolbox-pop" role="dialog" aria-label={t("Toolbox")}>
          <div className="toolbox-head">
            <span className="toolbox-tab">{t("Outputs")}</span>
            <button
              type="button"
              className="head-action"
              title={t("Close toolbox")}
              aria-label={t("Close toolbox")}
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          <ToolboxOutputs
            t={t}
            state={state}
            filter={filter}
            revealLabel={revealLabel}
            actionError={actionError}
            onFilter={setFilter}
            onOpen={(item) => act("artifacts:open", item)}
            onReveal={(item) => act("artifacts:reveal", item)}
            onReference={(item) => {
              if (item.mentionPath === undefined) return;
              clientStore.setDraft(threadId, appendMention(clientStore.draft(threadId), item.mentionPath));
            }}
          />
        </div>
      )}
    </div>
  );
}
