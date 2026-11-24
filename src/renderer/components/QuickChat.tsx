// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-05.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// v2.2.34 quick chat (frozen QuickChatView): one minimal box over other
// apps — Return sends a new chat, ⌘↩ additionally opens Tivano, the
// model chip picks the model for that message, expand carries the draft
// into the full chat, Esc/click-away hides while keeping the draft.
// Honest deltas: Electron windows take real focus (no nonactivating
// NSPanel), and the chip lists only the provider-reported catalog —
// pending/unavailable shows no fabricated models.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../client";
import { LanguageContext, useT } from "../locale";
import {
  pairCustomName,
  type HydraPair,
  type NewThreadDefault,
} from "../../shared/hydra";
import { modelsTitle } from "./HydraSection";
import type {
  AppInfo,
  CodexModelCatalog,
  LanguageId,
  Snapshot,
} from "../../shared/types";

/** Same shape HydraSection declares for `hydra:catalog` — the provider
 *  catalog pair labels resolve against (frozen ModelRegistry names). */
type ProviderCatalog = {
  providers: {
    id: string;
    label: string;
    ready: boolean;
    models: { id: string; name: string; efforts: string[] }[];
    defaultModel?: string | undefined;
  }[];
};

/** P2-42: the chip's options — provider models plus sub-agent presets
 *  (frozen NewThreadDefaultPicker). A preset starts the chat on its
 *  pair; a deleted preset falls back to Last selection main-side.
 *  `effort` rides only the pick reseeded from the saved model default
 *  — a cycled model pick has no effort of its own. */
type QuickPick =
  | { kind: "model"; id: string; effort?: string }
  | { kind: "pair"; id: string };

function QuickChatInner() {
  const t = useT();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [models, setModels] = useState<string[]>([]);
  const [pick, setPick] = useState<QuickPick | null>(null);
  // Raw pairs, not pre-rendered labels: the visibility-refresh closure
  // captures the language at mount, so localizing in render is the only
  // way preset labels follow a zh-Hans switch.
  const [presets, setPresets] = useState<HydraPair[]>([]);
  const [providers, setProviders] = useState<ProviderCatalog["providers"]>([]);
  const [saved, setSaved] = useState<NewThreadDefault | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Frozen distinguishes the chip's untouched default (no override — the
  // saved newThreadDefault resolves verbatim) from a pick the user
  // cycled to (an explicit choice that overrides it — including the
  // explicit "Last selection" null pick).
  const touchedRef = useRef(false);

  // Frozen rebuilds the view on every toggle — the panel's window is
  // lazily kept, so each show refetches the catalog/presets and reseeds
  // the chip from the saved default (the modelOverride reset). One
  // awaited pass keeps the reseed from racing the catalog fetch.
  const refresh = useCallback(() => {
    void Promise.all([
      api().invoke("models:list", {}),
      api().invoke("state:get", {}),
      api().invoke("hydra:catalog", {}),
      api().invoke("app:info", {}),
    ])
      .then(([m, s, c, i]) => {
        const cat = m as CodexModelCatalog;
        const snap = s as Snapshot;
        const info = i as AppInfo;
        const settings = snap.settings;
        setProviders((c as ProviderCatalog)?.providers ?? []);
        // Frozen NewThreadDefaultPicker lists only presets usable here —
        // the app-wide Hydra switch on and the pair's provider matching
        // the active provider (frozen ConversationSettingsPage).
        const usable = (settings.hydraPairs ?? []).filter(
          (p) =>
            settings.hydraEnabled !== false &&
            p.provider === info.providerId,
        );
        setPresets(usable);
        setSaved(settings.newThreadDefault);
        touchedRef.current = false;
        const def = settings.newThreadDefault;
        if (def?.kind === "pair")
          setPick({ kind: "pair", id: def.pairId });
        else if (def?.kind === "model")
          setPick({
            kind: "model",
            id: def.model,
            ...(def.effort !== undefined ? { effort: def.effort } : {}),
          });
        else setPick(null); // Last selection — no fabricated default
        setModels(
          cat.state === "ready" ? cat.models.map((x) => x.id) : [],
        );
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        refresh();
        areaRef.current?.focus();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const options = (): (QuickPick | null)[] => [
    null, // Last selection — frozen's first picker entry
    ...models.map((id): QuickPick => ({ kind: "model", id })),
    ...presets.map((p): QuickPick => ({ kind: "pair", id: p.id })),
  ];

  const cycleModel = () => {
    const opts = options();
    const i = opts.findIndex(
      (o) =>
        (o === null && pick === null) ||
        (o !== null && pick !== null && o.kind === pick.kind && o.id === pick.id),
    );
    touchedRef.current = true;
    setPick(opts[(i + 1) % opts.length] ?? null);
  };

  // The chip's pick only reaches the wire once the user cycled it —
  // an untouched send leaves the saved default (or Last selection)
  // to resolve exactly as a plain new chat would.
  const wirePick = () => {
    if (!touchedRef.current)
      return { model: null, effort: null, pairId: null, last: false };
    if (pick === null)
      return { model: null, effort: null, pairId: null, last: true };
    return pick.kind === "pair"
      ? { model: null, effort: null, pairId: pick.id, last: false }
      : {
          model: pick.id,
          effort:
            saved?.kind === "model" && saved.model === pick.id
              ? (saved.effort ?? null)
              : (pick.effort ?? null),
          pairId: null,
          last: false,
        };
  };

  const send = (openApp: boolean) => {
    const area = areaRef.current;
    const text = area?.value.trim() ?? "";
    if (!text || busy) return;
    setBusy(true);
    void api()
      .invoke("quick:send", { text, openApp, ...wirePick() })
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
      .invoke("quick:expand", { text, ...wirePick() })
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

  const pickLabel = (): string => {
    if (pick === null) return t("Last selection");
    if (pick.kind === "model") return pick.id;
    const pair = presets.find((p) => p.id === pick.id);
    return pair !== undefined
      ? (pairCustomName(pair) ?? modelsTitle(t, pair, providers))
      : t("%@ (unavailable)").replace("%@", t("Preset"));
  };

  return (
    <div className="quick-root">
      <div className="quick-head">
        <button
          type="button"
          className="quick-model"
          title={t("Model for this message")}
          onClick={cycleModel}
        >
          {pickLabel()}
        </button>
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
    const load = () =>
      void api()
        .invoke("state:get", {})
        .then((r) => setLang((r as Snapshot).settings.language));
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return (
    <LanguageContext.Provider value={lang}>
      <QuickChatInner />
    </LanguageContext.Provider>
  );
}
