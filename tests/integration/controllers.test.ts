import { describe, expect, it, spyOn } from 'bun:test';
import { BumpController } from '../../src/adapters/cli/bump-controller';
import { ChangelogController } from '../../src/adapters/cli/changelog-controller';
import { ConventionsController } from '../../src/adapters/cli/conventions-controller';
import { LintCommitController } from '../../src/adapters/cli/lint-commit-controller';
import { MigrateController } from '../../src/adapters/cli/migrate-controller';
import { NextController } from '../../src/adapters/cli/next-controller';
import { ReleaseController } from '../../src/adapters/cli/release-controller';
import { ConsoleIo } from '../../src/adapters/terminal/console-io';
import { CommitLinter } from '../../src/lib/commits/linter';
import type { MigrationService } from '../../src/lib/migration/migration-service';
import type { ReleasePreview, ReleaseService } from '../../src/lib/release/release-service';
import { captureIo, FakeConfigRepository, loadedConfig, MemoryFileSystem, TEST_CONFIG } from '../helpers/fakes';

const PREVIEW: ReleasePreview = {
  config: TEST_CONFIG,
  sourceVersion: 2,
  warnings: [],
  version: '1.0.0',
  tag: 'v1.0.0',
  previousTag: null,
  notes: '## 1.0.0\n',
  commits: [],
};

function releases(methods: object): ReleaseService {
  return methods as ReleaseService;
}

function migration(methods: object): MigrationService {
  return methods as MigrationService;
}

