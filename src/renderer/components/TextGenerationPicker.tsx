// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-26.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-18: single Model picker for Settings › Text generation (mirrors
// TextGenerationModelRows + NewThreadModelPicker for the Windows Codex
// provider: Automatic, Specific model + effort, and Off).

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppInfo,
  CodexModelCatalog,
  CodexModelOption,
  Settings,
} from "../../shared/types";
import {
  CODEX_AUTOMATIC_TEXT_MODEL,
  findAutomaticCodexTextModel,
  orderedTextGenEfforts,
  textGenEffortTitle,
} from "../../shared/textGen";
import { useT } from "../locale";
import { translateError } from "../i18n";
import { api, tryCall } from "../client";

export interface TextGenerationPickerProps {
  settings: Settings;
  providerMode: AppInfo["mode"];
  initialCatalog?: CodexModelCatalog | null;
  initialOpen?: boolean;
}

export function TextGenerationPicker(
  props: TextGenerationPickerProps,
): React.JSX.Element {
  const t = useT();
  const { settings, providerMode } = props;
  const [open, setOpen] = useState(props.initialOpen ?? false);
  const [catalog, setCatalog] = useState<CodexModelCatalog | null>(
    props.initialCatalog ?? null,
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const gen = useRef(0);

  const refresh = useCallback((force = false) => {
    if (props.initialCatalog !== undefined) return;
    const g = ++gen.current;
    api()
      .invoke("models:list", force ? { force: true } : {})
      .then((c) => {
        if (gen.current === g) setCatalog(c as CodexModelCatalog);
      })
      .catch((e) => {
        if (gen.current === g) {
          setCatalog({
            state: "unavailable",
            reason: (e as Error)?.message ?? String(e),
          });
        }
      });
  }, [props.initialCatalog]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    if (catalog?.state !== "ready") refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open, catalog?.state, refresh]);

  const choice = settings.textGeneration ?? "automatic";
  const models: CodexModelOption[] =
    catalog?.state === "ready" ? catalog.models : [];
  const miniModel = findAutomaticCodexTextModel(models);
  const savedModelId = settings.textGenerationModelID ?? "";
  const selectedOption =
    savedModelId !== "" ? models.find((m) => m.id === savedModelId) : undefined;
  const efforts = selectedOption
    ? orderedTextGenEfforts(selectedOption.efforts)
    : [];
  const effectiveEffort =
    settings.textGenerationEffort &&
    efforts.includes(settings.textGenerationEffort)
      ? settings.textGenerationEffort
      : "";

  const buttonTitle =
    choice === "off"
      ? t("Off")
      : choice === "codex"
        ? [
            t("Codex"),
            selectedOption?.name ??
              (savedModelId !== ""
                ? t("%@ (unavailable)", savedModelId)
                : miniModel?.name ?? t("Default")),
            effectiveEffort ? t(textGenEffortTitle(effectiveEffort)) : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : t("Automatic");

  const detail =
    choice === "off"
      ? t("No thread titles, commit messages or composer predictions are generated.")
      : choice === "codex"
        ? t(
            "Writes thread titles, commit messages and composer predictions. Fast, inexpensive models are usually enough.",
          )
        : t(
            "Uses %@ at low effort. For thread titles, commit messages and composer predictions.",
            miniModel?.name ?? CODEX_AUTOMATIC_TEXT_MODEL,
          );

  const selectModel = (nextModelId: string) => {
    if (!nextModelId) return;
    const nextOption = models.find((m) => m.id === nextModelId);
    const nextEffort =
      settings.textGenerationEffort &&
      nextOption?.efforts.includes(settings.textGenerationEffort)
        ? settings.textGenerationEffort
        : null;
    tryCall("settings:set", {
      textGeneration: "codex",
      textGenerationModelID: nextModelId,
      textGenerationEffort: nextEffort,
    });
  };

  const selectEffort = (nextEffort: string) => {
    if (!savedModelId) return;
    tryCall("settings:set", {
      textGeneration: "codex",
      textGenerationModelID: savedModelId,
      textGenerationEffort: nextEffort || null,
    });
  };

  return (
    <div className="tg-picker-block">
      <div className="tg-picker-row">
        <span className="tg-picker-label">{t("Model")}</span>
        <div className="tg-picker-wrap" ref={wrapRef}>
          <button
            ref={triggerRef}
            type="button"
            className="choice tg-model-btn"
            data-testid="text-generation-model-button"
            aria-label={t("Model")}
            aria-haspopup="dialog"
            aria-expanded={open}
            title={buttonTitle}
            onClick={() => setOpen((was) => !was)}
          >
            <span className="tg-model-btn-label">{buttonTitle}</span>
            <span className="tg-model-btn-chev" aria-hidden="true">
              ▾
            </span>
          </button>

          {open && (
            <div
              className="tg-picker-pop"
              role="dialog"
              aria-label={t("Model")}
              data-testid="text-generation-model-popover"
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={choice === "automatic"}
                data-testid="tg-choice-automatic"
                className={`tg-pop-item${choice === "automatic" ? " selected" : ""}`}
                onClick={() => {
                  tryCall("settings:set", { textGeneration: "automatic" });
                  setOpen(false);
                }}
              >
                <span className="tg-pop-check" aria-hidden="true">
                  {choice === "automatic" ? "✓" : ""}
                </span>
                <span>{t("Automatic")}</span>
              </button>

              <button
                type="button"
                role="menuitemradio"
                aria-checked={choice === "off"}
                data-testid="tg-choice-off"
                className={`tg-pop-item${choice === "off" ? " selected" : ""}`}
                onClick={() => {
                  tryCall("settings:set", { textGeneration: "off" });
                  setOpen(false);
                }}
              >
                <span className="tg-pop-check" aria-hidden="true">
                  {choice === "off" ? "✓" : ""}
                </span>
                <span>{t("Off")}</span>
              </button>

              <div className="tg-pop-divider" />

              <div className="tg-pop-section-head">
                <span className="tg-pop-check" aria-hidden="true">
                  {choice === "codex" ? "✓" : ""}
                </span>
                <span>{t("Specific model")}</span>
              </div>

              <div className="tg-editor-row">
                <span>{t("Provider")}</span>
                <span className="tg-provider-value">{t("Codex")}</span>
              </div>

              <label className="tg-editor-row">
                <span>{t("Model")}</span>
                <select
                  className="model-select tg-editor-select"
                  data-testid="tg-model-select"
                  aria-label={t("Model")}
                  value={choice === "codex" ? savedModelId : ""}
                  disabled={models.length === 0 && savedModelId === ""}
                  onChange={(e) => selectModel(e.target.value)}
                >
                  <option value="">{t("Choose a model")}</option>
                  {savedModelId !== "" &&
                    !models.some((m) => m.id === savedModelId) && (
                      <option value={savedModelId}>
                        {t("%@ (unavailable)", savedModelId)}
                      </option>
                    )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>

              {choice === "codex" && efforts.length > 0 && (
                <label className="tg-editor-row">
                  <span>{t("Reasoning effort")}</span>
                  <select
                    className="model-select tg-editor-select"
                    data-testid="tg-effort-select"
                    aria-label={t("Reasoning effort")}
                    value={effectiveEffort}
                    onChange={(e) => selectEffort(e.target.value)}
                  >
                    <option value="">{t("Default")}</option>
                    {efforts.map((ef) => (
                      <option key={ef} value={ef}>
                        {t(textGenEffortTitle(ef))}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {catalog?.state !== "ready" && (
                <div className="tg-catalog-note">
                  {catalog?.state === "unavailable" ? (
                    <span>{translateError(t, catalog.reason)}</span>
                  ) : (
                    <span>
                      {t("No models loaded for %@ yet.", t("Codex"))}
                      {providerMode === "codex"
                        ? ` ${t("Send a turn in Codex to load its models.")}`
                        : ""}
                    </span>
                  )}
                  {props.initialCatalog === undefined && (
                    <button
                      type="button"
                      className="choice settings-btn-compact"
                      onClick={() => refresh(true)}
                    >
                      {t("Refresh")}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <p className="codex-note" data-testid="text-generation-detail">
        {detail}
      </p>
    </div>
  );
}
