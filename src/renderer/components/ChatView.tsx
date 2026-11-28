// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-28.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Chat area: header with the labelled mock badge, message timeline with
// streaming/approval/error/interruption states, and the composer.

import { createElement, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AppInfo, ChatThread, CheckpointRecordView, CodexInfo, Message, Project, Settings, Turn } from "../../shared/types";
import { INTERRUPTED_MARKER } from "../../shared/types";
import { AttachChip } from "./AttachChip";
import { ToolMsgRow, WorkingIndicator } from "./WorkingIndicator";
import { useT } from "../locale";
import { translateError, translateNotice } from "../i18n";
import {
  prewarmMarkdown,
  renderMarkdown,
  StreamingMarkdownCoordinator,
  type MarkdownLabels,
} from "../markdown";
import { appActivity, subscribeMemoryPressure, useAppPaused, useInView } from "../appActivity";
import { visibleThreads } from "../../shared/threadOrder";
import { api, callApi, clientStore } from "../client";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { CheckpointPreviewDialog } from "./CheckpointPreviewDialog";
import { WorktreeDialog } from "./WorktreeDialog";
import { BranchMenu } from "./BranchMenu";
import { HydraMark } from "./HydraMark";
import { HydraPanel } from "./HydraPanel";
import { HelperPanel } from "./HelperPanel";
import { OpenInItems } from "./OpenInMenu";
import { ScriptsDialog } from "./ScriptsDialog";
import { Composer } from "./Composer";
import { TimelineMinimap } from "./TimelineMinimap";
import { ThreadChangesTab } from "./ThreadChangesTab";
import { HydraBriefPill } from "./HydraBriefPill";
import { HydraStaveBar } from "./HydraStaveBar";
import { MiniSpinner, WorkingSpinner } from "./SpinnerCells";
import { HydraDelegationCard } from "./HydraDelegationCard";
import { HydraReportRow } from "./HydraReportRow";
import { watchSelectionResidue } from "../selectionRepaint";
import { MessagePopover } from "./MessagePopover";
import { NewThreadPrompt } from "./NewThreadPrompt";
import { NoThreadView, WelcomeView } from "./WelcomeView";
import type { SettingsPageId } from "./SettingsModal";
import type { MessagePopoverState } from "./MessagePopover";
import { peelQuotes, quoteExcerpt } from "../../shared/replyQuote";
import { hydraPanelLayout } from "../../shared/hydra";
import { helperPopLayout } from "../../shared/helperPopLayout";
import {
  groupMessages,
  partitionGroup,
  formatDuration,
  type TimelineItem,
  type TurnGroup,
} from "../messageGroups";
import {
  TIMELINE_WINDOW,
  timelineFollowReset,
  timelineGrownOpen,
  timelineJumpWindow,
  timelinePagedBack,
  timelineSlice,
} from "../../shared/timelineWindow";

/** F04 content ops: per-message copy of the raw markdown source. */
/** F20: the row a limit-waiting thread shows — honest countdown target,
 *  cancel, and hand-off to a new chat (frozen AutoContinue controls). */
function LimitWaitRow({ threadId, resumeAt }: { threadId: string; resumeAt: number }): React.JSX.Element {
  const t = useT();
  const rowRef = useRef<HTMLDivElement>(null);
  const appPaused = useAppPaused();
  const inView = useInView(rowRef);
  const paused = appPaused || !inView;
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (paused) return;
    forceTick((x) => x + 1);
    const id = window.setInterval(() => forceTick((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, [paused]);
  const seconds = Math.max(0, Math.round((resumeAt - Date.now()) / 1000));
  const when = new Date(resumeAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div ref={rowRef} className="limit-wait" role="status">
      <span className="limit-wait-text">
        {t("Usage limit reached — continuing at")} {translateNotice(t, when)}
        {seconds > 0 ? ` (${seconds}s)` : ""}
      </span>
      <button
        type="button"
        onClick={() => {
          void callApi("limit:cancel", { threadId }).catch(() => {});
        }}
      >
        {t("Cancel wait")}
      </button>
      <button
        type="button"
        onClick={() => {
          void callApi("limit:handoff", { threadId })
            .then((r) => {
              const made = r as { threadId: string; text: string };
              clientStore.setDraft(made.threadId, made.text);
              return callApi("threads:select", { id: made.threadId });
            })
            .catch(() => {});
        }}
      >
        {t("Hand off to a new chat")}
      </button>
    </div>
  );
}

function MsgCopyButton({ text }: { text: string }): React.JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`msg-copy${copied ? " done" : ""}`}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? t("Copied") : t("Copy")}
    </button>
  );
}

function statusLabel(t: (k: string) => string, m: Message): string | null {
  switch (m.status) {
    case "interrupted":
      return t("Interrupted");
    case "cancelled":
      return t("Turn cancelled");
    case "denied":
      return t("Turn denied");
    case "error":
      return t("Turn failed");
    default:
      return null;
  }
}

/** F22: the delegation card rendered in place of a fenced hydra block
 *  (frozen HydraDelegationBlock) — injected so markdown stays pure. */
const delegationCard = (body: string, sent: boolean): React.ReactNode =>
  createElement(HydraDelegationCard, { body, sent });

/** P2-40 "One per sub-agent": automatic panels for running heads after
 *  the first. The layer measures the chat pane and keeps the pure layout
 *  outside the header and composer; panels themselves stay pointer-active
 *  while the layer lets the timeline behind it receive the other events. */
