/**
 * Environment aliases, normalized exactly as the backend does (`toAliasSlug` + the `studio`
 * synonym), so the value the SDK reasons about is the one the backend resolves.
 *
 * The set of environments is data, not an enum: projects may define their own (e.g. `staging`).
 */

export const PRODUCTION_ENVIRONMENT = "production";
export const DEVELOPMENT_ENVIRONMENT = "development";

const ALIAS_SYNONYMS: Record<string, string> = {
  studio: DEVELOPMENT_ENVIRONMENT,
};

/** Mirror of core-backend `toAliasSlug`: lowercase, spaces to dashes, strip the rest, trim dashes. */
export function toAliasSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalize a developer-supplied environment. Returns `undefined` for input that slugs to `""`. */
export function normalizeEnvironment(input: string): string | undefined {
  const slug = toAliasSlug(input);
  if (slug === "") return undefined;
  return ALIAS_SYNONYMS[slug] ?? slug;
}

/**
 * The v1 routes (marker ingestion, cohort membership) predate environment aliases: they pick the
 * environment from an `isstudio` boolean — `false` is production, `true` is development — and cannot
 * address any other environment.
 */
export type LegacyEnvironmentMapping =
  { supported: true; isStudio: boolean } | { supported: false; isStudio: true };

export function toLegacyEnvironment(alias: string): LegacyEnvironmentMapping {
  if (alias === PRODUCTION_ENVIRONMENT) return { supported: true, isStudio: false };
  if (alias === DEVELOPMENT_ENVIRONMENT) return { supported: true, isStudio: true };
  return { supported: false, isStudio: true };
}
