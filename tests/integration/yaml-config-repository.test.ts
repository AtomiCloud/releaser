import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YamlConfigRepository } from '../../src/adapters/config/yaml-config-repository';
import { BunFileSystem } from '../../src/adapters/filesystem/bun-filesystem';

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'releaser-yaml-'));
  roots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true })));
});

describe('YAML config repository', () => {
  it('should read v1 and atomically serialize canonical v2 with the existing mode', async () => {
    // Arrange
    const cwd = await root();
    const path = join(cwd, 'release.yaml');
    const handle = await open(path, 'w', 0o640);
    await handle.writeFile(`
conventionMarkdown: { path: CommitConventions.md, template: CONVENTION_DOCS_PLACEHOLDER }
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
      message: "release: \${nextRelease.version}\\n\\n\${nextRelease.notes}"
      assets: [Changelog.md]
`);
    await handle.close();
    const files = new BunFileSystem(cwd);
    const subject = new YamlConfigRepository(files);

    // Act
    const loaded = await subject.load('release.yaml');
    await subject.writeCanonical('release.yaml', loaded.config);

    // Assert
    expect(loaded.sourceVersion).toBe(1);
    expect((await subject.load('release.yaml')).sourceVersion).toBe(2);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await files.readText('release.yaml')).toContain('schemaVersion: 2');
  });

  it('should report invalid YAML with the source path', async () => {
    // Arrange
    const cwd = await root();
    await Bun.write(join(cwd, 'broken.yaml'), 'release: [');
    const subject = new YamlConfigRepository(new BunFileSystem(cwd));

    // Act / Assert
    await expect(subject.load('broken.yaml')).rejects.toThrow('broken.yaml');
  });
});

describe('legacy config tombstone', () => {
  it('should NAME the old config when only it exists, rather than reading it', async () => {
    // Arrange — a tree that has not migrated: the v1.x name is present and the
    // v2 name is not. There is deliberately no dual-name fallback, so the tool
    // must refuse AND say what to rename.
    const cwd = await root();
    await Bun.write(join(cwd, 'atomi_release.yaml'), 'schemaVersion: 2\n');
    const subject = new YamlConfigRepository(new BunFileSystem(cwd));

    // Act
    const act = subject.load('release.yaml');

    // Assert — the migration instruction is at the point of failure, where the
    // person who has to act is already looking.
    await expect(act).rejects.toThrow(/release\.yaml not found, but atomi_release\.yaml exists/);
    await expect(act).rejects.toThrow(/rename it to release\.yaml/);
  });

  it('should NOT silently read the old config — retire means gone, not aliased', async () => {
    // Arrange — the same tree. A fallback would make this load succeed, which is
    // exactly the outcome the tombstone exists to prevent: two live names, and a
    // migration nobody ever finishes.
    const cwd = await root();
    await Bun.write(join(cwd, 'atomi_release.yaml'), 'schemaVersion: 2\nnope: true\n');
    const subject = new YamlConfigRepository(new BunFileSystem(cwd));

    // Act / Assert — it must not resolve to the legacy file's contents.
    await expect(subject.load('release.yaml')).rejects.toThrow(/not found/);
  });

  it('should report a plain missing config when NEITHER name exists', async () => {
    // Arrange — the must-differ control: without it, a tombstone that fired
    // unconditionally would pass the arms above while saying the wrong thing to
    // someone who simply has no configuration at all.
    const cwd = await root();
    const subject = new YamlConfigRepository(new BunFileSystem(cwd));

    // Act
    const act = subject.load('release.yaml');

    // Assert
    await expect(act).rejects.toThrow(/failed to read YAML configuration/);
    await expect(act).not.rejects.toThrow(/formerly read/);
  });
});

describe('legacy tombstone scope', () => {
  it('should NOT misinstruct when a NON-default path is missing and the legacy file exists', async () => {
    // Arrange — someone passed -c deliberately. A stale atomi_release.yaml
    // elsewhere in the tree says nothing about the path they asked for, and
    // telling them to rename it to their own custom path would be a confident
    // instruction to do the wrong thing.
    const cwd = await root();
    await Bun.write(join(cwd, 'atomi_release.yaml'), 'schemaVersion: 2\n');
    const subject = new YamlConfigRepository(new BunFileSystem(cwd));

    // Act
    const act = subject.load('profiles/custom.yaml');

    // Assert — the ordinary missing-configuration error, naming THEIR path.
    await expect(act).rejects.toThrow(/failed to read YAML configuration "profiles\/custom\.yaml"/);
    await expect(act).rejects.not.toThrow(/formerly read/);
    await expect(act).rejects.not.toThrow(/rename it to profiles/);
  });

  it('should still read an explicitly requested legacy config unchanged', async () => {
    // Arrange — the tombstone must not break the documented escape hatch it
    // itself offers: pass -c atomi_release.yaml to keep the old name.
    const cwd = await root();
    await Bun.write(join(cwd, 'atomi_release.yaml'), 'schemaVersion: 2\ntypes: []\n');
    const subject = new YamlConfigRepository(new BunFileSystem(cwd));

    // Act / Assert — it reaches the parser rather than the tombstone.
    await expect(subject.load('atomi_release.yaml')).rejects.not.toThrow(/formerly read/);
  });
});
