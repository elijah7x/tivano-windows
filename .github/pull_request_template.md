## Summary

<!-- What changes and why. One PR does one thing. -->

## Related

<!-- Include "Closes #123" and, if this PR changes a parity row, add "Parity: <ID> -> <status>" (for example "Parity: P1-01 -> partial", with an optional "Parity-Notes: ..." line; never "done" or "deferred"). Do not edit docs/parity.md directly; parity statuses are batched onto main separately. -->

## Verification

Report each category separately with the result, or `NOT RUN`. One category never substitutes for another. Do not paste real credentials or production data.

- [ ] Synthetic replay: <!-- result, and the OS it ran on -->
- [ ] Real Windows: <!-- result, Windows edition/version, architecture, account type -->
- [ ] Real provider: <!-- result, or NOT RUN -->
- [ ] Desktop interaction: <!-- result, or NOT RUN -->
- [ ] Install/update: <!-- result, or NOT RUN -->

Tick a box once you have written its result, including `NOT RUN`. Results here are contributor self-tested until a Windows maintainer has reviewed them.

## Screenshots

<!-- Required for any user-visible change. Attach them here; do not commit them. -->

## Coding agent use

- [ ] No coding agent was used.
- [ ] A coding agent was used and followed AGENTS.md.

<!-- If an agent was used: what it generated, and which parts a person has reviewed. -->

## Product design (optional)

- [ ] This PR changes user-visible product design beyond platform adaptation (product owner input requested).

## Checklist

- [ ] I included a "Parity: <ID> -> <status>" line under Related (or this change has no parity row) and did not edit docs/parity.md.
- [ ] New user-visible strings have English and Simplified Chinese.
- [ ] New dependencies, images, fonts or other assets have had their licenses checked, or there are none.
