import type { Command } from 'commander';
import { type ReleaseService, userMessage } from '../../lib/release/release-service';
import type { ICliIo } from '../terminal/console-io';
import { EXIT_ERROR, EXIT_SUCCESS } from './exit-codes';

export class BumpController {
  constructor(
    private readonly releases: ReleaseService,
    private readonly io: ICliIo,
  ) {}

  register(program: Command): void {
    program
      .command('bump')
      // ⚠️ The version is a POSITIONAL argument and must stay one. The root
      // `-v, --version` shadows any subcommand-level `--version`, so a
      // `--version` option here would print the CLI's own version, exit 0 and
      // bump nothing — a false green by construction rather than by accident.
      .argument('<version>', 'version to stamp into the configured files')
      .description('stamp the configured version files without releasing')
      .option('-c, --config <path>', 'release configuration path', 'release.yaml')
      .action((version: string, options: { config: string }) => this.handle(version, options.config));
  }

  async handle(version: string, configPath: string): Promise<void> {
    try {
      const written = await this.releases.bump(version, configPath);
      // Name what changed. A bump that reports nothing is indistinguishable
      // from a bump that did nothing, and this command exists for the case
      // where a human is checking exactly that.
      this.io.write(
        written.length === 0
          ? `no bump entries configured in ${configPath}\n`
          : `${written.join('\n')}\nstamped to ${version}\n`,
      );
      this.io.setExitCode(EXIT_SUCCESS);
    } catch (error) {
      this.io.writeError(`${userMessage(error)}\n`);
      this.io.setExitCode(EXIT_ERROR);
    }
  }
}
