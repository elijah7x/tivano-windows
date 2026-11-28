// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Shared React hook for stable button-anchored popovers. Captures the initial
// anchor and layout pass before paint and repositions only for real anchor
// movement, viewport resize, or size/constraint changes >= 0.5px.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import {
  anchorPopover,
  rectToAnchor,
  samePopoverPosition,
  stepAnchoredPopover,
  type AnchorRect,
  type AnchoredPopoverPosition,
  type PopoverAlign,
  type PopoverSide,
  type PopoverSize,
  type StablePopoverState,
  type ViewportBounds,
} from "../shared/popoverAnchor";

export function readViewportBounds(): ViewportBounds {
  if (
    typeof window === "undefined" ||
    typeof window.innerWidth !== "number" ||
    typeof window.innerHeight !== "number" ||
    !Number.isFinite(window.innerWidth) ||
    !Number.isFinite(window.innerHeight) ||
    window.innerWidth <= 0 ||
    window.innerHeight <= 0
  ) {
    return { width: 1280, height: 800 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

export function anchoredPopoverStyle(
  pos: AnchoredPopoverPosition | null,
  extra?: React.CSSProperties,
): React.CSSProperties | undefined {
  if (!pos) return extra;
  return {
    ...extra,
    position: "fixed",
    left: pos.left,
    top: pos.top,
    right: "auto",
    bottom: "auto",
    maxWidth: pos.maxWidth,
    maxHeight: pos.maxHeight,
    transform: "none",
  };
}

export interface UseAnchoredPopoverOptions {
  open: boolean;
  /** Distinct target identity (e.g. threadId or trigger source). Changing this
   *  resets the captured anchor state for a fresh layout pass. */
  targetKey?: string | number | null | undefined;
  /** Initial anchor rect captured synchronously on open, or pointer point. */
  initialAnchor?: AnchorRect | null | undefined;
  /** Optional trigger element ref; used to read live bounds when getAnchorRect is omitted. */
  anchorRef?: React.RefObject<HTMLElement | null> | undefined;
  /** Live anchor reader. Returning null signals the anchor disappeared. */
  getAnchorRect?: (() => AnchorRect | null) | undefined;
  /** Estimated size for the pre-measurement fallback pass. */
  estimatedSize: PopoverSize;
  preferredSide: PopoverSide;
  align?: PopoverAlign | undefined;
  constrainSideHeight?: boolean | undefined;
  gap?: number | undefined;
  margin?: number | undefined;
  /** Scroll container whose scroll can move the anchor element. */
  scrollContainer?: HTMLElement | null | undefined;
  /** Called if getAnchorRect returns null while open. */
  onAnchorLost?: (() => void) | undefined;
  /** Content/layout token (e.g. expanded state, row count) that re-checks
   *  measured size synchronously in useLayoutEffect. */
  layoutKey?: unknown;
}

export function useAnchoredPopover<T extends HTMLElement = HTMLDivElement>(
  options: UseAnchoredPopoverOptions,
): {
  popRef: React.RefObject<T | null>;
  position: AnchoredPopoverPosition | null;
  syncPosition: () => void;
} {
  const popRef = useRef<T | null>(null);
  const stableRef = useRef<StablePopoverState | null>(null);
  const targetKeyRef = useRef<string | number | null | undefined>(undefined);
  const optsRef = useRef(options);
  optsRef.current = options;

  const [pos, setPos] = useState<AnchoredPopoverPosition | null>(null);

  if (!options.open) {
    if (stableRef.current !== null) stableRef.current = null;
    if (targetKeyRef.current !== undefined) targetKeyRef.current = undefined;
  } else if (options.targetKey !== targetKeyRef.current) {
    stableRef.current = null;
    targetKeyRef.current = options.targetKey;
  }

  const syncPosition = useCallback((): void => {
    const cur = optsRef.current;
    if (!cur.open) return;
    const el = popRef.current;
    if (!el) return;
    const liveAnchor = cur.getAnchorRect?.();
    if (liveAnchor === null) {
      cur.onAnchorLost?.();
      return;
    }
    let anchor = liveAnchor;
    if (anchor === undefined && cur.anchorRef?.current) {
      const triggerEl = cur.anchorRef.current;
      if (triggerEl.isConnected) {
        const tr = triggerEl.getBoundingClientRect();
        if (tr.width > 0 && tr.height > 0) anchor = rectToAnchor(tr);
      }
    }
    anchor = anchor ?? cur.initialAnchor ?? undefined;
    if (!anchor) return;
    const rect = el.getBoundingClientRect();
    const popoverSize: PopoverSize =
      rect.width > 0 && rect.height > 0
        ? { width: rect.width, height: rect.height }
        : cur.estimatedSize;
    const nextState = stepAnchoredPopover(stableRef.current, {
      anchor,
      popover: popoverSize,
      viewport: readViewportBounds(),
      preferredSide: cur.preferredSide,
      align: cur.align,
      constrainSideHeight: cur.constrainSideHeight,
      gap: cur.gap,
      margin: cur.margin,
    });
    if (nextState === stableRef.current) return;
    stableRef.current = nextState;
    setPos((prev) =>
      prev && samePopoverPosition(prev, nextState.position) ? prev : nextState.position,
    );
  }, []);

  useLayoutEffect(() => {
    if (!options.open) {
      stableRef.current = null;
      setPos((prev) => (prev === null ? prev : null));
      return;
    }
    syncPosition();
  }, [options.open, options.targetKey, options.layoutKey, options.initialAnchor, syncPosition]);

  useEffect(() => {
    if (!options.open) return;
    let alive = true;
    const onSync = (): void => {
      if (alive) syncPosition();
    };

    const el = popRef.current;
    const observer =
      el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(onSync) : null;
    if (el && observer) observer.observe(el);

    window.addEventListener("resize", onSync);
    const scroller = options.scrollContainer;
    scroller?.addEventListener("scroll", onSync, { passive: true });

    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(onSync);
    }

    return () => {
      alive = false;
      observer?.disconnect();
      window.removeEventListener("resize", onSync);
      scroller?.removeEventListener("scroll", onSync);
    };
  }, [options.open, options.scrollContainer, syncPosition]);

  const activePos =
    !options.open
      ? null
      : pos ??
        (options.initialAnchor
          ? anchorPopover({
              anchor: options.initialAnchor,
              popover: options.estimatedSize,
              viewport: readViewportBounds(),
              preferredSide: options.preferredSide,
              align: options.align,
              constrainSideHeight: options.constrainSideHeight,
              gap: options.gap,
              margin: options.margin,
            })
          : null);

  return { popRef, position: activePos, syncPosition };
}
