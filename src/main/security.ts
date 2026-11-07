// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Renderer hardening: no navigation away from the packaged UI, no new windows,
// no webviews, and IPC accepted only from the application's own top frame.

import type { WebContents } from "electron";

// xterm generates its own dimension/theme style elements. Script policy
// stays self-only; HTML style attributes remain disallowed.
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'none'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";

export interface LockdownOptions {
  /** Absolute file:// URL the single window is allowed to display. */
  allowedUrl: string;
  /** URLs permitted to open in the system browser (http/https only). */
  onExternalRequest?: (url: string) => void;
}

export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** True only for the packaged index document (no hash/query tricks). */
export function isAllowedFrameUrl(frameUrl: string, allowedUrl: string): boolean {
  if (frameUrl === allowedUrl) return true;
  try {
    const frame = new URL(frameUrl);
    const allowed = new URL(allowedUrl);
    return (
      frame.protocol === "file:" &&
      allowed.protocol === "file:" &&
      frame.pathname === allowed.pathname &&
      (frame.search === "" || frame.search === allowed.search)
    );
  } catch {
    return false;
  }
}

/** Testable core of the IPC sender check. */
export function isTrustedSender(
  sender: { isDestroyed(): boolean } | undefined,
  frameUrl: string | undefined,
  allowedUrl: string,
): boolean {
  if (!sender || sender.isDestroyed()) return false;
  if (!frameUrl) return false;
  return isAllowedFrameUrl(frameUrl, allowedUrl);
}

export function lockdownWebContents(contents: WebContents, opts: LockdownOptions): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) opts.onExternalRequest?.(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedFrameUrl(url, opts.allowedUrl)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAllowedFrameUrl(url, opts.allowedUrl)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}
