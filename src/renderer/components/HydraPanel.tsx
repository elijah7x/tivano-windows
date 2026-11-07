// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F22: Hydra head strip — frozen HydraPanel parity, bounded. A lead
// thread lists its heads (roster colour, name, task, status); a head
// thread shows a banner with a way back to its lead. Heads never appear
// in the sidebar — this strip is their only surface. "Stop" routes
// through hydra:stop so the report honestly reads "stopped".

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { personaAt } from "../../shared/hydraDelegation";
import type { ChatThread } from "../../shared/types";
import { callApi } from "../client";
import { useT } from "../locale";
import { HydraStaveBar } from "./HydraStaveBar";
import { MiniSpinner } from "./SpinnerCells";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

function statusLabel(
  status: "running" | "completed" | "stopped" | "failed",
  t: (s: string) => string,
): string {
  switch (status) {
    case "running":
      return t("Working");
    case "completed":
      return t("Done");
    case "stopped":
      return t("Stopped");
    case "failed":
      return t("Failed");
  }
}

/** F22 isolation: where an isolated head's work went — one honest word. */
function landingLabel(
  info: NonNullable<ChatThread["hydraHead"]>,
  t: (s: string) => string,
): string | null {
  if (info.landingPending === true) return t("Landing…");
  const l = info.landing;
  if (l) {
    if (l.files.length === 0 && !l.patchPath && !l.error) return t("changed nothing");
    if (l.patchPath) return t("patch kept");
    if (l.error && !l.files.length) return t("landing failed");
    if (l.conflicts.length) return `${t("landed")} · ${t("conflicts")}: ${l.conflicts.length}`;
    if (l.files.length) return `${t("landed")} ${l.files.length === 1 ? t("1 file") : `${l.files.length} ${t("files")}`}`;
  }
  if (info.copyKept === true) return t("copy kept");
  if (info.baseTree !== undefined && info.status === "running") return t("own copy");
  return null;
}

export function HydraPanel(props: {
  thread: ChatThread;
  /** Every thread — heads are filtered out of the sidebar but live in
   *  the store; this strip is how they are reached. */
  threads: ChatThread[];
  readOnly?: boolean;
}): React.JSX.Element | null {
  const t = useT();
  const { thread } = props;
  const ownHead = thread.hydraHead;
  const heads = useMemo(
    () =>
      props.threads
        .filter((x) => x.hydraHead?.leadId === thread.id)
        .slice()
        .sort((a, b) => a.hydraHead!.spawnedAt - b.hydraHead!.spawnedAt),
    [props.threads, thread.id],
  );
  const lead = useMemo(
    () =>
      ownHead
        ? (props.threads.find((x) => x.id === ownHead.leadId) ?? null)
        : null,
    [props.threads, ownHead],
  );

  // Frozen DotFieldSweep: when a head leaves "running", one wave of its
  // persona colour flows through the panel once. The prev-status map
  // keeps a restored panel (heads already done at mount) from firing.
  const prevStatus = useRef(new Map<string, string>());
  const [sweep, setSweep] = useState<{ id: string; tint: string } | null>(null);
  useEffect(() => {
    const prev = prevStatus.current;
    const done = heads.find(
      (h) =>
        prev.get(h.id) === "running" && h.hydraHead!.status !== "running",
    );
    for (const h of heads) prev.set(h.id, h.hydraHead!.status);
    if (!done) return;
    const persona = personaAt(done.hydraHead!.headIndex);
    setSweep({ id: done.id, tint: hex(persona.hex) });
    const timer = setTimeout(() => setSweep(null), 1200);
    return () => clearTimeout(timer);
  }, [heads]);

  if (ownHead) {
    const persona = personaAt(ownHead.headIndex);
    return (
      <div className="hydra-strip" role="note">
        <span className="hydra-dot" style={{ background: hex(persona.hex) }} />
        <span className="hydra-strip-text">
          {t("A Hydra head working for the lead")} — {ownHead.name}
        </span>
        {lead && (
          <button
            className="hydra-back"
            onClick={() =>
              void callApi("threads:select", { id: lead.id }).catch(() => {})
            }
          >
            {t("Back to lead")}
          </button>
        )}
      </div>
    );
  }
  if (!heads.length) return null;

  return (
    <div className="hydra-panel" aria-label={t("Heads")}>
      <span className="hydra-title">
        {t("Heads")} · {heads.length}
      </span>
      <ul>
        {heads.map((h) => {
          const info = h.hydraHead!;
          const persona = personaAt(info.headIndex);
          const land = landingLabel(info, t);
          return (
            <li key={h.id} className={`hydra-row ${info.status}`}>
              <button
                className="hydra-open"
                title={info.task}
                onClick={() =>
                  void callApi("threads:select", { id: h.id }).catch(() => {})
                }
              >
                <span
                  className="hydra-dot"
                  style={{ background: hex(persona.hex) }}
                />
                <span className="hydra-name">{info.name}</span>
                <span className="hydra-task">{info.task}</span>
                {land && <span className="hydra-land">{land}</span>}
                <span className={`hydra-status ${info.status}`}>
                  {statusLabel(info.status, t)}
                  {info.status === "running" && <MiniSpinner />}
                </span>
              </button>
              <HydraStaveBar
                messages={h.messages}
                tint={hex(persona.hex)}
                status={info.status}
                height={14}
              />
              {info.status === "running" && (
                <button
                  className="hydra-stop"
                  title={t("Stop this head")}
                  aria-label={`${t("Stop")} ${info.name}`}
                  disabled={props.readOnly === true}
                  onClick={() =>
                    void callApi("hydra:stop", { threadId: h.id }).catch(() => {})
                  }
                >
                  {t("Stop")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {sweep && (
        <span
          className="sweep-dots"
          style={{ "--sweep-tint": sweep.tint } as React.CSSProperties}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
