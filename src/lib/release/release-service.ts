import type { RawCommit } from '../commits/model';
import { DEFAULT_CONFIG_PATH } from '../config/paths';
import type { ReleaserConfig } from '../config/model';
import { ReleaseError, ReleaserError } from '../errors';
import { bumpPath, bumpPreset } from './bump-presets';
import type { ConventionsService } from './conventions-service';
import type { HookTemplate } from './hook-template';
import { unifiedDiff } from './line-diff';
import type { NotesService } from './notes-service';
import type { IClock, IConfigRepository, IFileSystem, IGit, IGitHub, IHookRunner, LoadedConfig } from './ports';
import { renderRefusal, type TagGuard } from './tag-guard';
import type { ReleaseTag, VersionService } from './version-service';

export interface ReleasePreview {
  readonly config: ReleaserConfig;
  readonly sourceVersion: 1 | 2;
  readonly warnings: readonly string[];
  readonly version: string;
  readonly tag: string;
  readonly previousTag: string | null;
  readonly notes: string;
  readonly commits: readonly RawCommit[];
}

const LOCK_FILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;
const SKIP_CI = /\[(?:skip ci|ci skip)\]/i;

/**
 * `match` — the document on disk is byte-identical to what the configuration
 * generates. `missing` — no document exists at the configured path.
 * `drift` — a document exists and differs, i.e. it was hand-edited or the
 * configuration moved on without it.
 */
type ConventionsCheckStatus = 'match' | 'missing' | 'drift';

export interface ConventionsCheck {
  readonly status: ConventionsCheckStatus;
  /** The configured document path that was judged. */
  readonly path: string;
  /** The configuration the expected bytes were generated from. */
  readonly configPath: string;
  readonly expected: string;
  /** The bytes on disk, or `null` when the document is missing. */
  readonly actual: string | null;
  /** Unified diff of expected against actual; empty unless `status` is `drift`. */
  readonly diff: string;
  readonly warnings: readonly string[];
}

/**
 * Single-quotes a path for a POSIX shell, closing and reopening the quote
 * around any embedded quote. The remedy is an instruction the operator is meant
 * to paste, so a path containing whitespace must not split into two arguments
 * and silently regenerate a different file than the one that was judged.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function remedyCommand(configPath: string): string {
  return configPath === DEFAULT_CONFIG_PATH
    ? 'releaser conventions'
    : `releaser conventions -c ${shellQuote(configPath)}`;
}

/**
 * Renders the operator-facing verdict: name the rule, name the remedy, then
 * show the difference. Kept in the domain so it is covered by the unit tier and
 * identical across every caller.
 */
export function describeConventionsCheck(check: ConventionsCheck): string {
  const remedy = remedyCommand(check.configPath);
  if (check.status === 'match') return `${check.path} is up to date with ${check.configPath}`;
  if (check.status === 'missing') {
    return [
      `D9: releaser-generated documents are regenerate-only, and ${check.path} is missing.`,
      `Run \`${remedy}\` to generate it.`,
    ].join('\n');
  }
  return [
    `D9: releaser-generated documents are regenerate-only, and ${check.path} has drifted from ${check.configPath}.`,
    `Hand-edits are not permitted; run \`${remedy}\` to regenerate it.`,
    '',
    check.diff,
  ].join('\n');
}

async function runPhase<T>(phase: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ReleaseError && error.phase === phase) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ReleaseError(`${phase} failed: ${message}`, phase);
  }
}

function assertAllowedBranch(config: ReleaserConfig, branch: string): void {
  if (!config.release.branches.includes(branch)) {
    throw new ReleaseError(
      `current branch "${branch}" is not allowed (expected one of: ${config.release.branches.join(', ')})`,
      'precondition',
    );
  }
}

function prependNotes(existing: string | null, title: string, notes: string): string {
  if (existing === null || existing.trim().length === 0) return `${title.trimEnd()}\n\n${notes.trimEnd()}\n`;
  const normalized = existing.replaceAll('\r\n', '\n');
  const heading = /^## /m.exec(normalized);
  if (heading === null || heading.index === undefined) {
    return `${normalized.trimEnd()}\n\n${notes.trimEnd()}\n`;
  }
  const preamble = normalized.slice(0, heading.index).trimEnd();
  const releases = normalized.slice(heading.index).trimStart();
  if (preamble.length === 0) return `${notes.trimEnd()}\n\n${releases}`;
  return `${preamble}\n\n${notes.trimEnd()}\n\n${releases}`;
}

async function lockHashes(fileSystem: IFileSystem): Promise<Readonly<Record<string, string | null>>> {
  const pairs = await Promise.all(LOCK_FILES.map(async path => [path, await fileSystem.hashIfExists(path)] as const));
  return Object.fromEntries(pairs);
}

function assertLocksUnchanged(
  before: Readonly<Record<string, string | null>>,
  after: Readonly<Record<string, string | null>>,
): void {
  for (const path of LOCK_FILES) {
    if (before[path] !== after[path]) throw new ReleaseError(`lockfile changed unexpectedly: ${path}`, 'asset-fence');
  }
}

