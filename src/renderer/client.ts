// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Renderer-side mirror of the main-process store. Hydration subscribes to
// the event channel FIRST and buffers, then applies only events stamped
// past the snapshot's revision boundary — never replaying events the
// snapshot already contains. Drafts live per thread id (not in component
// state) so switching threads, remounts and failed sends never lose text.

import type { AppEvent, RequestChannel } from "../shared/ipc";
import type { DraftCommand } from "../shared/slashCommands";
import type { AttachmentRef, ChatThread, Snapshot } from "../shared/types";
import { makeQuote, serializeOutgoing } from "../shared/replyQuote";
import type { ReplyQuote } from "../shared/replyQuote";
import { translate } from "./i18n";
import { playFinishChime } from "./finishChime";

/** F28: OS notification on a turn's completion — only for an UNSEEN
 *  result: the finished thread isn't the one on screen, or the window
 *  isn't focused. Opt-in via settings; never fires while the user is
 *  watching the thread complete. `silent` when the finish chime already
 *  sounded (frozen: the chime replaces the notification's own sound). */
const NOTIFY_BODY = {
  done: "Turn finished",
  stopped: "Stopped.",
  failed: "Stopped with an error.",
} as const;

function maybeNotifyDone(
  store: ClientStore,
  thread: ChatThread,
  kind: keyof typeof NOTIFY_BODY,
  silent: boolean,
): void {
  const s = store.snapshot;
  if (!s || s.settings.notifyOnDone !== true) return;
  const unseen = s.selectedThreadId !== thread.id || !document.hasFocus();
  if (!unseen) return;
  if (typeof Notification === "undefined") return;
  const fire = () => {
    try {
      // Clicking the notification selects that thread.
      const n = new Notification(thread.title || "Tivano", {
        body: translate(s.settings.language, NOTIFY_BODY[kind]),
        tag: `tivano-turn-${thread.id}`,
        silent,
      });
      n.onclick = () => {
        void api().invoke("threads:select", { id: thread.id });
      };
    } catch {
      // Notification unavailable in this context — stay silent.
    }
  };
  if (Notification.permission === "granted") fire();
  else if (Notification.permission === "default") {
    void Notification.requestPermission().then((p) => {
      if (p === "granted") fire();
    });
  }
}

export interface TivanoApi {
  invoke(channel: RequestChannel, payload: unknown): Promise<unknown>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  /** Host platform — literal Node platform string, for F27 chord mapping. */
  platform: string;
}

declare global {
  interface Window {
    tivano?: TivanoApi;
  }
}

export interface ClientView {
  snapshot: Snapshot | null;
  /** Last surfaced invoke/apply error; shown in the global error banner. */
  lastError: string | null;
}

interface Draft {
  text: string;
  /** Bumped on every edit; a send clears only the version it captured. */
  version: number;
  /** F05: picked slash command — a chip in the composer, the first word
   *  of what goes out (frozen ComposerDraft.command). */
  command?: DraftCommand;
  /** F05: attachment chips — display descriptors only; main keeps the
   *  library-copy records and consumes them on the next sendTurn. */
  attachments?: AttachmentRef[];
  /** F04: reply quotes — chips above the chat box that serialize ahead
   *  of the typed words as `> ` blockquote lines (frozen ReplyQuote). */
  quotes?: ReplyQuote[];
}

type InvokeFn = (channel: RequestChannel, payload: unknown) => Promise<unknown>;

export class ClientStore {
  snapshot: Snapshot | null = null;
  lastError: string | null = null;
  /** Cached subscription view — useSyncExternalStore re-reads by reference. */
  view: ClientView = { snapshot: null, lastError: null };
  private listeners = new Set<() => void>();
  /** Events received before the snapshot lands — filtered by rev at hydrate. */
  private buffered: AppEvent[] = [];
  private snapshotRev = -1;
  /** Bumped per hydration cycle so a stale (unmounted) cycle can't land. */
  private hydrateGen = 0;
  private drafts = new Map<string, Draft>();
  /** F09: per-thread "editing an earlier message" state — set by the
   *  message popover's Edit-from-here row; sendDraft reroutes to
   *  threads:resend while it is set. Ephemeral like drafts. */
  private editTargets = new Map<string, { turnId: string; messageId: string }>();
  private pendingSends = new Set<string>();
  /** F20: threads waiting for a usage-limit reset (ephemeral mirror). */
  limitResumes: Record<string, number> = {};
  private readonly invoke: InvokeFn;

