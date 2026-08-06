#!/usr/bin/env bash
set -euo pipefail

contract="${1:-}"
[ -z "${contract}" ] && echo "❌ usage: $0 <contract>" >&2 && exit 2

case "${contract}" in
arch)
  test -f bin/releaser.ts
  test -f src/lib/release/ports.ts
  test -f src/adapters/terminal/console-io.ts
  rg -q 'console\.|process\.(stdin|stdout|stderr|exitCode)|Bun\.(spawn|file)|node:(fs|path|process)|from .commander.' src/lib && echo '❌ terminal, filesystem, process, or CLI IO leaked into src/lib' >&2 && exit 1
  rg -q "from ['\"](\\.\\./)+adapters(?:/|['\"])" src/lib && echo '❌ src/lib imports an adapter (forbidden upward dependency)' >&2 && exit 1
  for config in knip.json knip.llm.json knip.production.json knip.production.llm.json; do
    jq -e '.entry | index("bin/releaser.ts") != null' "${config}" >/dev/null || {
      echo "❌ ${config} must retain bin/releaser.ts as a real entry" >&2
      exit 1
    }
  done
  ;;
release-backup-order)
  yq -o=json '.' atomi_release.yaml | jq -e '
    .schemaVersion == 2 and
    .release.hooks.prepare[0] == {"phase":"beforeWrite","command":"./scripts/release/backup-changelog.sh"} and
    .release.github == false'
  # D5: the releaser owns bumping, so this repository must express its own bumps
  # as configuration rather than as a script. Asserted both ways round — the
  # entries must exist, AND no hook may reintroduce a bump script — because a
  # capability that is merely deleted is one that gets re-grown as a shell script
  # the next time someone needs it in a hurry.
  yq -o=json '.' atomi_release.yaml | jq -e '
    [.release.bumps[].type] as $types |
    ($types | index("plain-version") != null) and ($types | index("node-version") != null)' >/dev/null || {
    echo '❌ atomi_release.yaml must bump its own VERSION and package.json via release.bumps' >&2
    exit 1
  }
  if yq -o=json '.' atomi_release.yaml | jq -e '[.release.hooks.prepare[].command, .release.hooks.success[]] | any(test("bump"))' >/dev/null 2>&1; then
    echo '❌ bumping is the releaser own capability; it must not be reintroduced as a hook or script' >&2
    exit 1
  fi
  ! test -f scripts/release/bump.sh
  ;;
changelog-asset)
  test -f Changelog.old.md
  yq -o=json '.' atomi_release.yaml | jq -e '
    .release.commit.assets | index("Changelog.old.md") != null'
  rg -F -- '--release-notes ./IncrementalChangelog.md' scripts/release/publish.sh
  ;;
release-artifacts)
  yq -o=json '.' .goreleaser.yaml | jq -e '
    (.archives | length) > 0 and
    (.checksum.name_template | length) > 0 and
    ([.release.extra_files[].glob] | index("scripts/release/install.sh") != null)'
  ;;
nfpms)
  yq -o=json '.' .goreleaser.yaml | jq -e '
    [.nfpms[].formats[]] as $formats |
    ($formats | index("deb") != null) and ($formats | index("rpm") != null)'
  ;;
homebrew-cask)
  yq -o=json '.' .goreleaser.yaml | jq -e '
    (.homebrew_casks | length) > 0 and
    ([.homebrew_casks[].hooks.post.install] | join("\n") | contains("com.apple.quarantine"))'
  ;;
fury-wiring)
  rg -F './scripts/release/publish.sh' .github/workflows/cd.yaml
  rg -F './scripts/release/fury.sh' scripts/release/publish.sh
  stage_line="$(rg -nF 'goreleaser release --clean --skip=publish --release-notes ./IncrementalChangelog.md' scripts/release/publish.sh | cut -d: -f1)"
  fury_line="$(rg -nF './scripts/release/fury.sh' scripts/release/publish.sh | cut -d: -f1)"
  publish_line="$(rg -nF 'goreleaser release --clean --release-notes ./IncrementalChangelog.md' scripts/release/publish.sh | cut -d: -f1)"
  [ "${stage_line}" -lt "${fury_line}" ] && [ "${fury_line}" -lt "${publish_line}" ] || {
    echo '❌ packages must be staged and sent to Gemfury before GoReleaser publishes GitHub + cask' >&2
    exit 1
  }
  rg -F -- '--config "${credential_config}"' scripts/release/fury.sh
  ! rg -F '${FURY_TOKEN}@' scripts/release/fury.sh
  # The Gemfury push is TEMPORARILY non-fatal (owner ruling). Suspending the
  # fatality turns a failing check green, so the only remaining signal is the
  # warning annotation — and a signal that can be tidied away without CI
  # noticing is not a signal. Both halves are asserted together:
  #   - the guarded form, so fatality cannot be left suspended by accident
  #   - the annotation, so the degradation cannot be silently un-announced
  # RESTORING FATALITY IS A DELIBERATE ACT: drop the guard, drop the annotation,
  # and drop these two assertions in the SAME commit. That is the point — the
  # restore shows up in the diff instead of resting on someone's memory.
  rg -F 'if ! ./scripts/release/fury.sh; then' scripts/release/publish.sh || {
    echo '❌ the Gemfury push must keep its guarded form while non-fatality stands (or restore fatality and drop this assertion)' >&2
    exit 1
  }
  rg -F '::warning title=Gemfury push failed' scripts/release/publish.sh || {
    echo '❌ a non-fatal Gemfury push must announce itself as a workflow warning; a green run may not hide a dead channel' >&2
    exit 1
  }
  ;;
