// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-78 (frozen RemoveProjectPopover / SidebarView.projectDeletePopover):
// opens adjacent to the selected sidebar project row on its trailing edge,
// clamped inside the viewport with keyboard and screen-reader focus preserved.

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  anchorPopover,
  sameAnchorRect,
  type AnchorRect,
  type PopoverSize,
  type ViewportBounds,
} from "../../shared/popoverAnchor";
import { useT } from "../locale";

const DEFAULT_POPOVER_SIZE: PopoverSize = { width: 280, height: 184 };
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;

function readViewport(): ViewportBounds {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

export interface RemoveProjectPopoverProps {
  projectId: string;
  projectName: string;
  threadCount: number;
  anchor: AnchorRect;
  getAnchorRect?: (() => { anchor: AnchorRect; visible: boolean } | null) | undefined;
  scrollContainer?: HTMLElement | null | undefined;
  getTriggerEl?: (() => HTMLElement | null) | undefined;
  readOnly?: boolean | undefined;
  onRemove: () => void;
  onCancel: (restoreFocus: boolean) => void;
}

export function RemoveProjectPopover(
  props: RemoveProjectPopoverProps,
): React.JSX.Element {
  const t = useT();
  const titleId = useId();
  const descId = useId();
  const popRef = useRef<HTMLDivElement>(null);
  const removeBtnRef = useRef<HTMLButtonElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const [liveAnchor, setLiveAnchor] = useState<AnchorRect>(props.anchor);
  const [measuredSize, setMeasuredSize] = useState<PopoverSize | null>(null);
  const [viewport, setViewport] = useState<ViewportBounds>(readViewport);

  // Sync incoming anchor whenever target project or external layout changes.
  useEffect(() => {
    setLiveAnchor(props.anchor);
  }, [props.projectId, props.anchor]);

  // Measure actual rendered popover size for exact viewport edge clamping
  // (e.g. multi-line localized descriptions near the bottom edge) and watch
  // for runtime font-size / language / layout changes while open.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      setMeasuredSize((prev) =>
        prev &&
        Math.abs(prev.width - r.width) < 0.5 &&
        Math.abs(prev.height - r.height) < 0.5
          ? prev
          : { width: r.width, height: r.height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.projectId, props.threadCount, liveAnchor, viewport]);

  // Move keyboard focus into the confirmation dialog (defaulting to Cancel
  // so accidental Enter/Space cannot immediately delete a project).
  useEffect(() => {
    cancelBtnRef.current?.focus();
  }, [props.projectId]);

  // Reposition along with sidebar scroll and window resize; close cleanly
  // if the anchored project row scrolls completely out of the list viewport.
  useEffect(() => {
    const sync = (): void => {
      const vp = readViewport();
      setViewport((prev) =>
        prev.width === vp.width && prev.height === vp.height ? prev : vp,
      );
      const next = props.getAnchorRect?.();
      if (next === undefined) return;
      if (!next || !next.visible) {
        props.onCancel(false);
        return;
      }
      setLiveAnchor((prev) => (sameAnchorRect(prev, next.anchor) ? prev : next.anchor));
    };
    const scroller = props.scrollContainer;
    scroller?.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    return () => {
      scroller?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [props.scrollContainer, props.getAnchorRect, props.onCancel]);

  // Transient dismissal + keyboard focus containment.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popRef.current?.contains(target)) return;
      if (props.getTriggerEl?.()?.contains(target)) return;
      props.onCancel(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        props.onCancel(true);
        return;
      }
      if (e.key === "Tab" && popRef.current) {
        const focusable = [removeBtnRef.current, cancelBtnRef.current].filter(
          (b): b is HTMLButtonElement => !!b && !b.disabled,
        );
        if (focusable.length === 0) return;
        const active = document.activeElement;
        const idx = focusable.indexOf(active as HTMLButtonElement);
        e.preventDefault();
        if (focusable.length === 1) {
          focusable[0]!.focus();
          return;
        }
        const nextIdx = e.shiftKey
          ? (idx <= 0 ? focusable.length - 1 : idx - 1)
          : (idx === -1 || idx >= focusable.length - 1 ? 0 : idx + 1);
        focusable[nextIdx]!.focus();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [props.getTriggerEl, props.onCancel]);

  const pos = anchorPopover({
    anchor: liveAnchor,
    popover: measuredSize ?? DEFAULT_POPOVER_SIZE,
    viewport,
    preferredSide: "trailing",
    gap: ANCHOR_GAP,
    margin: VIEWPORT_MARGIN,
  });

  const note = t(
    "This permanently deletes %lld chats, including linked sub-agents and helpers in other projects. Project source files will not be deleted.",
  ).replace("%lld", String(props.threadCount));

  return (
    <div
      ref={popRef}
      id="project-delete-popover"
      className="proj-delete-pop"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-project-id={props.projectId}
      data-project-name={props.projectName}
      data-side={pos.side}
      style={{
        left: pos.left,
        top: pos.top,
        maxWidth: pos.maxWidth,
        maxHeight: pos.maxHeight,
      }}
    >
      <div id={titleId} className="proj-delete-title">
        {t("Remove this project?")}
      </div>
      <div id={descId} className="proj-delete-note">
        {note}
      </div>
      <div className="proj-delete-sep" role="separator" />
      <button
        ref={removeBtnRef}
        type="button"
        className="proj-delete-btn danger"
        disabled={props.readOnly === true}
        onClick={props.onRemove}
      >
        {t("Remove project")}
      </button>
      <button
        ref={cancelBtnRef}
        type="button"
        className="proj-delete-btn"
        onClick={() => props.onCancel(true)}
      >
        {t("Cancel")}
      </button>
    </div>
  );
}
