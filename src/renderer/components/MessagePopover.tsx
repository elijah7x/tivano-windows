// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F04 / P2-51 message popover — v3.0.0 MessagePopoverMenu/messageActions:
// a right-click on a chat message opens a transient menu at the pointer.
// Every message opens with a single Copy row: "Copy" for an active
// selection, or "Copy all" copying the whole message as Markdown (code
// blocks keep their own copy button). Assistant replies also carry Add
// to reply; user prompts carry the F09 rewind rows ("Edit from here" /
// "Rewind to this turn", file changes kept).
//
// Transient like the frozen NSPopover(.transient): outside mousedown,
// Escape and scroll all close it; the rows take no focus. Action rows
// swap to their frozen confirm label ("Copied"/"Added") for a beat
// before the menu closes; the rewind row needs a second click.

import { useEffect, useRef, useState } from "react";
import { useT } from "../locale";
import { api, clientStore, tryCall } from "../client";

/** Port of v3.0.0 `MessageText.markdown`: returns the markdown source
 *  without Hydra delegation fences (which render as cards), trimmed. */
export function markdownMessageText(source: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of source.split(/\r\n|\r|\n/)) {
    const trimmed = line.trimStart();
    if (skipping) {
      if (trimmed.startsWith("```")) skipping = false;
      continue;
    }
    if (trimmed.startsWith("```")) {
      const info = trimmed.slice(3).trim().toLowerCase();
      if (info === "hydra" || info === "hydra-sent" || info === "hydra-leaving") {
        skipping = true;
        continue;
      }
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

export interface MessagePopoverState {
  /** The message snapshot frozen at menu-open time — a body update
   *  while the menu is open never replaces these values. */
  text: string;
  /** Selection text owned by this message at open time, if any —
   *  Copy takes it over the whole-message Copy all markdown fallback. */
  selection: string | null;
  role: "assistant" | "user";
  threadId: string;
  /** F09: message id + owning turn — present when the rewind rows show. */
  messageId: string;
  turnId?: string | undefined;
  /** Viewport point the menu's top-left anchors at (the pointer). */
  x: number;
  y: number;
}

export function MessagePopover(props: {
  state: MessagePopoverState;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const { state, onClose } = props;
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [confirmLabel, setConfirmLabel] = useState("");
  const closeTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);
  /** F09: how many files the rewound turns touched — fills the armed
   *  confirm label. undefined = still loading / unavailable. */
  const [previewFiles, setPreviewFiles] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (state.turnId === undefined) return;
    let live = true;
    void api()
      .invoke("threads:revert-preview", {
        threadId: state.threadId,
        turnId: state.turnId,
      })
      .then((r) => {
        if (live && r && typeof r === "object" && "files" in r)
          setPreviewFiles((r as { files: number }).files);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [state.threadId, state.turnId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".msg-menu")) onClose();
    };
    // Close on a USER scroll gesture (frozen transient). Listening to
    // `scroll` itself also catches the timeline's in-flight auto-scroll
    // from a just-sent message and would kill the menu the moment it
    // opens — wheel/touchmove only fire from real input.
    const onScroll = () => onClose();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("wheel", onScroll, true);
    document.addEventListener("touchmove", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("wheel", onScroll, true);
      document.removeEventListener("touchmove", onScroll, true);
    };
  }, [onClose]);

  /** Frozen RowAction.confirms: the row reads its confirm label for a
   *  beat, then the transient menu dismisses. */
  const act = (row: string, done: string, run: () => void) => {
    run();
    setConfirmed(row);
    setConfirmLabel(t(done));
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(onClose, 650);
  };

  const row = (
    key: string,
    icon: string,
    label: string,
    done: string,
    startsGroup: boolean,
    run: () => void,
  ) => (
    <button
      key={key}
      role="menuitem"
      className={`suggest-row msg-row${startsGroup ? " group-start" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => act(key, done, run)}
      disabled={confirmed !== null}
    >
      <span className="dl-icon" aria-hidden="true">{icon}</span>
      <span className="suggest-name">
        {confirmed === key ? confirmLabel : t(label)}
      </span>
    </button>
  );

  // Keep the menu inside the window (same honest clamp as LinkPopover).
  const x = Math.min(state.x, Math.max(8, window.innerWidth - 240));
  const y = Math.min(state.y, Math.max(8, window.innerHeight - 160));
  return (
    <div
      className="link-pop msg-menu"
      role="menu"
      aria-label={t("Message")}
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {row("copy", "📄", state.selection !== null ? "Copy" : "Copy all", "Copied", false, () => {
        void navigator.clipboard.writeText(state.selection ?? markdownMessageText(state.text));
      })}
      {state.role === "assistant" &&
        row("reply", "↩", "Add to reply", "Added", true, () => {
          clientStore.addDraftQuote(
            state.threadId,
            state.selection ?? state.text,
          );
        })}
      {state.role === "user" &&
        state.turnId !== undefined &&
        row("edit", "↺", "Edit from here", "Loaded — edit and send", true, () => {
          clientStore.beginEdit(state.threadId, state.turnId!, state.messageId, state.text);
        })}
      {state.role === "user" && state.turnId !== undefined && (
        <button
          role="menuitem"
          className="suggest-row msg-row"
          onMouseDown={(e) => e.preventDefault()}
          disabled={confirmed !== null && confirmed !== "rewind"}
          onClick={() => {
            // Two-step like the frozen confirm card: first click arms the
            // row with the files-kept wording, second click rewinds.
            if (confirmed !== "rewind") {
              setConfirmed("rewind");
              // Frozen revertPreview: the confirm says exactly what the
              // rewind touches — file count when the ledger knows it.
              setConfirmLabel(
                previewFiles !== undefined && previewFiles > 0
                  ? t("Rewind — %@ file(s) changed stay", String(previewFiles))
                  : t("Rewind — file changes stay"),
              );
              return;
            }
            tryCall("threads:revert", {
              threadId: state.threadId,
              turnId: state.turnId,
            });
            setConfirmLabel(t("Rewound"));
            window.setTimeout(onClose, 650);
          }}
        >
          <span className="dl-icon" aria-hidden="true">⤺</span>
          <span className="suggest-name">
            {confirmed === "rewind" ? confirmLabel : t("Rewind to this turn")}
          </span>
        </button>
      )}
    </div>
  );
}