changelog-format)
  # The generated changelog must be what the formatter would already produce.
  # Emitting markdown a formatter rewrites makes every adopting repository fail
  # its own format gate on a file nobody edited — and the exclusion workaround
  # only protects repositories that know to add it.
  #
  # ⚠️ THIS EXISTS BECAUSE THE ALTERNATIVE FAILS SILENTLY. A formatter release
  # could change what canonical means, and without this the breakage would reach
  # adopters one at a time, invisibly. Here it breaks OUR ci first.
  # Name the preconditions rather than inferring them from exit codes. A missing
  # `diff` makes the control below look like it PASSED — every comparison
  # "differs" when the comparator is absent — while the real assertions fail for
  # a reason that has nothing to do with the format. Measured, not imagined.
  for required in prettier diff; do
    command -v "${required}" >/dev/null 2>&1 || {
      echo "❌ ${required} is not available, so this check cannot run (it would report a false failure)" >&2
      exit 1
    }
  done
  tmp="$(mktemp -d)"
  before="$(mktemp -d)"
  trap 'rm -rf "${tmp}" "${before}"' EXIT
  # A must-differ control: if the formatter does not rewrite THIS, it did not run
  # at all, and every "unchanged" below would be meaningless.
  printf '#   Bad   Spacing\n\n\n\ntext   here\n' >"${tmp}/control.md"
  cp tests/fixtures/golden/*-notes.md "${tmp}/"
  cp "${tmp}"/*.md "${before}/"
  prettier --write "${tmp}"/*.md >/dev/null 2>&1 || true
  if diff -q "${before}/control.md" "${tmp}/control.md" >/dev/null 2>&1; then
    echo '❌ the formatter did not rewrite the control, so this check proves nothing' >&2
    exit 1
  fi
  for generated in "${tmp}"/*-notes.md; do
    name="$(basename "${generated}")"
    if ! diff -q "${before}/${name}" "${generated}" >/dev/null 2>&1; then
      echo "❌ generated changelog notes are not formatter-stable: ${name}" >&2
      diff "${before}/${name}" "${generated}" >&2 | head -10
      exit 1
    fi
  done
  ;;
installer-checksum)
  rg -F 'checksums.txt' scripts/release/install.sh
  rg -e 'sha256sum -c|shasum -a 256' scripts/release/install.sh
  ;;
installer-timeouts)
  curl_lines="$(rg '^[[:space:]]*curl ' scripts/release)"
  [ -z "${curl_lines}" ] && echo "❌ no release curl commands found" >&2 && exit 1
  bad_lines="$(printf '%s\n' "${curl_lines}" | awk '!/--connect-timeout/ || !/--max-time/')"
  [ -n "${bad_lines}" ] && printf '❌ curl missing timeout guard:\n%s\n' "${bad_lines}" >&2 && exit 1
  ;;
installation-parity)
  rg -F 'scripts/release/install.sh' .goreleaser.yaml
  rg -F "name_template: '{{ .ProjectName }}_{{ .Os }}_{{ .Arch }}'" .goreleaser.yaml
  rg -F 'checksums.txt' .goreleaser.yaml
  rg -F 'releaser_<os>_<arch>.tar.gz' INSTALLATION.md
  ;;
nix-release-wiring)
  rg -F 'releaser = pkgs.stdenv.mkDerivation' nix/packages.nix
  rg -F 'nix build .#releaser' .github/workflows/cd.yaml
  ;;
*)
  echo "❌ unknown CLI contract: ${contract}" >&2
  exit 2
  ;;
esac

echo "✅ CLI contract passed: ${contract}"
