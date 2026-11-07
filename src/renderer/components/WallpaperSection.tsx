// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F26 bounded slice: frozen WallpaperCard + the Transparency row. The
// frozen build paints the picture at backdropOpacity behind glass on a
// transparent window; this Electron window is opaque, so the slider
// honestly controls how strongly the picture shows through the app's
// own surfaces — never the desktop behind the window. Softness maps to
// a CSS blur radius like the frozen decode blur.

import { useEffect, useState } from "react";
import { api, tryCall } from "../client";
import { useT } from "../locale";
import type { Settings } from "../../shared/types";
import {
  DEFAULT_BACKDROP_OPACITY,
  wallpaperBlurPx,
} from "../../shared/wallpaper";

type InstallStatus =
  | { status: "installed"; file: string }
  | { status: "cancelled" }
  | { status: "notImage" }
  | { status: "tooLarge" }
  | { status: "error"; reason: string };

export function WallpaperSection(props: { settings: Settings }) {
  const t = useT();
  const { settings } = props;
  const wp = settings.wallpaper;
  const [preview, setPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const opacity = settings.backdropOpacity ?? DEFAULT_BACKDROP_OPACITY;

  // Preview bytes come over `wallpaper:data` — the renderer never sees
  // a filesystem path, only a library basename it already knows.
  useEffect(() => {
    let live = true;
    if (!wp) {
      setPreview(null);
      return;
    }
    void api()
      .invoke("wallpaper:data", { file: wp.file })
      .then((r) => {
        if (live)
          setPreview((r as { dataUrl: string } | null)?.dataUrl ?? null);
      })
      .catch(() => live && setPreview(null));
    return () => {
      live = false;
    };
  }, [wp?.file]);

  const report = (r: InstallStatus) => {
    if (r.status === "notImage") setStatus(t("That file isn't a supported image."));
    else if (r.status === "tooLarge") setStatus(t("That image is too large (25 MB max)."));
    else if (r.status === "error") setStatus(t("Could not use that picture."));
    else setStatus(null);
  };

  const perf = settings.performanceMode === true;

  return (
    <>
      <h3>{t("Wallpaper")}</h3>
      <div className="wp-card">
        <div
          className={`wp-preview${preview ? "" : " empty"}`}
          style={
            preview
              ? {
                  backgroundImage: `url(${preview})`,
                  opacity,
                  filter: `blur(${wallpaperBlurPx(wp?.softness ?? 0)}px)`,
                }
              : undefined
          }
          role="img"
          aria-label={t("Wallpaper preview")}
        />
        <div className="wp-actions">
          <button
            className="wp-btn"
            onClick={() =>
              void api()
                .invoke("wallpaper:choose", {})
                .then((r) => report(r as InstallStatus))
            }
          >
            {wp ? t("Change…") : t("Choose…")}
          </button>
          {wp && (
            <button
              className="wp-btn danger"
              onClick={() => {
                setStatus(null);
                tryCall("wallpaper:remove", {});
              }}
            >
              {t("Remove")}
            </button>
          )}
        </div>
        {status && <p className="wp-status">{status}</p>}
        {wp && (
          <label className="wp-slider">
            <span className="wp-slider-label">{t("Softness")}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={wp.softness}
              aria-label={t("Softness")}
              onChange={(e) =>
                tryCall("wallpaper:softness", { softness: Number(e.target.value) })
              }
            />
          </label>
        )}
        {perf && wp && (
          <p className="wp-note">{t("Wallpaper is paused while Performance Mode is on.")}</p>
        )}
      </div>

      <h3>{t("Transparency")}</h3>
      <label className="wp-slider">
        <span className="wp-slider-label">{t("Backdrop opacity")}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={opacity}
          aria-label={t("Backdrop opacity")}
          onChange={(e) =>
            tryCall("settings:set", { backdropOpacity: Number(e.target.value) })
          }
        />
        <button
          className="wp-btn"
          onClick={() => tryCall("settings:set", { backdropOpacity: DEFAULT_BACKDROP_OPACITY })}
        >
          {t("Reset")}
        </button>
      </label>
      <p className="wp-note">
        {t(
          "This window stays opaque — the slider controls how strongly the wallpaper shows through the interface, not the desktop behind it.",
        )}
      </p>
    </>
  );
}
