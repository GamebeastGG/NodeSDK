import {
  CONTEXT_MAX_ARRAY_ELEMENTS,
  CONTEXT_MAX_PROPERTIES,
  CUSTOM_PROPERTY_NAME_MAX as CONTEXT_PROPERTY_NAME_MAX,
} from "@gamebeast/sdk-contract/core";

import type { Logger } from "./logger";
import type { ContextValue } from "./wire";

/**
 * The backend validates the evaluation context as a whole, so one bad property fails the entire
 * request with a 400. The SDK enforces the contract's limits locally and drops invalid properties
 * (with a warning) instead.
 */
export { CONTEXT_MAX_ARRAY_ELEMENTS, CONTEXT_MAX_PROPERTIES, CONTEXT_PROPERTY_NAME_MAX };

/**
 * Values accepted as targeting properties. `Date` is sent as epoch milliseconds, which is how the
 * backend represents `date` fields on the wire.
 */
export type PropertyValue = ContextValue | Date;
export type Properties = Record<string, PropertyValue | undefined>;

function normalizeValue(value: unknown): ContextValue | undefined {
  if (value === null) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (value.length > CONTEXT_MAX_ARRAY_ELEMENTS) return undefined;
    if (value.length === 0) return [] as string[];
    const kind = typeof value[0];
    if (kind !== "string" && kind !== "number" && kind !== "boolean") return undefined;
    for (const element of value) {
      if (typeof element !== kind) return undefined;
      if (kind === "number" && !Number.isFinite(element)) return undefined;
    }
    return [...value] as ContextValue;
  }
  return undefined;
}

/**
 * Validate targeting properties against the backend's rules. Invalid entries are dropped with a
 * one-time warning per property name; `undefined` values are skipped silently so callers can write
 * `{ plan: user.plan }` without guarding.
 */
export function sanitizeProperties(
  input: Properties | undefined,
  logger: Logger
): Record<string, ContextValue> {
  const output: Record<string, ContextValue> = {};
  if (!input) return output;

  let count = 0;
  for (const [name, raw] of Object.entries(input)) {
    if (raw === undefined) continue;

    if (name.length === 0 || name.length > CONTEXT_PROPERTY_NAME_MAX) {
      logger.warnOnce(
        `property-name:${name}`,
        `Dropped targeting property '${name.slice(0, 40)}': names must be 1-${CONTEXT_PROPERTY_NAME_MAX} characters.`
      );
      continue;
    }

    const value = normalizeValue(raw);
    if (value === undefined) {
      logger.warnOnce(
        `property-value:${name}`,
        `Dropped targeting property '${name}': values must be a string, finite number, boolean, ` +
          `null, Date, or an array (max ${CONTEXT_MAX_ARRAY_ELEMENTS}) of one scalar type.`
      );
      continue;
    }

    if (count >= CONTEXT_MAX_PROPERTIES) {
      logger.warnOnce(
        "property-count",
        `Dropped targeting properties beyond the first ${CONTEXT_MAX_PROPERTIES}.`
      );
      break;
    }

    output[name] = value;
    count += 1;
  }
  return output;
}
