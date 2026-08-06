import type { Command } from 'commander';
import { describeConventionsCheck, type ReleaseService, userMessage } from '../../lib/release/release-service';
import type { ICliIo } from '../terminal/console-io';
import { EXIT_ERROR, EXIT_SUCCESS } from './exit-codes';

export class ConventionsController {
  constructor(
    private readonly releases: ReleaseService,
    private readonly io: ICliIo,
  ) {}

  register(program: Command): void {
    program
      .command('conventions')
      .description('write the configured commit-conventions document')
      .option('-c, --config <path>', 'release configuration path', 'atomi_release.yaml')
      .option('--check', 'verify the document matches the configuration instead of writing it')
      .action((options: { config: string; check?: boolean }) => this.handle(options.config, options.check === true));
  }

  async handle(configPath: string, check = false): Promise<void> {
    try {
      if (check) {
        await this.report(configPath);
        return;
      }
      const loaded = await this.releases.writeConventions(configPath);
      for (const warning of loaded.warnings) this.io.writeError(`warning: ${warning}\n`);
      this.io.write(`wrote ${loaded.config.conventions.path}\n`);
      this.io.setExitCode(EXIT_SUCCESS);
    } catch (error) {
      this.io.writeError(`${userMessage(error)}\n`);
      this.io.setExitCode(EXIT_ERROR);
    }
  }

  /**
   * Reports the D9 verdict. Drift and a missing document are failures, so they
   * go to stderr and set a non-zero exit code: the check exists to fail a CI
   * job, not to narrate on stdout.
   */
  private async report(configPath: string): Promise<void> {
    const result = await this.releases.checkConventions(configPath);
    for (const warning of result.warnings) this.io.writeError(`warning: ${warning}\n`);
    const verdict = describeConventionsCheck(result);
    if (result.status === 'match') {
      this.io.write(`${verdict}\n`);
      this.io.setExitCode(EXIT_SUCCESS);
      return;
    }
    this.io.writeError(`${verdict}\n`);
    this.io.setExitCode(EXIT_ERROR);
  }
}
