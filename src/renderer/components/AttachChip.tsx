// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05/A80 attachment chip + preview — bounded port of the frozen
// AttachmentThumbnail strip and AttachmentPreviewPanel. Image
// attachments the thread owns resolve through `attachments:read` into
// a data-URL thumbnail; tapping one opens the shared preview popover
// anchored at the pointer. Non-image attachments stay the plain file
// chip (heic/tiff land there too — Chromium cannot decode them), and a
// vanished or oversized library copy degrades to the same chip instead
// of a broken tile. The popover is transient like the frozen panel:
// Escape, an outside mousedown or a scroll gesture dismisses it.

import { useEffect, useState } from "react";
import { useT } from "../locale";
import { api } from "../client";

/** Compact byte size — the same compact readout as Composer's rows. */
function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

interface PreviewState {
  dataUrl: string;
  x: number;
  y: number;
}

export function AttachChip(props: {
  threadId: string;
  id: string;
  name: string;
  size: number;
  /** Composer variant — a removable draft chip. */
  onRemove?: () => void;
  readOnly?: boolean;
  /** Sent-message variant — the chip itself stays text-selectable while
   *  the thumbnail keeps its tap target (frozen message thumbs preview
   *  too). */
  ro?: boolean;
}): React.JSX.Element {
  const t = useT();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  useEffect(() => {
    let live = true;
    void api()
      .invoke("attachments:read", { threadId: props.threadId, id: props.id })
      .then((r) => {
        const rec = r as { kind: string; dataUrl?: string } | null;
        if (live && rec?.kind === "image" && rec.dataUrl) setDataUrl(rec.dataUrl);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [props.threadId, props.id]);

  useEffect(() => {
    if (preview === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPreview(null);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".attach-pop")) setPreview(null);
    };
    const onScroll = () => setPreview(null);
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
  }, [preview !== null]);

  const openPreview = (e: React.MouseEvent) => {
    if (dataUrl === null) return;
    setPreview((p) => (p === null ? { dataUrl, x: e.clientX, y: e.clientY } : null));
  };

  const popX = Math.min(preview?.x ?? 0, Math.max(8, window.innerWidth - 500));
  const popY = Math.min(preview?.y ?? 0, Math.max(8, window.innerHeight - 420));
  return (
    <span className={`attach-chip${props.ro ? " ro" : ""}`} title={props.name}>
      {dataUrl !== null && (
        <button
          type="button"
          className="attach-thumb-btn"
          aria-label={t("Preview attachment")}
          onClick={openPreview}
        >
          <img className="attach-thumb" src={dataUrl} alt="" />
        </button>
      )}
      <span className="attach-chip-name">
        {dataUrl === null ? "📄 " : ""}
        {props.name}
      </span>
      {props.onRemove && (
        <button
          className="attach-chip-x"
          aria-label={t("Remove attachment")}
          disabled={props.readOnly}
          onClick={props.onRemove}
        >
          ×
        </button>
      )}
      {preview !== null && (
        <div
          className="link-pop attach-pop"
          role="dialog"
          aria-label={t("Attachment preview")}
          style={{ left: popX, top: popY }}
        >
          <img className="attach-pop-img" src={preview.dataUrl} alt={props.name} />
          <div className="attach-pop-meta">
            <span className="attach-pop-name">{props.name}</span>
            <span className="attach-pop-size">{fmtSize(props.size)}</span>
          </div>
        </div>
      )}
    </span>
  );
}
