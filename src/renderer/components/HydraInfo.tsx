// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-01.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// A83: frozen HydraInfoPopover — the static explainer the Hydra settings
// sections hang off an InfoHover mark: hydra / heads / Codex head history.

import type React from "react";
import { personaAt } from "../../shared/hydraDelegation";
import { useT } from "../locale";

export type HydraInfoTopic = "hydra" | "heads" | "history";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

function Dots(props: { count: number }): React.JSX.Element {
  return (
    <span className="hi-glyphs" aria-hidden="true">
      {Array.from({ length: props.count }, (_, i) => (
        <span
          key={i}
          className="hydra-dot"
          style={{ background: hex(personaAt(i).hex) }}
        />
      ))}
    </span>
  );
}

function Step(props: {
  glyph: React.ReactNode;
  ok?: boolean;
  title: string;
  line: string;
}): React.JSX.Element {
  return (
    <div className="hi-step">
      <span className={`hi-step-glyph${props.ok ? " ok" : ""}`} aria-hidden="true">
        {props.glyph}
      </span>
      <div>
        <div className="hi-step-title">{props.title}</div>
        <div className="hi-step-line">{props.line}</div>
      </div>
    </div>
  );
}

export function HydraInfo(props: {
  topic: HydraInfoTopic;
}): React.JSX.Element {
  const t = useT();
  const head: Record<HydraInfoTopic, [string, string]> = {
    hydra: [t("Hydra"), t("One chat leads a team of heads on big jobs.")],
    heads: [t("Heads"), t("The helpers a chat sends out, one brief each.")],
    history: [
      t("Codex head history"),
      t("Archive completed heads and keep the option to continue."),
    ],
  };
  const [title, sub] = head[props.topic];
  return (
    <div className="hydra-info">
      <div className="hi-head">
        <Dots count={5} />
        <div>
          <div className="hi-title">{title}</div>
          <div className="hi-sub">{sub}</div>
        </div>
      </div>
      {props.topic === "hydra" && (
        <>
          <Step
            glyph={<Dots count={1} />}
            title={t("You ask, the chat leads")}
            line={t(
              "Ask as you always do. Small things it does itself; anything bigger it splits into briefs.",
            )}
          />
          <Step
            glyph={<Dots count={2} />}
            title={t("Heads go out in parallel")}
            line={t(
              "Each head gets one brief and a panel of its own beside the chat, all working at the same time. Heads use the selected models to do their tasks, then return their reports to the lead chat.",
            )}
          />
          <Step
            glyph="✓"
            ok
            title={t("Reports come back, the lead finishes")}
            line={t(
              "The lead checks their work, fixes what needs fixing and answers you. Their changes land as one merge.",
            )}
          />
          <div className="hi-hint">
            {t(
              "Right-click the Hydra mark in a chat to switch it off or on for that chat.",
            )}
          </div>
        </>
      )}
      {props.topic === "heads" && (
        <>
          <Step
            glyph={<Dots count={1} />}
            title={t("One brief, one panel")}
            line={t(
              "A head gets a self-contained brief and its own panel beside the chat, on the model its pair names or the chat's own.",
            )}
          />
          <Step
            glyph="⧉"
            title={t("Its own copy of the checkout")}
            line={t(
              "With the switch on, each head works in a copy of the project so heads never trip over each other; its changes land in the chat's checkout when it reports.",
            )}
          />
          <Step
            glyph="↩"
            ok
            title={t("Reports back to the lead")}
            line={t(
              "A finished head hands its report to the lead, which checks the work and answers you. Completed heads collapse automatically; their reports stay in completion cards in the chat.",
            )}
          />
        </>
      )}
      {props.topic === "history" && (
        <>
          <Step
            glyph="✓"
            ok
            title={t("Only newly dispatched heads")}
            line={t(
              "Only newly dispatched Codex heads managed by Tivano can be archived after successful completion. Lead chats, older sessions, heads with user follow-ups or descendant sessions, and heads not confirmed idle stay visible.",
            )}
          />
          <Step
            glyph="↩"
            ok
            title={t("Continue when needed")}
            line={t(
              "Archived sessions keep their IDs and can be resumed. Archiving does not affect Tivano's sidebar or history on provider websites.",
            )}
          />
          <Step
            glyph="⬇"
            title={t("Codex only, no permanent deletion")}
            line={t(
              "Other providers do not currently offer this archive option. Permanent deletion is unavailable to avoid also deleting child sessions.",
            )}
          />
        </>
      )}
    </div>
  );
}