describe('CLI controller handlers', () => {
  it('should handle changelog success, no-release, and error results', async () => {
    const calls: string[] = [];
    const success = captureIo();
    await new ChangelogController(
      releases({
        preview: async (path: string) => {
          calls.push(path);
          return PREVIEW;
        },
      }),
      success,
    ).handle('custom.yaml');
    expect(calls).toEqual(['custom.yaml']);
    expect(success.out).toEqual(['## 1.0.0\n']);
    expect(success.codes).toEqual([0]);

    const none = captureIo();
    await new ChangelogController(releases({ preview: async () => null }), none).handle('atomi_release.yaml');
    expect(none.out).toEqual([]);
    expect(none.codes).toEqual([0]);

    const failure = captureIo();
    await new ChangelogController(
      releases({
        preview: async () => {
          throw new Error('cannot calculate notes');
        },
      }),
      failure,
    ).handle('atomi_release.yaml');
    expect(failure.err).toEqual(['cannot calculate notes\n']);
    expect(failure.codes).toEqual([1]);
  });

  it('should handle next-version success, no-release, and error results', async () => {
    const calls: string[] = [];
    const success = captureIo();
    await new NextController(
      releases({
        preview: async (path: string) => {
          calls.push(path);
          return PREVIEW;
        },
      }),
      success,
    ).handle('custom.yaml');
    expect(calls).toEqual(['custom.yaml']);
    expect(success.out).toEqual(['1.0.0\n']);
    expect(success.codes).toEqual([0]);

    const none = captureIo();
    await new NextController(releases({ preview: async () => null }), none).handle('atomi_release.yaml');
    expect(none.err).toEqual(['no release necessary\n']);
    expect(none.codes).toEqual([2]);

    const failure = captureIo();
    await new NextController(
      releases({
        preview: async () => {
          throw new Error('cannot calculate version');
        },
      }),
      failure,
    ).handle('atomi_release.yaml');
    expect(failure.err).toEqual(['cannot calculate version\n']);
    expect(failure.codes).toEqual([1]);
  });

  it('should handle conventions warnings and errors', async () => {
    const calls: string[] = [];
    const success = captureIo();
    await new ConventionsController(
      releases({
        writeConventions: async (path: string) => {
          calls.push(path);
          return { ...loadedConfig(), warnings: ['translated legacy config'] };
        },
      }),
      success,
    ).handle('custom.yaml');
    expect(calls).toEqual(['custom.yaml']);
    expect(success.out).toEqual(['wrote docs/developer/CommitConventions.md\n']);
    expect(success.err).toEqual(['warning: translated legacy config\n']);
    expect(success.codes).toEqual([0]);

    const failure = captureIo();
    await new ConventionsController(
      releases({
        writeConventions: async () => {
          throw new Error('cannot write conventions');
        },
      }),
      failure,
    ).handle('atomi_release.yaml');
    expect(failure.err).toEqual(['cannot write conventions\n']);
    expect(failure.codes).toEqual([1]);
  });

  it('should report a matching conventions document on stdout with a zero exit code', async () => {
    // Arrange
    const io = captureIo();
    const check = {
      status: 'match',
      path: 'docs/developer/CommitConventions.md',
      configPath: 'atomi_release.yaml',
      expected: 'body',
      actual: 'body',
      diff: '',
      warnings: ['translated legacy config'],
    };

    // Act
    await new ConventionsController(releases({ checkConventions: async () => check }), io).handle(
      'atomi_release.yaml',
      true,
    );

    // Assert
    expect(io.out).toEqual(['docs/developer/CommitConventions.md is up to date with atomi_release.yaml\n']);
    expect(io.err).toEqual(['warning: translated legacy config\n']);
    expect(io.codes).toEqual([0]);
  });

  it('should fail the conventions check on drift, naming D9 and the remedy on stderr', async () => {
    // Arrange
    const io = captureIo();
    const check = {
      status: 'drift',
      path: 'docs/developer/CommitConventions.md',
      configPath: 'atomi_release.yaml',
      expected: 'generated\n',
      actual: 'hand edited\n',
      diff: '--- expected\n+++ actual\n@@ -1,1 +1,1 @@\n-generated\n+hand edited',
      warnings: [],
    };

    // Act
    await new ConventionsController(releases({ checkConventions: async () => check }), io).handle(
      'atomi_release.yaml',
      true,
    );

    // Assert — the check exists to fail a CI job, so nothing goes to stdout.
    expect(io.out).toEqual([]);
    expect(io.codes).toEqual([1]);
    const reported = io.err.join('');
    expect(reported).toContain('D9: releaser-generated documents are regenerate-only');
    expect(reported).toContain('Hand-edits are not permitted');
    expect(reported).toContain('`releaser conventions`');
    expect(reported).toContain('+hand edited');
  });

  it('should fail the conventions check when the document is missing', async () => {
    // Arrange
    const io = captureIo();
    const check = {
      status: 'missing',
      path: 'docs/developer/CommitConventions.md',
      configPath: 'atomi_release.yaml',
      expected: 'generated\n',
      actual: null,
      diff: '',
      warnings: [],
    };

    // Act
    await new ConventionsController(releases({ checkConventions: async () => check }), io).handle(
      'atomi_release.yaml',
      true,
    );

    // Assert
    expect(io.out).toEqual([]);
    expect(io.codes).toEqual([1]);
    expect(io.err.join('')).toContain('is missing');
  });

  it('should surface an unreadable configuration from the conventions check as a failure', async () => {
    // Arrange
    const io = captureIo();

    // Act
    await new ConventionsController(
      releases({
        checkConventions: async () => {
          throw new Error('failed to read YAML configuration "nope.yaml": file not found: nope.yaml');
        },
      }),
      io,
    ).handle('atomi_release.yaml', true);

    // Assert — "I could not look" must not render as "it is clean".
    expect(io.out).toEqual([]);
    expect(io.codes).toEqual([1]);
    expect(io.err.join('')).toContain('failed to read YAML configuration');
  });

  it('should handle release dry-run, live, no-release, and error results', async () => {
    const calls: Array<readonly [string, boolean]> = [];
    const dryRun = captureIo();
    await new ReleaseController(
      releases({
        release: async (path: string, dry: boolean) => {
          calls.push([path, dry]);
          return { ...PREVIEW, warnings: ['translated legacy config'] };
        },
      }),
      dryRun,
    ).handle(true, 'custom.yaml');
    expect(calls).toEqual([['custom.yaml', true]]);
    expect(dryRun.out).toEqual(['1.0.0\n\n## 1.0.0\n']);
    expect(dryRun.err).toEqual(['warning: translated legacy config\n']);
    expect(dryRun.codes).toEqual([0]);

    const live = captureIo();
    await new ReleaseController(releases({ release: async () => PREVIEW }), live).handle(false, 'atomi_release.yaml');
    expect(live.out).toEqual(['released 1.0.0\n']);
    expect(live.codes).toEqual([0]);

    const none = captureIo();
    await new ReleaseController(releases({ release: async () => null }), none).handle(false, 'atomi_release.yaml');
    expect(none.out).toEqual(['no release necessary\n']);
    expect(none.codes).toEqual([0]);

    const failure = captureIo();
    await new ReleaseController(
      releases({
        release: async () => {
          throw new Error('release failed');
        },
      }),
      failure,
    ).handle(false, 'atomi_release.yaml');
    expect(failure.err).toEqual(['release failed\n']);
    expect(failure.codes).toEqual([1]);
  });

  it('should handle migration success and errors', async () => {
    const calls: string[] = [];
    const success = captureIo();
    await new MigrateController(
      migration({
        migrate: async (path: string) => {
          calls.push(path);
          return { output: 'migrated\n' };
        },
      }),
      success,
    ).handle('custom.yaml');
    expect(calls).toEqual(['custom.yaml']);
    expect(success.out).toEqual(['migrated\n']);
    expect(success.codes).toEqual([0]);

    const failure = captureIo();
    await new MigrateController(
      migration({
        migrate: async () => {
          throw new Error('migration failed');
        },
      }),
      failure,
    ).handle('atomi_release.yaml');
    expect(failure.err).toEqual(['migration failed\n']);
    expect(failure.codes).toEqual([1]);
  });

  it('should handle valid, invalid, and unreadable commit messages', async () => {
    const configs = new FakeConfigRepository(loadedConfig());
    const files = new MemoryFileSystem({ valid: 'feat: add release', invalid: 'not conventional' });

    const valid = captureIo();
    await new LintCommitController(configs, files, new CommitLinter(), valid).handle('valid', 'custom.yaml');
    expect(valid.err).toEqual([]);
    expect(valid.codes).toEqual([0]);

    const invalid = captureIo();
    await new LintCommitController(configs, files, new CommitLinter(), invalid).handle('invalid', 'custom.yaml');
    expect(invalid.err[0]).toContain('invalid:1:CT1:');
    expect(invalid.codes).toEqual([1]);

    const missing = captureIo();
    await new LintCommitController(configs, files, new CommitLinter(), missing).handle('missing', 'custom.yaml');
    expect(missing.err).toEqual(['missing:1:config: file not found: missing\n']);
    expect(missing.codes).toEqual([1]);
  });
});

