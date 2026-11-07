// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Shortcuts settings section (F27): one row per command, the frozen
// section grouping, a per-row recorder that captures the next physical
// keydown, the frozen refusal rules verbatim (modifier-only, bare typing
// keys, system-reserved, already-owned), Remove/Reset actions and a
// per-section Reset once any binding is customized.

import { useEffect, useState } from "react";
import { api, tryCall } from "../client";
import { useT } from "../locale";
import {
  SHORTCUT_SECTIONS,
  chordFromEvent,
  chordLabel,
  defaultChord,
  effectiveChord,
  isModifierKey,
  sameChord,
  shortcutRefusal,
  SHORTCUT_DETAILS,
  SHORTCUT_TITLES,
  type KeyChord,
  type ShortcutCommandId,
} from "../../shared/shortcuts";

type Overrides = Record<string, KeyChord | null>;

export function ShortcutsSection(props: {
  shortcuts: Overrides | undefined;
  /** v2.2.34 quick chat master switch — its chord sits in the window
   *  list below (rebindable like any other). */
  quickChatEnabled: boolean;
}): React.JSX.Element {
  const t = useT();
  const isDarwin = api().platform === "darwin";
  const overrides = props.shortcuts ?? {};
  const [recording, setRecording] = useState<ShortcutCommandId | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const save = (next: Overrides) => tryCall("settings:set", { shortcuts: next });

  const record = (id: ShortcutCommandId, chord: KeyChord) => {
    const next = { ...overrides };
    const dflt = defaultChord(id, isDarwin);
    if (dflt && sameChord(chord, dflt)) delete next[id];
    else next[id] = chord;
    save(next);
  };

  const clear = (id: ShortcutCommandId) => save({ ...overrides, [id]: null });
  const resetOne = (id: ShortcutCommandId) => {
    const next = { ...overrides };
    delete next[id];
    save(next);
  };
  const resetSection = (ids: readonly ShortcutCommandId[]) => {
    const next = { ...overrides };
    for (const id of ids) delete next[id];
    save(next);
  };

  // The recorder: capture-phase so the pressed key never reaches the
  // global dispatcher, inputs or modal key handlers while a recording is
  // armed. Escape cancels; a pure modifier press is ignored (the session
  // keeps listening); any other key is judged by the frozen refusal rules.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        setRefusal(null);
        return;
      }
      if (isModifierKey(e.code)) return;
      const chord = chordFromEvent(e, isDarwin);
      const why = shortcutRefusal(chord, recording, overrides, isDarwin);
      if (why !== null) {
        setRefusal(why);
        return;
      }
      record(recording, chord);
      setRecording(null);
      setRefusal(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // Overrides are read at press time — the live map is fine to snapshot
    // because a committed recording closes the listener immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, isDarwin]);

  const refusalText = (raw: string): string => {
    // The conflict refusal carries its owner id after the pipe.
    const [key, owner] = raw.split("|");
    return owner ? t(key!, t(SHORTCUT_TITLES[owner as ShortcutCommandId])) : t(key!);
  };

  return (
    <>
      <h3>{t("Keyboard shortcuts")}</h3>
      <div className="shortcut-row">
        <div className="shortcut-text">
          <span className="shortcut-title">{t("Quick chat")}</span>
          <span className="shortcut-detail">
            {t(
              "Opens a quick chat box over any app. Return sends it as a new chat, placed and modelled like any other new chat.",
            )}
          </span>
        </div>
        <div className="choice-row">
          <button
            role="switch"
            aria-checked={props.quickChatEnabled}
            className={`choice${props.quickChatEnabled ? " active" : ""}`}
            onClick={() =>
              tryCall("settings:set", {
                quickChatEnabled: !props.quickChatEnabled,
              })
            }
          >
            {props.quickChatEnabled ? t("On") : t("Off")}
          </button>
        </div>
      </div>
      {(Object.keys(SHORTCUT_SECTIONS) as Array<keyof typeof SHORTCUT_SECTIONS>).map((sec) => {
        const ids = SHORTCUT_SECTIONS[sec];
        const customized = ids.some((id) => id in overrides);
        return (
          <div key={sec} className="shortcut-section">
            <div className="shortcut-section-head">
              <h4>{t(sec === "threads" ? "Threads" : "Window and panels")}</h4>
              {customized && (
                <button className="shortcut-reset" onClick={() => resetSection(ids)}>
                  {t("Reset")}
                </button>
              )}
            </div>
            {ids.map((id) => {
              const chord = effectiveChord(id, overrides, isDarwin);
              const isRecording = recording === id;
              const customizedOne = id in overrides;
              return (
                <div key={id} className="shortcut-row">
                  <div className="shortcut-text">
                    <span className="shortcut-title">{t(SHORTCUT_TITLES[id])}</span>
                    <span className="shortcut-detail">{t(SHORTCUT_DETAILS[id])}</span>
                  </div>
                  {isRecording ? (
                    <div className="shortcut-recorder">
                      <span className="shortcut-recording" role="status">
                        {refusal ? refusalText(refusal) : t("Press a shortcut…")}
                      </span>
                    </div>
                  ) : (
                    <div className="shortcut-control">
                      <button
                        className={`shortcut-chord${chord ? "" : " empty"}`}
                        title={chord ? t("Record a new shortcut") : t("Record shortcut")}
                        onClick={() => {
                          setRecording(id);
                          setRefusal(null);
                        }}
                      >
                        {chord ? chordLabel(chord, isDarwin) : t("Record shortcut")}
                      </button>
                      {chord && (
                        <button
                          className="shortcut-mini"
                          title={t("Remove shortcut")}
                          onClick={() => clear(id)}
                        >
                          {t("Remove")}
                        </button>
                      )}
                      {customizedOne && (
                        <button
                          className="shortcut-mini"
                          title={t("Reset to default")}
                          onClick={() => resetOne(id)}
                        >
                          {t("Reset")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <p className="codex-note">
        {t(
          "Modifiers are captured as pressed — Cmd is the primary key on macOS, Ctrl on Windows. Reserved system chords and keys that would steal typing cannot be recorded.",
        )}
      </p>
    </>
  );
}
