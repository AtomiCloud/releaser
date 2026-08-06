import type { ITagReader } from './ports';

/**
 * Stable, machine-readable identifiers for every refusal. They are part of the
 * CLI contract: CI jobs and hooks grep for them.
 */
type GuardCode = 'tag-collision' | 'tag-not-visible' | 'invalid-version' | 'shallow-clone' | 'not-a-git-repo';

export interface GuardRefusal {
  readonly code: GuardCode;
  readonly message: string;
}

/** `1.2.3`, `v1.2.3`, `v1.2.3-rc.1`, `1.2.3+build.4`. */
const FULL_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

interface SemVer {
  readonly raw: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string;
}

/**
 * Parses a full `x.y.z` version, optionally `v`-prefixed and optionally
 * carrying a prerelease or build suffix.
 *
 * Returns `null` for anything else, which is what makes floating major tags
 * safe: `semantic-release-major-tag` mints and **moves** `v3` and `v3.1`, so
 * counting them would make every release refuse itself.
 */
function parseVersion(tag: string): SemVer | null {
  const match = FULL_VERSION.exec(tag);
  if (match === null) return null;
  const dash = tag.indexOf('-');
  return {
    raw: tag,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: dash >= 0 ? tag.slice(dash + 1) : '',
  };
}

function compareVersion(left: SemVer, right: SemVer): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  // A release outranks its own prereleases; beyond that lexical order is enough
  // for the only question asked here — "is anything unreachable at least as
  // high as what we are about to compute".
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === '') return 1;
  if (right.prerelease === '') return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

export function renderRefusal(refusal: GuardRefusal): string {
  return `${refusal.code}: ${refusal.message}`;
}

interface TagSnapshot {
  readonly refusal: GuardRefusal | null;
  readonly all: readonly string[];
  readonly visible: readonly string[];
}

/**
 * Refuses to compute a release onto a version that a tag already occupies.
 *
 * The hazard this closes, measured on a live repository: `git tag --merged
 * <branch>` returned **zero** tags, so the releaser computed `1.0.0` from
 * scratch — while the repository already carried `v1.0.0` and ten further
 * v-tags on refs the release branch could not reach. Three properties made
 * that fatal rather than merely wrong: tag validation checked the tag's NAME
 * and not its existence; tag creation carried no `-f`, so a collision errors
 * instead of overwriting; and tagging happens AFTER the release commit.
 *
 * So the failure mode is not "the release stops". The release commit lands,
 * the changelog is written, the assets are committed — and only *then* does
 * tagging fail, leaving a committed release with no tag on the branch about to
 * be pushed. That instance was cleared by deleting four tags; the instance
 * closed and the class stayed open. This is the class fix.
 *
 * **Two of the four blocking tags were the human owner's own.** A
 * minter-sensitive guard would have waved them through, so identity is kept
 * unrepresentable in {@link ITagReader} rather than merely unconsulted.
 */
export class TagGuard {
  constructor(private readonly tags: ITagReader) {}

  /**
   * Refuses when the repository holds version tags that `HEAD` cannot reach.
   *
   * This is the arm that catches the measured incident, and it is the only
   * check possible *before* a version has been computed — which is exactly
   * when the release path needs an answer.
   */
  async checkVisibility(): Promise<GuardRefusal | null> {
    const snapshot = await this.snapshot();
    if (snapshot.refusal !== null) return snapshot.refusal;

    const versions = snapshot.all.map(parseVersion).filter((tag): tag is SemVer => tag !== null);
    const visible = new Set(snapshot.visible);
    const unreachable = versions.filter(tag => !visible.has(tag.raw));
    if (unreachable.length === 0) return null;

    const highest = unreachable.reduce((left, right) => (compareVersion(left, right) >= 0 ? left : right));
    return {
      code: 'tag-not-visible',
      message:
        `${unreachable.length} version tag(s) exist in this repository but are NOT reachable from HEAD ` +
        `(highest: ${highest.raw}; all: ${unreachable.map(tag => tag.raw).join(', ')}). ` +
        'The next version is computed from reachable tags only, so it can be computed onto one of these. ' +
        'Tagging happens after the release commit, so the commit and changelog would land and only then ' +
        "would tagging fail, leaving a committed release with no tag. Fetch the tags into this branch's " +
        'history, or delete them deliberately, before releasing.',
    };
  }

  /**
   * Refuses when a tag for `version` already exists anywhere in the repository
   * — reachable or not, annotated or lightweight, whoever created it.
   */
  async checkVersion(version: string): Promise<GuardRefusal | null> {
    if (parseVersion(version) === null) {
      return {
        code: 'invalid-version',
        message:
          `\`${version}\` is not a full version (expected \`x.y.z\`, optionally \`v\`-prefixed); ` +
          'refusing rather than guessing what to check',
      };
    }

    const snapshot = await this.snapshot();
    if (snapshot.refusal !== null) return snapshot.refusal;

    const bare = version.startsWith('v') ? version.slice(1) : version;
    const candidates = [bare, `v${bare}`];
    const taken = snapshot.all.filter(tag => candidates.includes(tag));
    if (taken.length === 0) return null;

    return {
      code: 'tag-collision',
      message:
        `tag(s) ${taken.join(', ')} already exist in this repository, so version ${bare} is already taken. ` +
        "Existence is the only test applied: the tag's author, date, annotation and reachability are not " +
        'consulted, because a tag minted by a human owner blocks a release exactly as hard as one minted ' +
        'by a machine.',
    };
  }

  /**
   * Establishes that the guard is able to answer at all.
   *
   * A guard that cannot read the tags must refuse, not pass: "I could not
   * look" and "I looked and it is clear" are different verdicts, and only one
   * of them is safe to release on. So a shallow clone and an unreadable
   * repository are REFUSALS, never skips.
   */
  private async snapshot(): Promise<TagSnapshot> {
    const empty = { all: [], visible: [] } as const;
    try {
      if (await this.tags.isShallow()) {
        return {
          ...empty,
          refusal: {
            code: 'shallow-clone',
            message:
              'this is a shallow clone, so the tag set is incomplete and a collision cannot be ruled out. ' +
              'Refusing instead of reporting a clear result from an incomplete population. Fetch full ' +
              'history and tags (`git fetch --unshallow --tags`) before releasing.',
          },
        };
      }
      return { refusal: null, all: await this.tags.allTags(), visible: await this.tags.visibleTags() };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ...empty, refusal: { code: 'not-a-git-repo', message: `cannot inspect tags: ${detail}` } };
    }
  }
}
