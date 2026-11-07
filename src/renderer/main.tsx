// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app

import { createRoot } from "react-dom/client";
import { createElement, StrictMode } from "react";
import "@xterm/xterm/css/xterm.css";
import { App } from "./app";
import { QuickChat } from "./components/QuickChat";

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");
// The quick-chat panel loads the same bundle with #quick (frozen: one
// responder, two window surfaces).
const quick = window.location.hash === "#quick";
createRoot(el).render(
  createElement(StrictMode, null, createElement(quick ? QuickChat : App)),
);
