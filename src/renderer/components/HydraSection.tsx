// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F21: frozen HydraSettingsPage bounded port — the configuration surface for
// lead↔heads pairs and every hydra* switch. Head scheduling itself is F22:
// this build saves the configuration honestly and says so, it never claims
// heads can run.

import { useEffect, useRef, useState } from "react";
import { InfoHover } from "./InfoHover";
import { HydraInfo } from "./HydraInfo";
import type { Settings } from "../../shared/types";
import {
  HYDRA_MAX_HEADS_RANGE,
  HYDRA_RECIPES,
  clampedHydraCap,
  hydraProviderName,
  isPairAdded,
  newHeadProfile,
  newHydraPair,
  pairCustomName,
  pairEffortsPhrase,
  pairHeadsProvider,
  pairSendsHeadsElsewhere,
  recipeMissingProvider,
  resolveRecipe,
  type HydraCatalog,
  type HydraHeadProfile,
  type HydraPair,
} from "../../shared/hydra";
import { useT } from "../locale";
import { api, tryCall } from "../client";

type T = (key: string, ...vars: string[]) => string;

interface CatalogProvider {
  id: string;
  label: string;
  ready: boolean;
  models: { id: string; name: string; efforts: string[] }[];
  defaultModel?: string | undefined;
}
interface HydraCatalogView {
  providers: CatalogProvider[];
}

/** Frozen ModelOption.effortTitle equivalent — "Extra High" for xhigh,
 *  otherwise the id capitalized. */
