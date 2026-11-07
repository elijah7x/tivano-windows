// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Renderer terminal registry: owns the live xterm instances and the
// terminal-state mirror. Entries survive React unmounts — a thread switch
// detaches the holder element but the xterm keeps draining output into its
// own scrollback, so returning to the thread restores the exact screen.
//
// Flow control: every written chunk is ACKed through xterm's write callback
// with its real sequence number. Chunks arriving before an xterm exists sit
// in a bounded pending buffer; a stalled or missing consumer never makes
// main buffer forever (it errors and tears down past its own hard cap).
//
// Safety: no link/web-links/clipboard/WebGL addons are ever registered —
// escape sequences can only draw, never open URLs, touch the clipboard or
// reach privileged state.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api, callApi, tryCall } from "./client";
import type { TerminalAttach, TerminalInfo } from "../shared/types";

export interface RenderedTerminal {
  info: TerminalInfo;
  term: Terminal;
  fit: FitAddon;
  /** Detached-capable wrapper — re-parented between pool and visible slot. */
  holder: HTMLElement;
  incarnation: number;
  hydrated: boolean;
  hydrating: number | null;
  lastSeq: number;
  disposed: boolean;
}

/** Scrollback cap per terminal. */
export const TERM_SCROLLBACK = 5000;
/** Stock terminal size (the frozen code stock is 12; our stock option is
 *  12.5 — the F26 code offset adds onto it exactly like CSS calc). */
const TERM_FONT_STOCK = 12.5;
let codeFontOffset = 1; // frozen default code=13 → +1

/** F26: live-update every mounted terminal's fontSize with the code
 *  offset, then re-fit so the grid stays honest. Hidden entries keep
 *  their size and re-fit on their next visible park. */
export function setCodeFontOffset(off: number): void {
  codeFontOffset = off;
  for (const e of entries.values()) {
    if (e.disposed) continue;
    e.term.options.fontSize = TERM_FONT_STOCK + off;
    if (e.holder.isConnected) {
      try {
        e.fit.fit();
      } catch {
        // A zero-size holder cannot be measured — it re-fits on park.
      }
    }
  }
}
/** Chunks buffered while no xterm exists for a terminalId. */
const PENDING_CAP = 512;
const PENDING_CHARS = 262144;

const entries = new Map<string, RenderedTerminal>();
const pending = new Map<string, { incarnation: number; seq: number; data: string }[]>();
const infos = new Map<string, TerminalInfo>();
const order = new Map<string, string[]>(); // threadId → terminal ids
const listeners = new Set<() => void>();
let bridgeOn = false;
let revision = 0;
const overflowed = new Set<string>();
export const terminalRevision = (): number => revision;

const notify = (): void => {
  for (const fn of listeners) fn();
};

