// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Frozen HydraReportRow + HydraReportsPopover: a heads' report batch
// renders on the user's side as a pill — glyphs, "Hank and Walter are
// done" — that opens the digest popover: intro, then one card per head
// with its outcome, its landed files and its report. With several heads
// the reports start collapsed to their files; a single head reads whole.
// The lead's closing instructions never leave the last head's body.

import { useEffect, useMemo, useRef, useState } from "react";
import { personaAt } from "../../shared/hydraDelegation";
import { parseHydraReportDigest, type Head, type Landing } from "../../shared/hydraReportDigest";
import { useT } from "../locale";
import { renderMarkdown } from "../markdown";

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

function list(names: string[], t: (k: string, ...v: string[]) => string): string {
  if (names.length <= 1) return names[0] ?? "";
  return (
    names.slice(0, -1).join(t(", ")) + t(" and ") + (names[names.length - 1] ?? "")
  );
}

/** "Hank is done", "Hank and Walter are done" — a head whose section
 *  says otherwise is named with its outcome instead (frozen). */
function reportSummary(
  heads: Head[],
  t: (k: string, ...v: string[]) => string,
): string {
  const done = heads.filter((h) => h.outcome === "done").map((h) => h.name);
  const others = heads.filter((h) => h.outcome !== "done");
  const parts: string[] = [];
  if (done.length)
    parts.push(t(done.length === 1 ? "%@ is done" : "%@ are done", list(done, t)));
  for (const h of others)
    parts.push(t(h.outcome === "stopped" ? "%@ stopped" : "%@ failed", h.name));
  return parts.join(t(", "));
}

function landingView(landing: Landing, t: (k: string, ...v: string[]) => string) {
  if (landing.kind === "none") return null;
  if (landing.kind === "nothing")
    return <div className="hr-landing s-none">{t("Changed nothing.")}</div>;
  if (landing.kind === "unfinished")
    return (
      <div className="hr-landing s-unfinished">
        {t("Nothing landed")}
        {landing.copyPath ? (
          <>
            {" — "}
            <code>{landing.copyPath}</code>
          </>
        ) : null}
      </div>
    );
  const cls = landing.kind === "landed" ? "s-landed" : "s-failed";
  return (
    <div className={`hr-landing ${cls}`}>
      <div className="hr-landing-head">
        {landing.kind === "landed" ? t("Landed in your checkout") : t("Did not land")}
        {landing.kind === "notLanded" && landing.error ? ` (${landing.error})` : ""}
      </div>
      {landing.files.length > 0 && (
        <ul className="hr-files">
          {landing.files.map((f) => (
            <li key={f.path} className="hr-file">
              <code className="ckpt-path">{f.path}</code>
              <span className="tc-add">+{f.additions}</span>
              <span className="tc-del">−{f.deletions}</span>
              {f.hasConflicts && <span className="hr-conflict">{t("conflicts")}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HydraReportRow(props: {
  heads: number[];
  content: string;
}): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Fixed-position popover (frozen badgePopover): measured off the
  // pill's rect and clamped inside the window — an absolute child
  // would be clipped by the timeline's scroll box once it grows past
  // the top edge on card expansion.
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    maxH: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const digest = useMemo(() => parseHydraReportDigest(props.content), [props.content]);
  const personas = useMemo(() => props.heads.map((i) => personaAt(i)), [props.heads]);
  const single = digest.heads.length === 1 ? digest.heads[0]! : null;

  const toggleOpen = (): void => {
    setOpen((o) => {
      if (o) return false;
      const el = rootRef.current?.querySelector(".hydra-report-pill");
      const r = el?.getBoundingClientRect();
      if (r) {
        const W = 460;
        const left = Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8));
        const above = r.top - 8;
        const below = window.innerHeight - r.bottom - 8;
        const maxH = 560;
        // Up when there's room above; otherwise below — capped so card
        // expansion can never grow past the window edge.
        if (above >= Math.min(maxH, 200) || above >= below) {
          setPos({ bottom: window.innerHeight - r.top + 8, left, maxH: Math.min(maxH, above - 8) });
        } else {
          setPos({ top: r.bottom + 8, left, maxH: Math.min(maxH, below - 8) });
        }
      }
      return true;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const title = reportSummary(digest.heads, t);
  const collapsible = digest.heads.length > 1;
  const isExpanded = (h: Head) => !collapsible || expanded.has(h.name);
  const toggle = (name: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const headCard = (h: Head) => (
    <div className="hr-card" key={h.name}>
      <button
        type="button"
        className="hr-card-head"
        aria-expanded={collapsible ? isExpanded(h) : true}
        onClick={() => collapsible && toggle(h.name)}
      >
        <span className="hr-card-name">{h.name}</span>
        <span className={`hr-outcome s-${h.outcome}`}>
          {h.outcome === "done" ? t("done") : h.outcome === "failed" ? t("failed") : t("stopped")}
        </span>
        {h.effort && <span className="hr-effort">{h.effort}</span>}
        <span className="hr-card-task">{h.task}</span>
        {collapsible && <span className="hr-chev" aria-hidden="true" />}
      </button>
      {landingView(h.landing, t)}
      {isExpanded(h) && h.body && (
        <div className="hr-body">{renderMarkdown(h.body, { copy: t("Copy"), copied: t("Copied") })}</div>
      )}
    </div>
  );

  return (
    <div className="hydra-report" ref={rootRef}>
      <button
        type="button"
        className="hydra-report-pill"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <span className="hr-glyphs" aria-hidden="true">
          {personas.slice(0, 9).map((p, i) => (
            <span
              key={i}
              className="hydra-dot"
              style={{ background: hex(p.hex) }}
            />
          ))}
        </span>
        <span className="hr-title">{title}</span>
        <span className="hr-pill-chev" aria-hidden="true" />
      </button>
      {open && pos && (
        <div
          className="hydra-report-pop"
          role="dialog"
          aria-label={t("Heads' reports")}
          style={{
            left: pos.left,
            maxHeight: pos.maxH,
            ...(pos.top !== undefined ? { top: pos.top } : {}),
            ...(pos.bottom !== undefined ? { bottom: pos.bottom } : {}),
          }}
        >
          {!single && (
            <div className="hr-pop-head">
              <span className="hr-glyphs" aria-hidden="true">
                {personas.slice(0, 9).map((p, i) => (
                  <span key={i} className="hydra-dot" style={{ background: hex(p.hex) }} />
                ))}
              </span>
              <span className="hr-pop-names">{digest.heads.map((h) => h.name).join(", ")}</span>
            </div>
          )}
          {digest.intro && <p className="hr-intro">{digest.intro}</p>}
          <div className="hr-cards">{digest.heads.map(headCard)}</div>
        </div>
      )}
    </div>
  );
}
