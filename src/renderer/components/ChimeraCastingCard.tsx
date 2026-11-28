// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-76 (frozen ChimeraCastingTab): attention card for adaptive sub-agent
// roles waiting on model assignment before starting.

import { useEffect, useMemo, useState } from "react";
import type { ChimeraPick } from "../../shared/chimera";
import type { ChimeraCasting, CodexModelCatalog, CodexModelOption } from "../../shared/types";
import { useT } from "../locale";
import { api, tryCall } from "../client";

export function ChimeraCastingCard(props: {
  threadId: string;
  casting: ChimeraCasting;
  mode: "mock" | "synthetic-stdio" | "codex";
  readOnly?: boolean | undefined;
}): React.JSX.Element {
  const t = useT();
  const { casting, threadId, readOnly } = props;
  const rowSignature = casting.rows.map((r) => r.id).join("\0");

  const [picks, setPicks] = useState<Record<string, ChimeraPick>>(() => {
    const initial: Record<string, ChimeraPick> = {};
    for (const row of casting.rows) initial[row.id] = row.prefill ? { ...row.prefill } : {};
    return initial;
  });
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [models, setModels] = useState<CodexModelOption[]>([]);

  useEffect(() => {
    const ids = new Set(casting.rows.map((r) => r.id));
    setPicks((prev) => {
      const next: Record<string, ChimeraPick> = {};
      for (const row of casting.rows) {
        next[row.id] = prev[row.id] ?? (row.prefill ? { ...row.prefill } : {});
      }
      return next;
    });
    setSkipped((prev) => new Set([...prev].filter((id) => ids.has(id))));
  }, [rowSignature]);

  useEffect(() => {
    if (props.mode !== "codex") {
      setModels([]);
      return;
    }
    let active = true;
    void api()
      .invoke("models:list", {})
      .then((res) => {
        if (!active) return;
        const cat = res as CodexModelCatalog;
        if (cat.state === "ready") setModels(cat.models);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [props.mode, rowSignature]);

  const sendCount = useMemo(
    () => casting.rows.filter((r) => !skipped.has(r.id)).length,
    [casting.rows, skipped],
  );

  const toggleRow = (id: string, include: boolean) => {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (include) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setModel = (id: string, model: string) => {
    const clean = model.trim();
    const opt = clean ? models.find((m) => m.id === clean) : undefined;
    setPicks((prev) => ({
      ...prev,
      [id]: clean
        ? {
            ...(prev[id]?.provider ? { provider: prev[id].provider } : {}),
            model: clean,
            ...(opt?.defaultEffort ? { effort: opt.defaultEffort } : {}),
          }
        : {},
    }));
  };

  const setEffort = (id: string, effort: string) => {
    const clean = effort.trim();
    setPicks((prev) => {
      const cur = prev[id] ?? {};
      const next: ChimeraPick = { ...cur };
      if (clean) next.effort = clean;
      else delete next.effort;
      return { ...prev, [id]: next };
    });
  };

  const sendNone = () => {
    if (readOnly) return;
    tryCall("hydra:confirm-casting", { threadId, picks: {} });
  };

  const sendSelected = () => {
    if (readOnly || sendCount === 0) return;
    const payload: Record<string, ChimeraPick | null> = {};
    for (const row of casting.rows) {
      if (skipped.has(row.id)) {
        payload[row.id] = null;
        continue;
      }
      const p = picks[row.id] ?? {};
      payload[row.id] = {
        ...(p.provider ? { provider: p.provider } : {}),
        ...(p.model ? { model: p.model } : {}),
        ...(p.effort ? { effort: p.effort } : {}),
      };
    }
    tryCall("hydra:confirm-casting", { threadId, picks: payload });
  };

  return (
    <section className="approval question casting" role="group" aria-label={t("Assign models")}>
      <div className="headline">
        {t("Assign models")}
        <span className="qcount">
          {" · "}
          {t("%d roles waiting for a model", String(casting.rows.length))}
        </span>
      </div>
      <p className="detail">{t("Pick a model for each role. Nothing starts until you send.")}</p>
      <div className="casting-rows">
        {casting.rows.map((row) => {
          const isSkipped = skipped.has(row.id);
          const pick = picks[row.id] ?? {};
          const selectedModel = pick.model ?? "";
          const modelOpt = selectedModel ? models.find((m) => m.id === selectedModel) : undefined;
          const extraModel =
            selectedModel && !modelOpt ? [{ id: selectedModel, name: selectedModel }] : [];
          return (
            <div key={row.id} className={`casting-row${isSkipped ? " skipped" : ""}`}>
              <div className="casting-meta">
                <div className="casting-role">{row.role}</div>
                <div className="casting-task" title={row.task}>
                  {row.task}
                </div>
              </div>
              <div className="casting-controls">
                <select
                  aria-label={row.role}
                  disabled={readOnly || isSkipped}
                  value={selectedModel}
                  onChange={(e) => setModel(row.id, e.target.value)}
                >
                  <option value="">{t("Follow the lead")}</option>
                  {extraModel.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                {modelOpt && modelOpt.efforts.length > 0 && (
                  <select
                    aria-label={`${row.role} effort`}
                    disabled={readOnly || isSkipped}
                    value={pick.effort ?? modelOpt.defaultEffort ?? ""}
                    onChange={(e) => setEffort(row.id, e.target.value)}
                  >
                    {modelOpt.efforts.map((eff) => (
                      <option key={eff} value={eff}>
                        {eff}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  type="checkbox"
                  checked={!isSkipped}
                  disabled={readOnly}
                  aria-label={t("Send %@", row.role)}
                  onChange={(e) => toggleRow(row.id, e.target.checked)}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="actions">
        <button type="button" disabled={readOnly} onClick={sendNone}>
          {t("Send none")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={readOnly || sendCount === 0}
          onClick={sendSelected}
        >
          {sendCount === 1 ? t("Send 1") : t("Send %d", String(sendCount))}
        </button>
      </div>
    </section>
  );
}
