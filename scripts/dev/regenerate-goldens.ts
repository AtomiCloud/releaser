#!/usr/bin/env bun
/**
 * Regenerates the real-history goldens.
 *
 * The goldens assert byte-exact notes for four captured repositories, so a
 * deliberate format change invalidates all of them at once. Hand-editing four
 * files is how a format change becomes a transcription error, so this exists to
 * do it mechanically.
 *
 * ⚠️ IT REFUSES TO REPORT SUCCESS WHEN IT CHANGED NOTHING. A regeneration that
 * silently regenerates nothing produces goldens that look reviewed and are
 * stale, and every visible signal says it worked — which is the failure this
 * repository keeps finding in other instruments. If no bytes moved, that is
 * either "already current" or "this script is inert", and the operator is told
 * both rather than shown a green tick.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YamlConfigRepository } from '../../src/adapters/config/yaml-config-repository';
import { BunFileSystem } from '../../src/adapters/filesystem/bun-filesystem';
import { GitCli } from '../../src/adapters/git/git-cli';
import { NotesService } from '../../src/lib/release/notes-service';
import { VersionService } from '../../src/lib/release/version-service';

const FIXTURES = [
  { name: 'bun-base', sha: '54bd91a', repository: 'https://github.com/AtomiCloud/diene.bun-base' },
  { name: 'bun-cli', sha: '4c01c90', repository: 'https://github.com/AtomiCloud/diene.bun-cli' },
  { name: 'bun-lib', sha: '6250148', repository: 'https://github.com/AtomiCloud/diene.bun-lib' },
  { name: 'dotnet-base', sha: 'cf94bed', repository: 'https://github.com/AtomiCloud/diene.dotnet-base' },
] as const;

/** The captured trees predate the v2 rename, so they carry the legacy name. */
const CAPTURED_CONFIG = 'atomi_release.yaml';
const DATE = '2026-07-22';

async function run(command: readonly string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if ((await proc.exited) !== 0) throw new Error(`${command.join(' ')} failed in ${cwd}`);
}

async function regenerate(fixture: (typeof FIXTURES)[number]): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), 'releaser-goldens-'));
  try {
    await run(['git', 'clone', '-q', `tests/fixtures/golden/${fixture.name}-history.bundle`, root], process.cwd());
    await run(['git', 'switch', '-q', '--detach', fixture.sha], root);

    const files = new BunFileSystem(root);
    const { config } = await new YamlConfigRepository(files).load(CAPTURED_CONFIG);
    const git = new GitCli(root);
    const versions = new VersionService();
    const latest = versions.latestTag(await git.reachableTags(), config.release.tagFormat);
    const commits = await git.commitsSince(latest?.tag ?? null);
    const decision = versions.analyze(config, latest?.version ?? null, commits);
    if (decision === null) throw new Error(`${fixture.name} produced no release decision`);

    const version = versions.format(decision.version);
    const notes = new NotesService().render({
      config,
      version,
      previousTag: latest?.tag ?? null,
      newTag: versions.formatTag(config.release.tagFormat, decision.version),
      commits,
      repositoryUrl: fixture.repository,
      date: DATE,
    });

    let changed = false;
    for (const [path, content] of [
      [`tests/fixtures/golden/${fixture.name}-version.txt`, `${version}\n`],
      [`tests/fixtures/golden/${fixture.name}-notes.md`, notes],
    ] as const) {
      const before = await Bun.file(path)
        .text()
        .catch(() => null);
      if (before !== content) {
        await Bun.write(path, content);
        changed = true;
        console.log(`updated ${path}`);
      }
    }
    return changed;
  } finally {
    await rm(root, { recursive: true });
  }
}

const results = [];
for (const fixture of FIXTURES) results.push(await regenerate(fixture));

if (!results.some(Boolean)) {
  console.error(
    '❌ regenerated NOTHING. Either the goldens were already current, or this script is no longer\n' +
      '   producing output (a stale golden that looks reviewed is the failure this guard exists for).\n' +
      '   Decide which before treating the goldens as regenerated.',
  );
  process.exit(1);
}

console.log(`✅ regenerated ${results.filter(Boolean).length} of ${FIXTURES.length} fixtures`);
