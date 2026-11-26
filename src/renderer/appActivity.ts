// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-24.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// P2-63: centralized app/window activity and element-visibility hooks so
// animations, timers and effects pause while the app is inactive,
// minimized or out of view, and resume immediately when visible again.

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

type Listener = () => void;

class AppActivityTracker {
  private windowActive = true;
  private documentHidden =
    typeof document !== "undefined" ? document.visibilityState === "hidden" : false;
  private modalCovered = false;
  private listeners = new Set<Listener>();
  private memListeners = new Set<(critical: boolean) => void>();
  private wired = false;

  private ensureWired(): void {
    if (this.wired || typeof window === "undefined" || typeof document === "undefined") return;
    this.wired = true;
    this.windowActive = typeof document.hasFocus === "function" ? document.hasFocus() : true;
    this.documentHidden = document.visibilityState === "hidden";
    const onVis = () => {
      this.documentHidden = document.visibilityState === "hidden";
      this.sync();
    };
    const onFocus = () => {
      this.windowActive = true;
      this.sync();
    };
    const onBlur = () => {
      this.windowActive = false;
      this.sync();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    this.syncDom();
  }

  get paused(): boolean {
    this.ensureWired();
    return this.documentHidden || !this.windowActive || this.modalCovered;
  }

  setWindowActive(active: boolean): void {
    this.ensureWired();
    if (this.windowActive === active) return;
    this.windowActive = active;
    this.sync();
  }

  setDocumentHidden(hidden: boolean): void {
    if (this.documentHidden === hidden) return;
    this.documentHidden = hidden;
    this.sync();
  }

  setModalCovered(covered: boolean): void {
    if (this.modalCovered === covered) return;
    this.modalCovered = covered;
    this.sync();
  }

  subscribe(fn: Listener): () => void {
    this.ensureWired();
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribeMemoryPressure(fn: (critical: boolean) => void): () => void {
    this.memListeners.add(fn);
    return () => this.memListeners.delete(fn);
  }

  emitMemoryPressure(critical: boolean): void {
    for (const fn of this.memListeners) fn(critical);
  }

  private syncDom(): void {
    if (typeof document === "undefined") return;
    const isPaused = this.documentHidden || !this.windowActive || this.modalCovered;
    if (isPaused) document.documentElement.dataset.paused = "1";
    else delete document.documentElement.dataset.paused;
  }

  private sync(): void {
    this.syncDom();
    for (const fn of this.listeners) fn();
  }
}

export const appActivity = new AppActivityTracker();

export function setWindowActive(active: boolean): void {
  appActivity.setWindowActive(active);
}

export function setModalCovered(covered: boolean): void {
  appActivity.setModalCovered(covered);
}

export function emitMemoryPressure(critical: boolean): void {
  appActivity.emitMemoryPressure(critical);
}

export function subscribeMemoryPressure(fn: (critical: boolean) => void): () => void {
  return appActivity.subscribeMemoryPressure(fn);
}

/** True when the app is inactive, minimized, hidden or covered by a modal. */
export function useAppPaused(): boolean {
  return useSyncExternalStore(
    (fn) => appActivity.subscribe(fn),
    () => appActivity.paused,
    () => appActivity.paused,
  );
}

/** True while `ref` intersects the viewport (or when IntersectionObserver is unavailable). */
export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setInView(entry.isIntersecting);
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}
