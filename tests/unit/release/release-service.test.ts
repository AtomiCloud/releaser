import { describe, expect, it } from 'bun:test';
import type { ReleaserConfig } from '../../../src/lib/config/model';
import { ConfigError, ReleaseError } from '../../../src/lib/errors';
import { ConventionsService } from '../../../src/lib/release/conventions-service';
import { HookTemplate } from '../../../src/lib/release/hook-template';
import { NotesService } from '../../../src/lib/release/notes-service';
import { describeConventionsCheck, ReleaseService, userMessage } from '../../../src/lib/release/release-service';
import { TagGuard } from '../../../src/lib/release/tag-guard';
import { VersionService } from '../../../src/lib/release/version-service';
import {
  FakeClock,
  FakeConfigRepository,
  FakeGit,
  FakeGitHub,
  FakeHookRunner,
  FakeTagReader,
  loadedConfig,
  MemoryFileSystem,
  TEST_CONFIG,
} from '../../helpers/fakes';

function fixture(config = TEST_CONFIG): {
  readonly subject: ReleaseService;
  readonly files: MemoryFileSystem;
  readonly git: FakeGit;
  readonly hooks: FakeHookRunner;
  readonly github: FakeGitHub;
  readonly tags: FakeTagReader;
} {
  const files = new MemoryFileSystem({ 'Changelog.md': '# Changelog\n', 'bun.lock': 'locked' });
  const git = new FakeGit();
  git.commits = [{ sha: 'a'.repeat(40), message: 'feat: add release' }];
  const hooks = new FakeHookRunner();
  const github = new FakeGitHub();
  const tags = new FakeTagReader();
  return {
    files,
    git,
    hooks,
    github,
    tags,
    subject: new ReleaseService(
      new FakeConfigRepository(loadedConfig(config)),
      files,
      git,
      hooks,
      github,
      new VersionService(),
      new NotesService(),
      new ConventionsService(),
      new HookTemplate(),
      new FakeClock(),
      new TagGuard(tags),
    ),
  };
}