function AutoPopPanels(props: {
  heads: ChatThread[];
  parentTitle: string;
  readOnly: boolean;
  settings?: Settings | undefined;
  popHeld: ReadonlySet<string>;
  onHold: (id: string) => void;
}): React.JSX.Element | null {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [metrics, setMetrics] = useState({
    width: 0,
    height: 0,
    chromeTop: 0,
    composerBottom: 0,
  });

  useEffect(() => {
    const chat = layerRef.current?.parentElement;
    if (!chat) return;
    const read = () => {
      const header = chat.querySelector<HTMLElement>(":scope > .chat-head");
      const team = chat.querySelector<HTMLElement>(":scope > .hydra-panel:not(.floating)");
      const composer = chat.querySelector<HTMLElement>(":scope > .composer");
      const next = {
        width: chat.clientWidth,
        height: chat.clientHeight,
        chromeTop: (header?.offsetHeight ?? 0) + (team?.offsetHeight ?? 0),
        composerBottom: composer?.offsetHeight ?? 0,
      };
      setMetrics((prev) =>
        prev.width === next.width &&
        prev.height === next.height &&
        prev.chromeTop === next.chromeTop &&
        prev.composerBottom === next.composerBottom
          ? prev
          : next,
      );
    };
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
    const observe = () => {
      ro?.disconnect();
      ro?.observe(chat);
      const header = chat.querySelector<HTMLElement>(":scope > .chat-head");
      const team = chat.querySelector<HTMLElement>(":scope > .hydra-panel:not(.floating)");
      const composer = chat.querySelector<HTMLElement>(":scope > .composer");
      if (header) ro?.observe(header);
      if (team) ro?.observe(team);
      if (composer) ro?.observe(composer);
      read();
    };
    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => observe());
    observe();
    mo?.observe(chat, { childList: true });
    window.addEventListener("resize", read);
    return () => {
      mo?.disconnect();
      ro?.disconnect();
      window.removeEventListener("resize", read);
    };
  }, []);

  const runningHeads = useMemo(
    () =>
      props.heads.filter(
        (h) => h.hydraHead?.status === "running" && !h.isArchived,
      ),
    [props.heads],
  );
  const layout = useMemo(
    () =>
      helperPopLayout({
        paneWidth: metrics.width,
        paneHeight: metrics.height,
        chromeTop: metrics.chromeTop,
        composerBottom: metrics.composerBottom,
        runningHeads: runningHeads.length,
        preferredSize: props.settings?.helperPanelSize,
      }),
    [metrics, runningHeads.length, props.settings?.helperPanelSize],
  );
  return (
    <div
      ref={layerRef}
      className="helper-pop-layer"
      style={metrics.width > 0 ? undefined : { visibility: "hidden" }}
    >
      {runningHeads.slice(1).map((h, i) => {
        if (props.popHeld.has(h.id)) return null;
        const placement = layout.placements[i];
        return (
          <HelperPanel
            key={h.id}
            thread={h}
            parentTitle={props.parentTitle}
            readOnly={props.readOnly}
            settings={props.settings}
            size={props.settings?.helperPanelSize}
            initialCorner={placement?.corner ?? "tr"}
            cascadeIndex={placement?.cascadeIndex ?? i}
            placement={metrics.width > 0 ? placement : undefined}
            chromeTop={metrics.chromeTop}
            composerBottom={metrics.composerBottom}
            overlay
            onDock={() => {}}
            onClose={() => props.onHold(h.id)}
          />
        );
      })}
    </div>
  );
}

export type HydraPanelEvent =
  | "toggle"
  | "pill"
  | "dismiss"
  | "auto-open"
  | "disable-auto-open"
  | "thread-change";

export interface HydraPanelState {
  hidden: boolean;
  focusSeq: number;
}

/**
 * Computes the next sub-agent panel visibility and toggle-focus sequence.
 * Any hide, dismiss, auto-open, or thread-switch clears `focusSeq` to 0 so
 * remounting on a subsequent head spawn never replays a stale toggle focus
 * and steals focus from the composer.
 */
export function nextHydraPanelState(
  prev: HydraPanelState,
  event: HydraPanelEvent,
  autoOpensPanels: boolean,
): HydraPanelState {
  switch (event) {
    case "toggle": {
      const hidden = !prev.hidden;
      return { hidden, focusSeq: hidden ? 0 : prev.focusSeq + 1 };
    }
    case "pill":
      return { hidden: false, focusSeq: prev.focusSeq + 1 };
    case "dismiss":
    case "disable-auto-open":
      return { hidden: true, focusSeq: 0 };
    case "auto-open":
      return { hidden: false, focusSeq: 0 };
    case "thread-change":
      return { hidden: !autoOpensPanels, focusSeq: 0 };
  }
}

