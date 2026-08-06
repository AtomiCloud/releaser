import type { RawCommit } from '../commits/model';
import type { ReleaserConfig } from '../config/model';

export interface LoadedConfig {
  readonly config: ReleaserConfig;
  readonly sourceVersion: 1 | 2;
  readonly warnings: readonly string[];
  readonly legacyGitlintPath: string;
}

export interface IConfigRepository {
  load(path: string): Promise<LoadedConfig>;
  writeCanonical(path: string, config: ReleaserConfig): Promise<void>;
}

export interface IFileSystem {
  readText(path: string): Promise<string>;
  readTextIfExists(path: string): Promise<string | null>;
  writeAtomic(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  hashIfExists(path: string): Promise<string | null>;
  matchesAny(path: string, patterns: readonly string[]): boolean;
}

export interface IGit {
  currentBranch(): Promise<string>;
  isClean(): Promise<boolean>;
  reachableTags(): Promise<readonly string[]>;
  commitsSince(tag: string | null): Promise<readonly RawCommit[]>;
  repositoryUrl(): Promise<string | null>;
  githubRepository(): Promise<string | null>;
  validateTag(tag: string): Promise<void>;
  changedFiles(): Promise<readonly string[]>;
  stage(paths: readonly string[]): Promise<void>;
  commit(message: string): Promise<void>;
  createTag(tag: string): Promise<void>;
  push(branch: string, tag: string): Promise<void>;
}

/**
 * Reads tag NAMES from a repository.
 *
 * Deliberately exposes no way to read a tag's tagger, committer, date or
 * message. The collision guard must refuse an existing tag REGARDLESS OF WHO
 * MINTED IT: of the four tags that blocked a release on this fleet, two were
 * the human owner's, and a minter-sensitive guard would have waved them
 * through. Keeping identity out of this interface makes that failure
 * unrepresentable rather than merely unwritten.
 */
export interface ITagReader {
  /** Every tag in the repository, reachable from `HEAD` or not. */
  allTags(): Promise<readonly string[]>;
  /** Only the tags reachable from `HEAD` — what version calculation can see. */
  visibleTags(): Promise<readonly string[]>;
  /** `false` unless the working copy is a shallow clone. */
  isShallow(): Promise<boolean>;
}

export interface IHookRunner {
  run(command: string): Promise<void>;
}

export interface GitHubReleaseRequest {
  readonly repository: string;
  readonly tag: string;
  readonly version: string;
  readonly notes: string;
  readonly commits: readonly RawCommit[];
  readonly successComment: string;
  readonly releasedLabels: readonly string[];
}

export interface IGitHub {
  publishRelease(request: GitHubReleaseRequest): Promise<void>;
}

export interface IClock {
  today(): string;
}
