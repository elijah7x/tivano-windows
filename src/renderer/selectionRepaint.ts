// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-34 selection residue: half-point line spacing leaves bottom selection
// pixels stranded when a selection clears — frozen LinkParagraphView marks
// the whole text view needsDisplay on had→cleared (and on resign) so no thin
// line stays under the first selected line. Chromium repaints only the old
// selection rects, which land on fractional line boxes; when a selection
// that touched this element ends, force one full repaint instead.

/** Returns cleanup. `document` is the element's ownerDocument so the
 *  listener survives no embedding changes and is removable. */
export function watchSelectionResidue(el: HTMLElement): () => void {
  const doc = el.ownerDocument;
  let hadInside = false;
  const onChange = (): void => {
    const sel = doc.getSelection();
    const inside =
      !!sel &&
      !sel.isCollapsed &&
      (el.contains(sel.anchorNode) || el.contains(sel.focusNode));
    if (hadInside && !inside) {
      // Write + forced reflow + reset in one task: a synchronous style
      // invalidation over the whole element so the cleared selection's
      // rects repaint rather than stranding fractional-line pixels (the
      // Chromium-side equivalent of the frozen needsDisplay).
      el.style.transform = "translateZ(0)";
      void el.offsetHeight;
      el.style.transform = "";
    }
    hadInside = inside;
  };
  doc.addEventListener("selectionchange", onChange);
  return () => doc.removeEventListener("selectionchange", onChange);
}