function assertAssetFence(fileSystem: IFileSystem, changedFiles: readonly string[], assets: readonly string[]): void {
  const unexpected = changedFiles.filter(path => !fileSystem.matchesAny(path, assets));
  if (unexpected.length > 0) {
    throw new ReleaseError(
      `hook or generator changed files outside configured assets: ${unexpected.join(', ')}`,
      'asset-fence',
    );
  }
}

function latestVersion(latest: ReleaseTag | null): ReleaseTag | null {
  return latest;
}

export class ReleaseService {
  constructor(
    private readonly configs: IConfigRepository,
    private readonly files: IFileSystem,
    private readonly git: IGit,
    private readonly hooks: IHookRunner,
    private readonly github: IGitHub,
    private readonly versions: VersionService,
    private readonly notes: NotesService,
    private readonly conventions: ConventionsService,
    private readonly templates: HookTemplate,
    private readonly clock: IClock,
    private readonly guard: TagGuard,
  ) {}

  /**
   * Mandatory preflight. There is deliberately **no bypass flag**: the hazard
   * it closes is one where the release commit and changelog land and only the
   * tagging step fails, so an escape hatch here would only make that outcome
   * reachable on purpose.
   */
  private async refuseOnExistingTag(refusal: Awaited<ReturnType<TagGuard['checkVisibility']>>): Promise<void> {
    if (refusal !== null) throw new ReleaseError(renderRefusal(refusal), 'tag-guard');
  }

  /**
   * Applies the configured bumps for `version`.
   *
   * Every file is read and transformed BEFORE any is written, so a failure
   * anywhere leaves the tree untouched rather than half-bumped. Returns the
   * paths written, so a caller can report what it changed.
   */
  private async writeBumps(config: ReleaserConfig, version: string): Promise<readonly string[]> {
    const pending: { path: string; content: string }[] = [];
    for (const entry of config.release.bumps) {
      const path = bumpPath(entry.type, entry.file);
      const current = await this.files.readTextIfExists(path);
      if (current === null) throw new ReleaseError(`bump target ${path} does not exist`, 'write:versions');
      pending.push({ path, content: bumpPreset(entry.type).apply(path, current, version).content });
    }
    for (const write of pending) await this.files.writeAtomic(write.path, write.content);
    return pending.map(write => write.path);
  }

  /**
   * Stamps the configured version files without releasing.
   *
   * For manual repair and verification arms only — the release owns bumping, so
   * this exists so a human can re-stamp a tree, not so a template can invoke it.
   */
  async bump(version: string, configPath = DEFAULT_CONFIG_PATH): Promise<readonly string[]> {
    const loaded = await this.configs.load(configPath);
    return this.writeBumps(loaded.config, version);
  }

  async preview(configPath = DEFAULT_CONFIG_PATH): Promise<ReleasePreview | null> {
    const loaded = await this.configs.load(configPath);
    const branch = await this.git.currentBranch();
    assertAllowedBranch(loaded.config, branch);
    const latest = latestVersion(
      this.versions.latestTag(await this.git.reachableTags(), loaded.config.release.tagFormat),
    );
    const commits = await this.git.commitsSince(latest?.tag ?? null);
    const decision = this.versions.analyze(loaded.config, latest?.version ?? null, commits);
    if (decision === null) return null;
    const version = this.versions.format(decision.version);
    const tag = this.versions.formatTag(loaded.config.release.tagFormat, decision.version);
    await this.git.validateTag(tag);
    const notes = this.notes.render({
      config: loaded.config,
      version,
      previousTag: latest?.tag ?? null,
      newTag: tag,
      commits,
      repositoryUrl: await this.git.repositoryUrl(),
      date: this.clock.today(),
    });
    return {
      config: loaded.config,
      sourceVersion: loaded.sourceVersion,
      warnings: loaded.warnings,
      version,
      tag,
      previousTag: latest?.tag ?? null,
      notes,
      commits,
    };
  }

