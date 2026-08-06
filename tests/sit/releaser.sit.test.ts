import { afterEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAll, run, scratchRepository } from '../helpers/scratch-repo';
import { configuredDriver } from './driver';

const roots: string[] = [];
const driver = configuredDriver();

function v2Config(type = 'feat', release = 'minor'): string {
  return `
schemaVersion: 2
types:
  - type: ${type}
    desc: Test type
    section: Test changes
    scopes:
      default: { desc: Test change, release: ${release} }
conventions:
  path: CommitConventions.md
  template: "# Conventions\\n\\nCONVENTION_DOCS_PLACEHOLDER\\n"
release:
  branches: [main]
  changelog: { path: Changelog.md, title: "# Changelog" }
  commit:
    message: "release: \${version}\\n\\n\${notes}"
    assets: [Changelog.md, CommitConventions.md]
  github: false
`;
}

function hookConfig(): string {
  return `
schemaVersion: 2
types:
  - type: feat
    desc: Test type
    section: Test changes
    scopes:
      default: { desc: Test change, release: minor }
conventions:
  path: CommitConventions.md
  template: "# Conventions\\n\\nCONVENTION_DOCS_PLACEHOLDER\\n"
release:
  branches: [main]
  changelog: { path: Changelog.md, title: "# Changelog" }
  commit:
    message: "release: \${version}\\n\\n\${notes}"
    assets: [Changelog.md, CommitConventions.md, HookAsset.txt]
  github: false
  hooks:
    prepare:
      - phase: beforeWrite
        command: "echo before > HookAsset.txt"
      - phase: afterWrite
        command: "echo after >> HookAsset.txt"
    success:
      - "echo done > .git/releaser-success.marker"
`;
}

// --- both-configs discriminator fixtures -------------------------------------
// Every -c sandbox holds BOTH release.yaml and atomi_release.yaml, and a marker
// exists in only the named one. An exit code cannot separate "read my config"
// from "ignored my flag and found atomi_release.yaml anyway"; the marker can.
const MARK = 'ZQMARKER';
const DECOY = 'DECOYCONF';

function markerV2(): string {
  return `
schemaVersion: 2
types:
  - type: fix
    desc: ${MARK} fix type
    section: ${MARK} changes
    scopes:
      default: { desc: Named default scope, release: minor }
      zqmarker: { desc: Named marker scope, release: minor }
  - type: mrkfeat
    desc: ${MARK} lint-only type
    section: ${MARK} lint-only changes
    scopes:
      default: { desc: Named lint-only scope, release: patch }
conventions:
  path: Named-Conventions.md
  template: "# ${MARK} Conventions\\n\\nCONVENTION_DOCS_PLACEHOLDER\\n"
release:
  branches: [main]
  changelog: { path: Named-Changelog.md, title: "# ${MARK} Changelog" }
  commit:
    message: "release: \${version}\\n\\n\${notes}"
    assets: [Named-Changelog.md, Named-Conventions.md]
  github: false
`;
}

function decoyV2(): string {
  return `
schemaVersion: 2
types:
  - type: fix
    desc: ${DECOY} fix type
    section: ${DECOY} changes
    scopes:
      default: { desc: Decoy default scope, release: patch }
      zqmarker: { desc: Decoy marker scope, release: patch }
conventions:
  path: Decoy-Conventions.md
  template: "# ${DECOY} Conventions\\n\\nCONVENTION_DOCS_PLACEHOLDER\\n"
release:
  branches: [main]
  changelog: { path: Decoy-Changelog.md, title: "# ${DECOY} Changelog" }
  commit:
    message: "release: \${version}\\n\\n\${notes}"
    assets: [Decoy-Changelog.md, Decoy-Conventions.md]
  github: false
`;
}

function legacyV1(label: string, conventionsPath: string, release: string): string {
  return `
conventionMarkdown: { path: ${conventionsPath}, template: CONVENTION_DOCS_PLACEHOLDER }
gitlint: .gitlint
branches: [main]
types:
  - type: fix
    desc: ${label} fix type
    scopes:
      default: { desc: ${label} default scope, release: ${release} }
plugins:
  - module: '@semantic-release/changelog'
  - module: '@semantic-release/git'
    config:
      message: "release: \${nextRelease.version}\\n\\n\${nextRelease.notes}"
      assets: [${label}-Changelog.md]
`;
}

