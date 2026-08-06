---
id: changelog-format
title: Changelog Format and What Adoption Changes
---

# Changelog format, and what adopting the releaser changes

The releaser emits changelog entries that a markdown formatter already considers canonical: **dash
bullets, and a single blank line between blocks.**

This is not cosmetic. Generated changelogs used to carry `*` bullets and double blank lines, which
prettier rewrites — so a repository releasing through the tool would fail its own format gate on a
file nobody had edited, every single release. The emitted shape is now the formatter's own, and
`scripts/validate/cli-contracts.sh changelog-format` asserts it stays that way, so a future formatter
release breaks this repository's CI before it reaches anyone else's.

## ⚠️ What you will see on your first release after adopting

**Your existing `Changelog.md` already contains `*` bullets from whatever generated it before.** New
entries are written with `-`. So on the first release after adoption your file is **mixed** — and the
first time any formatter runs over it, it rewrites the whole file at once.

**That is a one-time event, not a recurring one.** The fix stops the conflict recurring; it cannot
retroactively change history that is already on disk.

If that whole-file diff would be confusing to review, normalise the file yourself in a separate
commit — running your formatter over `Changelog.md` once, on its own, produces exactly the same result
with none of it tangled up in a release.

### The worked example is in this repository

`Changelog.md` at tag `v2.0.0` shows both states in one file:

- the `2.0.0` section uses **dash** bullets (lines 9, 13, 17)
- every earlier section, from `1.4.0` down, still uses **asterisks** (lines 24, 31, 38, and on)

That is precisely what an adopting repository looks like immediately after its first release on the
new format. Read it rather than taking this page's word for it.

## Unmeasured: your format gate may fail once

**This has not been tested against any real adopter's CI and is reasoning, not a finding.** If a
repository's CI asserts something like "the formatter produced no diff", the one-time rewrite could
fail that check on the first release after adoption. Normalising the changelog in its own commit,
before or after that release, avoids it.

It is stated here because it costs nothing if it turns out to be wrong.

## What this does not change

- **No content is lost or reworded.** Only the bullet character and blank-line spacing differ.
- **Markdown treats `-` and `*` identically**, so anything rendering your changelog is unaffected.
- **Older entries are never rewritten by the releaser.** It appends; your formatter is what
  normalises history, and only if you run one.
