// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F05 slash-command suggestions — bounded port of the frozen
// SlashCommand/ComposerView suggestion semantics: built-in commands only
// (provider CLI commands/skills need a signed-in provider this build does
// not have), the same match+rank ordering, and the same "the slash word
// must open the draft" activation rule.

/** A slash command row (frozen SlashCommand). `skillPath` exists in the
 *  frozen model for provider-loaded skills; this build never loads
 *  provider commands, so the field is intentionally absent. */
export interface SlashCommand {
  name: string;
  detail: string;
  isBuiltIn: boolean;
}

/** The chip a picked suggestion drops into the draft (frozen
 *  DraftCommand): what the composer shows and what outgoingText leads
 *  with on send. */
export interface DraftCommand {
  name: string;
  detail: string;
  isBuiltIn: boolean;
}

/** Frozen commandSuggestions: `plan` is always offered; `compact` only
 *  where the provider advertises compaction. Details are display keys —
 *  the renderer passes them through localization. */
export function builtinSlashCommands(supportsCompact: boolean): SlashCommand[] {
  const commands: SlashCommand[] = [
    { name: "plan", detail: "Turn plan mode on or off", isBuiltIn: true },
  ];
  if (supportsCompact) {
    commands.push({
      name: "compact",
      detail: "Summarize the conversation to free up context",
      isBuiltIn: true,
    });
  }
  return commands;
}

/** Frozen SlashCommand.suggestions — dedupe by name, case-insensitive
 *  contains-match, then prefix matches first, recently used before
 *  older, alphabetical inside a rank. `recent` is most-recent-first. */
export function slashSuggestions(
  commands: SlashCommand[],
  query: string,
  recent: string[],
): SlashCommand[] {
  const needle = query.toLowerCase();
  const ranks = new Map<string, number>();
  recent.forEach((name, i) => {
    if (!ranks.has(name)) ranks.set(name, i);
  });
  const seen = new Set<string>();
  const matched: { command: SlashCommand; name: string; prefixed: boolean; rank: number }[] = [];
  for (const command of commands) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    const name = command.name.toLowerCase();
    if (needle !== "" && !name.includes(needle)) continue;
    matched.push({
      command,
      name,
      prefixed: name.startsWith(needle),
      rank: ranks.get(command.name) ?? Number.MAX_SAFE_INTEGER,
    });
  }
  matched.sort((l, r) => {
    if (l.prefixed !== r.prefixed) return l.prefixed ? -1 : 1;
    if (l.rank !== r.rank) return l.rank - r.rank;
    return l.name < r.name ? -1 : l.name > r.name ? 1 : 0;
  });
  return matched.map((m) => m.command);
}

export interface SlashQuery {
  /** Text after the leading "/" up to the word end — the match needle. */
  query: string;
  /** Start of the slash word in the draft (always 0 — frozen start==0). */
  start: number;
  /** End of the slash word in the draft. */
  end: number;
}

/**
 * Frozen activation rule: the whitespace-bounded word under the caret
 * must start at index 0 and begin with "/". Typing anywhere inside that
 * word keeps suggestions live; moving outside it closes them.
 * Returns null when the caret is not inside a leading slash word.
 */
export function slashQueryAt(text: string, caret: number): SlashQuery | null {
  const at = Math.max(0, Math.min(caret, text.length));
  let start = at;
  while (start > 0 && !/\s/.test(text.charAt(start - 1))) start -= 1;
  let end = at;
  while (end < text.length && !/\s/.test(text.charAt(end))) end += 1;
  if (start !== 0 || !text.startsWith("/")) return null;
  return { query: text.slice(start + 1, end), start, end };
}
