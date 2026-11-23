// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-45/P2-34 (frozen ThreadTimeline): Chromium strands selection pixels
// on partial redraws — the frozen fix forces a repaint when a selection
// changes inside the timeline (clearing AND starting anew both leave
// gray residue behind otherwise).

/** Whether the document selection touches `el` — a residue repaint only
 *  matters while the selection starts, moves or ends inside it. */
export function selectionIntersects(
  sel: Pick<Selection, "isCollapsed" | "anchorNode" | "focusNode"> | null,
  el: Pick<Node, "contains">,
): boolean {
  if (!sel || sel.isCollapsed) return false;
  return (
    el.contains(sel.anchorNode as Node | null) ||
    el.contains(sel.focusNode as Node | null)
  );
}

/** Force a repaint of `el` — a compositing toggle makes Chromium redraw
 *  the whole region so stranded selection pixels clear. */
function forceRepaint(el: HTMLElement): void {
  const prev = el.style.transform;
  el.style.transform = "translateZ(0)";
  void el.offsetHeight;
  el.style.transform = prev;
}

/** Watch selection changes; repaint `el` whenever the selection inside
 *  it changes state (had→cleared, moved, or a new one starts while the
 *  old highlight could linger). Returns the unlisten fn. */
export function watchSelectionResidue(el: HTMLElement): () => void {
  let inside = selectionIntersects(document.getSelection(), el);
  const onChange = () => {
    const now = selectionIntersects(document.getSelection(), el);
    // Fire on every transition touching the element — a new selection
    // clears the old one's leftover paint as much as a full clear does.
    if (now !== inside || now) forceRepaint(el);
    inside = now;
  };
  document.addEventListener("selectionchange", onChange);
  return () => document.removeEventListener("selectionchange", onChange);
}
