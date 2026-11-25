// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-51 accent picker & appearance split circle (AppearanceSettingsPage.swift):
// 12 named accent colors in AppTheme.allCases order with localized names
// (System Accent, Avocado, Matcha Green, ... Honey Yellow) and a plain
// accent circle swatch with a hairline rim, paired with the split-circle
// Match System / Light / Dark toggle.

import { useEffect, useRef, useState } from "react";
import type { AppearanceMode, ThemeId } from "../../shared/types";
import {
  THEMES,
  appearanceModeTitle,
  nextAppearanceMode,
  resolveTheme,
  themeById,
} from "../theme";
import { useT } from "../locale";

/** v3.0.0 `swatch`: plain circle filled with the dynamic accent (or
 *  system blue for System Accent), with a hairline rim. */
function Swatch({
  id,
  appearanceMode,
  osDark,
}: {
  id: ThemeId;
  appearanceMode: AppearanceMode;
  osDark: boolean;
}) {
  const resolved = resolveTheme(id, osDark, appearanceMode);
  return (
    <span
      className="theme-swatch"
      style={{ background: resolved.accent }}
    />
  );
}

/** v3.0.0 `AppearanceSplitCircleButton`: cycles Match System -> Light -> Dark. */
export function AppearanceSplitCircleButton(props: {
  mode: AppearanceMode;
  onChange: (mode: AppearanceMode) => void;
}): React.JSX.Element {
  const t = useT();
  const title = t(appearanceModeTitle(props.mode));
  const left = props.mode === "dark" ? "#1E1E20" : "#FFFFFF";
  const right = props.mode === "light" ? "#FFFFFF" : "#1E1E20";
  return (
    <button
      type="button"
      className="openin-btn appearance-btn"
      title={title}
      aria-label={title}
      data-appearance-mode={props.mode}
      onClick={() => props.onChange(nextAppearanceMode(props.mode))}
    >
      <span
        className="appearance-circle"
        style={{ background: `linear-gradient(to right, ${left} 50%, ${right} 50%)` }}
      />
    </button>
  );
}

export function ThemePicker(props: {
  value: ThemeId;
  appearanceMode?: AppearanceMode;
  osDark?: boolean;
  onChange: (id: ThemeId) => void;
}): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = props.appearanceMode ?? "system";
  const osDark = props.osDark ?? false;

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
      <Swatch id={id} appearanceMode={mode} osDark={osDark} />
      <span className="theme-name">{t(themeById(id).name)}</span>
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
        <Swatch id={current.id} appearanceMode={mode} osDark={osDark} />
        <span className="theme-name">{t(current.name)}</span>
        <span className="theme-chev">▾</span>
      </button>
      {open && (
        <div className="openin-menu theme-menu" role="menu" aria-label={t("Theme")}>
          {THEMES.map((th) => item(th.id))}
        </div>
      )}
    </div>
  );
}
