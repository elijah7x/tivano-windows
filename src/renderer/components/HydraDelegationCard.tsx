// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F22: the lead's delegation block — the fenced ```hydra JSON — rendered
// as the card it stands for (frozen HydraDelegationBlock): the mark, a
// "Summoning/Summoned" title and one row per head with its glyph, task
// and target project. Never the JSON itself. Partial blocks read as they
// stream: a head appears the moment its brief's closing brace lands.

import type React from "react";
import { useMemo } from "react";
import {
  personaNamed,
  streamedDelegations,
} from "../../shared/hydraDelegation";
import { useT } from "../locale";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

export function HydraDelegationCard(props: {
  /** The fenced block's body (JSON text, possibly still streaming). */
  body: string;
  /** The block's opener was hydra-sent/-leaving — heads already went out. */
  sent: boolean;
}): React.JSX.Element {
  const t = useT();
  // The shared byte-accurate rescan expects the opener in the text —
  // supply it; the body arrives already unfenced by the markdown pass.
  const reading = useMemo(
    () => streamedDelegations("```hydra\n" + props.body),
    [props.body],
  );
  const delegations = reading?.delegations ?? [];
  const streaming = !(reading?.isComplete ?? false) && !props.sent;

  const title = (): string => {
    if (streaming || delegations.length === 0) return t("Summoning heads");
    if (delegations.length === 1) {
      const p = personaNamed(delegations[0]!.name ?? "");
      if (p)
        return props.sent
          ? t("Summoned %@", p.name)
          : t("Summoning %@", p.name);
      return props.sent ? t("Summoned a head") : t("Summoning a head");
    }
    return props.sent
      ? t("Summoned %d heads", String(delegations.length))
      : t("Summoning %d heads", String(delegations.length));
  };

  const projectName = (project?: string): string | null => {
    const p = project?.trim();
    if (!p) return null;
    const name = p.includes("/") ? (p.split("/").filter(Boolean).pop() ?? p) : p;
    return name || p;
  };

  return (
    <div className={`hydra-delegation${props.sent ? " sent" : ""}`}>
      <div className="hd-head">
        <span className="hd-mark" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className="hydra-dot hd-mark-dot" />
          ))}
        </span>
        <span className="hd-title">{title()}</span>
        {props.sent && (
          <span className="hd-sent" aria-label={t("Sent")}>✓</span>
        )}
      </div>
      {delegations.length > 0 && (
        <ul className="hd-list">
          {delegations.map((d, i) => {
            const p = personaNamed(d.name ?? "");
            const proj = projectName(d.project);
            return (
              <li key={i} className="hd-row">
                {p ? (
                  <span
                    className="hydra-dot"
                    style={{ background: hex(p.hex) }}
                    aria-label={p.name}
                  />
                ) : (
                  <span className="hd-mark" aria-hidden="true">
                    {[0, 1, 2].map((j) => (
                      <span key={j} className="hydra-dot hd-mark-dot" />
                    ))}
                  </span>
                )}
                <span className="hd-task">{d.task}</span>
                {proj && <span className="hd-proj">→ {proj}</span>}
              </li>
            );
          })}
          {streaming && (
            <li className="hd-row hd-next">
              <span className="hd-mark" aria-hidden="true" />
              <span className="hd-task">{t("Writing the next brief…")}</span>
            </li>
          )}
        </ul>
      )}
      {/* Frozen DotFieldSweep — one accent wave across the card as the
          block goes out; mounts once when `sent` lands. */}
      {props.sent && <span className="sweep-dots" aria-hidden="true" />}
    </div>
  );
}