// The named config maps fix -> minor and the decoy maps fix -> patch, so from tag
// v1.2.3 the two configs yield DIFFERENT versions (1.3.0 vs 1.2.4) and different
// note sections. Neither lands on the no-release branch, so `changelog`'s silent
// zero and `next`'s EXIT_NO_RELEASE can never be mistaken for a verdict.
async function markerRepository(schema: 'v1' | 'v2' = 'v2'): Promise<string> {
  const scratch = await scratchRepository();
  roots.push(scratch.root, scratch.remote);
  if (schema === 'v1') {
    await Bun.write(join(scratch.root, 'release.yaml'), legacyV1(MARK, 'Named-Conventions.md', 'minor'));
    await Bun.write(join(scratch.root, 'atomi_release.yaml'), legacyV1(DECOY, 'Decoy-Conventions.md', 'patch'));
    await Bun.write(join(scratch.root, '.gitlint'), 'legacy\n');
  } else {
    await Bun.write(join(scratch.root, 'release.yaml'), markerV2());
    await Bun.write(join(scratch.root, 'atomi_release.yaml'), decoyV2());
  }
  await Bun.write(join(scratch.root, 'Named-Changelog.md'), '# Named Changelog\n');
  await Bun.write(join(scratch.root, 'Decoy-Changelog.md'), '# Decoy Changelog\n');
  await Bun.write(join(scratch.root, 'seed.txt'), 'seed\n');
  await commitAll(scratch.root, 'chore: seed the sandbox');
  await run(['git', 'tag', 'v1.2.3'], scratch.root);
  await Bun.write(join(scratch.root, 'seed.txt'), 'seed\nsecond\n');
  await commitAll(scratch.root, 'fix(zqmarker): carry the marker into the notes');
  return scratch.root;
}

async function sha256(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await file.arrayBuffer());
  return hasher.digest('hex');
}

async function repository(message = 'feat: add release'): Promise<{ readonly root: string; readonly remote: string }> {
  const scratch = await scratchRepository();
  roots.push(scratch.root, scratch.remote);
  await Bun.write(join(scratch.root, 'atomi_release.yaml'), v2Config());
  await Bun.write(join(scratch.root, 'Changelog.md'), '# Changelog\n');
  await Bun.write(join(scratch.root, 'CommitConventions.md'), '# old\n');
  await Bun.write(join(scratch.root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await Bun.write(join(scratch.root, 'bun.lock'), 'locked\n');
  await commitAll(scratch.root, message);
  await run(['git', 'push', '-q', '-u', 'origin', 'main'], scratch.root);
  return scratch;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true })));
});