  async release(configPath = DEFAULT_CONFIG_PATH, dryRun = false): Promise<ReleasePreview | null> {
    // Arm 1, before anything is read, computed or written: the repository must
    // hold no version tag that HEAD cannot reach, because the next version is
    // computed from reachable tags only and could land on one of them.
    await this.refuseOnExistingTag(await this.guard.checkVisibility());
    if (!(await this.git.isClean())) throw new ReleaseError('working tree must be clean', 'precondition');
    const preview = await this.preview(configPath);
    if (preview === null) return preview;
    // Arm 2, once a concrete version exists but before any write: that exact
    // version's tag must be free anywhere in the repository.
    await this.refuseOnExistingTag(await this.guard.checkVersion(preview.version, preview.tag));
    if (dryRun) return preview;
    const beforeLocks = await lockHashes(this.files);

    for (const hook of preview.config.release.hooks.prepare.filter(candidate => candidate.phase === 'beforeWrite')) {
      await runPhase('prepare:beforeWrite', () =>
        this.hooks.run(this.templates.renderCommand(hook.command, preview.version, preview.notes)),
      );
    }

    await runPhase('write:conventions', () =>
      this.files.writeAtomic(preview.config.conventions.path, this.conventions.render(preview.config)),
    );
    await runPhase('write:changelog', async () => {
      const current = await this.files.readTextIfExists(preview.config.release.changelog.path);
      await this.files.writeAtomic(
        preview.config.release.changelog.path,
        prependNotes(current, preview.config.release.changelog.title, preview.notes),
      );
    });

    // The releaser owns the version number in every runtime it releases, so the
    // bump is a write phase of the release rather than a separate capability a
    // template has to remember to invoke. Every file is read and transformed
    // BEFORE any is written, so a failure anywhere leaves the tree untouched
    // rather than half-bumped.
    await runPhase('write:versions', () => this.writeBumps(preview.config, preview.version));

    for (const hook of preview.config.release.hooks.prepare.filter(candidate => candidate.phase === 'afterWrite')) {
      await runPhase('prepare:afterWrite', () =>
        this.hooks.run(this.templates.renderCommand(hook.command, preview.version, preview.notes)),
      );
    }

    assertLocksUnchanged(beforeLocks, await lockHashes(this.files));
    const changedFiles = await runPhase('asset-fence', () => this.git.changedFiles());
    assertAssetFence(this.files, changedFiles, preview.config.release.commit.assets);
    if (changedFiles.length === 0)
      throw new ReleaseError('release produced no configured asset changes', 'asset-fence');

    const message = this.templates.renderText(preview.config.release.commit.message, preview.version, preview.notes);
    if (SKIP_CI.test(message))
      throw new ReleaseError('release commit message contains a forbidden skip-CI token', 'commit');
    await runPhase('stage', () => this.git.stage(preview.config.release.commit.assets));
    await runPhase('commit', () => this.git.commit(message));
    await runPhase('post-commit-fence', async () => {
      if (!(await this.git.isClean())) {
        throw new ReleaseError('working tree is dirty after the release commit', 'post-commit-fence');
      }
    });
    await runPhase('tag', () => this.git.createTag(preview.tag));
    const branch = await this.git.currentBranch();
    await runPhase('push', () => this.git.push(branch, preview.tag));

    if (preview.config.release.github !== false) {
      const repository = await this.git.githubRepository();
      if (repository === null)
        throw new ReleaseError('GitHub release is enabled but origin is not a GitHub repository', 'github');
      await runPhase('github', () =>
        this.github.publishRelease({
          repository,
          tag: preview.tag,
          version: preview.version,
          notes: preview.notes,
          commits: preview.commits,
          successComment: this.templates.renderText(
            preview.config.release.github === false ? '' : preview.config.release.github.successComment,
            preview.version,
            preview.notes,
          ),
          releasedLabels: preview.config.release.github === false ? [] : preview.config.release.github.releasedLabels,
        }),
      );
    }

    for (const hook of preview.config.release.hooks.success) {
      await runPhase('success-hook', () =>
        this.hooks.run(this.templates.renderCommand(hook, preview.version, preview.notes)),
      );
    }
    if (!(await this.git.isClean())) throw new ReleaseError('working tree is dirty after release', 'postcondition');
    return preview;
  }

  async writeConventions(configPath = DEFAULT_CONFIG_PATH): Promise<LoadedConfig> {
    const loaded = await this.configs.load(configPath);
    await this.files.writeAtomic(loaded.config.conventions.path, this.conventions.render(loaded.config));
    return loaded;
  }

  /**
   * The read-only mirror of {@link writeConventions}: regenerates the document
   * in memory and compares it against the bytes on disk.
   *
   * Enforces D9 — releaser-generated documents are regenerate-only, so a
   * hand-edit is a violation and must be detectable without repairing it. This
   * path deliberately never calls `writeAtomic`: a check that silently fixes
   * what it judges cannot be run in CI to prove the tree is clean.
   *
   * A configuration that cannot be read, or a template that cannot render,
   * throws rather than reporting a match — "I could not look" and "I looked and
   * it is clean" are different verdicts.
   */
  async checkConventions(configPath = DEFAULT_CONFIG_PATH): Promise<ConventionsCheck> {
    const loaded = await this.configs.load(configPath);
    const expected = this.conventions.render(loaded.config);
    const path = loaded.config.conventions.path;
    const actual = await this.files.readTextIfExists(path);
    const base = { path, configPath, expected, actual, warnings: loaded.warnings } as const;
    if (actual === null) return { ...base, status: 'missing', diff: '' };
    if (actual === expected) return { ...base, status: 'match', diff: '' };
    return {
      ...base,
      status: 'drift',
      diff: unifiedDiff(expected, actual, {
        expectedLabel: `expected (generated from ${configPath})`,
        actualLabel: `actual (${path} on disk)`,
      }),
    };
  }
}

export function userMessage(error: unknown): string {
  if (error instanceof ReleaserError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
