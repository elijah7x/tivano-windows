# Parity checklist

Alignment target: **Tivano for macOS v2.5.7**, commit `8d1b8c2814f51d105cb5bf4a0e3a6aa04fef8ca1` (released 2026-11-06). The tag, commit and policy are recorded in [source-baseline.json](source-baseline.json); [AGENTS.md](../AGENTS.md) holds the rules for using the reference source.

This file lists what separates this project from that baseline, so a contributor can pick a row and work on it.

- **How to use it.** Pick a row that is `not started` or `partial` and start; no approval is needed. Quote its ID (for example `P2-22`) in the issue or pull request. To avoid duplicate work, comment on the issue for that row or open a draft PR early.
- **Where the rows come from.** Sections 1 and 2 are derived from the upstream changelog and an earlier delta review, not from a source diff of v2.5.7. A changelog line can understate a change. Fetch the tag, read the real behavior, and fix the row if it differs. v2.5.7 has no local snapshot yet.
- **Status legend.**

| Status | Meaning |
| --- | --- |
| `done` | Implemented in `src/`. A Windows maintainer confirms it. |
| `partial` | Some of the behavior exists; the Notes say what is missing. |
| `not started` | Nothing found in `src/`, or not checked yet (Notes then say `unchecked`). |
| `blocked (reason)` | Cannot proceed until the stated dependency exists. |
| `n/a (macOS-only: reason)` | Does not apply on Windows; the reason is stated. |

`done` means implemented, nothing more. Verification is recorded separately in the five categories from [AGENTS.md](../AGENTS.md): synthetic replay, real Windows, real provider, desktop interaction, install/update. A Notes entry marked agent self-tested means a Windows maintainer has not reviewed that row yet; the README Status section lists the earlier review records.

The "Notes" column cites upstream release numbers (for example `2.4.2`) and, where a status rests on a search of the code, the file it rests on.

## 1. v2.0.0 → v2.2.34

Statuses are taken from the earlier delta review of this range and have not been raised since. Rows that port a macOS v2.2.12 behavior are `done` but only agent self-tested (see the README).

### Features

| ID | Feature | Status | Notes |
| --- | --- | --- | --- |
| P1-01 | Thread titles "Keep updated": rename a chat every six completed turns, never touch user-set titles | `done` | 2.2.34. Settings › Text generation › Thread titles; rename pass in `src/main/engine.ts`; `tests/engine.test.ts`. |
| P1-02 | Quick chat: global shortcut opens a minimal box (Return = new chat, Cmd/Ctrl+Return also opens the app, model chip, expand into the full chat, Esc or click-away keeps the draft) | `done` | 2.2.34. Second window plus global shortcut (`src/renderer/components/QuickChat.tsx`, `src/main/index.ts`). Not a non-activating panel. The chord is rebindable. The global-shortcut press itself has not been verified. |
| P1-03 | Settings › Storage: diagnostics file sizes, separate cleanup confirmations, keep the latest hang report, logs and recovery files | `not started` | The storage page lists archives only. Diagnostics half is feasible now. |
| P1-04 | Settings › Storage: update file sizes and cleanup | `blocked (no real updater, see P1-06)` | |
| P1-05 | Codex multi-account: list plans and usage, browser sign-in, import from account switchers, manual pick, auto-switch on limit, wait for reset | `blocked (needs real Codex accounts and sign-in flows)` | Windows has a single Codex CLI path. |
| P1-06 | Auto-update: background download and verify, idle-aware silent install, reopen in background, update-wait chat list with reasons | `blocked (needs code signing and a publishing channel)` | Only synthetic updater checks exist. |
| P1-07 | Rename the "Shelved projects" group (empty restores the default) | `done` | 2.2.22. Right-click rename in the sidebar. |
| P1-08 | Hydra heads work in non-Git folders (add the folder to the sidebar, create it if the parent exists, refuse system folders) | `not started` | Heads are synthetic and assume Git. Feasible on the synthetic Hydra path. See P2-05. |
| P1-09 | Hydra independent review: on by default, reviewer model card (first and second provider, model, effort, fallback), review row names the model actually used | `not started` | Review is a synthetic single pass with no model choice. |
| P1-10 | Shelved projects open in a side panel so they can be browsed without unshelving | `done` | Bounded: shelved row plus project list panel; the inline expand is kept. |
| P1-11 | About credits split into Code, Assets and References, without link buttons | `not started` | The Windows About carries only the single required attribution so far; the categorized credits list is not built. |
| P1-12 | Hydra 2.0 GA: delegation levels (Restrained, Proactive, Aggressive), structured head reports (deviations, unfinished, doubts), rework send-back, lead always reviews, legacy switches removed | `not started` | No delegation-level setting in `src/`. Pair presets and the info popover exist (`src/renderer/components/HydraSection.tsx`, `HydraInfo.tsx`). Head reports already ask for open items (`src/shared/hydraDelegation.ts`) but not as separate fields. |
| P1-13 | Auto-shelve idle projects (3, 7 or 14 days, off by default; running, unread and open chats exempt) | `done` | Hourly sweep, `autoShelveDays` in `src/shared/types.ts`; unit-tested. |
| P1-14 | Realtime voice leaves Alpha and moves to Settings › General | `blocked (needs a voice provider and audio stack)` | Voice is unsupported. |
| P1-15 | Jev decision shadow: judges Hydra reports, reviews and replies; secrets masked in 2.2.34 | `blocked (needs an external decision-model API key and account)` | Absent. |

