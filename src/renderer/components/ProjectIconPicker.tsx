// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F01: the frozen ProjectIconPicker, emoji half only — categorized emoji,
// the same search, and a Folder tile that clears back to the default
// mark. The picker's second half, SF Symbols, is an Apple-proprietary
// mark set that cannot render on Windows; it is absent here rather than
// faked with lookalikes.

import { useEffect, useRef, useState } from "react";
import { matchingEmojiGroups } from "../../shared/projectIcons";
import { useT } from "../locale";

export function ProjectIconPicker(props: {
  /** Current mark — emoji string, or undefined for the folder mark. */
  icon: string | undefined;
  /** Popover anchor: the icon button's viewport rect. */
  anchor: { x: number; y: number };
  /** Emoji pick sends the mark; the Folder tile sends null to clear. */
  onPick: (icon: string | null) => void;
  onClose: () => void;
}): React.JSX.Element {
  const t = useT();
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  // Transient like every other popover: Escape, outside mousedown, scroll
  // or resize close it without committing anything.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node))
        props.onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", props.onClose, true);
    window.addEventListener("resize", props.onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", props.onClose, true);
      window.removeEventListener("resize", props.onClose);
    };
  }, [props]);

  const groups = matchingEmojiGroups(query);
  const PANEL_W = 296;
  const x = Math.max(8, Math.min(props.anchor.x, window.innerWidth - PANEL_W - 8));

  return (
    <div
      ref={panelRef}
      className="icon-pop"
      style={{ left: x, top: props.anchor.y + 6, width: PANEL_W }}
      role="dialog"
      aria-label={t("Project icon")}
    >
      <div className="icon-pop-title">{t("Project icon")}</div>
      <input
        className="icon-pop-search"
        type="text"
        autoFocus
        value={query}
        placeholder={t("Try cat, 猫, or folder")}
        aria-label={t("Project icon")}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="icon-pop-scroll">
        <div className="icon-pop-group">
          <button
            className={`icon-tile folder${props.icon === undefined ? " picked" : ""}`}
            title={t("Folder")}
            aria-label={t("Folder")}
            onClick={() => props.onPick(null)}
          >
            <span className="icon-tile-mark">📁</span>
            <span className="icon-tile-name">{t("Folder")}</span>
          </button>
        </div>
        {groups.map((group) => (
          <div className="icon-pop-group" key={group.id}>
            <div className="icon-pop-heading">{t(group.title)}</div>
            <div className="icon-pop-grid">
              {group.entries.map((entry) => (
                <button
                  key={entry.emoji}
                  className={`icon-tile${props.icon === entry.emoji ? " picked" : ""}`}
                  title={entry.keywords.split(",")[0]?.trim() ?? entry.emoji}
                  aria-label={`${t("Project icon")}: ${entry.emoji}`}
                  onClick={() => props.onPick(entry.emoji)}
                >
                  <span className="icon-tile-mark">{entry.emoji}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <div className="icon-pop-empty">
            <div>{t("No matching icons")}</div>
            <div className="icon-pop-empty-sub">
              {t("Try another keyword or clear the search.")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
