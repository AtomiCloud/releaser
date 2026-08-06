import type { ReleaserConfig } from '../../lib/config/model';
import { detectSchemaVersion, parseCanonicalV2 } from '../../lib/config/schema';
import { translateV1 } from '../../lib/config/translator';
import { DEFAULT_CONFIG_PATH, LEGACY_CONFIG_PATH } from '../../lib/config/paths';
import { ConfigError } from '../../lib/errors';
import type { IConfigRepository, IFileSystem, LoadedConfig } from '../../lib/release/ports';

export class YamlConfigRepository implements IConfigRepository {
  constructor(private readonly files: IFileSystem) {}

  async load(path: string): Promise<LoadedConfig> {
    // TOMBSTONE. The configuration was called `atomi_release.yaml` up to v1.x and
    // there is deliberately NO dual-name fallback: retire means gone, not aliased.
    // A silent fallback would leave two live names indefinitely and nobody would
    // ever finish the migration. So the old name is not read — it is NAMED at the
    // point of failure, where the person who has to act is already looking.
    // Only when the DEFAULT was requested. Someone who passed `-c` named a path
    // deliberately, and a stale legacy file elsewhere in the tree says nothing
    // about it — telling them to rename it to their own custom path would be a
    // confident instruction to do the wrong thing.
    if (
      path === DEFAULT_CONFIG_PATH &&
      !(await this.files.exists(path)) &&
      (await this.files.exists(LEGACY_CONFIG_PATH))
    ) {
      throw new ConfigError(
        `${path} not found, but ${LEGACY_CONFIG_PATH} exists. This tool formerly read ` +
          `${LEGACY_CONFIG_PATH}; rename it to ${path} (or pass -c ${LEGACY_CONFIG_PATH} to keep the old name).`,
      );
    }
    let raw: unknown;
    try {
      raw = Bun.YAML.parse(await this.files.readText(path));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`failed to read YAML configuration "${path}": ${message}`);
    }
    const sourceVersion = detectSchemaVersion(raw);
    if (sourceVersion === 2) {
      return {
        config: parseCanonicalV2(raw),
        sourceVersion,
        warnings: [],
        legacyGitlintPath: '.gitlint',
      };
    }
    const translated = translateV1(raw);
    return {
      config: translated.config,
      sourceVersion,
      warnings: translated.warnings,
      legacyGitlintPath: translated.gitlintPath,
    };
  }

  async writeCanonical(path: string, config: ReleaserConfig): Promise<void> {
    const yaml = Bun.YAML.stringify(config, null, 2);
    await this.files.writeAtomic(path, `${yaml.trimEnd()}\n`);
  }
}
