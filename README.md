# Tivano Windows

An independent Windows product, currently implemented with Electron + React + TypeScript. The goal is full parity of features and product style with the frozen **Tivano for macOS v2.5.7** baseline. System behavior (windows, paths, shortcuts, processes, credentials) is adapted to Windows where that makes sense. The Mac product is not rewritten or modified.

This is development software, not a release. Nothing here is accepted as a supported Windows product yet, and the full feature/provider support matrix is not complete, so do not assume any given provider is supported.

## Maintainers

- Product owner: [@elijah7x](https://github.com/elijah7x), the author of Tivano for macOS. Sets product design and direction, and gives final acceptance of official releases.
- Windows maintainer: [@Li-changwu](https://github.com/Li-changwu). Makes the technical decisions, reviews and merges PRs, and decides when a parity row is `done`.

What each role decides, and how to contribute, is in [CONTRIBUTING.md › Roles](CONTRIBUTING.md#roles).

## Documentation

- [AGENTS.md](AGENTS.md): rules for contributors and coding agents.
- [docs/architecture.md](docs/architecture.md): technical direction and unverified items.
- [docs/execution-plan.md](docs/execution-plan.md): phases and open items.
- [docs/source-baseline.json](docs/source-baseline.json): exact tag, commit and how the reference was obtained.
- [docs/parity.md](docs/parity.md): alignment checklist against the baseline, with per-feature status for contributors to pick from.
- `docs/phase-*.md`: per-phase design notes and recorded results. Short commit hashes in these documents (for example `e0af84b`) refer to the pre-publication development history, which is archived by the project owner and not part of this repository.

## Build and verify

Install dependencies with `npm install`, then:

| Command | What it does |
| --- | --- |
| `npm run verify` | Build, type-check, unit tests and isolated Electron e2e, in that order |
| `npm run build` / `npm run typecheck` | Build the bundle / type-check only |
| `npm test` / `npm run test:e2e` | Unit tests (vitest) / isolated Electron e2e only |
| `npm run dev` | Build, then start an isolated dev instance with its own data root (`.devdata` by default; override with `TIVANO_DATA_ROOT` or `--data-root`) |

Windows-only tooling (see [docs/phase-2c-windows-helper.md](docs/phase-2c-windows-helper.md), [docs/phase-2h-windows-packaging.md](docs/phase-2h-windows-packaging.md) and [docs/phase-2i-packaged-job.md](docs/phase-2i-packaged-job.md)):

| Command | What it does |
| --- | --- |
| `npm run helper:build:win` | Build the native Job Object helper (needs Visual Studio Build Tools with the C++ workload and a Windows 10 SDK; installs nothing itself) |
| `npm run test:windows` | Native helper harness (refuses to run off Windows; needs `--helper`, `--fixture`, `--out` arguments) |
| `npm run package:windows:plan` | Static packaging check; safe on any host and never implies a Windows build or validation |
| `npm run package:windows` | Build the internal x64 installer (refuses unless run on win32/x64) |
| `npm run smoke:packaged` | Offline smoke test of the packaged build (win32/x64 only; mock provider) |
| [Desktop acceptance helpers](scripts/windows-acceptance/README.md) | Desktop acceptance helpers: launch in the interactive session, screenshots, runs as a standard user |
| [Automated PR review](scripts/pr-review/README.md) | Automated PR review on a Windows machine: isolated checks as a standard account, read-only agent review posted as a comment (see its README) |

The recorded `npm run verify` results come from a macOS arm64 host. A full run on a Windows development machine is not recorded.

## Status

Verification is reported in five separate categories: synthetic replay, real Windows, real provider, desktop interaction and install/update. A result in one category does not stand in for another, and anything not run is `NOT RUN`. Review results below were produced on a macOS arm64 host unless a Windows host is named. Details are in the phase documents. The "Maintainer review" records predate the current maintainer team and were made by the project owner.

| Area | Maintainer review | Not verified |
| --- | --- | --- |
| Foundation: restricted IPC, isolated persistence, synthetic provider (session, approval, resume), English and Simplified Chinese shell | Reviewed | Synthetic provider only |
| Codex app-server adapter | Reviewed against an offline fixture | Real Codex CLI launch, authentication and inference |
| Project folders, embedded terminal (macOS PTY), read-only Git panel | Reviewed | Windows terminal and Git, see below |
| Checkpoints: private store, per-turn ledger, restore preview | Reviewed | Preview only, no Apply/Undo exists. Windows-native run |
| Codex CLI path setting | Reviewed | Native file chooser select/save/cancel acceptance is incomplete. Windows, packaged and real Codex runs |
| Windows Job Object helper | Component evidence on Windows Server 2022 x64 (elevated account): 45/45 portable checks, 24/24 harness cases | Not an ordinary-user Windows 10/11 result; not application-level |
| Windows packaging and packaged offline chain | Packaging pipeline reviewed. Internal installer built and offline mock smoke 22/22 plus packaged job test 38/38 (after a recorded correction) on Windows Server 2022 x64 (elevated account) | Ordinary-user install, signing, updates |
| Windows read-only Git (helper-run) | Local implementation reviewed. Native `--run` checks and packaged smoke passed on Windows Server 2022 x64 | Not accepted: packaged Git stalled before repository assertions, and the packaged job regression after it was NOT RUN |
| Windows terminal (ConPTY + Job host) | Local implementation reviewed | Not accepted: disabled in ordinary builds; MSVC build, native ConPTY and packaged candidate NOT RUN |

**Agent self-tested only.** The last two batches of work were tested by the agent that wrote them and have not been reviewed or accepted by a Windows maintainer:

- The feature batch: Codex model and reasoning-effort selection, the user-question card, checkpoint ledger changes, MCP, Hydra, themes and related changes.
- The parity-fix batch for macOS v2.2.12 behavior: queueing a second message while a turn is stopping, binding the limit wait to the model, and keeping a Hydra head's brief while the head is busy.

Still unverified:

- Install and run as an ordinary user on Windows 10/11. All maintainer-reviewed Windows evidence so far is from Windows Server 2022 x64 with an elevated account; some agent self-tested unit runs were made on Windows 11 as an administrator.
- Real provider authentication and inference, end to end.
- Windows native folder picker and file chooser.
- Packaged Git on Windows.
- Windows terminal. A later terminal acceptance suite was incomplete: 3 passed, the Ctrl-C case failed, 18 NOT RUN.
- Undo (not implemented).
- Code signing and updates.
- Startup on Windows: one direct start of a Windows build raised `Failed to get 'appData' path`. The resolver now queries `appData` only for the packaged default; that change has not been tested on Windows, and why the OS query failed is unknown.

## Origin and license

The baseline is [Tivano v2.5.7](https://github.com/elijah7x/tivano/releases/tag/v2.5.7) (released 2026-11-06), commit `8d1b8c2814f51d105cb5bf4a0e3a6aa04fef8ca1`. The current main/dev branches are not used in its place. The reference source is read-only: fetch it from that GitHub tag and do not develop in it or run its scripts. Earlier baselines v2.2.34 (commit `d4c27410553677354bd08e70becd20ebbd240183`) and v2.0.0 (commit `d31e093b356846ff538dd8ba0dc22d62598e4427`) are recorded in [docs/source-baseline.json](docs/source-baseline.json) as historical.

Tivano Windows is an independent Windows rewrite derived from that baseline (started 2026-10-23). It is not the original Droppy Code and does not represent production by, endorsement by or affiliation with Droppy or Jordy Spruit. Original attribution: **Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app**.

The [LICENSE](LICENSE) (AGPL v3 with the additional attribution terms of section 7), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [TRADEMARK.md](TRADEMARK.md) of the frozen baseline are preserved. Third-party notices are kept as received and do not mean this project includes all of those components; each new dependency needs its own license check. Attribution must remain in the About screen (or an equally visible place) and in source-file copyright notices, with modifications and dates marked and the corresponding source obligations met. The full Mac source tree, its images and fonts, production data and credentials were not copied into this project. Assets are admitted only after their eligibility is confirmed one by one, and the source license grants no right to use the Droppy brand or icon.