describe(`releaser SIT (${process.env.SIT_DRIVER === 'binary' ? 'binary' : 'in-process'})`, () => {
  it('should report version 1.0.0 and list exactly the six domain commands', async () => {
    // Act
    const version = await driver.run(['--version'], process.cwd());
    const help = await driver.run(['--help'], process.cwd());

    // Assert
    expect(version).toMatchObject({ code: 0, out: '1.0.0\n' });
    for (const command of ['release', 'lint-commit', 'next', 'changelog', 'conventions', 'migrate']) {
      expect(help.out).toContain(command);
    }
    expect(help.out).not.toContain('seed');
  });

  it('should keep release --dry-run and changelog byte-side-effect free', async () => {
    // Arrange
    const scratch = await repository();
    const beforeStatus = await run(['git', 'status', '--porcelain'], scratch.root);
    const beforeLock = await Bun.file(join(scratch.root, 'bun.lock')).text();

    // Act
    const dryRun = await driver.run(['release', '--dry-run'], scratch.root);
    const changelog = await driver.run(['changelog'], scratch.root);

    // Assert
    expect(dryRun.code).toBe(0);
    expect(dryRun.out).toStartWith('1.0.0\n\n## 1.0.0');
    expect(changelog.out).toStartWith('## 1.0.0');
    expect(await run(['git', 'status', '--porcelain'], scratch.root)).toBe(beforeStatus);
    expect(await Bun.file(join(scratch.root, 'bun.lock')).text()).toBe(beforeLock);
  });

  it('should perform a complete local release with exact commit, tag, push, and no loop', async () => {
    // Arrange
    const scratch = await repository();

    // Act
    const release = await driver.run(['release'], scratch.root);
    const next = await driver.run(['next'], scratch.root);

    // Assert
    expect(release).toMatchObject({ code: 0, out: 'released 1.0.0\n' });
    expect((await run(['git', 'tag', '--list'], scratch.remote)).trim()).toBe('v1.0.0');
    expect(await run(['git', 'log', '-1', '--format=%s'], scratch.remote)).toBe('release: 1.0.0\n');
    expect(next).toMatchObject({ code: 2, err: 'no release necessary\n' });
  });

  it('should run ordered prepare hooks and a success hook, then leave a clean immutable tree', async () => {
    // Arrange
    const scratch = await scratchRepository();
    roots.push(scratch.root, scratch.remote);
    await Bun.write(join(scratch.root, 'atomi_release.yaml'), hookConfig());
    await Bun.write(join(scratch.root, 'Changelog.md'), '# Changelog\n');
    await Bun.write(join(scratch.root, 'CommitConventions.md'), '# old\n');
    await Bun.write(join(scratch.root, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    await Bun.write(join(scratch.root, 'bun.lock'), 'locked\n');
    await commitAll(scratch.root, 'feat: add release');
    await run(['git', 'push', '-q', '-u', 'origin', 'main'], scratch.root);
    const beforePackage = await Bun.file(join(scratch.root, 'package.json')).text();
    const beforeLock = await Bun.file(join(scratch.root, 'bun.lock')).text();

    // Act
    const release = await driver.run(['release'], scratch.root);

    // Assert
    expect(release).toMatchObject({ code: 0, out: 'released 1.0.0\n' });
    // Prepare hooks ran in order: beforeWrite created the asset, afterWrite appended to it.
    expect(await Bun.file(join(scratch.root, 'HookAsset.txt')).text()).toBe('before\nafter\n');
    // Success hook executed; it wrote under .git so the working tree stays clean.
    expect(await Bun.file(join(scratch.root, '.git', 'releaser-success.marker')).text()).toBe('done\n');
    // Generated documents contain their expected content.
    const changelog = await Bun.file(join(scratch.root, 'Changelog.md')).text();
    expect(changelog).toContain('# Changelog');
    expect(changelog).toContain('## 1.0.0');
    const conventions = await Bun.file(join(scratch.root, 'CommitConventions.md')).text();
    expect(conventions).toContain('# Conventions');
    expect(conventions).toContain('## Types');
    // The package manifest and lockfile are byte-identical (M1–M3): the tool never touches them.
    expect(await Bun.file(join(scratch.root, 'package.json')).text()).toBe(beforePackage);
    expect(await Bun.file(join(scratch.root, 'bun.lock')).text()).toBe(beforeLock);
    // The working tree is clean, and the hook-produced asset landed in the release commit.
    expect((await run(['git', 'status', '--porcelain'], scratch.root)).trim()).toBe('');
    expect(await run(['git', 'show', '--name-only', '--format=', 'HEAD'], scratch.root)).toContain('HookAsset.txt');
  });

  it('should lint valid and invalid commit messages with stable diagnostics', async () => {
    // Arrange
    const scratch = await repository();
    await Bun.write(join(scratch.root, 'valid.txt'), 'feat: add a release capability\n');
    await Bun.write(join(scratch.root, 'invalid.txt'), 'WIP bad.\n');

    // Act
    const valid = await driver.run(['lint-commit', 'valid.txt'], scratch.root);
    const invalid = await driver.run(['lint-commit', 'invalid.txt'], scratch.root);

    // Assert
    expect(valid).toMatchObject({ code: 0, out: '', err: '' });
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain('invalid.txt:1:');
  });

  it('should print next and return exit 2 when no commit requests a release', async () => {
    // Arrange
    const release = await repository();
    const none = await repository('docs: update documentation');

    // Act / Assert
    expect(await driver.run(['next'], release.root)).toMatchObject({ code: 0, out: '1.0.0\n' });
    expect(await driver.run(['next'], none.root)).toMatchObject({ code: 2, err: 'no release necessary\n' });
  });

  it('should make conventions the only changed path', async () => {
    // Arrange
    const scratch = await repository();

    // Act
    const actual = await driver.run(['conventions'], scratch.root);

    // Assert
    expect(actual).toMatchObject({ code: 0, out: 'wrote CommitConventions.md\n' });
    expect((await run(['git', 'status', '--porcelain'], scratch.root)).trim()).toBe('M CommitConventions.md');
  });

  it('should migrate v1, remove legacy files, and remain byte-idempotent', async () => {
    // Arrange
    const scratch = await scratchRepository();
    roots.push(scratch.root, scratch.remote);
    const legacy = `
conventionMarkdown: { path: CommitConventions.md, template: CONVENTION_DOCS_PLACEHOLDER }
gitlint: .gitlint
branches: [main]
types:
  - type: feat
    desc: Features
    scopes:
      default: { desc: Feature, release: minor }
plugins:
  - module: '@semantic-release/changelog'
  - module: '@semantic-release/git'
    config:
      message: "release: \${nextRelease.version}\\n\\n\${nextRelease.notes}\\n\\n[skip ci]\\n\\nSigned"
      assets: [Changelog.md]
`;
    await Bun.write(join(scratch.root, 'atomi_release.yaml'), legacy);
    await Bun.write(join(scratch.root, '.gitlint'), 'legacy');
    await Bun.write(join(scratch.root, '.releaserc.yaml'), 'generated');

    // Act
    const first = await driver.run(['migrate'], scratch.root);
    const migrated = await Bun.file(join(scratch.root, 'atomi_release.yaml')).text();
    const second = await driver.run(['migrate'], scratch.root);

    // Assert
    expect(first.out).toContain('migrated');
    expect(first.out).toContain('normalizations:\n- removed legacy [skip ci] token');
    expect(second.out).toStartWith('already v2');
    expect(second.out).not.toContain('normalizations:');
    expect(Bun.YAML.parse(migrated)).toMatchObject({
      release: {
        commit: {
          message: 'release: ${version}\n\n${notes}\n\n\n\nSigned',
        },
      },
    });
    expect(await Bun.file(join(scratch.root, 'atomi_release.yaml')).text()).toBe(migrated);
    expect(await Bun.file(join(scratch.root, '.gitlint')).exists()).toBe(false);
    expect(await Bun.file(join(scratch.root, '.releaserc.yaml')).exists()).toBe(false);
  });

  it('should fail unknown legacy modules and wrong branches loudly', async () => {
    // Arrange
    const scratch = await repository();
    await run(['git', 'branch', '-m', 'wrong'], scratch.root);
    const wrong = await driver.run(['next'], scratch.root);
    const config = await Bun.file(join(scratch.root, 'atomi_release.yaml')).text();
    await Bun.write(
      join(scratch.root, 'atomi_release.yaml'),
      config.replace('schemaVersion: 2', 'branches: [main]\nplugins: [{ module: "@semantic-release/npm" }]'),
    );

    // Act
    const unknown = await driver.run(['migrate'], scratch.root);

    // Assert
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('not allowed');
    expect(unknown.code).toBe(1);
  });

  it('should reject an invalid rendered tag before every release mutation surface', async () => {
    // Arrange
    const scratch = await repository();
    const configPath = join(scratch.root, 'atomi_release.yaml');
    const config = await Bun.file(configPath).text();
    await Bun.write(configPath, config.replace('branches: [main]', 'branches: [main]\n  tagFormat: "bad..${version}"'));
    await commitAll(scratch.root, 'feat: configure invalid tag');
    const beforeChangelog = await Bun.file(join(scratch.root, 'Changelog.md')).text();

    // Act
    const next = await driver.run(['next'], scratch.root);
    const changelog = await driver.run(['changelog'], scratch.root);
    const dryRun = await driver.run(['release', '--dry-run'], scratch.root);
    const release = await driver.run(['release'], scratch.root);

    // Assert
    for (const result of [next, changelog, dryRun, release]) {
      expect(result.code).toBe(1);
      expect(result.err).toContain('check-ref-format');
    }
    expect(await Bun.file(join(scratch.root, 'Changelog.md')).text()).toBe(beforeChangelog);
    expect(await run(['git', 'status', '--porcelain'], scratch.root)).toBe('');
    expect(await run(['git', 'tag', '--list'], scratch.root)).toBe('');
  });
});

describe(`releaser -c/--config (${process.env.SIT_DRIVER === 'binary' ? 'binary' : 'in-process'})`, () => {
  it('should expose -c/--config on every subcommand and prove each own usage line', async () => {
    // Arrange
    // Commander serves --help BEFORE the unknown-command handler, so `<sub> --help`
    // exiting 0 proves nothing about existence. A real subcommand prints its OWN
    // usage line; a bogus one falls through to the program-level usage. That
    // fallthrough is the must-differ control which makes the six results mean
    // something -- without it, "lacks -c" and "does not exist" look identical.
    const root = process.cwd();
    const commands = ['release', 'lint-commit', 'next', 'changelog', 'conventions', 'migrate'];

    // Act
    const helps = await Promise.all(commands.map(command => driver.run([command, '--help'], root)));
    const bogus = await driver.run(['definitely-not-a-subcommand', '--help'], root);
    const bare = await driver.run(['definitely-not-a-subcommand'], root);

    // Assert
    for (const [index, command] of commands.entries()) {
      const help = helps[index];
      expect(help?.out).toContain(`Usage: releaser ${command}`);
      expect(help?.out).toContain('-c, --config <path>');
      expect(help?.out).toContain('atomi_release.yaml');
    }
    // The control: the bogus name never gets an own usage line, so the six above
    // are genuinely per-subcommand results and not root-help fallthroughs.
    expect(bogus.out).toContain('Usage: releaser [options] [command]');
    expect(bogus.out).not.toContain('Usage: releaser definitely-not-a-subcommand');
    expect(bogus.out).not.toContain('-c, --config <path>');
    // Existence read from the refusal, never from a --help exit code.
    expect(bare.code).not.toBe(0);
    expect(bare.err).toContain('error: unknown command');
  });

  it('should write the -c-named conventions document and never the default one', async () => {
    // Arrange
    const named = await markerRepository();
    const control = await markerRepository();

    // Act
    const actual = await driver.run(['conventions', '-c', 'release.yaml'], named);
    const withoutFlag = await driver.run(['conventions'], control);

    // Assert -- the MUTATION, never the exit code.
    expect(actual.out).toBe('wrote Named-Conventions.md\n');
    expect(await Bun.file(join(named, 'Named-Conventions.md')).text()).toContain(`# ${MARK} Conventions`);
    expect(await Bun.file(join(named, 'Decoy-Conventions.md')).exists()).toBe(false);
    // In-population known positive: with no flag the effect lands on the decoy,
    // so this sandbox demonstrably CAN show the difference the arm above claims.
    expect(withoutFlag.out).toBe('wrote Decoy-Conventions.md\n');
    expect(await Bun.file(join(control, 'Named-Conventions.md')).exists()).toBe(false);
  });

  it('should migrate only the -c-named file and leave the default byte-identical', async () => {
    // Arrange
    // migrate rewrites IN PLACE, so a pass-through bug writes the RIGHT content to
    // the WRONG file and still exits 0. Assert which file's sha256 moved.
    const root = await markerRepository('v1');
    const namedBefore = await sha256(join(root, 'release.yaml'));
    const decoyBefore = await sha256(join(root, 'atomi_release.yaml'));

    // Act
    const actual = await driver.run(['migrate', '-c', 'release.yaml'], root);

    // Assert
    expect(await sha256(join(root, 'release.yaml'))).not.toBe(namedBefore);
    expect(await sha256(join(root, 'atomi_release.yaml'))).toBe(decoyBefore);
    expect(await Bun.file(join(root, 'release.yaml')).text()).toContain(MARK);
    expect(actual.out).toContain('migrated release.yaml to schemaVersion 2');
  });

  it('should migrate the default file when no -c is given', async () => {
    // Arrange -- in-population known positive for the sha instrument.
    const root = await markerRepository('v1');
    const namedBefore = await sha256(join(root, 'release.yaml'));
    const decoyBefore = await sha256(join(root, 'atomi_release.yaml'));

    // Act
    const actual = await driver.run(['migrate'], root);

    // Assert
    expect(await sha256(join(root, 'atomi_release.yaml'))).not.toBe(decoyBefore);
    expect(await sha256(join(root, 'release.yaml'))).toBe(namedBefore);
    expect(actual.out).toContain('migrated atomi_release.yaml to schemaVersion 2');
  });

  it('should print the version the -c-named config decides, not the default one', async () => {
    // Arrange
    // Both configs release, at DIFFERENT levels from tag v1.2.3 (named fix->minor,
    // decoy fix->patch), so neither run reaches the no-release branch and
    // EXIT_NO_RELEASE (2) can never be mistaken for a verdict.
    const named = await markerRepository();
    const control = await markerRepository();

    // Act
    const actual = await driver.run(['next', '-c', 'release.yaml'], named);
    const withoutFlag = await driver.run(['next'], control);

    // Assert -- the OUTPUT.
    expect(actual.out).toBe('1.3.0\n');
    expect(withoutFlag.out).toBe('1.2.4\n');
  });

  it('should print the notes the -c-named config decides, not the default ones', async () => {
    // Arrange
    // changelog is the true silent zero: on preview === null it writes nothing and
    // still sets EXIT_SUCCESS. Its exit code is never read here.
    const named = await markerRepository();
    const control = await markerRepository();

    // Act
    const actual = await driver.run(['changelog', '-c', 'release.yaml'], named);
    const withoutFlag = await driver.run(['changelog'], control);

    // Assert -- the OUTPUT.
    expect(actual.out).toContain(`### ${MARK} changes`);
    expect(actual.out).toStartWith('## 1.3.0');
    expect(actual.out).not.toContain(DECOY);
    expect(withoutFlag.out).toContain(`### ${DECOY} changes`);
    expect(withoutFlag.out).not.toContain(MARK);
  });

  it('should keep release and lint-commit following the -c-named config too', async () => {
    // Arrange
    // MUST-DIFFER CONTROL. These two already had -c before this change. If they do
    // not follow the marker, the harness is broken and no verdict above means
    // anything.
    const root = await markerRepository();
    await Bun.write(join(root, 'msg.txt'), 'mrkfeat: carry the marker through the linter\n');
    // `release` refuses a dirty tree before it ever reads the config, so the lint
    // fixture is committed. `chore` is a type neither config declares, so it
    // changes neither the version nor the notes.
    await commitAll(root, 'chore: add the lint fixture');

    // Act
    const named = await driver.run(['release', '--dry-run', '-c', 'release.yaml'], root);
    const withoutFlag = await driver.run(['release', '--dry-run'], root);
    const lintNamed = await driver.run(['lint-commit', 'msg.txt', '-c', 'release.yaml'], root);
    const lintWithoutFlag = await driver.run(['lint-commit', 'msg.txt'], root);

    // Assert
    expect(named.out).toStartWith('1.3.0\n');
    expect(named.out).toContain(`### ${MARK} changes`);
    expect(withoutFlag.out).toStartWith('1.2.4\n');
    expect(withoutFlag.out).toContain(`### ${DECOY} changes`);
    // `mrkfeat` is a type only the named config declares.
    expect(lintNamed).toMatchObject({ code: 0, err: '' });
    expect(lintWithoutFlag.err).toContain('unknown commit type "mrkfeat"');
  });

  it('should reject a missing -c config on every subcommand for a config-read reason', async () => {
    // Arrange
    // Nonexistence and config-not-found BOTH exit 1, so the exit code cannot tell
    // them apart -- only the MESSAGE can. Commander's unknown-command message
    // echoes the whole argv including the config path, so asserting the path alone
    // would go green against a CLI lacking the command entirely. Assert the
    // config-read message AND that the nonexistence and unknown-option signatures
    // are absent. Required per subcommand: each controller wires its own
    // pass-through, so each is an independent place to forget it.
    const root = await markerRepository();
    const subcommands = [
      ['conventions'],
      ['migrate'],
      ['next'],
      ['changelog'],
      ['release', '--dry-run'],
      ['lint-commit', 'msg.txt'],
    ];
    await Bun.write(join(root, 'msg.txt'), 'fix: a perfectly valid message\n');
    // `release` checks the working tree before it reads the config; committing the
    // fixture keeps this arm about the config, not about tree cleanliness.
    await commitAll(root, 'chore: add the lint fixture');

    // Act
    const results = await Promise.all(subcommands.map(args => driver.run([...args, '-c', 'nope.yaml'], root)));

    // Assert
    for (const index of subcommands.keys()) {
      const result = results[index];
      const output = `${result?.out ?? ''}${result?.err ?? ''}`;
      expect(result?.code).not.toBe(0);
      expect(output).toContain('failed to read YAML configuration "nope.yaml"');
      expect(output).toContain('file not found');
      // Not the unknown-SUBCOMMAND signature: that would prove nothing about -c.
      expect(output).not.toContain('error: unknown command');
      // Not the unknown-OPTION signature: that would mean the flag was rejected,
      // not the config -- which is precisely what the four gapped subcommands did
      // before this change.
      expect(output).not.toContain("error: unknown option '-c'");
    }
    // Nothing was written and no version was printed on any of the six.
    expect(await Bun.file(join(root, 'Named-Conventions.md')).exists()).toBe(false);
    expect(await Bun.file(join(root, 'Decoy-Conventions.md')).exists()).toBe(false);
  });
});
