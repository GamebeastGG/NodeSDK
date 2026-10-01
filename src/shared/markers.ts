import type { Logger } from "./logger";
import { describeError } from "./logger";
import { uuidv4 } from "./uuid";
import type { MarkerPayload } from "./wire";

/** Marker properties: any JSON-serializable object. */
export type MarkerProperties = Record<string, unknown>;

export interface MarkerFields {
  distinctId?: string | undefined;
  sessionId?: string | undefined;
  /** Epoch milliseconds or a `Date`. Defaults to now. */
  timestamp?: number | Date | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function resolveTimestamp(timestamp: MarkerFields["timestamp"]): number | undefined {
  if (timestamp === undefined) return Date.now();
  const value = timestamp instanceof Date ? timestamp.getTime() : timestamp;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Validate and snapshot one marker. Returns `undefined` (after logging why) for input the backend
 * would reject, so a single bad marker can never fail a whole batch.
 *
 * Properties are serialized immediately: later mutations by the caller do not leak into the
 * marker, and non-serializable values (cycles, `BigInt`) are caught here rather than at send time.
 */
export function buildMarker(
  eventName: unknown,
  properties: unknown,
  fields: MarkerFields,
  logger: Logger
): MarkerPayload | undefined {
  if (typeof eventName !== "string" || eventName.trim() === "") {
    logger.error("A marker requires a non-empty event name; marker dropped.");
    return undefined;
  }

  let snapshot: Record<string, unknown> = {};
  if (properties !== undefined && properties !== null) {
    if (!isPlainObject(properties)) {
      logger.error(
        `Marker '${eventName}' properties must be a plain object (e.g. { level: 3 }); marker dropped.`
      );
      return undefined;
    }
    try {
      snapshot = JSON.parse(JSON.stringify(properties)) as Record<string, unknown>;
    } catch (error) {
      logger.error(
        `Marker '${eventName}' properties are not JSON-serializable (${describeError(error)}); marker dropped.`
      );
      return undefined;
    }
  }

  const timestamp = resolveTimestamp(fields.timestamp);
  if (timestamp === undefined) {
    logger.error(`Marker '${eventName}' has an invalid timestamp; marker dropped.`);
    return undefined;
  }

  const marker: MarkerPayload = {
    markerId: uuidv4(),
    timestamp,
    eventName,
    properties: snapshot,
  };
  if (fields.distinctId !== undefined && fields.distinctId !== "")
    marker.distinctId = fields.distinctId;
  if (fields.sessionId !== undefined && fields.sessionId !== "")
    marker.sessionId = fields.sessionId;
  return marker;
}