  constructor(invoke?: InvokeFn) {
    this.invoke = invoke ?? ((c, p) => api().invoke(c, p));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private publish(): void {
    this.view = { snapshot: this.snapshot, lastError: this.lastError };
  }

  private notify(): void {
    this.publish();
    for (const fn of this.listeners) fn();
  }

  /** Open a hydration cycle: events buffer until hydrate() lands the snapshot. */
  beginHydration(): number {
    this.buffered = [];
    this.snapshotRev = -1;
    return ++this.hydrateGen;
  }

  /** Entry point for the preload event subscription. */
  onBridgeEvent(e: AppEvent): void {
    if (this.snapshotRev < 0) {
      this.buffered.push(e);
      return;
    }
    if ((e.rev ?? -1) > this.snapshotRev) this.apply(e);
  }

  /** Land the snapshot for cycle `gen`, then replay only newer events. */
  hydrate(s: Snapshot, gen: number): void {
    if (gen !== this.hydrateGen) return; // superseded cycle (StrictMode replay)
    this.snapshot = s;
    this.snapshotRev = s.rev;
    this.limitResumes = { ...(s.limitResumesAt ?? {}) };
    for (const e of this.buffered) {
      this.onBridgeEvent(e);
    }
    this.buffered = [];
    this.notify();
  }

  reportError(message: string): void {
    this.lastError = message;
    this.notify();
  }

  clearError(): void {
    if (!this.lastError) return;
    this.lastError = null;
    this.notify();
  }

  // ---- per-thread drafts ------------------------------------------------

  draft(threadId: string): string {
    return this.drafts.get(threadId)?.text ?? "";
  }

  draftCommand(threadId: string): DraftCommand | undefined {
    return this.drafts.get(threadId)?.command;
  }

  setDraftCommand(threadId: string, command: DraftCommand | undefined): void {
    const prev = this.drafts.get(threadId);
    if (command) {
      // Frozen pick(): the typed "/query" is replaced by the chip.
      this.drafts.set(threadId, {
        text: "",
        version: (prev?.version ?? 0) + 1,
        command,
        ...(prev?.attachments ? { attachments: prev.attachments } : {}),
        ...(prev?.quotes ? { quotes: prev.quotes } : {}),
      });
    } else if (prev?.command) {
      this.drafts.set(threadId, {
        text: prev.text,
        version: prev.version + 1,
        ...(prev.attachments ? { attachments: prev.attachments } : {}),
        ...(prev.quotes ? { quotes: prev.quotes } : {}),
      });
    } else {
      return;
    }
    this.notify();
  }

  draftAttachments(threadId: string): AttachmentRef[] {
    return this.drafts.get(threadId)?.attachments ?? [];
  }

  draftQuotes(threadId: string): ReplyQuote[] {
    return this.drafts.get(threadId)?.quotes ?? [];
  }

  /** F04 "Add to reply" — frozen messageActions: a quote identical to
   *  one already held is not added twice. */
  addDraftQuote(threadId: string, text: string): void {
    const prev = this.drafts.get(threadId);
    if (prev?.quotes?.some((q) => q.text === text)) return;
    this.drafts.set(threadId, {
      text: prev?.text ?? "",
      version: (prev?.version ?? 0) + 1,
      ...(prev?.command ? { command: prev.command } : {}),
      ...(prev?.attachments ? { attachments: prev.attachments } : {}),
      quotes: [...(prev?.quotes ?? []), makeQuote(text)],
    });
    this.notify();
  }

  removeDraftQuote(threadId: string, id: string): void {
    const prev = this.drafts.get(threadId);
    if (!prev?.quotes?.some((q) => q.id === id)) return;
    this.drafts.set(threadId, {
      text: prev.text,
      version: prev.version + 1,
      ...(prev.command ? { command: prev.command } : {}),
      ...(prev.attachments ? { attachments: prev.attachments } : {}),
      quotes: prev.quotes!.filter((q) => q.id !== id),
    });
    this.notify();
  }

  /** F05: ask main to show the file dialog and copy the picks into the
   *  library; returns what was attached plus the over-cap drop count
   *  (frozen "left out" notice input). Never rejects — the error lands
   *  in the banner like every other invoke. */
  async attachFiles(
    threadId: string,
  ): Promise<{ attached: AttachmentRef[]; dropped: number; canceled?: boolean }> {
    try {
      const r = (await this.invoke("attachments:pick", { threadId })) as {
        attached: AttachmentRef[];
        dropped: number;
        canceled?: boolean;
      };
      const prev = this.drafts.get(threadId);
      if (r.attached.length > 0) {
        this.drafts.set(threadId, {
          text: prev?.text ?? "",
          version: (prev?.version ?? 0) + 1,
          ...(prev?.command ? { command: prev.command } : {}),
          attachments: [...(prev?.attachments ?? []), ...r.attached],
          ...(prev?.quotes ? { quotes: prev.quotes } : {}),
        });
        this.notify();
      }
      return r;
    } catch (e) {
      this.reportError(e instanceof Error ? e.message : String(e));
      return { attached: [], dropped: 0 };
    }
  }

  /** F05 paste/drop: the renderer ships the bytes it already holds —
   *  never a path — so the channel grants no file-read primitive. */
  async attachBlobs(
    threadId: string,
    files: { name: string; data: Uint8Array }[],
  ): Promise<{ attached: AttachmentRef[]; dropped: number }> {
    try {
      const r = (await this.invoke("attachments:add-blob", { threadId, files })) as {
        attached: AttachmentRef[];
        dropped: number;
      };
      const prev = this.drafts.get(threadId);
      if (r.attached.length > 0) {
        this.drafts.set(threadId, {
          text: prev?.text ?? "",
          version: (prev?.version ?? 0) + 1,
          ...(prev?.command ? { command: prev.command } : {}),
          attachments: [...(prev?.attachments ?? []), ...r.attached],
          ...(prev?.quotes ? { quotes: prev.quotes } : {}),
        });
        this.notify();
      }
      return r;
    } catch (e) {
      this.reportError(e instanceof Error ? e.message : String(e));
      return { attached: [], dropped: 0 };
    }
  }

  /** F05 downloads popover: ids from `downloads:list` attach through
   *  main's path resolution — the renderer holds only opaque ids and
   *  names, exactly like the dialog flow's descriptors. */
  async attachDownloads(
    threadId: string,
    ids: string[],
  ): Promise<{ attached: AttachmentRef[]; dropped: number; unresolved?: number }> {
    try {
      const r = (await this.invoke("downloads:attach", { threadId, ids })) as {
        attached: AttachmentRef[];
        dropped: number;
        unresolved?: number;
      };
      const prev = this.drafts.get(threadId);
      if (r.attached.length > 0) {
        this.drafts.set(threadId, {
          text: prev?.text ?? "",
          version: (prev?.version ?? 0) + 1,
          ...(prev?.command ? { command: prev.command } : {}),
          attachments: [...(prev?.attachments ?? []), ...r.attached],
          ...(prev?.quotes ? { quotes: prev.quotes } : {}),
        });
        this.notify();
      }
      return r;
    } catch (e) {
      this.reportError(e instanceof Error ? e.message : String(e));
      return { attached: [], dropped: 0 };
    }
  }

  async removeDraftAttachment(threadId: string, id: string): Promise<void> {
    const prev = this.drafts.get(threadId);
    if (prev?.attachments?.some((a) => a.id === id)) {
      this.drafts.set(threadId, {
        text: prev.text,
        version: prev.version + 1,
        ...(prev.command ? { command: prev.command } : {}),
        attachments: prev.attachments.filter((a) => a.id !== id),
        ...(prev.quotes ? { quotes: prev.quotes } : {}),
      });
      this.notify();
    }
    try {
      await this.invoke("attachments:remove", { threadId, id });
    } catch (e) {
      this.reportError(e instanceof Error ? e.message : String(e));
    }
  }

  isPending(threadId: string): boolean {
    return this.pendingSends.has(threadId);
  }

  setDraft(threadId: string, text: string): void {
    const prev = this.drafts.get(threadId);
    if (prev?.text === text) return;
    this.drafts.set(threadId, {
      text,
      version: (prev?.version ?? 0) + 1,
      ...(prev?.command ? { command: prev.command } : {}),
      ...(prev?.attachments ? { attachments: prev.attachments } : {}),
      ...(prev?.quotes ? { quotes: prev.quotes } : {}),
    });
    this.notify();
  }

  /**
   * Send this thread's current draft. The thread id, text and draft
   * version are captured up-front: success clears the draft only if it is
   * still the submitted version (text typed mid-flight is never lost),
   * failure keeps it entirely. Concurrent sends for the same thread are
   * refused via pendingSends. Never rejects — errors surface in the banner.
   */
  /** Frozen ComposerDraft.outgoingText: reply quotes lead as `> `
   *  blockquote lines, a picked command becomes the "/name" head. */
  private outgoingText(d: Draft): string {
    return serializeOutgoing(d.quotes ?? [], d.text.trim(), d.command);
  }

  async sendDraft(threadId: string): Promise<void> {
    const d = this.drafts.get(threadId);
    const text = d ? this.outgoingText(d) : "";
    // F05: an attachment-carried draft is sendable with no typed text
    // (frozen draft.isEmpty counts attachments).
    if ((!text && !(d?.attachments?.length)) || this.pendingSends.has(threadId)) return;
    const version = d!.version;
    this.pendingSends.add(threadId);
    this.notify();
    // F09/F06 local commands — frozen handleLocalCommand: "/plan" toggles
    // the interaction mode on every provider; "/compact" runs only where
    // the provider supports it, elsewhere it falls through to a send.
    const command =
      text === "/plan"
        ? "plan"
        : text === "/compact" && this.snapshot?.info.supportsCompact === true
          ? "compact"
          : null;
    try {
      if (command === "plan") {
        const cur =
          this.snapshot?.threads.find((t) => t.id === threadId)?.interactionMode ?? "build";
        // Frozen handleLocalCommand: the use is recorded before dispatch.
        await this.invoke("slash:record", { name: "plan" });
        await this.invoke("threads:set-interaction-mode", {
          threadId,
          mode: cur === "plan" ? "build" : "plan",
        });
      } else if (command === "compact") {
        await this.invoke("threads:compact", { threadId });
      } else {
        const target = this.editTargets.get(threadId);
        if (target) {
          // F09 resend: rewind to before the edited turn, then send.
          await this.invoke("threads:resend", { threadId, turnId: target.turnId, text });
          this.editTargets.delete(threadId);
        } else {
          await this.invoke("turns:send", { threadId, text });
        }
      }
      const cur = this.drafts.get(threadId);
      if (cur && cur.version === version) this.drafts.delete(threadId);
    } catch (e) {
      this.reportError(e instanceof Error ? e.message : String(e));
    } finally {
      this.pendingSends.delete(threadId);
      this.notify();
    }
  }

  /** F08: same draft-clear discipline as sendDraft — success clears the
   *  submitted version only; text typed mid-flight is never lost. */
  private async draftTo(threadId: string, channel: "followUps:enqueue" | "followUps:interrupt-send"): Promise<void> {
    const d = this.drafts.get(threadId);
    const text = d ? this.outgoingText(d) : "";
    if (!text || this.pendingSends.has(threadId)) return;
    const version = d!.version;
    this.pendingSends.add(threadId);
    this.notify();
    try {
      await this.invoke(channel, { threadId, text });
      const cur = this.drafts.get(threadId);
      if (cur && cur.version === version) this.drafts.delete(threadId);
    } catch (e) {
      this.reportError(e instanceof Error ? e.message : String(e));
    } finally {
      this.pendingSends.delete(threadId);
      this.notify();
    }
  }

  /** F09 edit-from-here: mark the composer as editing an earlier turn.
   *  The message text is prefilled by the caller; sending rewinds first. */
  beginEdit(threadId: string, turnId: string, messageId: string, text: string): void {
    this.editTargets.set(threadId, { turnId, messageId });
    this.setDraft(threadId, text);
    this.notify();
  }

  editTarget(threadId: string): { turnId: string; messageId: string } | undefined {
    return this.editTargets.get(threadId);
  }

  clearEditTarget(threadId: string): void {
    if (this.editTargets.delete(threadId)) this.notify();
  }

  /** Queue the draft behind the running turn (Cmd/Ctrl+Enter parity). */
  async queueDraft(threadId: string): Promise<void> {
    await this.draftTo(threadId, "followUps:enqueue");
  }

  /** Enter while a turn runs: stop it and send as soon as the stop lands. */
  async interruptSendDraft(threadId: string): Promise<void> {
    await this.draftTo(threadId, "followUps:interrupt-send");
  }

  private dropThreadState(threadId: string): void {
    this.drafts.delete(threadId);
    this.editTargets.delete(threadId);
    this.pendingSends.delete(threadId);
  }

  // ---- event application ------------------------------------------------

  apply(event: AppEvent): void {
    const s = this.snapshot;
    if (!s) return;
    if (event.rev !== undefined) {
      if (event.rev <= this.snapshotRev) return;
      this.snapshotRev = event.rev;
    }
    switch (event.type) {
      case "snapshot":
        this.snapshot = event.snapshot;
        this.snapshotRev = event.snapshot.rev;
        this.notify();
        return;
    }
    // Mutate first, then publish a new top-level reference so
    // useSyncExternalStore sees the change. Nested objects are shared.
    switch (event.type) {
      case "project-added":
        s.projects = [...s.projects.filter((p) => p.id !== event.project.id), event.project];
        break;
      case "project-updated":
        s.projects = s.projects.map((p) => (p.id === event.project.id ? event.project : p));
        break;
      case "project-removed":
        for (const t of s.threads) if (t.projectId === event.projectId) this.dropThreadState(t.id);
        s.projects = s.projects.filter((p) => p.id !== event.projectId);
        s.threads = s.threads.filter((t) => t.projectId !== event.projectId);
        break;
      case "thread-added":
        s.threads = [...s.threads.filter((t) => t.id !== event.thread.id), event.thread];
        break;
      case "thread-updated":
        s.threads = s.threads.map((t) => (t.id === event.thread.id ? event.thread : t));
        break;
      case "thread-removed":
        this.dropThreadState(event.threadId);
        s.threads = s.threads.filter((t) => t.id !== event.threadId);
        break;
      case "thread-selected":
        s.selectedThreadId = event.threadId;
        break;
      case "settings-changed":
        s.settings = event.settings;
        break;
      case "app-state":
        if (event.readOnly) s.readOnly = true;
        else delete s.readOnly;
        break;
      case "slash-recorded":
        s.recentCommands = event.recentCommands;
        break;
      case "turn-chunk": {
        const t = this.thread(event.threadId);
        const turn = t?.turn;
        if (!t || !turn || turn.id !== event.turnId) return;
        if (event.seq <= turn.seq) return; // late/duplicate chunk
        turn.seq = event.seq;
        const m = t.messages.find((x) => x.id === turn.assistantMessageId);
        if (m) {
          if (event.content !== undefined) m.content = event.content;
          else if (event.delta !== undefined) m.content += event.delta;
        }
        break;
      }
      case "turn-status": {
        const t = this.thread(event.threadId);
        const turn = t?.turn;
        if (!t || !turn || turn.id !== event.turnId) return;
        turn.status = event.status;
        if (event.error) turn.error = event.error;
        const m = t.messages.find((x) => x.id === turn.assistantMessageId);
        if (m && m.status === "streaming" && event.status !== "running" && event.status !== "waiting-approval")
          m.status = event.status === "done" ? "done" : event.status;
        break;
      }
      case "finish-signal": {
        // F28 frozen turnFinished — the engine applied the setting and
        // stillWorking/userStopped gates; here remains the on-screen check.
        if (event.chime) playFinishChime();
        const t = this.thread(event.threadId);
        if (event.notify && t) maybeNotifyDone(this, t, event.notify, event.silent);
        break;
      }
      case "quick-draft": {
        // v2.2.34 quick chat expand — the draft lands in the selected
        // thread's composer (frozen quickDraft → full chat handoff).
        if (s.selectedThreadId) this.setDraft(s.selectedThreadId, event.text);
        break;
      }
      case "approval-requested": {
        const t = this.thread(event.threadId);
        const turn = t?.turn;
        if (!t || !turn || turn.id !== event.turnId) return;
        turn.approval = event.approval;
        break;
      }
      case "approval-resolved": {
        const t = this.thread(event.threadId);
        const turn = t?.turn;
        if (!t || !turn || turn.id !== event.turnId) return;
        turn.approval = event.approval;
        break;
      }
      case "limit-wait": {
        this.limitResumes[event.threadId] = event.resumeAt;
        break;
      }
      case "limit-wait-ended": {
        delete this.limitResumes[event.threadId];
        break;
      }
      case "sleep-prevention-changed": {
        if (event.active) s.sleepPreventionActive = true;
        else delete s.sleepPreventionActive;
        break;
      }
      case "worktree-failed": {
        // F01: the default-workspace worktree failed — surface the
        // reason in the same banner an IPC rejection would use.
        this.lastError = `worktree: ${event.reason}`;
        break;
      }
    }
    this.snapshot = { ...s, rev: this.snapshotRev };
    this.notify();
  }

  thread(id: string): ChatThread | undefined {
    return this.snapshot?.threads.find((t) => t.id === id);
  }
}

export function api(): TivanoApi {
  const bridge = window.tivano;
  if (!bridge) throw new Error("tivano bridge is not available");
  return bridge;
}

/** The one client store instance shared by the shell and callApi(). */
export const clientStore = new ClientStore();

/**
 * invoke() with uniform error surfacing: a rejected call lands in the
 * global error banner instead of vanishing into `void`. The promise is
 * re-thrown for callers that need the failure themselves.
 */
export async function callApi(channel: RequestChannel, payload: unknown): Promise<unknown> {
  try {
    return await api().invoke(channel, payload);
  } catch (e) {
    clientStore.reportError(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/**
 * Fire-and-forget invoke for event handlers: the rejection is consumed
 * here (already surfaced in the banner), so nothing escapes as an
 * unhandledrejection.
 */
export function tryCall(channel: RequestChannel, payload: unknown): void {
  callApi(channel, payload).catch(() => {});
}
