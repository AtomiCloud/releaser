import { describe, expect, it } from 'bun:test';
import { createProgram, registerDomain } from '../../bin/releaser';
import {
  captureIo,
  FakeClock,
  FakeConfigRepository,
  FakeGit,
  FakeGitHub,
  FakeTagReader,
  FakeHookRunner,
  loadedConfig,
  MemoryFileSystem,
} from '../helpers/fakes';

function registeredProgram() {
  const program = createProgram();
  registerDomain(program, {
    io: captureIo(),
    files: new MemoryFileSystem(),
    configs: new FakeConfigRepository(loadedConfig()),
    git: new FakeGit(),
    hooks: new FakeHookRunner(),
    github: new FakeGitHub(),
    tags: new FakeTagReader(),
    clock: new FakeClock(),
  });
  return program;
}

describe('controller registration', () => {
  it('should register exactly the six public commands', () => {
    // Arrange / Act
    const program = registeredProgram();

    // Assert
    expect(program.commands.map(command => command.name())).toEqual([
      'release',
      'lint-commit',
      'next',
      'changelog',
      'conventions',
      'migrate',
    ]);
  });

  it('should give every command the same -c/--config option with the same default', () => {
    // Arrange / Act
    // Each controller wires its own pass-through, so each is an independent place to forget it.
    const program = registeredProgram();

    // Assert
    const configOptions = program.commands.map(command => {
      const option = command.options.find(candidate => candidate.long === '--config');
      return [command.name(), option?.flags ?? null, option?.defaultValue ?? null] as const;
    });
    expect(configOptions).toEqual([
      ['release', '-c, --config <path>', 'atomi_release.yaml'],
      ['lint-commit', '-c, --config <path>', 'atomi_release.yaml'],
      ['next', '-c, --config <path>', 'atomi_release.yaml'],
      ['changelog', '-c, --config <path>', 'atomi_release.yaml'],
      ['conventions', '-c, --config <path>', 'atomi_release.yaml'],
      ['migrate', '-c, --config <path>', 'atomi_release.yaml'],
    ]);
  });
});
