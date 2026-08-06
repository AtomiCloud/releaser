/**
 * The configuration filename, in one place.
 *
 * Kept here rather than in the release service because the config repository
 * needs it too, and a rename that has to be made in two files is a rename that
 * eventually gets made in one.
 */
export const DEFAULT_CONFIG_PATH = 'release.yaml';

/**
 * The pre-v2 name. Never read — it exists only so the tool can tell a user what
 * to rename when they have not migrated. There is deliberately no fallback:
 * retire means gone, not aliased.
 */
export const LEGACY_CONFIG_PATH = 'atomi_release.yaml';