### Fixes and polish

| ID | Feature | Status | Notes |
| --- | --- | --- | --- |
| P1-16 | A message sent while a turn is stopping queues at the front instead of overwriting; archiving keeps the queued message | `done` | 2.2.12. Agent self-tested. The archive part is unchecked. |
| P1-17 | A Hydra head that is busy keeps its brief queued until its turn ends (fixes a main-thread spin) | `done` | 2.2.12. Agent self-tested. |
| P1-18 | A usage-limit wait is cancelled when the model changes | `done` | 2.2.12. Agent self-tested. |
| P1-19 | A head that cannot start (checkout missing, store failure) ends as failed with a report | `not started` | 2.2.12. Unchecked. |
| P1-20 | Auto-merge retry cap with a single notice | `not started` | 2.2.12. Unchecked. |
| P1-21 | Provider-broken is not reported for transient head errors; one per-provider cause when heads fail before doing work | `not started` | 2.0.22, 2.2.12. Unchecked. |
| P1-22 | Updater: no silent install while a terminal is busy; a failed quit marks the update failed instead of retrying silently | `blocked (no real updater, see P1-06)` | 2.2.34. |
| P1-23 | "Update & restart" re-checks running work before quitting; wait list shows reasons and open buttons | `blocked (no real updater, see P1-06)` | 2.0.22, 2.0.23. |
| P1-24 | Model picker keeps its trimmed list between renders; search finds all models, honoring hide-outdated | `not started` | 2.0.22. Unchecked against `src/renderer/components/ModelPicker.tsx`. |
| P1-25 | Hide outdated models (on by default, three newest per vendor; Fusion pairing fold) | `not started` | 2.0.6. Unchecked. |
| P1-26 | Performance: history paging of 12 turns per chunk, mention byte-search, cached Hydra-block regex | `not started` | 2.0.22. Low priority. |
| P1-27 | File-completion list refreshes when the filesystem changes | `not started` | 2.0.22. Unchecked. |
| P1-28 | Image preview reloads and retries | `not started` | 2.0.22. Unchecked. |
| P1-29 | Markdown keeps streaming during long replies | `not started` | 2.0.22. Unchecked. |
| P1-30 | Composer buttons share one round hover; full access shows a checked shield | `done` | 2.0.22. The composer's controls (paperclip, context ring, runtime-mode and model/effort pickers, Build/Plan segments, Queue/Stop) share one hover fill (`var(--hover)`), and the standalone controls are fully round (`src/renderer/styles.css`); with Full access selected, a checked-shield glyph sits beside the runtime-mode picker (`src/renderer/components/RuntimeModePicker.tsx`), mirroring the Mac `checkmark.shield` symbol. Cosmetic; agent self-tested. |
| P1-31 | Hydra panel: middle drag area, clicking a head's name opens its chat, context menu | `not started` | 2.1.20. |
| P1-32 | DeepSeek Harness routes, agent mode and CLI-from-app | `blocked (macOS-only provider integration, no Windows equivalent identified)` | See P2-15. |
| P1-33 | MCP: use the full command path for ACP agents; skip with a notice when the command is missing | `not started` | 2.0.22. Unchecked against `src/main/mcpService.ts`. |
| P1-34 | Settings › CLI command shows the installed state with Install, Reinstall and Repair wording | `partial` | 2.2.22. The installer already reports its state (`src/main/cliInstall.ts`); wording parity is unchecked. |

