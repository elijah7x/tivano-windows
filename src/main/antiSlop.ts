// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-29.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// F31 anti-slop guidance — bounded port of the frozen AntiSlopPolicy
// (Tivano/Core/Models/AntiSlopPolicy.swift). Instruction text is copied
// verbatim; delivery semantics live in engine.sendTurn/startProvider:
// injected once per provider session on the first ordinary message,
// spent only when the provider actually starts, and skipped when the
// text names a slash command (frozen SlashCommand.name(in:) check —
// commands consume no ordinary prompt, so the delivery stays pending).

const ENABLED = `[Tivano anti-slop guidance]
Give the shortest complete answer, leading with the result. Use plain, natural language. Skip filler, hype, stock openings, repeated summaries and unsolicited closers. Preserve requested detail, facts, uncertainty, blockers and required validation.
Make focused edits using existing patterns. Add comments only for non-obvious reasons, constraints or pitfalls; omit banners, obvious narration and speculative TODOs. Preserve useful documentation. Avoid unrelated cleanup, dependencies and abstractions.
For UI work, follow the product’s components, typography and colors. Prefer purposeful structure and real content; preserve accessibility, responsive layouts and visible loading, empty and error states.
Reuse evidence, read relevant sections and batch independent lookups. Avoid repeated scans, polling and echoed logs. Perform required checks; brevity never excuses incomplete work. Apply this guidance to delegated work too. Report changes, affected files and material limits once. User requests and project requirements take precedence.`;

// Resumed conversations may still contain the enabled guidance — the
// disabled block tells them to disregard it (frozen verbatim).
const DISABLED = `[Tivano anti-slop guidance: off]
Disregard earlier app-provided anti-slop guidance. Continue following user requests and project requirements.`;

/** Frozen AntiSlopPolicy.instructions(enabled:). Both directions
 *  produce a block — an "off" session still delivers the disregard
 *  notice once, not silence. */
export function antiSlopInstructions(enabled: boolean): string {
  return enabled ? ENABLED : DISABLED;
}
