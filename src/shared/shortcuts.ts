// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-31.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Configurable keyboard shortcuts (F27) — a port of the frozen
// `Shortcuts.swift` KeyChord/AppShortcut/ShortcutStore model. A chord is a
// PHYSICAL key (KeyboardEvent.code, position-based like the frozen macOS
// keyCode) plus four modifier flags. `mod` is the platform primary
// modifier — Cmd on macOS, Ctrl on Windows/Linux; `ctrl` is the literal
// Control key (macOS only — on Windows Ctrl IS the primary modifier, so a
// recorded chord never carries the separate flag). Only OVERRIDES are
// persisted; a stored null chord means the shortcut was cleared
// (frozen Override semantics). The frozen `toggleActivityView` command is
// intentionally absent — this build has no activity view, so the command
// is listed in the ledger gap rather than faked here.

export type ShortcutCommandId =
  | "newThread"
  | "newWorktreeThread"
  | "addProject"
  | "stopTurn"
  | "queueChat"
  | "togglePlanMode"
  | "previousThread"
  | "nextThread"
  | "runScript"
  | "archiveThreadDirect"
  | "archiveThread"
  | "commandPalette"
  | "toggleSidebar"
  | "toggleTerminal"
  | "toggleChanges"
  | "showMainWindow"
  | "openSettings"
  | "quickChat";

