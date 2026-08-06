#!/usr/bin/env bash
set -euo pipefail

# Release orchestration (mirrors sulfone.iridium):
#   publish.sh            → real release: stage packages, push to Gemfury, then publish GH + cask
#   publish.sh --snapshot → dry-run: build everything into dist/ with NO publish
SNAPSHOT=0
[ "${1:-}" = "--snapshot" ] && SNAPSHOT=1

# Prebuilt binaries go into prebuilt/ (survives GoReleaser's --clean, unlike dist/).
echo "🔨 Compiling prebuilt Bun binaries into prebuilt/ ..."
COMPILE_OUTDIR="prebuilt" ./scripts/release/compile.sh

if [ "${SNAPSHOT}" -eq 1 ]; then
  echo "📦 GoReleaser snapshot (no publish) ..."
  goreleaser release --snapshot --clean --skip=publish
  echo "✅ Snapshot complete — artifacts in dist/, nothing was published."
  exit 0
fi

[ -z "${HOMEBREW_TAP_TOKEN:-}" ] && echo "❌ 'HOMEBREW_TAP_TOKEN' env var not set" >&2 && exit 1
[ -z "${FURY_TOKEN:-}" ] && echo "❌ 'FURY_TOKEN' env var not set" >&2 && exit 1
[ -z "${GITHUB_TOKEN:-}" ] && echo "❌ 'GITHUB_TOKEN' env var not set" >&2 && exit 1

# Release notes = this version's changelog section (diff of Changelog.md vs Changelog.old.md).
echo "⚙️ Generating changelog diff ..."
if [ ! -f Changelog.md ] || [ ! -f Changelog.old.md ]; then
  touch IncrementalChangelog.md
else
  set +e
  diff --new-line-format='' --unchanged-line-format='' --old-line-format='%L' Changelog.md Changelog.old.md >IncrementalChangelog.md
  ec="$?"
  set -e
  [ "${ec}" -gt 1 ] && echo "❌ changelog diff failed" >&2 && exit 1
fi

echo "📦 Staging release artifacts without publishing ..."
goreleaser release --clean --skip=publish --release-notes ./IncrementalChangelog.md

# ⚠️ TEMPORARY NON-FATALITY (owner ruling). RESTORE THE `set -e` BEHAVIOUR ONCE FURY_TOKEN IS FIXED.
#
# This push has failed with HTTP 403 at EVERY tag since v1.0.0 — the token is
# present but rejected, so it is a credential problem rather than a code one.
# Under `set -e` that failure aborted the script HERE, before the GoReleaser
# call below, so the GitHub release and the Homebrew cask were never published
# once in this repository's history. One optional distribution channel was
# decapitating the primary ones.
#
# The line stays in this position deliberately: `cli-contracts.sh fury-wiring`
# asserts stage < fury < publish, and that ordering is the contract's intent.
# Only the FATALITY is suspended, not the order.
#
# ⚠️ THE WIDTH OF THIS GUARD IS WIDER THAN THE INCIDENT THAT MOTIVATED IT, AND
# THAT IS DELIBERATE. It catches ANY non-zero exit from fury.sh — not only the
# 403, but a missing FURY_TOKEN or FURY_ENDPOINT, a DNS or connect failure, a
# timeout, any curl error. The ruling suspends the CHANNEL, not one status code.
# What keeps that breadth from hiding a population: the annotation below fires
# on EVERY failure regardless of cause, so a transient network fault and a
# permanent credential refusal are both announced. The guard defers the failure;
# it does not conceal it. If the annotation is ever removed, this breadth stops
# being safe — which is why `cli-contracts.sh fury-wiring` asserts both.
echo "📤 Pushing Linux packages to Gemfury ..."
if ! ./scripts/release/fury.sh; then
  # A GitHub Actions warning annotation, so a GREEN run still VISIBLY carries the
  # degradation in its summary. stderr alone is not loud enough: suspending the
  # fatality turns a failing check into a passing one, and a green that quietly
  # means "one channel is dead" is exactly the check that stops being read.
  echo "::warning title=Gemfury push failed (temporarily non-fatal)::The Linux deb/rpm channel did NOT publish for this release. This is a TEMPORARY owner ruling so that the GitHub release and Homebrew cask can publish at all. RESTORE FATALITY in scripts/release/publish.sh once FURY_TOKEN is fixed (it is present but rejected with HTTP 403, so it is a permission on push.fury.io/atomicloud)."
  echo "⚠️ Gemfury push FAILED — continuing so the GitHub release and cask still publish." >&2
  echo "⚠️ This is a TEMPORARY owner ruling; restore fatality once FURY_TOKEN is fixed." >&2
fi

echo "📦 GoReleaser release (creates the GitHub release, publishes the cask) ..."
goreleaser release --clean --release-notes ./IncrementalChangelog.md

echo "✅ Release complete."
