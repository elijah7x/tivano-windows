// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-34 selection residue: half-point line spacing leaves bottom selection
// pixels stranded when a selection clears — frozen LinkParagraphView marks
// the whole text view needsDisplay on had→cleared (and on resign) so no thin
// line stays under the first selected line. Chromium repaints only the old
// selection rects, which land on fractional line boxes; when a selection
// that touched this element ends, force one full repaint instead.

/** Forces one real repaint of `el`: promoting the element to its own
 *  composited layer for exactly one painted frame repaints its full
 *  box on both the promote and the demote, unlike a same-task
 *  write→reflow→reset which Blink collapses to none→none with no
 *  PrePaint/Paint/Raster at all. */
export function repaintNextFrame(el: HTMLElement): void {
  el.style.transform = "translateZ(0)";
  el.ownerDocument.defaultView?.requestAnimationFrame(() => {
    el.style.transform = "";
  });
}

/** Returns cleanup. `document` is the element's ownerDocument so the
 *  listener survives no embedding changes and is removable. */
export function watchSelectionResidue(el: HTMLElement): () => void {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  let hadInside = false;
  const onChange = (): void => {
    const sel = doc.getSelection();
    const inside =
      !!sel &&
      !sel.isCollapsed &&
      (el.contains(sel.anchorNode) || el.contains(sel.focusNode));
    if (hadInside && !inside) repaintNextFrame(el);
    hadInside = inside;
  };
  // Frozen resignFirstResponder: the window losing focus drops the
  // selection's painted state without a selectionchange — repaint too.
  const onBlur = (): void => {
    if (hadInside) repaintNextFrame(el);
    hadInside = false;
  };
  doc.addEventListener("selectionchange", onChange);
  win?.addEventListener("blur", onBlur);
  return () => {
    doc.removeEventListener("selectionchange", onChange);
    win?.removeEventListener("blur", onBlur);
  };
}

/** Whether an uncollapsed document selection touches `el`. */
export function selectionIntersects(
  sel: { isCollapsed: boolean; anchorNode: Node | null; focusNode: Node | null } | null,
  el: { contains: (n: Node | null) => boolean },
): boolean {
  return (
    !!sel &&
    !sel.isCollapsed &&
    (el.contains(sel.anchorNode) || el.contains(sel.focusNode))
  );
}
