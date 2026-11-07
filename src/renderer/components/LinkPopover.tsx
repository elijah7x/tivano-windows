// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F04 link popover — frozen LinkPopover: a right-click on a chat link
// opens a transient menu under the link's own bounds with the two
// universal rows, Open Link and Copy Link.
// F25: a link that parses as a merge/pull request (frozen
// MergeRequestLink) earns the frozen top row "Merge !n/#n" — it hands
// the brief to the enclosing chat's helper (threads:spawn-helper).
//
// Transient like the frozen NSPopover(.transient): outside mousedown,
// Escape and scroll all close it; the rows take no focus.

import { useEffect } from "react";
import { useT } from "../locale";
import { tryCall } from "../client";
import { parseMergeRequestLink } from "../../shared/mergeRequestLink";

export interface LinkPopoverState {
  href: string;
  /** Viewport point the popover's top-left anchors at (link bounds). */
  x: number;
  y: number;
  /** F25: the chat whose timeline the link sits in — the helper's
   *  parent (frozen MergeRequestTarget.chatID). */
  chatId?: string | undefined;
}

export function LinkPopover(props: {
  state: LinkPopoverState;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const { state, onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".link-pop")) onClose();
    };
    // Close on a USER scroll gesture (frozen transient) — `scroll`
    // itself also catches the timeline's in-flight auto-scroll and
    // would kill a menu opened right after sending; wheel/touchmove
    // only fire from real input.
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

  // Keep the menu inside the window (frozen relies on NSPopover's own
  // edge flipping — a plain clamp is the honest equivalent here).
  const x = Math.min(state.x, Math.max(8, window.innerWidth - 200));
  const y = Math.min(state.y, Math.max(8, window.innerHeight - 96));
  // Frozen: a merge/PR link earns the "Merge {label}" row at the top —
  // only when a chat owns the link (a chat timeline always does).
  const merge =
    state.chatId !== undefined ? parseMergeRequestLink(state.href) : undefined;
  return (
    <div
      className="link-pop"
      role="menu"
      aria-label={t("Link")}
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {merge && state.chatId && (
        <>
          <button
            role="menuitem"
            className="suggest-row"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onClose();
              tryCall("threads:spawn-helper", {
                parentId: state.chatId!,
                title: merge.title,
                prompt: merge.prompt,
              });
            }}
          >
            <span className="dl-icon" aria-hidden="true">⎇</span>
            <span className="suggest-name">{merge.title}</span>
          </button>
          <div className="link-pop-sep" role="separator" />
        </>
      )}
      <button
        role="menuitem"
        className="suggest-row"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          onClose();
          tryCall("links:open-external", { url: state.href });
        }}
      >
        <span className="dl-icon" aria-hidden="true">🌐</span>
        <span className="suggest-name">{t("Open Link")}</span>
      </button>
      <button
        role="menuitem"
        className="suggest-row"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          onClose();
          void navigator.clipboard.writeText(state.href);
        }}
      >
        <span className="dl-icon" aria-hidden="true">🔗</span>
        <span className="suggest-name">{t("Copy Link")}</span>
      </button>
    </div>
  );
}
