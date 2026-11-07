// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Navigation/sender gating: only the packaged index frame may invoke IPC,
// and only http/https URLs may leave the app for the system browser.

import { describe, expect, it } from "vitest";
import { isAllowedFrameUrl, isHttpUrl, isTrustedSender } from "../src/main/security";

const ALLOWED = "file:///app/dist/renderer/index.html";

describe("sender/frame gating", () => {
  it("accepts the packaged index frame exactly and with benign suffixes", () => {
    expect(isAllowedFrameUrl(ALLOWED, ALLOWED)).toBe(true);
    expect(isAllowedFrameUrl(`${ALLOWED}#top`, ALLOWED)).toBe(true);
  });

  it("rejects other files, hosts and schemes", () => {
    expect(isAllowedFrameUrl("file:///etc/passwd", ALLOWED)).toBe(false);
    expect(isAllowedFrameUrl("file:///app/dist/renderer/evil.html", ALLOWED)).toBe(false);
    expect(isAllowedFrameUrl("https://example.com/", ALLOWED)).toBe(false);
    expect(isAllowedFrameUrl("file:///app/dist/renderer/index.html.evil", ALLOWED)).toBe(false);
    expect(isAllowedFrameUrl("", ALLOWED)).toBe(false);
    expect(isAllowedFrameUrl("not a url", ALLOWED)).toBe(false);
  });

  it("requires a live sender and a known frame", () => {
    const live = { isDestroyed: () => false };
    const dead = { isDestroyed: () => true };
    expect(isTrustedSender(live, ALLOWED, ALLOWED)).toBe(true);
    expect(isTrustedSender(dead, ALLOWED, ALLOWED)).toBe(false);
    expect(isTrustedSender(undefined, ALLOWED, ALLOWED)).toBe(false);
    expect(isTrustedSender(live, undefined, ALLOWED)).toBe(false);
    expect(isTrustedSender(live, "https://attacker.example/x", ALLOWED)).toBe(false);
  });
});

describe("external link gate", () => {
  it("permits http and https only", () => {
    expect(isHttpUrl("https://example.com/a?b=c")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
  });

  it("blocks scriptable and local schemes", () => {
    for (const u of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "about:blank",
      "chrome://settings",
      "C:\\Windows\\System32",
      "/etc/passwd",
      "\\\\host\\share",
      "not a url",
      "",
    ]) {
      expect(isHttpUrl(u), u).toBe(false);
    }
  });
});
