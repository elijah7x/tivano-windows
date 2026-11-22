// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-05.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// v2.2.34 quick chat (frozen QuickChatView): one minimal box over other
// apps — Return sends a new chat, ⌘↩ additionally opens Tivano, the
// model chip picks the model for that message, expand carries the draft
// into the full chat, Esc/click-away hides while keeping the draft.
// Honest deltas: Electron windows take real focus (no nonactivating
// NSPanel), and the chip lists only the provider-reported catalog —
// pending/unavailable shows no fabricated models.

import { useEffect, useRef, useState } from "react";
import { api } from "../client";
import { LanguageContext, useT } from "../locale";
import { pairCustomName } from "../../shared/hydra";
import type {
  CodexModelCatalog,
  LanguageId,
  Snapshot,
} from "../../shared/types";

/** P2-42: the chip's options — provider models plus sub-agent presets
 *  (frozen NewThreadDefaultPicker). A preset starts the chat on its
 *  pair; a deleted preset falls back to Last selection main-side. */
type QuickPick = { kind: "model"; id: string } | { kind: "pair"; id: string };

function QuickChatInner() {
  const t = useT();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [models, setModels] = useState<string[]>([]);
  const [pick, setPick] = useState<QuickPick | null>(null);
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api()
      .invoke("models:list", {})
      .then((r) => {
        const cat = r as CodexModelCatalog;
        if (cat.state !== "ready") return; // honest: no fabricated list
        setModels(cat.models.map((m) => m.id));
        setPick((cur) =>
          cur ?? {
            kind: "model",
            id: cat.models.find((m) => m.isDefault)?.id ?? cat.models[0]?.id ?? "",
          },
        );
      });
    void api()
      .invoke("state:get", {})
      .then((r) => {
        const s = (r as Snapshot).settings;
        setPresets(
          (s.hydraPairs ?? []).map((p) => ({
            id: p.id,
            label: pairCustomName(p) ?? t("Preset"),
          })),
        );
        // The saved default opens the chip on its pick when it resolves.
        if (s.newThreadDefault?.kind === "pair")
          setPick({ kind: "pair", id: s.newThreadDefault.pairId });
        else if (s.newThreadDefault?.kind === "model")
          setPick({ kind: "model", id: s.newThreadDefault.model });
      })
      .catch(() => undefined);
    areaRef.current?.focus();
  }, []);

  const options = (): QuickPick[] => [
    ...models.map((id): QuickPick => ({ kind: "model", id })),
    ...presets.map((p): QuickPick => ({ kind: "pair", id: p.id })),
  ];

  const cycleModel = () => {
    const opts = options();
    if (!opts.length) return;
    const i = pick ? opts.findIndex((o) => o.kind === pick.kind && o.id === pick.id) : -1;
    setPick(opts[(i + 1) % opts.length] ?? null);
  };

  const send = (openApp: boolean) => {
    const area = areaRef.current;
    const text = area?.value.trim() ?? "";
    if (!text || busy) return;
    setBusy(true);
    void api()
      .invoke("quick:send", {
        text,
        openApp,
        model: pick?.kind === "model" ? pick.id : null,
        pairId: pick?.kind === "pair" ? pick.id : null,
      })
      .then(() => {
        if (area) area.value = "";
      })
      .catch(() => {
        /* keep the draft on failure */
      })
      .finally(() => setBusy(false));
  };

  const expand = () => {
    const text = areaRef.current?.value ?? "";
    void api()
      .invoke("quick:expand", { text })
      .then(() => {
        if (areaRef.current) areaRef.current.value = "";
      })
      .catch(() => undefined);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      void api().invoke("quick:hide", {});
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(e.metaKey || e.ctrlKey);
    }
  };

  return (
    <div className="quick-root">
      <div className="quick-head">
        {options().length > 0 && pick && (
          <button
            type="button"
            className="quick-model"
            title={t("Model for this message")}
            onClick={cycleModel}
          >
            {pick.kind === "pair"
              ? (presets.find((p) => p.id === pick.id)?.label ??
                t("%@ (unavailable)").replace("%@", t("Preset")))
              : pick.id}
          </button>
        )}
        <span className="quick-spacer" />
        <button
          type="button"
          className="quick-act"
          title={t("Open in Tivano")}
          onClick={expand}
        >
          ⤢
        </button>
        <button
          type="button"
          className="quick-act"
          title={t("Hide quick chat")}
          onClick={() => void api().invoke("quick:hide", {})}
        >
          ✕
        </button>
      </div>
      <textarea
        ref={areaRef}
        className="quick-input"
        placeholder={t("Message Tivano")}
        rows={3}
        onKeyDown={onKey}
      />
      <div className="quick-hint">
        {t("↩ send · ⌘↩ open Tivano · Esc hide")}
      </div>
    </div>
  );
}

export function QuickChat() {
  const [lang, setLang] = useState<LanguageId>("en");
  useEffect(() => {
    void api()
      .invoke("state:get", {})
      .then((r) => setLang((r as Snapshot).settings.language));
  }, []);
  return (
    <LanguageContext.Provider value={lang}>
      <QuickChatInner />
    </LanguageContext.Provider>
  );
}