export function subscribeTerminals(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function terminalsOf(threadId: string): TerminalInfo[] {
  return (order.get(threadId) ?? [])
    .map((id) => infos.get(id))
    .filter((i): i is TerminalInfo => !!i);
}

export function entryOf(terminalId: string): RenderedTerminal | undefined {
  return entries.get(terminalId);
}

/** Every live entry — cross-thread. A thread switch must park ALL of them,
 *  not just the new thread's, or the previous slot keeps rendering. */
export function allEntries(): RenderedTerminal[] {
  return [...entries.values()];
}

/** Hydrate a thread's session list from main (called on panel mount and
 *  thread change — idempotent). */
export function setThreadTerminals(threadId: string, list: TerminalInfo[], expectedRevision = revision): boolean {
  if (expectedRevision !== revision) return false;
  const known = new Set(order.get(threadId) ?? []);
  order.set(threadId, list.map((i) => i.id));
  for (const i of list) infos.set(i.id, i);
  for (const id of known) if (!list.some((i) => i.id === id)) { infos.delete(id); dropEntry(id); }
  notify();
  return true;
}

const ack = (e: RenderedTerminal, incarnation: number, seq: number): void => {
  if (seq <= 0 || e.disposed || e.incarnation !== incarnation) return;
  tryCall("terminals:ack", { terminalId: e.info.id, incarnation, seq });
};
const writeChunk = (e: RenderedTerminal, seq: number, data: string): void => {
  if (seq <= e.lastSeq) return;
  if (seq !== e.lastSeq + 1) { streamFailed(e); return; }
  e.lastSeq = seq;
  const incarnation = e.incarnation;
  e.term.write(data, () => ack(e, incarnation, seq));
};
function streamFailed(e: RenderedTerminal): void {
  e.hydrated = false;
  e.info = { ...e.info, state: "error", reason: "stall" };
  infos.set(e.info.id, e.info);
  notify();
  // Withhold credit. Main's bounded consumer watchdog stops the producer.
}
function hydrate(e: RenderedTerminal): void {
  if (e.hydrated || e.disposed || e.hydrating !== null || overflowed.has(e.info.id)) return;
  const incarnation = e.incarnation;
  e.hydrating = incarnation;
  void callApi("terminals:select", { terminalId: e.info.id }).then(a => {
    const att = a as TerminalAttach;
    if (e.disposed || e.incarnation !== incarnation || att.info.incarnation !== incarnation || overflowed.has(e.info.id)) return;
    const chunks = pending.get(e.info.id) ?? [];
    pending.delete(e.info.id);
    e.lastSeq = att.tailEndSeq;
    if (att.tail) e.term.write(att.tail, () => ack(e, incarnation, att.tailEndSeq));
    else ack(e, incarnation, att.tailEndSeq);
    e.hydrated = true;
    for (const c of chunks) if (c.incarnation === incarnation && c.seq > att.tailEndSeq) writeChunk(e, c.seq, c.data);
  }).catch(() => { /* A subsequent ensureEntry retries the failed selection. */ })
    .finally(() => { if (e.hydrating === incarnation) e.hydrating = null; });
}

/** Create (or reuse) the live xterm for a session — called eagerly for every
 *  listed terminal so hidden terminals keep draining, not just the visible
 *  one. */
export function ensureEntry(info: TerminalInfo): RenderedTerminal {
  let e = entries.get(info.id);
  if (e && !e.disposed) {
    if (e.incarnation !== info.incarnation) {
      e.incarnation = info.incarnation;
      dropEntry(info.id);
      return ensureEntry(info);
    }
    e.info = info;
    hydrate(e);
    return e;
  }
  const term = new Terminal({
    scrollback: TERM_SCROLLBACK,
    fontFamily: '"SF Mono", "Cascadia Mono", Consolas, monospace',
    fontSize: TERM_FONT_STOCK + codeFontOffset,
    cursorBlink: true,
    allowProposedApi: false,
    disableStdin: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const holder = document.createElement("div");
  holder.className = "term-holder";
  term.open(holder);
  const entry: RenderedTerminal = {
    info,
    term,
    fit,
    holder,
    incarnation: info.incarnation,
    hydrated: false,
    hydrating: null,
    lastSeq: 0,
    disposed: false,
  };
  entry.info = info;
  entries.set(info.id, entry);
  term.onData((d) => {
    const live = entries.get(info.id);
    if (!live || live.disposed || live.info.state !== "running") return;
    tryCall("terminals:input", {
      terminalId: info.id,
      incarnation: live.incarnation,
      data: d,
    });
  });
  term.onResize(({ cols, rows }) => {
    if (entry.disposed) return;
    tryCall("terminals:resize", { terminalId: info.id, incarnation: entry.incarnation, cols, rows });
  });
  hydrate(entry);
  return entry;
}

/** Park the holder in a container (visible slot or hidden pool). The xterm
 *  element is never destroyed by navigation — only re-parented. */
export function parkHolder(e: RenderedTerminal, container: HTMLElement): void {
  if (e.holder.parentElement !== container) container.appendChild(e.holder);
}

/** Remove a terminal entirely — its xterm and every buffer die with it. */
export function dropEntry(terminalId: string): void {
  const e = entries.get(terminalId);
  if (e) {
    e.disposed = true;
    try {
      e.term.dispose();
    } catch {
      /* already disposed */
    }
    e.holder.remove();
    entries.delete(terminalId);
  }
  pending.delete(terminalId);
  overflowed.delete(terminalId);
}

/** Single bridge subscription — events reach live xterms immediately or a
 *  bounded pre-attach buffer; state/removed update the mirror + notify. */
export function ensureTerminalBridge(): void {
  if (bridgeOn) return;
  bridgeOn = true;
  api().onEvent((e) => {
    switch (e.type) {
      case "terminal-data": {
        const ent = entries.get(e.terminalId);
        if (ent && !ent.disposed && e.incarnation === ent.incarnation && ent.hydrated) {
          writeChunk(ent, e.seq, e.data);
        } else {
          const buf = pending.get(e.terminalId) ?? [];
          if (buf.length < PENDING_CAP && buf.reduce((n, c) => n + c.data.length, 0) + e.data.length <= PENDING_CHARS) {
            buf.push({ incarnation: e.incarnation, seq: e.seq, data: e.data });
            pending.set(e.terminalId, buf);
          } else { overflowed.add(e.terminalId); if (ent) streamFailed(ent); }
        }
        break;
      }
      case "terminal-state": {
        revision++;
        infos.set(e.terminal.id, e.terminal);
        const ids = order.get(e.terminal.threadId) ?? [];
        if (!ids.includes(e.terminal.id)) {
          ids.push(e.terminal.id);
          order.set(e.terminal.threadId, ids);
        }
        // Create the consumer even when its panel is hidden; do not let
        // React mount timing decide whether output is drained.
        ensureEntry(e.terminal);
        notify();
        break;
      }
      case "terminal-removed": {
        revision++;
        infos.delete(e.terminalId);
        for (const [tid, ids] of order)
          order.set(
            tid,
            ids.filter((i) => i !== e.terminalId),
          );
        dropEntry(e.terminalId);
        notify();
        break;
      }
      default:
        break;
    }
  });
}

/** Translate an unavailable reason / session error code into a localized
 *  string. Codes are emitted by main; WORKSPACE_* and spawn/host suffixes
 *  carry a raw tail passed through verbatim. */
export function terminalReasonLabel(
  t: (k: string) => string,
  translateError: (t: (k: string) => string, m: string) => string,
  code: string,
): string {
  switch (code) {
    case "platform":
      return t("The terminal isn't available on this platform yet");
    case "unbound":
      return t("This thread isn't bound to a project — bind one to open a terminal");
    case "no-grant":
      return t("The project has no authorized folder — open its folder first");
    case "capacity-thread":
      return t("This thread already has the maximum number of terminals");
    case "capacity-total":
      return t("The terminal limit for this app session was reached");
    case "startup-timeout":
      return t("The shell did not start in time");
    case "stall":
      return t("Terminal output stalled — the consumer fell too far behind");
    case "kill-timeout":
      return t("The shell could not be stopped within the bound");
    case "host-lost":
      return t("The terminal process exited unexpectedly");
    default:
      break;
  }
  if (code.startsWith("spawn-failed:"))
    return `${t("The shell failed to start")}: ${code.slice("spawn-failed:".length)}`;
  if (code.startsWith("host-error:"))
    return `${t("Terminal error")}: ${code.slice("host-error:".length)}`;
  return translateError(t, code);
}