## 2. v2.2.34 → v2.5.7

Extracted from the upstream changelog for 2.2.42, 2.3.0, 2.4.2, 2.5.3 and 2.5.7. Small fixes to one feature are merged into one row, with the releases listed in Notes. Internal refactors, release process and documentation entries are left out. The v2.2.12 parity fixes already in this repository are in section 1.

### Chat and threads

| ID | Feature | Status | Notes |
| --- | --- | --- | --- |
| P2-01 | Composer predictions: after a reply the empty composer suggests the likely next message in gray with a "Press Tab to accept" hint; Tab or → puts it in the draft; can be turned off in Settings › Text generation | `not started` | 2.4.2. Uses the text-generation model (P2-18). No match for "predict" in `src/`. |
| P2-02 | Switch a started chat to another provider's model or Hydra pair: takes effect on the next message, one-line context warning with Undo, new session gets recent conversation as text and a marker where it took over; unavailable while a turn, pending request or heads are running | `not started` | 2.3.0, 2.4.2 (undo after crash, revert or loading; edit and revert while waiting; Esc; lost original session; reselecting after a failed send; hand-over of a forwarded chat's own history; usage-limit notice above a waiting switch; warning wording). Unchecked. Needs a second provider or the synthetic provider to develop against. |
| P2-03 | With Hydra on, the composer model picker shows pairs and models in two columns with the recent pair and model on top; search covers pair names; single column without pairs | `not started` | 2.3.0. `src/renderer/components/ModelPicker.tsx` has no pair column. |
| P2-04 | Model pickers stay open after a model is picked so the effort can be set; Last selection, Automatic and Off still close them | `not started` | 2.5.7. Applies to Settings › Default model, the text-generation model, Quick Chat, Chimera presets and the Casting card. Unchecked. |

### Hydra

| ID | Feature | Status | Notes |
| --- | --- | --- | --- |
| P2-05 | Heads in the home folder and in non-Git folders: read-only heads use it as is; writing heads work in the narrowest folder holding their files and do not start if a file lies outside home; files are backed up before a head starts in a non-Git folder, and the report carries the diff and backup location; a head that needs an unlisted file asks the lead; heads never work in Tivano's own data folders; a continued head backs up its new files; stopping a head during backup cannot restart it with the old brief | `not started` | 2.4.2, 2.5.3. Builds on P1-08. Unchecked. |
| P2-06 | Head status "Stalled": a head stopped after 10 quiet minutes shows Stalled instead of Stopped, the lead is told Tivano stopped it and it can be continued, and the report says when the provider last produced output | `not started` | 2.5.3. Head status in `src/shared/hydra.ts` has only running, completed, failed and stopped. The last-output time is Antigravity-only upstream; the Windows build has no Antigravity provider. |
| P2-07 | Head waiting for the user shows "Awaiting your answer" or "Awaiting approval" on its capsule, in the Hydra panel and in the sidebar; the stall check pauses while it waits; the lead's chat notes it | `not started` | 2.5.3. Same status type as P2-06. |
| P2-08 | Alpha decision model (Jev) updates: revised question set including a pre-review check for files outside the job, background patch parsing with at most four calls, extra shadow-test records, review findings accepted in Chinese ("Finding 1：接受") count as accepted | `blocked (depends on P1-15)` | 2.2.42, 2.5.3. |

### Chimera (experimental)

| ID | Feature | Status | Notes |
| --- | --- | --- | --- |
| P2-09 | Chimera mode: switch on in Settings › Alpha, light the Chimera button beside Hydra; the lead names roles and a Casting card sets each role's model and effort, switches roles off or sends none; nothing starts until sent; a recast role keeps the last pick; Chimera and Hydra never run together | `not started` | 2.5.3. No match for "Chimera" in `src/`. Settings › Alpha exists. |
| P2-10 | Settings › Chimera presets pair a model with a specialty to prefill the card; equal-width model pills; drag handle to reorder | `not started` | 2.5.3, 2.5.7. Depends on P2-09. |
| P2-11 | In a Chimera chat the working-heads count sits on the Chimera button, clicking it shows or hides the panel, and the panel count uses the Chimera mark | `not started` | 2.5.7. Depends on P2-09. |

