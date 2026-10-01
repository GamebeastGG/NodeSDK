import { DISTINCT_ID_MAX_LENGTH } from "@gamebeast/sdk-contract/core";

export { DISTINCT_ID_MAX_LENGTH };

/** Validate a user or server id. Numbers are accepted and stringified. */
export function normalizeDistinctId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > DISTINCT_ID_MAX_LENGTH) return undefined;
  return trimmed;
}
