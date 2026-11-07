// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F26 theme menu (frozen ThemePickerButton): the current theme's swatch
// and name in a capsule button; the popover lists Breeze and System on
// top, then every dark theme under "Dark" and every light theme under
// "Light" — the frozen ordering, with the selected item checked. Theme
// names stay in English verbatim like the frozen `localizesTitle: false`.

import { useEffect, useRef, useState } from "react";
import type { ThemeId } from "../../shared/types";
import { THEMES, themeById } from "../theme";
import { useT } from "../locale";

/** Frozen `swatch`: surface→accent gradient; follow-OS themes split half
 *  light/half dark, and Breeze carries its avocado core. */
function Swatch({ id }: { id: ThemeId }) {
  const p = themeById(id).palette;
  if (p.scheme == null) {
    return (
      <span
        className="theme-swatch"
        style={{ background: "linear-gradient(to right, #ffffff 50%, #1e1e20 50%)" }}
      >
        {id === "breeze" && (
          <span className="theme-swatch-core" style={{ background: "#7ba58f" }} />
        )}
      </span>
    );
  }
  const accent = p.accent ? `#${p.accent}` : "#0a84ff";
  return (
    <span
      className="theme-swatch"
      style={{
        background: `linear-gradient(to bottom right, #${p.surface} 0%, #${p.surface} 42%, ${accent} 100%)`,
      }}
    />
  );
}

export function ThemePicker(props: {
  value: ThemeId;
  onChange: (id: ThemeId) => void;
}): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const current = themeById(props.value);
  const dark = THEMES.filter((th) => th.palette.scheme === "dark");
  const light = THEMES.filter((th) => th.palette.scheme === "light");

  const item = (id: ThemeId) => (
    <button
      key={id}
      type="button"
      role="menuitemradio"
      aria-checked={id === props.value}
      onClick={() => {
        props.onChange(id);
        setOpen(false);
      }}
    >
      <Swatch id={id} />
      <span className="theme-name">{themeById(id).name}</span>
      {id === props.value && <span className="theme-check">✓</span>}
    </button>
  );

  return (
    <div className="openin theme-picker" ref={rootRef}>
      <button
        type="button"
        className="openin-btn theme-btn"
        aria-expanded={open}
        aria-label={t("Theme")}
        onClick={() => setOpen((o) => !o)}
      >
        <Swatch id={current.id} />
        <span className="theme-name">{current.name}</span>
        <span className="theme-chev">▾</span>
      </button>
      {open && (
        <div className="openin-menu theme-menu" role="menu" aria-label={t("Theme")}>
          {item("breeze")}
          {item("system")}
          <div className="openin-section">{t("Dark")}</div>
          {dark.map((th) => item(th.id))}
          <div className="openin-section">{t("Light")}</div>
          {light.map((th) => item(th.id))}
        </div>
      )}
    </div>
  );
}
