# Tivano Windows: rules for contributors and coding agents

Tivano Windows is an independent Electron + React + TypeScript derivative of Tivano for macOS. These rules apply to human contributors and coding agents alike.

## Stack and architecture

- Electron + React + TypeScript. Implementation boundaries are in [docs/architecture.md](docs/architecture.md).
- System behavior (windows, paths, shortcuts, processes, credentials) may be adapted to Windows. Features and product style target parity with the macOS baseline below.

## Parity target and reference source

- The target is **Tivano for macOS v2.2.34**, commit `d4c27410553677354bd08e70becd20ebbd240183`, recorded in [docs/source-baseline.json](docs/source-baseline.json). Do not substitute main, dev or another tag.
- The reference source is read-only. Fetch it from the GitHub tag `v2.2.34` ([release](https://github.com/elijah7x/tivano/releases/tag/v2.2.34)). Do not develop inside it or run its scripts.
- Do not copy the whole Mac source tree. Do not copy images, fonts or brand assets whose licensing has not been verified.

## Verification reporting

- Report these five categories separately: **synthetic replay**, **real Windows**, **real provider**, **desktop interaction**, **install/update**.
- Anything not executed is reported as `NOT RUN`. One category never substitutes for another: a macOS run, a `path.win32` assertion or a mock-provider run is not Windows or real-provider evidence.
- An agent's own test run is not maintainer acceptance. Label such results "agent self-tested" until a maintainer has reviewed them.

## Evidence and data

- Keep screenshots, session transcripts and other evidence outside the repository.
- Do not use real credentials or production data in code, tests, fixtures or logs. Use synthetic data.

## License and attribution

- Keep `LICENSE`, `THIRD_PARTY_NOTICES.md` and `TRADEMARK.md`, and comply with the AGPL and the attribution obligations they impose.
- Mark this project clearly as a modified derivative version, with the modification date. Do not imply endorsement by the original authors.
- Keep the attribution `Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app` in the About screen (or an equally visible place), in the README and in source-file copyright notices.
- Keeping third-party notices does not mean the listed components are included. Check the license of every dependency, image, font and brand asset individually before introducing it.
