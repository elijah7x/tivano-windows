// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-23.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Sandboxed bridge: the renderer sees only this typed API — no Node, no
// ipcRenderer, no filesystem, no shell. Unknown channels never leave the
// bridge; malformed payloads are rejected in main as well (defense in depth).

import { contextBridge, ipcRenderer } from "electron";
import { EVENT_CHANNEL, REQUEST_CHANNELS, type AppEvent, type RequestChannel } from "../shared/ipc";

const allowed = new Set<string>(REQUEST_CHANNELS);

function invoke(channel: RequestChannel, payload: unknown): Promise<unknown> {
  if (!allowed.has(channel)) return Promise.reject(new Error(`unknown channel: ${channel}`));
  return ipcRenderer.invoke(channel, payload ?? {});
}

function onEvent(listener: (event: AppEvent) => void): () => void {
  const wrapped = (_e: Electron.IpcRendererEvent, payload: AppEvent) => listener(payload);
  ipcRenderer.on(EVENT_CHANNEL, wrapped);
  return () => {
    ipcRenderer.removeListener(EVENT_CHANNEL, wrapped);
  };
}

// The host platform — needed so F27 chords map `mod` to the correct
// physical modifier (Cmd on macOS, Ctrl on Windows/Linux). A literal
// value, not a Node handle.
const api = { invoke, onEvent, platform: process.platform };
export type TivanoBridge = typeof api;

contextBridge.exposeInMainWorld("tivano", api);
