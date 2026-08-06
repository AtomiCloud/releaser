import { ReleaserError } from '../errors';

/** A bump refused rather than guessed. Names the file and the field every time. */
export class BumpError extends ReleaserError {}

/**
 * The runtime-named bump presets.
 *
 * A preset knows the ONE field it owns and, usually, a default path. A
 * configuration entry may override the path but never the field: the field is
 * what makes a preset a preset.
 *
 * Two rules are shared by every preset, and both exist so that a bump is either
 * visibly correct or visibly red — never quietly nothing:
 *
 *  1. **NEVER CREATE A FIELD, ONLY REPLACE ONE.** Writing a version into a file
 *     that does not declare one is a project-shape change, not a bump. An absent
 *     field is an error naming the file and the field.
 *  2. **EXACTLY ONE OCCURRENCE.** Zero is `absent`, two or more is `ambiguous`.
 *     There is no first-match-wins, because a bump that silently picks the wrong
 *     one of two candidates is worse than a bump that refuses. This is not our
 *     invention: dotnet-base's own `bump.sh` already errors on a count that is
 *     not exactly one, so the rule is what the thing being replaced enforced.
 */
export type BumpTypeName = 'node-version' | 'dart-version' | 'dotnet-version' | 'plain-version';

interface BumpOutcome {
  /** Full new content, byte-identical to the old apart from the field. */
  readonly content: string;
  /** What the field held before, for reporting. */
  readonly from: string;
}

export interface BumpPreset {
  readonly type: BumpTypeName;
  /**
   * Default path relative to the repository root, or `null` when no default can
   * be correct and the configuration must name the file itself.
   */
  readonly defaultFile: string | null;
  /** Human-readable name of the single field this preset owns. */
  readonly field: string;
  apply(path: string, content: string, version: string): BumpOutcome;
}

/**
 * A version has to survive being pasted into JSON, YAML and XML without changing
 * the shape of the host document, so anything carrying whitespace or markup is
 * refused rather than written and then un-written.
 */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/**
 * Strips a single leading `v` when a digit follows, matching the `${version#v}`
 * every bump script being replaced performs. Without it a tag-shaped `v1.2.3`
 * would be written verbatim into `package.json`, which is not valid semver for
 * npm — a bump that succeeds and produces a broken manifest.
 */
export function normalizeVersion(version: string): string {
  return /^v\d/.test(version) ? version.slice(1) : version;
}

function assertUsableVersion(version: string): string {
  const normalized = normalizeVersion(version);
  if (!VERSION_PATTERN.test(normalized))
    throw new BumpError(
      `${JSON.stringify(version)} is not a usable version: expected only alphanumerics, dot, plus and hyphen, ` +
        'starting with an alphanumeric',
    );
  return normalized;
}

/**
 * Applies the exactly-one rule and reports which way it failed, because "the
 * field is missing" and "there are two of them" need different fixes.
 */
function soleMatch(matches: readonly RegExpMatchArray[], path: string, field: string): RegExpMatchArray {
  if (matches.length === 0)
    throw new BumpError(
      `${path} declares no ${field}; refusing to create one, because introducing a version field is a ` +
        'project-shape change rather than a bump',
    );
  if (matches.length > 1)
    throw new BumpError(
      `${path} declares ${field} ${matches.length} times; refusing to guess which one to bump — ` +
        'name the file explicitly or remove the duplicate',
    );
  return matches[0] as RegExpMatchArray;
}

/** Replaces exactly the captured group, leaving every other byte untouched. */
function replaceCapture(content: string, match: RegExpMatchArray, capture: string, version: string): string {
  const start = (match.index ?? 0) + match[0].indexOf(capture);
  return content.slice(0, start) + version + content.slice(start + capture.length);
}

function buildPreset(
  type: BumpTypeName,
  defaultFile: string | null,
  field: string,
  pattern: RegExp,
  captureIndex: number,
): BumpPreset {
  return {
    type,
    defaultFile,
    field,
    apply(path, content, version) {
      const normalized = assertUsableVersion(version);
      const matches = [...content.matchAll(pattern)];
      const match = soleMatch(matches, path, field);
      const from = match[captureIndex] as string;
      return { content: replaceCapture(content, match, from, normalized), from };
    },
  };
}

/**
 * `"version": "…"` at the top level of a JSON manifest.
 *
 * Anchored to a two-space indent so a nested `version` inside `dependencies` or
 * a workspace entry cannot be mistaken for the manifest's own.
 */
const NODE_VERSION = /^ {2}"version"\s*:\s*"([^"]*)"/gm;

/** `version: …` at column zero of a pubspec, i.e. the document's own version. */
const DART_VERSION = /^version\s*:\s*["']?([^\s"'#]+)["']?/gm;

/** A single `<Version>…</Version>` MSBuild property. */
const DOTNET_VERSION = /<Version>([^<]*)<\/Version>/g;

/**
 * A plain-text `VERSION` file whose entire content is the version.
 *
 * The two shared rules still apply, mapped onto a file with no field syntax: a
 * file with no non-blank line has nothing to replace (absent), and one with more
 * than one has no single version to bump (ambiguous). Surrounding whitespace and
 * the trailing newline are preserved, so the file stays byte-identical apart from
 * the version itself.
 */
const PLAIN_VERSION = /^[ \t]*(\S+)[ \t]*$/gm;

const PRESETS: readonly BumpPreset[] = [
  buildPreset('node-version', 'package.json', 'a top-level "version"', NODE_VERSION, 1),
  buildPreset('dart-version', 'pubspec.yaml', 'a top-level version', DART_VERSION, 1),
  // dotnet ships NO default: measured across the authoritative trees the version
  // lives in App/App.csproj, in Version.props, and nowhere at all. Any default
  // would be wrong somewhere, and would write to the wrong file rather than
  // complain — so the configuration must name it.
  buildPreset('dotnet-version', null, 'a <Version> property', DOTNET_VERSION, 1),
  buildPreset('plain-version', 'VERSION', 'a version line', PLAIN_VERSION, 1),
];

const BY_NAME = new Map(PRESETS.map(preset => [preset.type, preset]));

export function bumpPreset(type: BumpTypeName): BumpPreset {
  const preset = BY_NAME.get(type);
  if (preset === undefined) throw new BumpError(`unknown bump type ${JSON.stringify(type)}`);
  return preset;
}

export function bumpPresetNames(): readonly BumpTypeName[] {
  return PRESETS.map(preset => preset.type);
}

/**
 * The path a bump entry acts on: its override when it names one, otherwise the
 * preset's default. A type with no default and no override is a configuration
 * error rather than a runtime guess.
 */
export function bumpPath(type: BumpTypeName, file: string | null): string {
  const preset = bumpPreset(type);
  const path = file ?? preset.defaultFile;
  if (path === null) throw new BumpError(`${type} has no default file, so the bump entry must name one explicitly`);
  return path;
}
