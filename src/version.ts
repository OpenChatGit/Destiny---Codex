/**
 * Central version definition for Destiny Codex.
 *
 * Two version numbers are used:
 * - dateVersion: the release date (DD.MM.YYYY)
 * - semver: the semantic version (MAJOR.MINOR.PATCH.BUILD)
 *
 * Both are shown everywhere: CLI --version, codex version, MCP serverInfo, package.json.
 */
export const DATE_VERSION = "07.01.2026";
export const SEMVER = "0.4.0.0";

/** Combined display string, e.g. "0.2.4.022 (07.01.2026)". */
export const FULL_VERSION = `${SEMVER} (${DATE_VERSION})`;

/** npm-compatible version (semver without build metadata suffix). */
export const NPM_VERSION = SEMVER;