export function ChatView(props: {
  thread: ChatThread | null;
  /** F22: every thread — the Hydra panel resolves a lead's heads and a
   *  head's lead from it (heads never enter the sidebar). */
  threads?: ChatThread[];
  /** The thread's project — presence enables project-scoped actions
   *  (F12 scripts). */
  project?: Project | null;
  /** Every project — the new-thread prompt lists them for the
   *  affiliation switch (frozen NewThreadPrompt). */
  projects?: Project[];
  providerLabel: string;
  mode: "mock" | "synthetic-stdio" | "codex";
  codex?: CodexInfo;
  info?: Pick<AppInfo, "mode" | "providerId" | "providerLabel" | "codex"> | undefined;
  settingsOpen?: boolean | undefined;
  readOnly?: boolean;
  /** F15: the thread's working directory when provably available. */
  directory?: string | null;
  /** Which dock panel is open — terminal and Git share one slot. */
  dock?: "terminal" | "git" | null;
  onToggleDock?: (name: "terminal" | "git") => void;
  /** P2-53: toggled by Cmd/Ctrl+D or Command Palette to open the top-bar changes popover. */
  changesToggleSeq?: number;
  /** P2-53: collapsed tray sidebar can be reopened from the top bar. */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  /** F20: scheduled auto-resume for a usage-limit wait, epoch ms. */
  limitResumeAt?: number;
  /** F01: snapshot settings — showReasoning gates the thinking blocks,
   *  showsWorkingCard picks the live working indicator's card/line
   *  form (frozen Conversation defaults). */
  settings?: Settings;
  /** P2-51: whether the chat header's More controls (…) are expanded; owned
   *  by the shell so switching chats keeps the expanded state. */
  topControlsExpanded?: boolean;
  onSetTopControlsExpanded?: (
    next: boolean | ((prev: boolean) => boolean),
  ) => void;
  /** Hydra intro's "Set up in Settings" & WelcomeView's Manage — the modal lives on the shell. */
  onOpenSettings?: ((page?: SettingsPageId) => void) | undefined;
}): React.JSX.Element {
  const t = useT();
  const endRef = useRef<HTMLDivElement>(null);
  // F03: scroll container for the conversation-outline rail.
  const timelineRef = useRef<HTMLDivElement>(null);
  const { thread } = props;

  // Per-turn checkpoint records — fetched by ledger identity, refetched
  // on "checkpoints-changed". A generation guard keeps late responses
  // from overwriting another thread's selection.
  const [ckpts, setCkpts] = useState<CheckpointRecordView[]>([]);
  const [previewTurn, setPreviewTurn] = useState<string | null>(null);
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [localMoreOpen, setLocalMoreOpen] = useState(false);
  const moreOpen = props.topControlsExpanded ?? localMoreOpen;
  const setMoreOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    if (props.onSetTopControlsExpanded) props.onSetTopControlsExpanded(next);
    else setLocalMoreOpen(next);
  };
  const moreRef = useRef<HTMLDivElement>(null);
  const [msgMenu, setMsgMenu] = useState<MessagePopoverState | null>(null);
  const ckptGen = useRef(0);
  const threadId = thread?.id ?? null;
  // P1-26 (frozen TimelineWindow): the rendered tail — opens on firstPaint,
  // grows to initial a beat later, pages back while the reader scrolls up,
  // and collapses to initial when the live tail outgrows eagerLimit.
  const [timelineVisible, setTimelineVisible] = useState<number>(
    TIMELINE_WINDOW.firstPaint,
  );
  // A thread switch resets the window during render so the old thread's
  // tail never over-mounts on the new one.
  const [windowThreadId, setWindowThreadId] = useState(threadId);
  if (windowThreadId !== threadId) {
    setWindowThreadId(threadId);
    setTimelineVisible(TIMELINE_WINDOW.firstPaint);
  }
  const timelineAnchorRef = useRef<number | null>(null);
  const timelineJumpRef = useRef<string | null>(null);
  const timelineLastPageRef = useRef(0);
  const timelineVisibleRef = useRef(timelineVisible);
  const timelineItems = useMemo(
    () => (thread ? groupMessages(thread.messages) : []),
    [thread?.messages, thread],
  );
  const { shown: windowedItems, hidden: windowedHidden } = useMemo(
    () => timelineSlice(timelineItems, timelineVisible),
    [timelineItems, timelineVisible],
  );
  useEffect(() => {
    setCkpts([]);
    setPreviewTurn(null);
    if (!threadId) return;
    const g = ++ckptGen.current;
    const refetch = () => {
      const mine = g;
      callApi("checkpoints:list", { threadId })
        .then((r) => {
          if (mine === ckptGen.current && Array.isArray(r))
            setCkpts(r as CheckpointRecordView[]);
        })
        .catch(() => {});
    };
    refetch();
    return api().onEvent((e) => {
      if (e.type === "checkpoints-changed" && e.threadId === threadId) refetch();
    });
  }, [threadId]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      // The open grow prepends too — hold the bottom spot through the
      // same measured shift as a scroll-back page rather than trusting
      // Chromium's scroll anchoring. A no-op grow (the reader already
      // paged past initial) must not leave a stale anchor that the next
      // window change would apply.
      const el = timelineRef.current;
      if (el && timelineVisibleRef.current < TIMELINE_WINDOW.initial)
        timelineAnchorRef.current = el.scrollHeight - el.scrollTop;
      setTimelineVisible((v) => timelineGrownOpen(v));
    }, 40);
    return () => window.clearTimeout(t);
  }, [threadId]);

  // P2-34: clearing a selection inside the timeline forces one full
  // repaint — fractional line boxes strand a thin line under the first
  // selected line otherwise (frozen LinkParagraphView needsDisplay on
  // had→cleared).
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    return watchSelectionResidue(el);
    // The timeline element only exists while a thread is open — the
    // watcher must rebind when it mounts again (archived/deleted thread,
    // first launch with no selection).
  }, [thread != null]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
    // Following the live tail past the eager limit collapses the window
    // (frozen): a reader who paged back keeps what they loaded only while
    // nothing new pins them to the end.
    setTimelineVisible((v) => timelineFollowReset(v, true));
  }, [thread?.messages.length, thread?.turn?.seq, thread?.turn?.status]);

  // A page landing prepends rows: hold the reader's spot by measuring the
  // document growth and shifting scrollTop by the same amount (frozen
  // HistoryAnchorMath's synchronous shift — pre-paint, so the prepend
  // never flickers). A minimap jump waiting on a mount scrolls the same
  // step — the target exists by then.
  useLayoutEffect(() => {
    timelineVisibleRef.current = timelineVisible;
    const el = timelineRef.current;
    const anchor = timelineAnchorRef.current;
    if (el && anchor !== null) {
      timelineAnchorRef.current = null;
      el.scrollTop = el.scrollHeight - anchor;
    }
    const jumpId = timelineJumpRef.current;
    if (el && jumpId !== null) {
      timelineJumpRef.current = null;
      el
        .querySelector<HTMLElement>(`[data-mid="${jumpId}"]`)
        ?.scrollIntoView({ block: "start" });
    }
  }, [timelineVisible]);

  // F22: the lead's resolved heads for the mark and the panel (frozen
  // HydraButton.panelHeads). Runtime-only panel visibility — a new head
  // auto-shows it (frozen AppModel+Hydra spawn parity).
  const heads = useMemo(
    () =>
      (props.threads ?? [])
        .filter((x) => x.hydraHead?.leadId === threadId && !x.isArchived)
        .slice()
        .sort((a, b) => a.hydraHead!.spawnedAt - b.hydraHead!.spawnedAt),
    [props.threads, threadId],
  );
  // Frozen ThreadRuntime init: isHydraPanelHidden = !hydraAutoOpensPanels
  // — under Off a fresh thread starts with the panel hidden (the working
  // pill shows instead); Single/Independent open it.
  const [panelState, setPanelState] = useState<HydraPanelState>(() => ({
    hidden: props.settings?.hydraAutoOpensPanels === false,
    focusSeq: 0,
  }));
  const hydraPanelHidden = panelState.hidden;
  const panelFocusSeq = panelState.focusSeq;
  const hydraMarkBtnRef = useRef<HTMLButtonElement>(null);
  const headCount = useRef(0);
  // Frozen HelpersWorkingRow.hidden: this chat's children at work that
  // no visible panel shows — heads while THEIR panel is hidden (Off, or
  // dismissed mid-run under Single/Independent), plain helpers while
  // isInPanel is false (Off, or closed while working). Newest first.
  const hiddenWorking = useMemo(
    () =>
      (props.threads ?? [])
        .filter(
          (x) => x.parentThreadId === threadId || x.hydraHead?.leadId === threadId,
        )
        .filter((h) => {
          if (h.isArchived) return false;
          const running =
            h.hydraHead?.status === "running" ||
            (h.turn !== null &&
              ["running", "waiting-approval", "stopping"].includes(h.turn.status));
          if (!running) return false;
          return h.hydraHead ? hydraPanelHidden : h.isInPanel !== true;
        })
        .sort((a, b) => b.createdAt - a.createdAt),
    [props.threads, threadId, hydraPanelHidden],
  );
  // Frozen agentControls: under Off a plain helper working outside its
  // panel also gets a small top-bar capsule that re-opens the panel.
  const offTopHelper =
    hydraPanelLayout(props.settings ?? {}) === "off"
      ? hiddenWorking.find((h) => !h.hydraHead)
      : undefined;
  // A84 (frozen StreamVeil): per-message veil bookkeeping — how much text
  // the latest flush added and the EMA of flush gaps that paces the fade.
  const veilRef = useRef(
    new Map<
      string,
      {
        len: number;
        ema: number | null;
        at: number;
        veil: { chars: number; ms: number } | null;
        veilUntil: number;
      }
    >(),
  );
  // P1-29/P1-31-follow-up (frozen StreamingParseCoordinator): per-message
  // incremental parse — stable leading blocks are reused element-for-
  // element and just the tail re-renders per chunk; a tail past the sync
  // bound parses deferred and paints the last landed result meanwhile,
  // so a giant open block never stalls a render.
  const mdCoordRef = useRef(new Map<string, StreamingMarkdownCoordinator>());
  const [, mdBump] = useReducer((x: number) => x + 1, 0);
  const mdCoordFor = (id: string): StreamingMarkdownCoordinator => {
    let c = mdCoordRef.current.get(id);
    if (!c) {
      c = new StreamingMarkdownCoordinator(() => mdBump());
      mdCoordRef.current.set(id, c);
    }
    return c;
  };
  useEffect(() => {
    setPanelState((s) =>
      nextHydraPanelState(
        s,
        "thread-change",
        props.settings?.hydraAutoOpensPanels !== false,
      ),
    );
    // Seed with THIS thread's count — resetting to 0 would count the
    // existing heads as "new" and reopen a panel the user dismissed
    // when switching between same-count threads (frozen parity: only
    // a genuinely new head opens the panel).
    headCount.current = heads.length;
    setPopHeld(new Set());
    veilRef.current.clear();
    mdCoordRef.current.forEach((c) => c.dispose());
    mdCoordRef.current.clear();
  }, [threadId]);
  // Frozen AppModel: turning the layout Off hides any open panel —
  // turning it On only allows future auto-opens, nothing re-opens on
  // the flip itself.
  useEffect(() => {
    if (props.settings?.hydraAutoOpensPanels === false) {
      setPanelState((s) => nextHydraPanelState(s, "disable-auto-open", false));
    }
  }, [props.settings?.hydraAutoOpensPanels]);
  useEffect(() => {
    if (!moreOpen) return;
    const down = (e: MouseEvent): void => {
      const target = e.target as Element | null;
      if (target && (moreRef.current?.contains(target) || target.closest(".sidebar"))) {
        return;
      }
      setMoreOpen(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [moreOpen]);
  useEffect(() => {
    return subscribeMemoryPressure(() => {
      veilRef.current.clear();
      mdCoordRef.current.forEach((c) => c.dispose());
      mdCoordRef.current.clear();
    });
  }, []);
  const threadsRef = useRef(props.threads);
  const projectsRef = useRef(props.projects);
  threadsRef.current = props.threads;
  projectsRef.current = props.projects;
  const prewarmedRef = useRef<string>("");
  useEffect(() => {
    const threads = threadsRef.current;
    const projects = projectsRef.current;
    if (!threadId || !threads || !projects) return;
    const timer = window.setTimeout(() => {
      if (appActivity.paused) return;
      const curThreads = threadsRef.current;
      const curProjects = projectsRef.current;
      if (!curThreads || !curProjects) return;
      const order = visibleThreads(
        curProjects.filter((p) => !p.isShelved),
        curThreads.filter((x) => !x.isInPanel || !x.parentThreadId),
      );
      const idx = order.findIndex((x) => x.id === threadId);
      if (idx < 0) return;
      const neighbor = order[idx + 1] ?? order[idx - 1];
      if (!neighbor || neighbor.messages.length === 0) return;
      const key = `${threadId}|${neighbor.id}|${neighbor.updatedAt}`;
      if (prewarmedRef.current === key) return;
      prewarmedRef.current = key;
      const labels: MarkdownLabels = {
        copy: t("Copy"),
        copied: t("Copied"),
        renderDelegation: delegationCard,
      };
      const sources = neighbor.messages
        .slice(-TIMELINE_WINDOW.initial)
        .filter((m) => m.role === "assistant" && m.status !== "streaming")
        .map((m) =>
          m.content.replaceAll(
            `*${INTERRUPTED_MARKER}*`,
            `*[${t("interrupted by restart — not resumed")}]*`,
          ),
        );
      prewarmMarkdown(sources, labels);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [threadId, props.threads?.length, props.projects?.length, t]);
  // P2-40: panels open on their own only under the Single/Independent
  // layouts (frozen hydraAutoOpensPanels); Off shows the working pill.
  // Only a new head count may auto-open — the layout flip alone never
  // re-opens a dismissed panel (frozen ThreadRuntime parity).
  useEffect(() => {
    if (heads.length > headCount.current && props.settings?.hydraAutoOpensPanels !== false) {
      setPanelState((s) => nextHydraPanelState(s, "auto-open", true));
    }
    headCount.current = heads.length;
  }, [heads.length]);

  // P2-40 "One per sub-agent" (frozen hydraAutoPopsHeads +
  // hydraAutoPopHeld): under Independent with the panels allowed to
  // open, every head after the first pops its own floating panel.
  // Dismissing one holds it closed until the team panel is dismissed;
  // the head stays reachable in the team panel.
  const [popHeld, setPopHeld] = useState<ReadonlySet<string>>(new Set());
  const popsOn = hydraPanelLayout(props.settings ?? {}) === "independent";

  if (!thread) {
    const isFirstLaunch =
      (props.projects?.length ?? 0) === 0 && (props.threads?.length ?? 0) === 0;
    const welcomeInfo = props.info ?? {
      mode: props.mode,
      providerId: props.mode,
      providerLabel: props.providerLabel,
      ...(props.codex ? { codex: props.codex } : {}),
    };
    return (
      <main className="chat">
        {props.sidebarCollapsed && props.onToggleSidebar && (
          <header className="chat-head chat-head-empty">
            <button
              type="button"
              className="head-action sidebar-reopen"
              title={t("Toggle sidebar")}
              aria-label={t("Toggle sidebar")}
              onClick={props.onToggleSidebar}
            >
              ☰
            </button>
          </header>
        )}
        {isFirstLaunch ? (
          <WelcomeView
            info={welcomeInfo}
            readOnly={props.readOnly === true}
            settingsOpen={props.settingsOpen}
            onOpenSettings={props.onOpenSettings}
          />
        ) : (
          <NoThreadView
            readOnly={props.readOnly === true}
            settings={props.settings}
          />
        )}
      </main>
    );
  }

  const turn = thread.turn;
  const waiting = turn?.status === "waiting-approval";
  // P1-35: frozen continuableTurnID — the Continue affordance shows on a
  // failed or stopped last turn of an ordinary thread. Heads continue
  // from the Hydra panel; codex without a provider binding has no
  // session to resume; the engine re-checks the gate on turns:continue.
  const continuable =
    thread.isArchived !== true &&
    !thread.hydraHead &&
    !!turn &&
    (turn.status === "error" ||
      turn.status === "cancelled" ||
      turn.status === "denied" ||
      turn.status === "interrupted") &&
    (props.mode !== "codex" || thread.providerThread !== undefined);
  const hadInterrupted = thread.messages.some((m) => m.status === "interrupted");
  const syntheticStdio = props.mode === "synthetic-stdio";
  const codex = props.mode === "codex" ? props.codex : undefined;
  const badgeText = syntheticStdio
    ? t("Synthetic stdio")
    : codex
      ? codex.state === "fixture"
        ? t("Codex fixture")
        : t("Codex")
      : t("Mock Provider");
  const badgeTitle = syntheticStdio
    ? t("Controlled local child process — no real model, tools or network")
    : codex
      ? codex.state === "fixture"
        ? t("Offline Codex protocol fixture — deterministic, no real CLI or model")
        : codex.state === "unconfigured"
          ? t("Codex app-server is not configured")
          : t("Codex app-server — real launch not yet verified")
      : t("Synthetic provider — no real model, tools or commands");

  const hasDirectory = props.directory !== undefined && props.directory !== null;

  return (
    <main className="chat">
      <header className="chat-head">
        {props.sidebarCollapsed && props.onToggleSidebar && (
          <button
            type="button"
            className="head-action sidebar-reopen"
            title={t("Toggle sidebar")}
            aria-label={t("Toggle sidebar")}
            onClick={props.onToggleSidebar}
          >
            ☰
          </button>
        )}
        <h1>{thread.title}</h1>
        <span className="badge mock" title={badgeTitle}>
          {badgeText}
        </span>
        {turn && (turn.status === "running" || waiting) && (
          <span className="badge">
            {waiting ? t("Waiting for approval") : `${t("Working")}`}
            {!waiting && <span className="dots" aria-hidden="true" />}
          </span>
        )}
        <div className="chat-top-controls">
          <HydraMark
            thread={thread}
            heads={heads}
            settings={props.settings}
            buttonRef={hydraMarkBtnRef}
            readOnly={props.readOnly === true}
            panelHidden={hydraPanelHidden}
            onTogglePanel={() =>
              setPanelState((s) =>
                nextHydraPanelState(
                  s,
                  "toggle",
                  props.settings?.hydraAutoOpensPanels !== false,
                ),
              )
            }
            {...(props.onOpenSettings ? { onOpenSettings: props.onOpenSettings } : {})}
          />
          {offTopHelper && (
            <div className="chrome-capsule">
              <button
                type="button"
                className="helper-working-btn"
                title={t("Show the sub-agent panel")}
                aria-label={t("Show the sub-agent panel")}
                aria-valuetext={t("Sub-agent working")}
                disabled={props.readOnly === true}
                onClick={() =>
                  void callApi("threads:show-helper", { id: offTopHelper.id }).catch(() => {})
                }
              >
                <span className="helper-working-glyph" aria-hidden="true">
                  <span />
                  <span />
                </span>
                <MiniSpinner />
              </button>
            </div>
          )}
          {hasDirectory && (
            <BranchMenu
              threadId={thread.id}
              worktree={thread.worktreeDir !== undefined}
              running={turn?.status === "running" || turn?.status === "waiting-approval"}
              readOnly={props.readOnly === true}
            />
          )}
          {props.onToggleDock && (
            <div className="chrome-capsule">
              <button
                className={`term-toggle ${props.dock === "terminal" ? "on" : ""}`}
                onClick={() => props.onToggleDock!("terminal")}
                aria-pressed={props.dock === "terminal"}
                title={t("Terminal")}
              >
                {t("Terminal")}
              </button>
              <button
                className={`term-toggle ${props.dock === "git" ? "on" : ""}`}
                onClick={() => props.onToggleDock!("git")}
                aria-pressed={props.dock === "git"}
                title={t("Git")}
              >
                {t("Git")}
              </button>
            </div>
          )}
          <ThreadChangesTab
            threadId={thread.id}
            toggleSeq={props.changesToggleSeq}
            git={
              hasDirectory && thread.projectId
                ? {
                    projectId: thread.projectId,
                    worktree: thread.worktreeDir !== undefined,
                    running: turn?.status === "running" || turn?.status === "waiting-approval",
                    readOnly: props.readOnly === true,
                  }
                : undefined
            }
          />
          <div className="openin more-controls" ref={moreRef}>
            <button
              type="button"
              className={`head-action more-controls-btn${moreOpen ? " active" : ""}`}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-label={t("More controls")}
              title={t("More controls")}
              disabled={props.readOnly === true}
              onClick={() => setMoreOpen((o) => !o)}
            >
              ⋯
            </button>
            {moreOpen && (
              <div className="openin-menu more-controls-menu" role="menu" aria-label={t("More controls")}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    void callApi("threads:forward", { threadId: thread.id }).catch(() => {});
                  }}
                >
                  {t("Forward to new thread")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    setWorktreeOpen(true);
                  }}
                >
                  {thread.worktreeDir ? `⎇ ${t("Thread worktree")}` : t("Thread worktree")}
                </button>
                {props.project && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      setScriptsOpen(true);
                    }}
                  >
                    ▶ {t("Scripts")}
                  </button>
                )}
                <div className="openin-divider" aria-hidden="true" />
                <OpenInItems
                  threadId={thread.id}
                  hasDirectory={hasDirectory}
                  open={moreOpen}
                  onClose={() => setMoreOpen(false)}
                  itemProps={{ "data-openin-item": "true" }}
                />
              </div>
            )}
          </div>
        </div>
      </header>
      {thread && props.threads && (!hydraPanelHidden || !!thread.hydraHead) && (
        <HydraPanel
          thread={thread}
          threads={props.threads}
          readOnly={props.readOnly === true}
          focusSeq={panelFocusSeq}
          onDismiss={() => {
            // Frozen dismissHydraHeads: dismissing the team panel releases
            // every automatic-pop hold, so the held heads pop again when
            // the team panel returns.
            setPopHeld(new Set());
            setPanelState((s) =>
              nextHydraPanelState(
                s,
                "dismiss",
                props.settings?.hydraAutoOpensPanels !== false,
              ),
            );
            requestAnimationFrame(() =>
              hydraMarkBtnRef.current?.focus({ preventScroll: true }),
            );
          }}
        />
      )}
      {thread && !thread.hydraHead && popsOn && !hydraPanelHidden && (
        <AutoPopPanels
          heads={heads}
          parentTitle={thread.title}
          readOnly={!!props.readOnly}
          settings={props.settings}
          popHeld={popHeld}
          onHold={(id) => setPopHeld((s) => new Set(s).add(id))}
        />
      )}
      {props.readOnly && (
        <div className="banner error" role="alert">
          {t(
            "Closing failed earlier — the app is read-only and no new turns can start. Retry closing from the system menu.",
          )}
        </div>
      )}
      {hadInterrupted && (
        <div className="banner" role="status">
          {t("This thread had an interrupted turn. It was not resumed automatically.")}
        </div>
      )}
      {turn?.status === "error" && (
        <div className="banner error" role="alert">
          {t("Error")}: {turn.error ? translateError(t, turn.error) : null}
        </div>
      )}
      <div className="timeline-wrap">
      <div
        className="timeline"
        role="log"
        aria-live="polite"
        ref={timelineRef}
        data-chat-id={thread.id}
        onScroll={() => {
          // P1-26: nearing the top with unrendered history pages a chunk
          // in (frozen page=10); the anchor ref holds the measured spot
          // so the prepend lands without moving the reader. One page per
          // gesture — a wheel burst near the top must not pull several
          // chunks in one motion.
          const el = timelineRef.current;
          if (
            !el ||
            el.scrollTop >= 120 ||
            windowedHidden === 0 ||
            Date.now() - timelineLastPageRef.current < 250
          )
            return;
          timelineLastPageRef.current = Date.now();
          timelineAnchorRef.current = el.scrollHeight - el.scrollTop;
          setTimelineVisible((v) => timelinePagedBack(v));
        }}
      >
        {thread.messages.length === 0 && (
          <NewThreadPrompt
            thread={thread}
            project={props.project ?? null}
            projects={props.projects ?? []}
          />
        )}
        {(() => {
          // A84 (frozen StreamVeil): the tail that just flushed dissolves
          // in once; the fade length follows an EMA of the gaps between
          // flushes, clamped 120–400ms. Settled text never animates.
          const veilFor = (m: Message): { chars: number; ms: number } | null => {
            if (m.status !== "streaming") {
              veilRef.current.delete(m.id);
              return null;
            }
            const now = performance.now();
            const rec = veilRef.current.get(m.id);
            const chars = m.content.length - (rec?.len ?? 0);
            const gap = rec ? now - rec.at : null;
            const ema =
              rec && chars > 0 && gap !== null
                ? rec.ema == null
                  ? gap
                  : rec.ema * 0.7 + gap * 0.3
                : (rec?.ema ?? null);
            if (chars <= 0) {
              // Frozen dissolve-in-once: within the fade window the same
              // veil stays mounted so the animation completes; settled
              // text (window past) renders plainly even mid-stream.
              if (rec?.veil && now < rec.veilUntil) return rec.veil;
              return null;
            }
            const ms = Math.min(400, Math.max(120, (ema ?? 80) * 3));
            const veil = { chars, ms };
            veilRef.current.set(m.id, {
              len: m.content.length,
              ema,
              at: now,
              veil,
              veilUntil: now + ms,
            });
            return veil;
          };
          // P1-29: while a message streams, render through the incremental
          // parse; once it settles the state drops and the plain whole
          // render produces the identical final tree.
          const mdFor = (
            m: Message,
            source: string,
            labels: MarkdownLabels | undefined,
            veil: { chars: number; ms: number } | null,
          ): React.ReactNode => {
            if (m.status !== "streaming") {
              const c = mdCoordRef.current.get(m.id);
              if (c) {
                c.dispose();
                mdCoordRef.current.delete(m.id);
              }
              return renderMarkdown(source, labels);
            }
            return mdCoordFor(m.id).parse(source, labels, veil);
          };
          const renderMessage = (m: Message): React.JSX.Element | null => {
          const ck = m.role === "assistant" && m.turnId
            ? ckpts.find((r) => r.turnId === m.turnId)
            : undefined;
          if (m.kind === "reasoning") {
            // Frozen TimelineGroup.build: thinking NEVER renders as a row
            // of its own — it only lives behind the running indicator's
            // chevron while the turn is live (and showReasoning is on).
            return null;
          }
          if (m.kind === "plan") {
            return (
              <details
                key={m.id}
                className={`msg plan-block ${m.status}`}
                open
              >
                <summary>
                  {t("Plan")}
                  {m.status === "streaming" && (
                    <span className="plan-spin">
                      <WorkingSpinner cellSize={3} />
                    </span>
                  )}
                </summary>
                <div className="plan-body">
                  {mdFor(m, m.content, {
                    copy: t("Copy"),
                    copied: t("Copied"),
                    renderDelegation: delegationCard,
                  }, veilFor(m))}
                </div>
              </details>
            );
          }
          if (m.kind === "todos") {
            const steps = m.steps ?? [];
            const doneCount = steps.filter((st) => st.status === "done").length;
            return (
              <div key={m.id} className="msg todo-block" role="status">
                <div className="todo-head">
                  {t("Steps")} {doneCount}/{steps.length}
                </div>
                <ul className="todo-list">
                  {steps.map((st, i) => (
                    <li key={i} className={`todo-step s-${st.status}`}>
                      <span className="todo-mark" aria-hidden="true">
                        {st.status === "done" ? "✓" : st.status === "active" ? "▸" : "○"}
                      </span>
                      {st.text}
                    </li>
                  ))}
                </ul>
              </div>
            );
          }
          if (m.kind === "notice") {
            // Frozen NoticeRow: level glyph + tinted pill for warning/error,
            // plain inline text for info.
            const lv = m.noticeLevel ?? "info";
            return (
              <div key={m.id} className={`msg notice-row lv-${lv}`}>
                <span className="notice-glyph" aria-hidden="true">
                  {lv === "error" ? "⛔" : lv === "warning" ? "⚠" : "ⓘ"}
                </span>
                <span className="notice-text">{translateNotice(t, m.content)}</span>
              </div>
            );
          }
          if (m.kind === "tool" && m.tool) {
            // Frozen: while the turn runs its tool entries fold into the
            // working indicator's chevron — never rows of their own.
            if (turn?.status === "running" && m.turnId === turn.id) return null;
            return <ToolMsgRow key={m.id} m={m} />;
          }
          // F04 / P2-51 (v3.0.0 MessagePopoverMenu): right-click opens the
          // message's context menu at the pointer — single Copy (for a
          // selection) or Copy all (whole message as Markdown), plus Add
          // to reply on replies or rewind rows on user prompts.
          const openMsgMenu = (e: React.MouseEvent) => {
            if (m.role !== "assistant" && m.role !== "user") return;
            const el = e.target as HTMLElement;
            if (el.closest("a[data-md-link]")) return;
            e.preventDefault();
            const article = el.closest("article.msg");
            const sel = window.getSelection();
            const selection =
              sel && !sel.isCollapsed && article && article.contains(sel.anchorNode)
                ? sel.toString()
                : null;
            setMsgMenu({
              text: m.content,
              selection: selection === "" ? null : selection,
              role: m.role,
              threadId: thread.id,
              messageId: m.id,
              // F09: rewind rows only show for messages that belong to
              // a turn (system notes in this list carry no turnId).
              ...(m.turnId !== undefined ? { turnId: m.turnId } : {}),
              x: e.clientX,
              y: e.clientY,
            });
          };
          const peeled = m.role === "user" ? peelQuotes(m.content) : null;
          return (
            <article
              key={m.id}
              data-mid={m.id}
              className={`msg ${m.role} ${m.status}`}
              onContextMenu={openMsgMenu}
            >
              {(m.role === "assistant" || m.role === "user") && (
                <MsgCopyButton text={m.content} />
              )}
              {m.role === "assistant" ? (
                <div className="msg-body">
                  {mdFor(
                    m,
                    m.content.replaceAll(
                      `*${INTERRUPTED_MARKER}*`,
                      `*[${t("interrupted by restart — not resumed")}]*`,
                    ),
                    {
                      copy: t("Copy"),
                      copied: t("Copied"),
                      renderDelegation: delegationCard,
                    },
                    veilFor(m),
                  )}
                </div>
              ) : m.hydraBrief === true ? (
                // Frozen HydraBriefRow: the lead's brief arrives on the
                // head's thread as a pill — the markdown lives in its
                // popover, not in a raw user bubble.
                <div className="msg-body">
                  <HydraBriefPill
                    thread={thread}
                    {...(m.turnId !== undefined ? { turnId: m.turnId } : {})}
                    content={m.content}
                  />
                </div>
              ) : m.hydraHeads !== undefined ? (
                // Frozen HydraReportRow: a heads' report batch is a pill
                // on the user's side — the digest lives in its popover,
                // not in a raw-text bubble.
                <div className="msg-body">
                  <HydraReportRow heads={m.hydraHeads} content={m.content} />
                </div>
              ) : (
                <div className="msg-body">
                  {(peeled?.quotes ?? []).map((q) => (
                    <span className="quote-chip ro" key={q.id} title={q.text}>
                      <span className="quote-chip-text">{quoteExcerpt(q.text)}</span>
                    </span>
                  ))}
                  {m.role === "system"
                    ? translateNotice(t, peeled?.body ?? m.content)
                    : (peeled?.body ?? m.content)}
                </div>
              )}
              {m.role === "user" && m.attachments && m.attachments.length > 0 && (
                <span className="msg-attach">
                  {m.attachments.map((a) => (
                    <AttachChip
                      key={a.id}
                      threadId={thread.id}
                      id={a.id}
                      name={a.name}
                      size={a.size}
                      ro
                    />
                  ))}
                </span>
              )}
              {m.role !== "user" && statusLabel(t, m) && (
                <span className="status-line">{statusLabel(t, m)}</span>
              )}
              {ck && (
                <div className={`ckpt-card s-${ck.status}`} role="status">
                  <span className="ckpt-state">
                    {ck.status === "complete"
                      ? t("Checkpoint captured")
                      : ck.status === "capturing"
                        ? t("Capturing checkpoint…")
                        : ck.status === "invalidated"
                          ? t("Checkpoint invalidated")
                          : t("Checkpoint unavailable")}
                  </span>
                  {ck.reason && <span className="ckpt-reason">{ck.reason}</span>}
                  {ck.touchedPaths.length > 0 && (
                    <span className="ckpt-paths">
                      {t("Files")}: {ck.touchedPaths.slice(0, 5).join(", ")}
                      {ck.touchedPaths.length > 5 ? ` +${ck.touchedPaths.length - 5}` : ""}
                    </span>
                  )}
                  {ck.status === "complete" && !ck.stale && (
                    <button
                      className="ckpt-preview-btn"
                      onClick={() => setPreviewTurn(ck.turnId)}
                    >
                      {t("Preview restore")}
                    </button>
                  )}
                  {ck.status === "complete" && ck.stale && (
                    <span className="ckpt-reason">{t("workspace changed — preview unavailable")}</span>
                  )}
                </div>
              )}
            </article>
          );
          };

          // F03 (frozen TurnFinishedBlock, bounded): messages cluster into
          // turn groups by turnId. The LIVE turn (thread.turn — running or
          // its last completed state) renders flat as before; earlier turns
          // keep user/assistant/system rows open while their work steps
          // fold into one "Worked for %@" details block. Undo/paging/
          // chronological toggles stay out of this cut.
          // P1-26: only the newest `timelineVisible` items mount; the rest
          // page in on scroll-back (frozen TimelineWindow). The windowed
          // slice comes from the memoized items above.
          const renderTurnSteps = (g: TurnGroup): React.ReactNode => {
            const { steps, open } = partitionGroup(g);
            if (g.turnId === turn?.id || steps.length === 0)
              return g.messages.map(renderMessage);
            const stepIds = new Set(steps.map((m) => m.id));
            const lastAssistant = [...open]
              .reverse()
              .find((m) => m.role === "assistant");
            const first = g.messages[0]!;
            const last = g.messages[g.messages.length - 1]!;
            const dur = formatDuration(first.ts, last.ts);
            const status = lastAssistant?.status;
            const stateLabel =
              status === "error" ? t("Failed after %@", dur)
              : status === "cancelled" || status === "denied" || status === "interrupted"
                ? t("Stopped after %@", dur)
                : t("Worked for %@", dur);
            const stepCount =
              steps.length === 1
                ? t("1 step")
                : t("%@ steps", String(steps.length));
            const fold = (
              <details
                key={`fold-${g.turnId}`}
                className="turn-steps"
                aria-label={t("Show this turn's steps")}
              >
                <summary>
                  <span className="turn-steps-label">{stateLabel}</span>
                  <span className="turn-steps-count">{stepCount}</span>
                  <span className="turn-steps-bar">
                    <HydraStaveBar
                      messages={g.messages}
                      tint="var(--accent)"
                      status={
                        status === "error" ? "failed"
                        : status === "cancelled" || status === "denied" || status === "interrupted" ? "stopped"
                        : "completed"
                      }
                    />
                  </span>
                </summary>
                <div className="turn-steps-body">{steps.map(renderMessage)}</div>
              </details>
            );
            const out: React.ReactNode[] = [];
            let inserted = false;
            for (const m of g.messages) {
              if (stepIds.has(m.id)) {
                if (!inserted) {
                  inserted = true;
                  out.push(fold);
                }
                continue;
              }
              out.push(renderMessage(m));
            }
            return out;
          };
          return windowedItems.map((item: TimelineItem) =>
            item.kind === "lone" ? renderMessage(item.message) : renderTurnSteps(item),
          );
        })()}
        {/* F03: frozen WorkingIndicator — the live working line at the
            timeline's tail while the turn runs. showsWorkingCard picks
            the card carrying the turn's progress bar; off renders the
            plain one-line badge (both share the header's live badge). */}
        {turn?.status === "running" && (
          <WorkingIndicator
            thread={thread}
            turn={turn}
            showsCard={props.settings?.showsWorkingCard !== false}
            showReasoning={props.settings?.showReasoning === true}
          />
        )}
        {turn?.approval && <ApprovalCard threadId={thread.id} approval={turn.approval} />}
        {turn?.question && <QuestionCard threadId={thread.id} question={turn.question} />}
        {props.limitResumeAt !== undefined && (
          <LimitWaitRow threadId={thread.id} resumeAt={props.limitResumeAt} />
        )}
        {/* P1-35: frozen Continue button on a failed or stopped turn —
            resumes the same provider session via turns:continue. */}
        {continuable && (
          <div className="continue-row">
            <button
              className="continue-btn"
              disabled={props.readOnly === true}
              onClick={() =>
                void callApi("turns:continue", { threadId: thread.id }).catch(
                  () => {},
                )
              }
            >
              {t("Continue")}
            </button>
          </div>
        )}
        {/* P2-40/F25 (frozen HelpersWorkingRow): helpers at work with
            no panel showing end the timeline as a pill — tapping opens
            the hidden head panel or re-panels the folded helper. */}
        {hiddenWorking.length > 0 &&
          (() => {
            const first = hiddenWorking[0]!;
            return (
              <button
                type="button"
                className="hydra-working-pill"
                title={t("Show the panel")}
                onClick={() => {
                  if (first.hydraHead) {
                    setPanelState((s) =>
                      nextHydraPanelState(
                        s,
                        "pill",
                        props.settings?.hydraAutoOpensPanels !== false,
                      ),
                    );
                  } else
                    void callApi("threads:show-helper", { id: first.id }).catch(
                      () => {},
                    );
                }}
              >
                {hiddenWorking.length === 1
                  ? t("%@ is working", first.hydraHead?.name ?? first.title)
                  : t("%d sub-agents working", String(hiddenWorking.length))}
              </button>
            );
          })()}
        <div ref={endRef} />
      </div>
      {/* F03: frozen TimelineMinimap — one tick per user message on the
          timeline's leading edge, shown only when at least two exist. */}
      <TimelineMinimap
        messages={thread.messages}
        scrollRef={timelineRef}
        onJumpToMessage={(id) => {
          const idx = timelineItems.findIndex((it) =>
            it.kind === "lone"
              ? it.message.id === id
              : it.messages.some((m) => m.id === id),
          );
          if (idx < 0) return;
          // Only when the target sits above the window does the row need
          // mounting first — stash the pending jump so the layout effect
          // scrolls once it lands. An already-mounted target scrolls in
          // the minimap's own querySelector right after this returns;
          // marking it pending here would leave a stale jump that fires
          // on the next unrelated window change.
          const need = timelineJumpWindow(timelineItems.length, idx);
          if (need > timelineVisible) {
            timelineJumpRef.current = id;
            setTimelineVisible(need);
          }
        }}
      />
      </div>
      <Composer
        key={thread.id}
        thread={thread}
        mode={props.mode}
        readOnly={!!props.readOnly}
      />
      {msgMenu && (
        <MessagePopover
          key={`${msgMenu.messageId}:${msgMenu.x}:${msgMenu.y}`}
          state={msgMenu}
          onClose={() => setMsgMenu(null)}
        />
      )}
      {previewTurn && (
        <CheckpointPreviewDialog
          threadId={thread.id}
          turnId={previewTurn}
          onClose={() => setPreviewTurn(null)}
        />
      )}
      {worktreeOpen && <WorktreeDialog thread={thread} onClose={() => setWorktreeOpen(false)} />}
      {scriptsOpen && props.project && (
        <ScriptsDialog
          thread={thread}
          project={props.project}
          onClose={() => setScriptsOpen(false)}
          onRan={() => {
            if (props.dock !== "terminal") props.onToggleDock?.("terminal");
          }}
        />
      )}
    </main>
  );
}