function effortTitle(effort: string): string {
  if (effort === "xhigh" || effort === "extra-high") return "Extra High";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** Union of efforts the provider's catalog advertises, low→high-ish. */
function allEfforts(models: { efforts: string[] }[]): string[] {
  const rank = (e: string) =>
    ({ none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 })[
      e.toLowerCase()
    ] ?? 99;
  const set = new Set<string>();
  for (const m of models) for (const e of m.efforts) set.add(e);
  return [...set].sort((a, b) => rank(a) - rank(b));
}

function providerLabel(providers: CatalogProvider[], id: string): string {
  return providers.find((p) => p.id === id)?.label ?? id;
}

function modelName(
  providers: CatalogProvider[],
  providerId: string,
  modelId: string | undefined,
): string | undefined {
  if (!modelId) return undefined;
  const p = providers.find((x) => x.id === providerId);
  return p?.models.find((m) => m.id === modelId)?.name ?? modelId;
}

/** Frozen HydraPairSummary.modelsTitle — "Fable + Opus", "Any X model +
 *  itself". */
function modelsTitle(t: T, pair: HydraPair, providers: CatalogProvider[]): string {
  const lead =
    modelName(providers, pair.provider, pair.orchestratorModel) ??
    t("Any %@ model", providerLabel(providers, pair.provider));
  const worker =
    modelName(providers, pairHeadsProvider(pair), pair.workerModel) ??
    (pairSendsHeadsElsewhere(pair)
      ? providerLabel(providers, pairHeadsProvider(pair))
      : undefined);
  return worker === undefined
    ? t("%@ + itself", lead)
    : `${lead} + ${worker}`;
}

/** Frozen row summary — "Lead: m - e | Head: m - e - cap", plus the
 *  not-set-up caveat when the heads' provider cannot run here. */
function pairSummary(
  t: T,
  pair: HydraPair,
  providers: CatalogProvider[],
  pageCap: number | undefined,
): string {
  const leadModel =
    modelName(providers, pair.provider, pair.orchestratorModel) ?? t("Any model");
  const leadEffort = pair.orchestratorEffort
    ? t(effortTitle(pair.orchestratorEffort))
    : t("Default");
  const headsElsewhere = pairSendsHeadsElsewhere(pair);
  const headModel =
    modelName(providers, pairHeadsProvider(pair), pair.workerModel) ??
    (headsElsewhere
      ? t("%@'s default", providerLabel(providers, pairHeadsProvider(pair)))
      : t("Same as the chat"));
  const headEffort = pair.workerEffort
    ? t(effortTitle(pair.workerEffort))
    : t("Automatic");
  const cap = [pair.maxHeads, pageCap].filter(
    (x): x is number => x !== undefined,
  ).length
    ? Math.min(...[pair.maxHeads, pageCap].filter((x): x is number => x !== undefined))
    : undefined;
  let line = t(
    "Lead: %@ - %@ | Head: %@ - %@ - %@",
    leadModel,
    leadEffort,
    headModel,
    headEffort,
    cap !== undefined ? t("Up to %d", String(cap)) : t("No cap"),
  );
  // Heads on a provider this build cannot run stay on the lead's (frozen
  // AppModel.hydraHeadsProvider) — the row says so.
  const headsReady =
    !headsElsewhere ||
    providers.some((p) => p.id === pairHeadsProvider(pair) && p.ready);
  if (!headsReady) {
    line += ` · ${t(
      "%@ is not set up, heads stay on %@",
      providerLabel(providers, pairHeadsProvider(pair)),
      providerLabel(providers, pair.provider),
    )}`;
  }
  return line;
}

function ChoiceRow(props: {
  options: readonly (readonly [string, string])[];
  value: string;
  aria: string;
  onPick: (v: string) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const t = useT();
  return (
    <div className="choice-row" role="radiogroup" aria-label={t(props.aria)}>
      {props.options.map(([v, label]) => (
        <button
          key={v}
          role="radio"
          aria-checked={props.value === v}
          className={`choice${props.value === v ? " active" : ""}`}
          disabled={props.disabled}
          onClick={() => props.onPick(v)}
        >
          {t(label)}
        </button>
      ))}
    </div>
  );
}

function ToggleRow(props: {
  title: string;
  detail: string;
  on: boolean;
  onFlip: (next: boolean) => void;
  blockedBy?: string | undefined;
}): React.JSX.Element {
  const t = useT();
  return (
    <div className="hydra-toggle">
      <div className="choice-row">
        <button
          role="switch"
          aria-checked={props.on}
          className={`choice${props.on ? " active" : ""}`}
          disabled={!!props.blockedBy}
          onClick={() => props.onFlip(!props.on)}
        >
          {t(props.title)}
        </button>
      </div>
      <p className="codex-note">{t(props.blockedBy ?? props.detail)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pair editor — a bounded inline form: every field writes the draft locally
// and Save persists the whole hydraPairs list through settings:set.

function PairEditor(props: {
  pair: HydraPair;
  providers: CatalogProvider[];
  onSave: (pair: HydraPair) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useT();
  const [draft, setDraft] = useState<HydraPair>(() => ({
    ...props.pair,
    headProfiles: props.pair.headProfiles.map((p) => ({ ...p })),
  }));
  const { providers } = props;
  const upd = (fn: (p: HydraPair) => void) => {
    setDraft((d) => {
      const next = { ...d, headProfiles: d.headProfiles.map((p) => ({ ...p })) };
      fn(next);
      return next;
    });
  };

  const readyProviders = providers.filter((p) => p.ready);
  const leadOptions = readyProviders.some((p) => p.id === draft.provider)
    ? readyProviders
    : [...readyProviders, ...providers.filter((p) => p.id === draft.provider)];
  const headsElsewhere = pairSendsHeadsElsewhere(draft);
  const headsProvider = pairHeadsProvider(draft);
  const headsOptions = readyProviders.some((p) => p.id === headsProvider)
    ? readyProviders
    : [...readyProviders, ...providers.filter((p) => p.id === headsProvider)];

  const modelsFor = (id: string) =>
    providers.find((p) => p.id === id)?.models ?? [];
  const leadModels = modelsFor(draft.provider);
  const headModels = modelsFor(headsProvider);
  const leadModelOption = leadModels.find((m) => m.id === draft.orchestratorModel);
  const workerModelOption = headModels.find((m) => m.id === draft.workerModel);
  // Frozen editor semantics: a lead that may be any model offers every effort
  // the provider's models know; heads inherit the lead's efforts unless they
  // run on another provider's default model.
  const leadEfforts =
    leadModelOption?.efforts?.length ? leadModelOption.efforts : allEfforts(leadModels);
  const headEfforts = workerModelOption?.efforts?.length
    ? workerModelOption.efforts
    : headsElsewhere
      ? allEfforts(headModels)
      : leadEfforts;

  const providerSelect = (
    value: string,
    options: CatalogProvider[],
    onPick: (id: string) => void,
    aria: string,
  ) => (
    <select
      className="model-select"
      aria-label={t(aria)}
      value={value}
      onChange={(e) => onPick(e.target.value)}
    >
      {options.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </select>
  );

  const modelSelect = (
    value: string | undefined,
    models: { id: string; name: string; efforts: string[] }[],
    emptyLabel: string,
    onPick: (id: string | undefined) => void,
    aria: string,
  ) => (
    <select
      className="model-select hydra-model-choice"
      aria-label={t(aria)}
      value={value ?? ""}
      onChange={(e) => onPick(e.target.value === "" ? undefined : e.target.value)}
    >
      <option value="">{emptyLabel}</option>
      {value !== undefined && !models.some((m) => m.id === value) && (
        <option value={value}>{`${value} (${t("saved")})`}</option>
      )}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );

  const effortSelect = (
    value: string | undefined,
    efforts: string[],
    onPick: (id: string | undefined) => void,
    aria: string,
  ) => (
    <select
      className="effort-select"
      aria-label={t(aria)}
      value={value ?? ""}
      disabled={efforts.length === 0 && value === undefined}
      onChange={(e) => onPick(e.target.value === "" ? undefined : e.target.value)}
    >
      <option value="">{t("Default")}</option>
      {value !== undefined && !efforts.includes(value) && (
        <option value={value}>{`${effortTitle(value)} (${t("saved")})`}</option>
      )}
      {efforts.map((e) => (
        <option key={e} value={e}>
          {t(effortTitle(e))}
        </option>
      ))}
    </select>
  );

  const updProfile = (id: string, fn: (p: HydraHeadProfile) => void) =>
    upd((d) => {
      const p = d.headProfiles.find((x) => x.id === id);
      if (p) fn(p);
    });

  return (
    <div className="hydra-editor" data-testid="hydra-pair-editor">
      <label className="wt-field">
        <span>{t("Shown in the picker and the composer")}</span>
        <input
          className="wt-input"
          defaultValue={draft.name ?? ""}
          placeholder={modelsTitle(t, draft, providers)}
          spellCheck={false}
          onChange={(e) =>
            upd((d) => {
              const v = e.target.value;
              if (v === "") delete d.name;
              else d.name = v;
            })
          }
        />
      </label>

      <div className="hydra-editor-grid">
        <span className="hydra-editor-side">{t("Lead")}</span>
        <label className="wt-field">
          <span>{t("Provider")}</span>
          {providerSelect(draft.provider, leadOptions, (id) =>
            upd((d) => {
              if (d.provider === id) return;
              d.provider = id;
              delete d.orchestratorModel;
              delete d.orchestratorEffort;
              // Frozen: heads on the old lead provider go with it; heads on
              // a provider of their own keep model/effort — and when that
              // provider is the new lead's they are simply on the lead's.
              if (d.workerProvider === undefined) {
                delete d.workerModel;
                delete d.workerEffort;
              } else if (d.workerProvider === id) {
                delete d.workerProvider;
              }
            }),
          "Lead provider")}
        </label>
        <label className="wt-field">
          <span>{t("Model")}</span>
          {modelSelect(
            draft.orchestratorModel,
            leadModels,
            t("Any model"),
            (id) =>
              upd((d) => {
                if (id === undefined) delete d.orchestratorModel;
                else d.orchestratorModel = id;
                delete d.orchestratorEffort;
              }),
            "Lead model",
          )}
        </label>
        <label className="wt-field">
          <span>{t("Effort")}</span>
          {effortSelect(
            draft.orchestratorEffort,
            leadEfforts,
            (id) =>
              upd((d) => {
                if (id === undefined) delete d.orchestratorEffort;
                else d.orchestratorEffort = id;
              }),
            "Lead effort",
          )}
        </label>

        <span className="hydra-editor-side">{t("Heads")}</span>
        <label className="wt-field">
          <span>{t("Provider")}</span>
          <select
            className="model-select"
            aria-label={t("Heads provider")}
            value={draft.workerProvider ?? ""}
            onChange={(e) =>
              upd((d) => {
                const v = e.target.value;
                if (v === "") delete d.workerProvider;
                else d.workerProvider = v;
                delete d.workerModel;
                delete d.workerEffort;
              })
            }
          >
            <option value="">{t("Same as the lead")}</option>
            {headsOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="wt-field">
          <span>{t("Model")}</span>
          {modelSelect(
            draft.workerModel,
            headModels,
            headsElsewhere
              ? t("%@'s default", providerLabel(providers, headsProvider))
              : t("Same as the chat"),
            (id) =>
              upd((d) => {
                if (id === undefined) delete d.workerModel;
                else d.workerModel = id;
                delete d.workerEffort;
              }),
            "Heads model",
          )}
        </label>
        <label className="wt-field">
          <span>{t("Effort")}</span>
          {effortSelect(
            draft.workerEffort,
            headEfforts,
            (id) =>
              upd((d) => {
                if (id === undefined) delete d.workerEffort;
                else d.workerEffort = id;
              }),
            "Heads effort",
          )}
        </label>

        <label className="wt-field">
          <span>{t("Heads at once")}</span>
          <select
            className="model-select"
            aria-label={t("Heads at once")}
            value={draft.maxHeads === undefined ? "" : String(draft.maxHeads)}
            onChange={(e) =>
              upd((d) => {
                if (e.target.value === "") delete d.maxHeads;
                else d.maxHeads = clampedHydraCap(parseInt(e.target.value, 10));
              })
            }
          >
            <option value="">{t("As many as it takes")}</option>
            {Array.from(
              {
                length:
                  HYDRA_MAX_HEADS_RANGE.upper - HYDRA_MAX_HEADS_RANGE.lower + 1,
              },
              (_, i) => HYDRA_MAX_HEADS_RANGE.lower + i,
            ).map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="hydra-profiles">
        <span className="hydra-editor-side">{t("Head profiles")}</span>
        {draft.headProfiles.map((p) => (
          <div className="hydra-profile" key={p.id}>
            <input
              className="wt-input hydra-profile-name"
              defaultValue={p.name}
              placeholder={t("Profile name (for example: quick, deep, docs)")}
              spellCheck={false}
              onChange={(e) => updProfile(p.id, (x) => (x.name = e.target.value))}
            />
            {providerSelect(
              p.provider ?? "",
              [
                { id: "", label: t("Pair's heads provider"), ready: true, models: [] },
                ...headsOptions,
              ],
              (id) =>
                updProfile(p.id, (x) => {
                  if (id === "") delete x.provider;
                  else x.provider = id;
                  delete x.model;
                  delete x.effort;
                }),
              "Profile provider",
            )}
            {modelSelect(
              p.model,
              p.provider ? modelsFor(p.provider) : headModels,
              t("Pair's model"),
              (id) =>
                updProfile(p.id, (x) => {
                  if (id === undefined) delete x.model;
                  else x.model = id;
                  delete x.effort;
                }),
              "Profile model",
            )}
            {effortSelect(
              p.effort,
              p.provider ? allEfforts(modelsFor(p.provider)) : headEfforts,
              (id) =>
                updProfile(p.id, (x) => {
                  if (id === undefined) delete x.effort;
                  else x.effort = id;
                }),
              "Profile effort",
            )}
            <button
              className="choice hydra-remove"
              title={t("Remove this profile")}
              aria-label={t("Remove this profile")}
              onClick={() =>
                upd((d) => {
                  d.headProfiles = d.headProfiles.filter((x) => x.id !== p.id);
                })
              }
            >
              −
            </button>
          </div>
        ))}
        <button
          className="choice"
          onClick={() =>
            upd((d) => {
              d.headProfiles.push(newHeadProfile(""));
            })
          }
        >
          {t("Add a head profile")}
        </button>
      </div>

      <div className="choice-row hydra-editor-actions">
        <button className="choice" onClick={() => props.onSave(draft)}>
          {t("Save pair")}
        </button>
        <button className="choice" onClick={props.onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A76: frozen HydraCookbookPanel — the pair-presets popover hanging off the
// Pairs header. Recipes that resolve against the live catalog offer Add; the
// rest wait, dimmed, under "Needs a provider" naming the first provider to
// set up (frozen missingProvider semantics — a recipe whose sides all have a
// ready provider but no catalog match appears in neither list).

function effortPhraseText(t: T, pair: HydraPair): string | undefined {
  const phrase = pairEffortsPhrase(pair, (e) => t(effortTitle(e)));
  switch (phrase.kind) {
    case "same":
      return t("%@ effort", phrase.lead!);
    case "split":
      return t("Lead %@, heads %@ effort", phrase.lead!.toLowerCase(), phrase.heads!.toLowerCase());
    case "lead":
      return t("Lead %@ effort", phrase.lead!.toLowerCase());
    case "heads":
      return t("Heads %@ effort", phrase.heads!.toLowerCase());
    default:
      return undefined;
  }
}

function CookbookPopover(props: {
  providers: CatalogProvider[];
  pairs: HydraPair[];
  pos: { top: number; left: number; maxH: number };
  onAdd: (pair: HydraPair) => void;
}): React.JSX.Element {
  const t = useT();
  const catalogView: HydraCatalog = {
    isReady: (p) => props.providers.some((x) => x.id === p && x.ready),
    models: (p) => props.providers.find((x) => x.id === p)?.models ?? [],
    defaultModel: (p) => props.providers.find((x) => x.id === p)?.defaultModel,
    displayName: (p) => providerLabel(props.providers, p),
  };
  const label = (id: string) => {
    const hit = props.providers.find((p) => p.id === id);
    return hit ? hit.label : hydraProviderName(id);
  };
  const ready = HYDRA_RECIPES.map((recipe) => ({
    recipe,
    pair: resolveRecipe(recipe, catalogView),
  })).filter(
    (e): e is { recipe: (typeof HYDRA_RECIPES)[number]; pair: HydraPair } =>
      e.pair !== undefined,
  );
  const waiting = HYDRA_RECIPES.map((recipe) => ({
    recipe,
    missing: recipeMissingProvider(recipe, catalogView),
  })).filter(
    (e): e is { recipe: (typeof HYDRA_RECIPES)[number]; missing: string } =>
      e.missing !== undefined,
  );

  return (
    <div
      className="cook-pop"
      role="dialog"
      aria-label={t("Pair presets")}
      style={{ top: props.pos.top, left: props.pos.left, maxHeight: props.pos.maxH }}
    >
      <div className="cook-head">
        <span className="cook-title">{t("Pair presets")}</span>
        <span className="cook-hint">{t("Add a preset to your model picker.")}</span>
      </div>
      <div className="cook-list">
        {ready.length === 0 && (
          <p className="codex-note cook-empty">
            {t(
              "Set up a provider in Settings, and its models bring their pairs here.",
            )}
          </p>
        )}
        {ready.map(({ recipe, pair }) => {
          const headsElsewhere = pairSendsHeadsElsewhere(pair);
          const providersLine = headsElsewhere
            ? t("%@ lead, %@ heads", label(pair.provider), label(pairHeadsProvider(pair)))
            : undefined;
          const efforts = effortPhraseText(t, pair);
          const detail = [providersLine, efforts]
            .filter((x): x is string => x !== undefined)
            .join(" · ");
          const added = isPairAdded(pair, props.pairs);
          return (
            <div className="cook-row" key={recipe.id} data-recipe={recipe.id}>
              <span className="cook-provs">
                <span className="cook-prov">{label(pair.provider)}</span>
                <span className="cook-prov">
                  {label(pairHeadsProvider(pair))}
                </span>
              </span>
              <span className="cook-main">
                <span className="cook-name">
                  {pairCustomName(pair) ?? modelsTitle(t, pair, props.providers)}
                </span>
                <span className="cook-tag">{t(recipe.tagline)}</span>
                {detail !== "" && <span className="cook-detail">{detail}</span>}
              </span>
              {added ? (
                <span className="cook-added">✓ {t("Added")}</span>
              ) : (
                <button
                  type="button"
                  className="choice cook-add"
                  onClick={() => props.onAdd(pair)}
                >
                  {t("Add")}
                </button>
              )}
            </div>
          );
        })}
        {waiting.length > 0 && (
          <>
            <div className="cook-wait-head">{t("Needs a provider")}</div>
            {waiting.map(({ recipe, missing }) => (
              <div
                className="cook-row cook-waiting"
                key={recipe.id}
                data-recipe={recipe.id}
              >
                <span className="cook-provs">
                  <span className="cook-prov">
                    {label(recipe.lead.providers[0]!)}
                  </span>
                  <span className="cook-prov">
                    {label(recipe.heads.providers[0]!)}
                  </span>
                </span>
                <span className="cook-main">
                  <span className="cook-name">{t(recipe.title)}</span>
                  <span className="cook-tag">{t(recipe.tagline)}</span>
                  <span className="cook-detail">
                    {t("Set up %@ to add this pair.", label(missing))}
                  </span>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function HydraSection(props: { settings: Settings }): React.JSX.Element {
  const t = useT();
  const { settings } = props;
  const [catalog, setCatalog] = useState<HydraCatalogView | null>(null);
  const [editing, setEditing] = useState<HydraPair | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    api()
      .invoke("hydra:catalog", {})
      .then((c) => {
        if (mounted.current) setCatalog(c as HydraCatalogView);
      })
      .catch(() => {
        if (mounted.current) setCatalog({ providers: [] });
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  const providers = catalog?.providers ?? [];
  const pairs = settings.hydraPairs ?? [];
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [cookPos, setCookPos] = useState<{ top: number; left: number; maxH: number } | null>(null);
  const cookAnchor = useRef<HTMLSpanElement>(null);
  const togglePresets = (): void => {
    if (presetsOpen) return setPresetsOpen(false);
    // Frozen HydraCookbookPanel: a fixed 460×540 panel below the button,
    // clamped inside the viewport like every other popover here.
    const r = cookAnchor.current?.querySelector(".cook-open")?.getBoundingClientRect();
    if (r) {
      const W = 460;
      const left = Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8));
      const maxH = Math.min(540, window.innerHeight - r.bottom - 16);
      setCookPos({ top: r.bottom + 8, left, maxH: Math.max(180, maxH) });
    }
    setPresetsOpen(true);
  };
  useEffect(() => {
    if (!presetsOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (cookAnchor.current && !cookAnchor.current.contains(e.target as Node))
        setPresetsOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // Capture phase + stopPropagation: the settings modal's own
        // Escape-to-close runs on the bubble path — swallow the key here
        // so closing the popover never closes the modal with it.
        e.stopPropagation();
        setPresetsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [presetsOpen]);

  const savePairs = (next: HydraPair[]) =>
    tryCall("settings:set", { hydraPairs: next });
  const toggle = (key: string, next: boolean) =>
    tryCall("settings:set", { [key]: next });
  const on = (v: boolean | undefined, dflt: boolean) => v ?? dflt;

  const hydraOn = on(settings.hydraEnabled, true);

  return (
    <div className={`hydra-section${hydraOn ? "" : " hydra-off"}`}>
      <h3>
        {t("Hydra")}
        <InfoHover help="How Hydra works" label="Hydra">
          <HydraInfo topic="hydra" />
        </InfoHover>
      </h3>
      <p className="codex-note">{t("One chat leads a team of heads on big jobs.")}</p>
      <div className="choice-row">
        <button
          role="switch"
          aria-checked={hydraOn}
          className={`choice${hydraOn ? " active" : ""}`}
          onClick={() => toggle("hydraEnabled", !hydraOn)}
        >
          {t("Hydra")}
        </button>
      </div>
      <p className="codex-note hydra-status" data-testid="hydra-status">
        {t(
          "With “Own copy” each head works in a disposable worktree of the checkout and Tivano lands its changes back when it reports; checkouts that cannot be copied stay shared. Merge requests and review gating are not wired in this build yet.",
        )}
      </p>

      <div className="hydra-pairs-head">
        <h4>{t("Pairs")}</h4>
        <span className="cook-anchor" ref={cookAnchor}>
          <button
            type="button"
            className="choice cook-open"
            aria-expanded={presetsOpen}
            onClick={togglePresets}
          >
            {t("Pair presets")}
          </button>
          {presetsOpen && cookPos && (
            <CookbookPopover
              providers={providers}
              pairs={pairs}
              pos={cookPos}
              onAdd={(pair) => {
                if (!isPairAdded(pair, pairs)) savePairs([...pairs, pair]);
              }}
            />
          )}
        </span>
      </div>
      <div className="hydra-pairs">
        {pairs.length === 0 && editing === null && (
          <div className="kv">
            <span>{t("No pairs yet")}</span>
            <span>
              {t("Heads run on the chat's own model until a chat joins a pair.")}
            </span>
          </div>
        )}
        {pairs.map((pair) => (
          <div className="hydra-pair" key={pair.id} data-pair={pair.id}>
            <button
              className="hydra-pair-label"
              title={t("Edit this pair")}
              onClick={() => setEditing(editing?.id === pair.id ? null : { ...pair })}
            >
              <span className="hydra-pair-title">
                {pairCustomName(pair) ?? modelsTitle(t, pair, providers)}
              </span>
              <span className="hydra-pair-summary">
                {pairSummary(t, pair, providers, settings.hydraMaxHeads)}
              </span>
            </button>
            <button
              className="choice hydra-remove"
              title={t("Remove this pair")}
              aria-label={t("Remove this pair")}
              onClick={() => savePairs(pairs.filter((p) => p.id !== pair.id))}
            >
              −
            </button>
          </div>
        ))}
        {editing !== null && (
          <PairEditor
            pair={editing}
            providers={providers}
            onCancel={() => setEditing(null)}
            onSave={(next) => {
              const idx = pairs.findIndex((p) => p.id === next.id);
              const list = [...pairs];
              if (idx < 0) list.push(next);
              else list[idx] = next;
              savePairs(list);
              setEditing(null);
            }}
          />
        )}
        <div className="kv">
          <span>{t("Another pair")}</span>
          <span>
            <button
              className="choice"
              title={t("One per provider is enough.")}
              disabled={providers.filter((p) => p.ready).length === 0}
              onClick={() => {
                const provider =
                  providers.find((p) => p.ready)?.id ?? pairs[0]?.provider ?? "codex";
                setEditing(newHydraPair(provider));
              }}
            >
              +
            </button>
          </span>
        </div>
      </div>

      <h4>
        {t("Heads")}
        <InfoHover help="How heads work" label="Heads">
          <HydraInfo topic="heads" />
        </InfoHover>
      </h4>
      <div className="hydra-sub">
        <div className="kv">
          <span>{t("Checkout")}</span>
          <span>
            <ChoiceRow
              aria="Checkout"
              options={[["own", "Own copy"], ["shared", "Shared"]]}
              value={on(settings.hydraIsolateHeads, true) ? "own" : "shared"}
              onPick={(v) => toggle("hydraIsolateHeads", v === "own")}
            />
          </span>
        </div>
        <p className="codex-note">
          {on(settings.hydraIsolateHeads, true)
            ? t("Each head gets its own copy of the checkout; its work lands back when it reports.")
            : t("Heads work directly in the chat's checkout.")}
        </p>
        <div className="kv">
          <span>{t("Heads at once per chat")}</span>
          <span>
            <ChoiceRow
              aria="Heads at once per chat"
              options={[
                ["none", "No cap"] as const,
                ...Array.from(
                  { length: HYDRA_MAX_HEADS_RANGE.upper - HYDRA_MAX_HEADS_RANGE.lower + 1 },
                  (_, i) => [String(HYDRA_MAX_HEADS_RANGE.lower + i), String(HYDRA_MAX_HEADS_RANGE.lower + i)] as const,
                ),
              ]}
              value={
                settings.hydraMaxHeads === undefined ? "none" : String(settings.hydraMaxHeads)
              }
              onPick={(v) =>
                tryCall("settings:set", {
                  hydraMaxHeads: v === "none" ? null : parseInt(v, 10),
                })
              }
            />
          </span>
        </div>
        <p className="codex-note">
          {t("The lower of this limit and the preset's limit applies. No cap adds no limit here.")}
        </p>
        <div className="kv">
          <span>{t("Head panel")}</span>
          <span>
            <ChoiceRow
              aria="Head panel"
              options={[["progress", "Progress"], ["steps", "Every step"]]}
              value={on(settings.hydraShowsHeadDetails, false) ? "steps" : "progress"}
              onPick={(v) => toggle("hydraShowsHeadDetails", v === "steps")}
            />
          </span>
        </div>
        <p className="codex-note">{t("The head's progress bar, or each of its steps as it goes.")}</p>
        <div className="kv">
          <span>{t("Heads' panels")}</span>
          <span>
            <ChoiceRow
              aria="Heads' panels"
              options={[["one", "One panel"], ["each", "A panel each"]]}
              value={on(settings.hydraAutoPopsHeads, false) ? "each" : "one"}
              onPick={(v) => toggle("hydraAutoPopsHeads", v === "each")}
            />
          </span>
        </div>
        <p className="codex-note">
          {on(settings.hydraAutoPopsHeads, false)
            ? t("Each head after the first gets a panel of its own beside the chat while there is room, left and right until each side is full.")
            : t("One panel over the chat lists every head.")}
        </p>
        <ToggleRow
          title="Lower the default reasoning effort for heads"
          detail="Effort set in a pair is unaffected. When no effort is specified and the head uses the same provider as the lead, the head stays at the standard effort (usually medium); if the lead uses a lower effort, the head inherits it."
          on={on(settings.hydraTempersHeadEffort, true)}
          onFlip={(v) => toggle("hydraTempersHeadEffort", v)}
        />
      </div>

      <h4>{t("Messages")}</h4>
      <div className="hydra-sub">
        <ToggleRow
          title="Send queued follow-ups to heads"
          detail="Each one goes to a head as soon as there is room, instead of waiting for the lead."
          on={on(settings.hydraQueueHeads, true)}
          onFlip={(v) => toggle("hydraQueueHeads", v)}
          blockedBy={
            on(settings.hydraAlwaysHeads, false)
              ? "Heads are already preferred for messages."
              : undefined
          }
        />
        <ToggleRow
          title="Prefer heads for messages"
          detail="Use heads when there is room. Commands and messages that cannot be delegated stay with the lead."
          on={on(settings.hydraAlwaysHeads, false)}
          onFlip={(v) => toggle("hydraAlwaysHeads", v)}
        />
      </div>

      <h4>{t("When the team is done")}</h4>
      <div className="hydra-sub">
        <ToggleRow
          title="Ask the lead to review heads' changes"
          detail="Adds a review step before the lead finishes. This uses additional time and tokens. Not wired in this build yet."
          on={on(settings.hydraReviewHeads, false)}
          onFlip={(v) => toggle("hydraReviewHeads", v)}
        />
        <ToggleRow
          title="Automatically publish and merge team changes"
          detail="Commits and pushes the team's changes, opens a pull/merge request, and attempts to merge it. Requires a configured remote and access. Not wired in this build yet."
          on={on(settings.hydraAutoMerge, false)}
          onFlip={(v) => toggle("hydraAutoMerge", v)}
        />
      </div>

      <h4>
        {t("Codex head history")}
        <InfoHover help="About Codex head history" label="Codex head history">
          <HydraInfo topic="history" />
        </InfoHover>
      </h4>
      <div className="hydra-sub">
        <div className="kv">
          <span>{t("After completion")}</span>
          <span>
            <ChoiceRow
              aria="After completion"
              options={[["keep", "Keep visible"], ["archive", "Auto-archive"]]}
              value={on(settings.hydraArchivesCodexHeads, false) ? "archive" : "keep"}
              onPick={(v) => toggle("hydraArchivesCodexHeads", v === "archive")}
            />
          </span>
        </div>
        <p className="codex-note">
          {t("Automatically archive head sessions that finish successfully, and restore them when you need to continue. This only affects Codex's local history; it does not clean up existing records or delete sessions.")}
        </p>
      </div>
    </div>
  );
}
