/** Backend bound on distinct ids (`unit.distinctId` is 1-256 characters). */
export const DISTINCT_ID_MAX_LENGTH = 256;

/** Validate a user or server id. Numbers are accepted and stringified. */
export function normalizeDistinctId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > DISTINCT_ID_MAX_LENGTH) return undefined;
  return trimmed;
}
