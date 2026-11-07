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
import type {
  CodexModelCatalog,
  LanguageId,
  Snapshot,
} from "../../shared/types";

function QuickChatInner() {
  const t = useT();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api()
      .invoke("models:list", {})
      .then((r) => {
        const cat = r as CodexModelCatalog;
        if (cat.state !== "ready") return; // honest: no fabricated list
        setModels(cat.models.map((m) => m.id));
        setModel(
          cat.models.find((m) => m.isDefault)?.id ?? cat.models[0]?.id ?? null,
        );
      });
    areaRef.current?.focus();
  }, []);

  const cycleModel = () => {
    if (!models.length) return;
    const i = model ? models.indexOf(model) : -1;
    setModel(models[(i + 1) % models.length] ?? null);
  };

  const send = (openApp: boolean) => {
    const area = areaRef.current;
    const text = area?.value.trim() ?? "";
    if (!text || busy) return;
    setBusy(true);
    void api()
      .invoke("quick:send", { text, openApp, model })
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
        {models.length > 0 && (
          <button
            type="button"
            className="quick-model"
            title={t("Model for this message")}
            onClick={cycleModel}
          >
            {model}
          </button>
        )}
        <span className="quick-spacer" />
        <button
          type="button"
          className="quick-act"
          title={t("Carry draft into Tivano")}
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