describe('ConsoleIo', () => {
  it('should write to the matching process streams and set the requested exit code', () => {
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    const subject = new ConsoleIo();

    try {
      subject.write('ordinary output\n');
      subject.writeError('diagnostic output\n');
      subject.setExitCode(7);

      expect(stdout).toHaveBeenCalledWith('ordinary output\n');
      expect(stderr).toHaveBeenCalledWith('diagnostic output\n');
      expect(process.exitCode).toBe(7);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      process.exitCode = previousExitCode ?? 0;
    }
  });
});

describe('bump controller', () => {
  it('should report the written paths, the no-entries case, and a failure', async () => {
    // Arrange / Act — the happy path names what it wrote, because a bump that
    // reports nothing is indistinguishable from a bump that did nothing.
    const calls: string[] = [];
    const success = captureIo();
    await new BumpController(
      releases({
        bump: async (version: string, path: string) => {
          calls.push(`${version}@${path}`);
          return ['VERSION', 'package.json'];
        },
      }),
      success,
    ).handle('2.5.0', 'custom.yaml');

    // Assert
    expect(calls).toEqual(['2.5.0@custom.yaml']);
    expect(success.out).toEqual(['VERSION\npackage.json\nstamped to 2.5.0\n']);
    expect(success.codes).toEqual([0]);

    // Act — no entries configured: say so rather than print an empty success.
    const empty = captureIo();
    await new BumpController(releases({ bump: async () => [] }), empty).handle('2.5.0', 'atomi_release.yaml');

    // Assert
    expect(empty.out).toEqual(['no bump entries configured in atomi_release.yaml\n']);
    expect(empty.codes).toEqual([0]);

    // Act — a refusal is surfaced as an error with a non-zero exit.
    const failure = captureIo();
    await new BumpController(
      releases({
        bump: async () => {
          throw new Error('VERSION declares no version line');
        },
      }),
      failure,
    ).handle('2.5.0', 'atomi_release.yaml');

    // Assert
    expect(failure.err).toEqual(['VERSION declares no version line\n']);
    expect(failure.codes).toEqual([1]);
  });
});