### Providers and accounts

| ID | Feature | Status | Notes |
| --- | --- | --- | --- |
| P2-12 | Claude account management in Settings › Providers › Claude: add, rename, select, remove; selection applies to new independent chats and managed chats keep their account through retries, rewinds and child chats; the default profile follows the external CLI login; no automatic rotation; a verified managed account is reused for five minutes | `blocked (no Claude provider on Windows yet)` | 2.2.42. `src/main` has Codex and synthetic providers only. |
| P2-13 | Import Claude accounts from CSWAP, choosing which ones; imported logins stay pending until enabled | `blocked (no Claude provider on Windows yet)` | 2.2.42. Whether CSWAP exists on Windows is unchecked. |
| P2-14 | Claude usage checks: read existing credentials and query the usage endpoint without starting the CLI or refreshing tokens; each bound chat shows its own account; cached and rate-limited; an expired token makes usage unavailable | `blocked (no Claude provider on Windows yet)` | 2.2.42. |
| P2-15 | DeepSeek Harness: models added in it appear without waiting up to six hours; chats start on 0.2.2 with delegation off or Minimal; delegation tools stay off by package name; an unappliable patch names the version, row and patch file | `blocked (macOS-only provider integration, see P1-32)` | 2.2.42, 2.5.7. |
| P2-16 | A macOS Keychain prompt no longer freezes the app; default-account usage is read through the system `security` tool with a five-second limit; account import, sign-in and removal run in the background | `n/a (macOS-only: macOS Keychain)` | 2.2.42. A Windows credential store would be part of P2-12. |
| P2-17 | ZCode chats no longer fill the Dock with blank "exec" icons | `n/a (macOS-only: Dock icons)` | 2.4.2. |

### Settings

| ID | Feature | Status | Notes |
| --- | --- | --- | --- |
| P2-18 | Settings › Text generation uses one Model picker: Automatic (Haiku for Claude chats, GPT Terra at low effort for others), Choose model (any Claude or Codex model and effort), Off (titles, commit messages, predictions); choosing Codex no longer runs the Codex default model | `not started` | 2.4.2. The setting is still `"automatic" \| "off"` (`src/shared/types.ts`). |
| P2-19 | Settings › Providers as two columns: provider list with status dots (ready, needs attention, not installed), an All providers entry, title-bar search, provider name and route on the first card; the list stays in view and selecting a far-down provider returns the page to the top | `not started` | 2.3.0, 2.4.2. No Providers page among the sections in `src/renderer/components/SettingsModal.tsx`. |
| P2-20 | Settings › Models as two columns: providers with their selected-model counts, an All models entry, provider name on each catalogue card, catalogues no longer fold; the list stays in view | `not started` | 2.3.0, 2.4.2. `src/renderer/components/ModelListSettings.tsx` still folds sections. |
| P2-21 | Model buttons in Settings take only the width their label needs | `not started` | 2.4.2. Unchecked. |
| P2-22 | Collapsible section headers (sidebar, Settings › Models, model picker) show the arrow after the title: always when collapsed, only on hover when expanded | `not started` | 2.2.42. Arrows exist in `src/renderer/components/Sidebar.tsx` and `ModelListSettings.tsx`; placement and hover rule are unchecked. |

### Local control and MCP

| ID | Feature | Status | Notes |
| --- | --- | --- | --- |
| P2-23 | Local control, with Install or repair CLI, leaves Alpha and moves to Settings › General above Power; each feature keeps the state it had in effect | `not started` | 2.3.0. Still gated by Alpha plus a separate switch (`src/shared/types.ts`) and shown in the Alpha section of `SettingsModal.tsx`. |
| P2-24 | Local control with Hydra: `tivano create ... --hydra on` uses the provider's saved pair (needs the app-wide Hydra switch); Hydra-led chats accept `send` and `interrupt`, report busy while heads work, and `thread` reports `hydra`; provider failure kinds are the same in English and Chinese | `not started` | 2.2.42, 2.4.2. No Hydra handling in `src/main/localControl.ts`. |
| P2-25 | Remote MCP moves out of Alpha to the bottom of Settings › MCP; sending to a Hydra-led chat requires its full-access setting | `not started` | 2.2.42, 2.3.0. No Remote MCP in `src/`; `McpSection.tsx` covers MCP client servers only. Depends on P2-24. |