export interface KeyChord {
  /** Physical key position — DOM KeyboardEvent.code ("KeyK", "Digit1",
   *  "Tab", "Enter", "Backspace", "F5", "ArrowLeft", …). */
  key: string;
  /** Platform primary modifier (⌘ on macOS, Ctrl on Windows/Linux). */
  mod: boolean;
  /** Literal Control (macOS chords like Ctrl+Tab). Never set on
   *  non-darwin platforms — Control is `mod` there. */
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export const SHORTCUT_COMMANDS: readonly ShortcutCommandId[] = [
  "newThread",
  "newWorktreeThread",
  "addProject",
  "stopTurn",
  "queueChat",
  "togglePlanMode",
  "previousThread",
  "nextThread",
  "runScript",
  "archiveThreadDirect",
  "archiveThread",
  "commandPalette",
  "toggleSidebar",
  "toggleTerminal",
  "toggleChanges",
  "showMainWindow",
  "openSettings",
  "quickChat",
];

/** Frozen Section grouping (Threads / Window and panels). */
export const SHORTCUT_SECTIONS: Record<
  "threads" | "window",
  readonly ShortcutCommandId[]
> = {
  threads: [
    "newThread",
    "newWorktreeThread",
    "addProject",
    "stopTurn",
    "queueChat",
    "togglePlanMode",
    "previousThread",
    "nextThread",
    "runScript",
    "archiveThreadDirect",
    "archiveThread",
  ],
  window: [
    "commandPalette",
    "toggleSidebar",
    "toggleTerminal",
    "toggleChanges",
    "showMainWindow",
    "openSettings",
    "quickChat",
  ],
};

const c = (
  key: string,
  mod = false,
  ctrl = false,
  alt = false,
  shift = false,
): KeyChord => ({ key, mod, ctrl, alt, shift });

/** Frozen defaultChord values, in macOS modifier semantics. */
const DEFAULTS_DARWIN: Record<ShortcutCommandId, KeyChord | null> = {
  newThread: c("KeyN", true),
  newWorktreeThread: c("KeyN", true, false, false, true),
  addProject: c("KeyO", true),
  stopTurn: c("Period", true),
  queueChat: c("Enter", true),
  togglePlanMode: c("KeyP", true, false, false, true),
  previousThread: c("Tab", false, true, false, true),
  nextThread: c("Tab", false, true),
  runScript: c("KeyR", true),
  archiveThreadDirect: c("Backspace", true, false, false, true),
  archiveThread: c("KeyW", true),
  commandPalette: c("KeyK", true),
  toggleSidebar: c("KeyB", true),
  toggleTerminal: c("KeyJ", true),
  toggleChanges: c("KeyD", true),
  showMainWindow: c("Digit0", true),
  openSettings: c("Comma", true),
  // v2.2.34 quick chat — frozen ⇧⌘Space.
  quickChat: c("Space", true, false, false, true),
};

/** Canonical form for comparison: on non-darwin platforms the literal
 *  Control flag folds into the primary modifier — a frozen Ctrl+Tab
 *  default becomes the Windows Ctrl+Tab (same keys pressed). */
export function normalizeChord(chord: KeyChord, isDarwin: boolean): KeyChord {
  if (isDarwin) return { ...chord };
  return {
    key: chord.key,
    mod: chord.mod || chord.ctrl,
    ctrl: false,
    alt: chord.alt,
    shift: chord.shift,
  };
}

export function defaultChord(
  id: ShortcutCommandId,
  isDarwin: boolean,
): KeyChord | null {
  const d = DEFAULTS_DARWIN[id];
  return d ? normalizeChord(d, isDarwin) : null;
}

/** Effective chord: stored override wins; a stored null means cleared —
 *  it does NOT fall back to the default (frozen Override semantics). */
export function effectiveChord(
  id: ShortcutCommandId,
  overrides: Record<string, KeyChord | null> | undefined,
  isDarwin: boolean,
): KeyChord | null {
  if (overrides && id in overrides) {
    const o = overrides[id];
    return o ? normalizeChord(o, isDarwin) : null;
  }
  return defaultChord(id, isDarwin);
}

export function sameChord(a: KeyChord, b: KeyChord): boolean {
  return (
    a.key === b.key &&
    a.mod === b.mod &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
}

/** Chord captured from a keydown event, in platform canonical form. */
export function chordFromEvent(e: {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}, isDarwin: boolean): KeyChord {
  if (isDarwin) {
    return {
      key: e.code,
      mod: e.metaKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      shift: e.shiftKey,
    };
  }
  // Windows/Linux: Control is the primary modifier — never a separate flag.
  return {
    key: e.code,
    mod: e.ctrlKey,
    ctrl: false,
    alt: e.altKey,
    shift: e.shiftKey,
  };
}

export function isModifierKey(code: string): boolean {
  return (
    code === "ControlLeft" ||
    code === "ControlRight" ||
    code === "ShiftLeft" ||
    code === "ShiftRight" ||
    code === "AltLeft" ||
    code === "AltRight" ||
    code === "MetaLeft" ||
    code === "MetaRight"
  );
}

/** Keys that type a character or move the caret — frozen typesText().
 *  A chord of only Shift/none on one of these would steal text input. */
export function typesText(code: string): boolean {
  if (/^(Key[A-Z]|Digit[0-9]|Numpad[0-9])$/.test(code)) return true;
  return PUNCT.has(code) || CARET_KEYS.has(code);
}

const PUNCT = new Set([
  "Equal",
  "Minus",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "Backquote",
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadDecimal",
  "NumpadComma",
  "NumpadEqual",
]);
const CARET_KEYS = new Set([
  "Enter",
  "NumpadEnter",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

const SPECIAL_LABELS: Record<string, string> = {
  Enter: "Return",
  NumpadEnter: "Return",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Delete",
  Delete: "Del",
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/** Display label for a physical key, or null for a key a shortcut
 *  cannot hold (frozen keyEquivalent/menu-usable rule). */
export function keyLabel(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^F(?:[1-9]|1[0-9]|20)$/.test(code)) return code;
  if (PUNCT.has(code)) return PUNCT_GLYPHS[code] ?? code;
  return SPECIAL_LABELS[code] ?? null;
}

const PUNCT_GLYPHS: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

/** "⌘⇧K" / "Ctrl+Shift+K" — modifier symbols first, frozen order
 *  ⌃⌥⇧⌘ (darwin) or Ctrl+Alt+Shift+Mod (elsewhere). */
export function chordLabel(chord: KeyChord, isDarwin: boolean): string {
  const key = keyLabel(chord.key) ?? chord.key;
  if (isDarwin) {
    let s = "";
    if (chord.ctrl) s += "⌃";
    if (chord.alt) s += "⌥";
    if (chord.shift) s += "⇧";
    if (chord.mod) s += "⌘";
    return s + key;
  }
  const parts: string[] = [];
  if (chord.mod) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Chords the OS/app already answers to — frozen `reserved`, in macOS
 *  semantics (normalized at compare time so the same physical keys stay
 *  reserved on Windows). */
const RESERVED: readonly KeyChord[] = [
  // ⌘Q ⌘H ⌘M ⌘C ⌘V ⌘X ⌘A ⌘Z ⇧⌘Z
  c("KeyQ", true),
  c("KeyH", true),
  c("KeyM", true),
  c("KeyC", true),
  c("KeyV", true),
  c("KeyX", true),
  c("KeyA", true),
  c("KeyZ", true),
  c("KeyZ", true, false, false, true),
  // ⌘1…⌘9 — script slots / tab switching territory, kept reserved.
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => c(`Digit${n}`, true)),
];

/** Frozen refusal(): why a chord cannot be taken, or null when it can.
 *  Returned strings are i18n KEYS (English verbatim). `%@` marks the
 *  owning command's localized title. */
export function shortcutRefusal(
  chord: KeyChord,
  commandId: ShortcutCommandId,
  overrides: Record<string, KeyChord | null> | undefined,
  isDarwin: boolean,
): string | null {
  const current = effectiveChord(commandId, overrides, isDarwin);
  if (current && sameChord(normalizeChord(chord, isDarwin), current)) return null;
  if (isModifierKey(chord.key)) return "Add a key to the modifiers.";
  const norm = normalizeChord(chord, isDarwin);
  if (!norm.mod && !norm.ctrl && !norm.alt && typesText(norm.key))
    return "Add a modifier so typing still works.";
  if (keyLabel(norm.key) === null) return "This key cannot be a shortcut.";
  for (const r of RESERVED) {
    if (sameChord(normalizeChord(r, isDarwin), norm))
      return "The system or Tivano already uses this chord.";
  }
  for (const other of SHORTCUT_COMMANDS) {
    if (other === commandId) continue;
    const oc = effectiveChord(other, overrides, isDarwin);
    if (oc && sameChord(oc, norm)) return `%@ already uses this chord.|${other}`;
  }
  return null;
}

/** Frozen AppShortcut titles — English keys for i18n. */
export const SHORTCUT_TITLES: Record<ShortcutCommandId, string> = {
  newThread: "New thread",
  newWorktreeThread: "New thread in worktree",
  addProject: "Add project",
  stopTurn: "Stop the running turn",
  queueChat: "Queue a chat",
  togglePlanMode: "Plan mode",
  previousThread: "Previous thread",
  nextThread: "Next thread",
  runScript: "Run top script",
  archiveThreadDirect: "Archive thread",
  archiveThread: "Archive thread…",
  commandPalette: "Command palette",
  toggleSidebar: "Toggle sidebar",
  toggleTerminal: "Toggle terminal",
  toggleChanges: "Toggle changes",
  showMainWindow: "Show Tivano",
  openSettings: "Settings",
  quickChat: "Quick chat",
};

/** Frozen AppShortcut details — English keys for i18n. */
export const SHORTCUT_DETAILS: Record<ShortcutCommandId, string> = {
  newThread: "Starts a thread in the current project.",
  newWorktreeThread: "Starts a thread in its own git worktree.",
  addProject: "Opens a folder as a project.",
  stopTurn: "Interrupts the agent while it works.",
  queueChat: "While a turn runs, lines the draft up behind it.",
  togglePlanMode: "Plans before building.",
  previousThread: "Selects the thread above in the sidebar.",
  nextThread: "Selects the thread below in the sidebar.",
  runScript: "Runs the first project script in the selected thread's terminal.",
  archiveThreadDirect: "Archives the selected thread without asking for confirmation.",
  archiveThread: "Asks to archive the selected thread; Return archives it, and Delete is a click away.",
  commandPalette: "Searches threads, projects and actions.",
  toggleSidebar: "Shows or hides the sidebar.",
  toggleTerminal: "Shows or hides the thread's terminal.",
  toggleChanges: "Shows or hides the changes panel.",
  showMainWindow: "Brings the main window to the front.",
  openSettings: "Opens this window.",
  quickChat: "Opens or hides the quick chat box.",
};
