# Contributing to Tivano Windows

Tivano Windows is an independent derivative of Tivano for macOS, currently implemented with Electron + React + TypeScript. The goal is feature and product-style parity with the macOS baseline recorded in [docs/source-baseline.json](docs/source-baseline.json), with system behavior adapted to Windows where it has to differ.

Read [AGENTS.md](AGENTS.md) before you start: its rules apply to every contributor, human or coding agent. The [README](README.md) says what is and is not verified today. This is development software, so expect gaps.

## Roles

- **Product owner: `@elijah7x`**, who is also the author of Tivano for macOS. Owns the product design philosophy and direction, and gives the final acceptance of official releases, confirming that the Windows version stays consistent with Tivano's design philosophy. Does not review day-to-day PRs and does not follow implementation details.
- **Windows maintainers: currently `@Li-changwu`**, and more may be added. Own all technical decisions, including architecture and the technology stack. Review and merge PRs. Their own testing and acceptance is this repository's basis for acceptance. They decide whether a row in [docs/parity.md](docs/parity.md) is marked `done`.
- **Contributors:** anyone else. You do not need to be assigned or approved, and you do not need to wait for anyone to confirm before you start. See [Picking work](#picking-work).

Only these need the product owner's sign-off:

- User-visible changes that depart from the Mac product design, other than normal platform adaptation.
- Official releases.
- License and attribution.
- Brand and icons.

## Getting started

These notes describe the current Electron + React + TypeScript implementation. If the stack changes (see [Changing the stack or architecture](#changing-the-stack-or-architecture)), this section changes with it.

**Requirements**

- Node.js and npm. `package.json` has no `engines` field, so no version is pinned. The Windows packaging notes ([docs/phase-2h-windows-packaging.md](docs/phase-2h-windows-packaging.md)) ask for Node 22.12.0 or newer, with Node 24 LTS recommended. Use at least that.
- Git.

**Install and verify**

```
npm install
npm run verify
```

`npm run verify` builds, type-checks, runs the unit tests and then the isolated Electron e2e, in that order. The "Build and verify" section of the [README](README.md) lists every script. Two you will use often:

- `npm test` runs the unit tests (vitest) only.
- `npm run dev` builds and starts an isolated dev instance with its own data root, so it never touches real user data.

Recorded `verify` results so far come from a macOS arm64 host. A full run on Windows is not recorded yet, so say what you see on yours.

**Windows-only scripts**

These refuse to run, or mean nothing, off Windows:

| Script | Needs |
| --- | --- |
| `npm run helper:build:win` | Windows, Visual Studio Build Tools with the C++ workload, a Windows 10 SDK |
| `npm run test:windows` | Windows, a built helper and fixture (`--helper`, `--fixture`, `--out`) |
| `npm run package:windows` | win32/x64 |
| `npm run smoke:packaged` | win32/x64, a packaged build |

`npm run package:windows:plan` is a static check that is safe on any host. It never implies a Windows build or validation.

Nothing installs the C++ toolchain for you, and the helper build writes to a fresh, empty directory outside the source tree. See [helpers/win32/BUILD.md](helpers/win32/BUILD.md) and [docs/phase-2c-windows-helper.md](docs/phase-2c-windows-helper.md) for the exact invocation and the verification contract.

## Where to file things

- **Windows-specific bugs, build problems and parity tasks:** open an issue in this repository with the matching template. For a bug, include your Windows edition and build, architecture, account type and how you installed the app.
- **Product feature requests and questions about Mac behavior:** file them at <https://github.com/elijah7x/tivano/issues>. This repository follows the macOS baseline and does not decide product direction.
- **Security problems:** do not open a public issue. For now, contact the maintainer privately through the contact details on the GitHub profile of `elijah7x`. Do not put exploit details in a public issue, a PR or a discussion.

## Picking work

1. Pick a row from [docs/parity.md](docs/parity.md) whose status is `not started` or `partial`. The statuses are `done`, `partial`, `not started`, `blocked (reason)` and `n/a (macOS-only: reason)`. A `blocked` row needs its stated blocking condition resolved first; say in the issue or PR how you deal with it. An `n/a` row does not apply on Windows.
2. Start. No claim, approval or acknowledgement is required.
3. To avoid duplicate work, comment on the issue for that row (the parity template is one way to open it) saying you are working on it, or open a draft PR early.
4. Reference the row ID (for example `P1-01` or `W-01`) in the PR title or body.

For anything large, open an issue and discuss it with a Windows maintainer first: a new dependency, a change to the IPC surface, a change to the architecture in [docs/architecture.md](docs/architecture.md), or a row that spans several areas.

## Changing the stack or architecture

The current implementation is Electron + React + TypeScript. That is the present choice, not a requirement. Windows maintainers may change the stack, including rewriting it (for example in Rust with GPUI).

- A major stack or architecture change needs a short decision record under `docs/`: the motivation, the trade-offs, the migration plan, and the effect on existing features and acceptance status.
- If the change affects user-visible behavior, tell the product owner.
- The parity target, AGPL-3.0 and Droppy attribution, the ban on real credentials and production data, evidence kept outside the repository, and the five verification categories do not change with the stack.
- Contributors, and coding agents acting for them, propose such a change in an issue. They do not switch the stack without a maintainer's decision record.

## Pull requests

**Shape**

- Branch from `main`. External contributors work from a fork.
- One PR does one thing. Split unrelated fixes.
- `main` accepts squash merges only, so the PR title becomes the commit subject. Write it accordingly.
- Update the matching row in `docs/parity.md` in the same PR. Set the status from what you verified, not what you intend. Contributors propose a status; a Windows maintainer confirms `done`.

**Before you open it**

- Run `npm run verify` and fix the failures your change causes.
- Re-read your diff. Remove debug output, unrelated edits and generated files.
- Check that no evidence or build output is staged. `dist/` and `.devdata/` are git-ignored; anything else is not.

**Verification**

Fill in the [PR template](.github/pull_request_template.md). Report each of the five categories from `AGENTS.md` separately, with the result or `NOT RUN`:

| Category | Roughly means |
| --- | --- |
| Synthetic replay | Unit tests, fixtures, mock or synthetic provider, isolated e2e. `npm run verify` belongs here; state which OS you ran it on |
| Real Windows | Executed on a real Windows host |
| Real provider | A real provider's authentication and inference, end to end |
| Desktop interaction | A person operating the UI, including native dialogs |
| Install/update | Installing, upgrading and uninstalling a built package |

One category never substitutes for another. A macOS run, a `path.win32` assertion or a mock-provider run is not Windows or real-provider evidence. Not having credentials or a Windows machine is fine; write `NOT RUN`.

**Evidence and data**

- A change to user-visible behavior needs screenshots. Attach them to the PR. Do not commit them: screenshots, session transcripts and other evidence stay outside the repository.
- Use synthetic data only. Never put real credentials or production data in code, tests, fixtures, logs or screenshots.

## Maintainer acceptance

The Windows maintainers' own testing is the routine basis for acceptance. A row becomes `done` in `docs/parity.md` only after a Windows maintainer confirms it. Your own test run, and any agent's, is "contributor self-tested" until a Windows maintainer has reviewed it. It is useful, and it is not acceptance. Describe your results as self-tested, and expect follow-up requests for desktop interaction and install/update checks.

Before an official release, the product owner does a final product acceptance on their own Windows 11 acceptance machine, which may be operated by an agent. This confirms that the Windows version matches Tivano's design philosophy. It is not part of PR review, and it does not replace reporting the five verification categories above.

## Coding agents

You may use an AI coding agent. If you do:

- Make the agent follow `AGENTS.md`, including the parity target, the read-only reference source, the evidence rules and the five verification categories.
- In the PR, say which parts the agent generated and which parts a person has reviewed. An agent's own test run is labelled "agent self-tested" until a Windows maintainer has reviewed it.
- Do not have the agent change the technology stack without a Windows maintainer's decision record. Once one exists, an agent may carry out the change. See [Changing the stack or architecture](#changing-the-stack-or-architecture).
- You are responsible for what you submit. Read the diff before you open the PR.

## Code style

- Follow the surrounding code: naming, comment density, file layout. Source lives in `src/main`, `src/preload`, `src/renderer` and `src/shared`, with tests under `tests/`. Implementation boundaries are in [docs/architecture.md](docs/architecture.md).
- Do not reformat or refactor code unrelated to your change.
- New source files carry the same two-line header as existing ones: `Tivano Windows — derived from Tivano (AGPL-3.0), modified <date>.` followed by `Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app`.
- Every new user-visible string needs English and Simplified Chinese:
  - The English source text is the key. The UI calls `t("English text")` (see `src/renderer/locale.tsx`), and a missing translation falls back to the English key.
  - Add the zh-Hans value to the `zhHans` table in `src/renderer/i18n.ts`.
  - Placeholders are positional: `%@` for objects and `%d` for counts.
  - Where a string exists in the macOS baseline, reuse its Simplified Chinese wording. The tests check shared keys against a fixture.

## License and attribution

- Contributions are licensed under AGPL-3.0, the same as this repository's [LICENSE](LICENSE). There is no CLA. Submit only work you have the right to contribute under that license.
- Keep the attribution `Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app` in the About screen (or an equally visible place), in the README and in source-file copyright notices.
- Check the license of every new dependency, image, font and brand asset individually before you add it, and say what you checked in the PR. If a license cannot be confirmed, do not add the item.
- Do not copy the macOS source tree, or images, fonts and brand assets from it.
- Keep `LICENSE`, `THIRD_PARTY_NOTICES.md` and `TRADEMARK.md` intact. The Droppy names and icon are not licensed with the code; see [TRADEMARK.md](TRADEMARK.md).
- Changes to license, attribution, brand or icons need the product owner's sign-off.