### Localization

| ID | Feature | Status | Notes |
| --- | --- | --- | --- |
| P2-26 | Provider errors, approval prompts, usage and reset details, tool-call rows and model descriptions appear in Chinese | `not started` | 2.3.0. Unchecked. |
| P2-27 | Chinese wording uses one term per concept (子智能体, 主智能体, 对话, 服务商, 组合); fixes mistranslations such as the "More" button and Creator mode; settings paths read "Settings › …" everywhere | `not started` | 2.3.0. Unchecked. `src/renderer/i18n.ts` already uses 子智能体 and 服务商 in places, so this is likely an audit of the rest. |
| P2-28 | Chinese for text that was still English: menus, notifications, update errors, Hydra merge notes, plan approval title, MCP sign-in pages and errors; CLI help and connection errors point to Settings › General for Local control | `not started` | 2.3.0, 2.4.2. Unchecked. MCP sign-in is not implemented (see `McpSection.tsx`). |

### Updates

| ID | Feature | Status | Notes |
| --- | --- | --- | --- |
| P2-29 | Preview builds (such as 3.0.0 Preview 1) download from GitHub and install over the regular app; a preview updates to newer previews and to newer regular releases, and regular installs never offer previews | `blocked (needs the real updater, see P1-06)` | 2.5.3. |

## 3. Windows platform gates

These are acceptance gates, not features. All maintainer-reviewed Windows evidence so far comes from a Windows Server 2022 x64 test machine with an elevated account. Some agent self-tested unit runs were made on Windows 11 under an administrator account. Status words follow the README: `NOT RUN` (no recorded run), `partial` (some evidence, gate not accepted), `not started` (not implemented), `blocked (reason)`.

| ID | Gate | Status | Category | Notes |
| --- | --- | --- | --- | --- |
| W-01 | Install and run as an ordinary user on Windows 10 and 11 | `NOT RUN` | real Windows, install/update | The packaged offline chain was exercised on Windows Server 2022 only. |
| W-02 | Real provider authentication and inference, end to end | `NOT RUN` | real provider | The Codex adapter is reviewed against an offline fixture only. Needs real credentials, so it runs on a maintainer's own account, never with shared or production credentials. |
| W-03 | Native folder picker and file chooser | `partial` | real Windows, desktop interaction | Select, save and cancel acceptance is incomplete. |
| W-04 | Packaged Git on Windows | `partial` | real Windows | Native checks and packaged smoke passed, but packaged Git stalled before the repository assertions and the packaged job regression after it was NOT RUN. Not accepted. |
| W-05 | Windows terminal (ConPTY with the Job host) | `partial` | real Windows, desktop interaction | Disabled in ordinary builds. Latest acceptance suite: 3 passed, the Ctrl-C case failed, 18 NOT RUN. MSVC build, native ConPTY and the packaged candidate are NOT RUN. |
| W-06 | Undo and applying a checkpoint restore | `not started` | none yet | Restore preview exists; there is no Apply or Undo. |
| W-07 | Code signing | `blocked (needs a signing certificate)` | install/update | NOT RUN. |
| W-08 | Update flow on Windows | `blocked (needs W-07 and a publishing channel)` | install/update | NOT RUN. See P1-06. |
| W-09 | Startup `Failed to get 'appData' path` | `partial` | real Windows | The resolver now queries `appData` only for the packaged default. That change is untested on Windows, and why the OS query failed is unknown. |
| W-10 | Job Object helper as an ordinary user and at application level | `partial` | real Windows | Component evidence only: 45/45 portable checks and 24/24 harness cases on Windows Server 2022 x64, elevated. |
| W-11 | Checkpoint integration on Windows (Job-runner path) | `NOT RUN` | real Windows | Wired, but no Windows-native run is recorded. |

## Updating this file

A pull request that moves a row changes that row's Status and Notes in the same pull request. The contributor proposes the status; a Windows maintainer decides whether a row is `done`. Cite the file that implements the behavior, and name the verification category that was actually run (synthetic replay, real Windows, real provider, desktop interaction, install/update). Anything not run stays `NOT RUN`; one category never stands in for another.

Do not mark a row `done` from a changelog line alone; compare against the v2.5.7 source. New rows (a newer upstream release, or a behavior this file missed) take the next free ID in their section and are never renumbered. When the alignment target changes, add a new section for the range and leave the old sections as history.