describe('release service', () => {
  it('should keep dry-run pure', async () => {
    // Arrange
    const { subject, files, git } = fixture();
    const before = new Map(files.values);

    // Act
    const actual = await subject.release('atomi_release.yaml', true);

    // Assert
    expect(actual?.version).toBe('1.0.0');
    expect(files.values).toEqual(before);
    expect(git.calls).toEqual([]);
  });

  it('should execute writes, exact commit, tag, and atomic-push seam in order', async () => {
    // Arrange
    const config = {
      ...TEST_CONFIG,
      release: {
        ...TEST_CONFIG.release,
        hooks: {
          prepare: [
            { phase: 'beforeWrite' as const, command: './before ${version}' },
            { phase: 'afterWrite' as const, command: './after ${version}' },
          ],
          success: ['./success ${version}'],
        },
      },
    };
    const { subject, files, git, hooks } = fixture(config);

    // Act
    const actual = await subject.release();

    // Assert
    expect(actual?.version).toBe('1.0.0');
    expect(files.values.get('Changelog.md')).toContain('## 1.0.0');
    expect(files.values.get('docs/developer/CommitConventions.md')).toContain('## Types');
    expect(git.calls).toEqual([
      'stage:Changelog.md,docs/developer/CommitConventions.md',
      'commit',
      'tag:v1.0.0',
      'push:main:v1.0.0',
    ]);
    expect(git.committedMessage).toStartWith('release: 1.0.0\n\n## 1.0.0');
    expect(git.committedMessage).not.toMatch(/\[(skip ci|ci skip)\]/i);
    expect(hooks.commands).toEqual(["./before '1.0.0'", "./after '1.0.0'", "./success '1.0.0'"]);
  });

  it('should fail before staging when a hook changes an unexpected asset or lockfile', async () => {
    // Arrange
    const unexpected = fixture();
    unexpected.git.changed = ['unexpected.txt'];
    const lock = fixture({
      ...TEST_CONFIG,
      release: {
        ...TEST_CONFIG.release,
        hooks: { prepare: [{ phase: 'beforeWrite', command: './change-lock' }], success: [] },
      },
    });
    const renamed = fixture({
      ...TEST_CONFIG,
      release: {
        ...TEST_CONFIG.release,
        commit: {
          ...TEST_CONFIG.release.commit,
          assets: [...TEST_CONFIG.release.commit.assets, 'allowed.txt'],
        },
      },
    });
    renamed.git.changed = ['allowed.txt', 'outside.txt'];
    lock.hooks.run = async command => {
      lock.hooks.commands.push(command);
      lock.files.values.set('bun.lock', 'changed');
    };

    // Act / Assert
    await expect(unexpected.subject.release()).rejects.toThrow('outside configured assets');
    await expect(lock.subject.release()).rejects.toThrow('lockfile changed unexpectedly');
    await expect(renamed.subject.release()).rejects.toThrow('outside.txt');
    expect(unexpected.git.calls).toEqual([]);
    expect(lock.git.calls).toEqual([]);
    expect(renamed.git.calls).toEqual([]);
  });

  it('should stop before tag and push when the release commit leaves a dirty path', async () => {
    // Arrange
    const dirty = fixture();
    let cleanChecks = 0;
    dirty.git.isClean = async () => {
      cleanChecks += 1;
      return cleanChecks === 1;
    };

    // Act / Assert
    await expect(dirty.subject.release()).rejects.toThrow('dirty after the release commit');
    expect(dirty.git.calls).toEqual(['stage:Changelog.md,docs/developer/CommitConventions.md', 'commit']);
    expect(dirty.git.calls.some(call => call.startsWith('tag:') || call.startsWith('push:'))).toBe(false);
  });

  it('should reject an ambiguous hook template before invoking the hook runner', async () => {
    // Arrange
    const invalid = fixture({
      ...TEST_CONFIG,
      release: {
        ...TEST_CONFIG.release,
        hooks: {
          prepare: [{ phase: 'beforeWrite', command: "hook '${version}" }],
          success: [],
        },
      },
    });

    // Act / Assert
    await expect(invalid.subject.release()).rejects.toThrow('unterminated');
    expect(invalid.hooks.commands).toEqual([]);
    expect(invalid.git.calls).toEqual([]);
  });

  it('should validate the rendered tag before any mutation', async () => {
    // Arrange
    const invalid = fixture({
      ...TEST_CONFIG,
      release: { ...TEST_CONFIG.release, tagFormat: 'bad..${version}' },
    });
    invalid.git.tagValidationError = new Error('invalid tag ref');
    const before = new Map(invalid.files.values);

    // Act / Assert
    await expect(invalid.subject.preview()).rejects.toThrow('invalid tag ref');
    await expect(invalid.subject.release('atomi_release.yaml', true)).rejects.toThrow('invalid tag ref');
    await expect(invalid.subject.release()).rejects.toThrow('invalid tag ref');
    expect(invalid.files.values).toEqual(before);
    expect(invalid.hooks.commands).toEqual([]);
    expect(invalid.git.calls).toEqual([]);
    expect(invalid.git.validatedTags).toEqual(['bad..1.0.0', 'bad..1.0.0', 'bad..1.0.0']);
  });

  it('should prepend notes at byte zero when the changelog has no preamble', async () => {
    // Arrange
    const release = fixture();
    release.files.values.set('Changelog.md', '## 0.9.0 (2026-01-01)\n\nold release\n');

    // Act
    await release.subject.release();

    // Assert
    const changelog = release.files.values.get('Changelog.md');
    expect(changelog).toStartWith('## 1.0.0');
    expect(changelog).toContain('## 0.9.0 (2026-01-01)\n\nold release\n');
  });

  it('should publish the configured GitHub release payload and reject a non-GitHub origin', async () => {
    const config: ReleaserConfig = {
      ...TEST_CONFIG,
      release: {
        ...TEST_CONFIG.release,
        github: {
          enabled: true,
          successComment: 'Released ${version}: ${notes}',
          releasedLabels: ['released', 'shipped'],
        },
      },
    };
    const published = fixture(config);

    await published.subject.release();

    expect(published.github.requests).toHaveLength(1);
    expect(published.github.requests[0]).toMatchObject({
      repository: 'AtomiCloud/example',
      tag: 'v1.0.0',
      version: '1.0.0',
      releasedLabels: ['released', 'shipped'],
    });
    expect(published.github.requests[0]?.successComment).toStartWith('Released 1.0.0: ## 1.0.0');

    const missingRepository = fixture(config);
    missingRepository.git.githubSlug = null;
    await expect(missingRepository.subject.release()).rejects.toThrow('origin is not a GitHub repository');
    expect(missingRepository.github.requests).toEqual([]);
  });

  it('should expose no-release, precondition, empty-asset, and hook failure contracts', async () => {
    const noRelease = fixture();
    noRelease.git.commits = [{ sha: 'a', message: 'docs: update guide' }];
    expect(await noRelease.subject.preview()).toBeNull();
    expect(await noRelease.subject.release()).toBeNull();

    const dirty = fixture();
    dirty.git.clean = false;
    await expect(dirty.subject.release()).rejects.toThrow('working tree must be clean');

    const empty = fixture();
    empty.git.changed = [];
    await expect(empty.subject.release()).rejects.toThrow('no configured asset changes');

    const failingHook = fixture({
      ...TEST_CONFIG,
      release: {
        ...TEST_CONFIG.release,
        hooks: { prepare: [{ phase: 'beforeWrite', command: './fail' }], success: [] },
      },
    });
    failingHook.hooks.failure = new Error('hook exploded');
    await expect(failingHook.subject.release()).rejects.toThrow('prepare:beforeWrite failed: hook exploded');
  });

  it('should write conventions independently and render safe user-facing errors', async () => {
    const release = fixture();
    const loaded = await release.subject.writeConventions('custom.yaml');

    expect(loaded.config).toBe(TEST_CONFIG);
    expect(release.files.values.get(TEST_CONFIG.conventions.path)).toContain('## Types');
    expect(userMessage(new ReleaseError('release failed', 'test'))).toBe('release failed');
    expect(userMessage(new Error('ordinary failure'))).toBe('ordinary failure');
    expect(userMessage({ reason: 'unknown' })).toBe('[object Object]');
  });
});

/**
 * D9 — releaser-generated documents are regenerate-only, so a hand-edit is a
 * violation the check must detect. Arm names match the A-series carried over
 * from the semantic-generator port plan; the same arms run black-box against
 * the built CLI in the SIT tier.
 */
describe('conventions check (D9)', () => {
  const DOC = TEST_CONFIG.conventions.path;

  async function generated(): Promise<{ release: ReturnType<typeof fixture>; body: string }> {
    const release = fixture();
    await release.subject.writeConventions();
    const body = release.files.values.get(DOC);
    if (body === undefined) throw new Error('fixture did not generate a document');
    return { release, body };
  }

  it('A1: should report a match on the bytes the generator itself wrote', async () => {
    // Arrange
    const { release } = await generated();

    // Act
    const actual = await release.subject.checkConventions();

    // Assert
    expect(actual.status).toBe('match');
    expect(actual.diff).toBe('');
    expect(actual.path).toBe(DOC);
  });

  it('A2: should report drift when the document body is edited', async () => {
    // Arrange
    const { release, body } = await generated();
    release.files.values.set(DOC, body.replace('## Types', '## Types (hand-edited)'));

    // Act
    const actual = await release.subject.checkConventions();

    // Assert
    expect(actual.status).toBe('drift');
    expect(actual.diff).toContain('## Types (hand-edited)');
  });

  it('A3: should report drift on a single appended whitespace byte', async () => {
    // Arrange
    const { release, body } = await generated();
    release.files.values.set(DOC, `${body} `);

    // Act
    const actual = await release.subject.checkConventions();

    // Assert
    expect(actual.status).toBe('drift');
    expect(actual.diff).not.toBe('');
  });

  it('A4: should report a missing document rather than a match', async () => {
    // Arrange
    const release = fixture();

    // Act
    const actual = await release.subject.checkConventions();

    // Assert
    expect(actual.status).toBe('missing');
    expect(actual.actual).toBeNull();
    expect(actual.diff).toBe('');
  });

  it('A5: should report drift when the configuration moves and the document does not', async () => {
    // Arrange — the document is generated, then the config gains a commit type.
    const { body } = await generated();
    const moved = fixture({
      ...TEST_CONFIG,
      types: [
        ...TEST_CONFIG.types,
        { type: 'perf', desc: 'Performance', scopes: { default: { desc: 'Perf', release: 'patch' } } },
      ],
    });
    moved.files.values.set(DOC, body);

    // Act
    const actual = await moved.subject.checkConventions();

    // Assert
    expect(actual.status).toBe('drift');
    expect(actual.diff).toContain('perf');
  });

  it('A6: should stay green after a byte-identical rewrite', async () => {
    // Arrange — proves a red arm reacts to the CONTENT, not merely to a write.
    const { release } = await generated();
    await release.subject.writeConventions();

    // Act
    const actual = await release.subject.checkConventions();

    // Assert
    expect(actual.status).toBe('match');
  });

  it('A7: should not modify the document it judges', async () => {
    // Arrange
    const { release, body } = await generated();
    const drifted = `${body}trailing junk\n`;
    release.files.values.set(DOC, drifted);

    // Act
    const actual = await release.subject.checkConventions();

    // Assert — a check that repaired what it judged could never fail a CI job.
    expect(actual.status).toBe('drift');
    expect(release.files.values.get(DOC)).toBe(drifted);
  });

  it('A8: should surface an unreadable configuration as a failure, not a match', async () => {
    // Arrange
    const release = fixture();
    const broken = new ReleaseService(
      {
        load: async () => {
          throw new ConfigError('failed to read YAML configuration "nope.yaml": file not found: nope.yaml');
        },
        writeCanonical: async () => undefined,
      },
      release.files,
      release.git,
      release.hooks,
      release.github,
      new VersionService(),
      new NotesService(),
      new ConventionsService(),
      new HookTemplate(),
      new FakeClock(),
      new TagGuard(release.tags),
    );

    // Act & Assert — "I could not look" must never render as "it is clean".
    await expect(broken.checkConventions('nope.yaml')).rejects.toThrow('failed to read YAML configuration');
  });

  it('should name the rule and the remedy in every verdict', async () => {
    // Arrange
    const { release, body } = await generated();

    // Act
    const match = describeConventionsCheck(await release.subject.checkConventions());
    const missingCheck = await fixture().subject.checkConventions();
    release.files.values.set(DOC, `${body}drift\n`);
    const drift = describeConventionsCheck(await release.subject.checkConventions());

    // Assert
    expect(match).toContain('is up to date with');
    expect(describeConventionsCheck(missingCheck)).toContain('regenerate-only');
    expect(describeConventionsCheck(missingCheck)).toContain('`releaser conventions`');
    expect(drift).toContain('D9');
    expect(drift).toContain('Hand-edits are not permitted');
    expect(drift).toContain('+drift');
  });

  it('should point the remedy at a non-default configuration path', async () => {
    // Arrange
    const release = fixture();

    // Act
    const actual = describeConventionsCheck(await release.subject.checkConventions('custom.yaml'));

    // Assert
    expect(actual).toContain("`releaser conventions -c 'custom.yaml'`");
  });

  it('should quote a configuration path containing whitespace in the remedy', async () => {
    // Arrange — the remedy is an instruction the operator pastes. An unquoted
    // path with a space splits into two arguments, so the command would
    // regenerate a different file than the one that was judged.
    const release = fixture();

    // Act
    const spaced = describeConventionsCheck(await release.subject.checkConventions('my configs/rel.yaml'));
    const quoted = describeConventionsCheck(await release.subject.checkConventions("odd'name.yaml"));

    // Assert
    expect(spaced).toContain("`releaser conventions -c 'my configs/rel.yaml'`");
    expect(quoted).toContain("odd'\\''name.yaml");
  });
});
