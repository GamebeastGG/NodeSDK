import { toAliasSlug } from "./environment";
import type { JsonValue } from "./wire";

/**
 * A configuration path. The first segment is the configuration alias, the rest walks into the
 * document:
 *
 * - `"GameSettings.PlayerSpeed"` — dot-separated
 * - `"GameSettings.Levels.0"` — array index
 * - `["GameSettings", "key.with.dots"]` — segment array, for keys that themselves contain `.`
 * - `"GameSettings"` — the whole document
 */
export type ConfigPath = string | readonly string[];

export interface ParsedConfigPath {
  /** The alias as written, sent to the backend (which normalizes it). */
  alias: string;
  /** Normalized alias, the key the SDK stores the configuration under. */
  key: string;
  segments: readonly string[];
}

export function parseConfigPath(path: ConfigPath): ParsedConfigPath | undefined {
  let parts: unknown[];
  if (typeof path === "string") parts = path.split(".");
  else if (Array.isArray(path)) parts = [...(path as readonly unknown[])];
  else return undefined;

  if (parts.some((part) => typeof part !== "string")) return undefined;
  const segments = parts as string[];
  const alias = (segments[0] ?? "").trim();
  const key = toAliasSlug(alias);
  if (key === "") return undefined;
  return { alias, key, segments: segments.slice(1) };
}

export function formatConfigPath(path: ConfigPath): string {
  if (typeof path === "string") return path;
  return Array.isArray(path) ? path.join(".") : String(path);
}

const hasOwn = (target: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(target, key);

/**
 * Walk `segments` into `root`. Returns `undefined` when any segment is missing. Only own properties
 * are read, so a path like `constructor` can never reach an object's prototype.
 */
export function resolvePath(
  root: JsonValue | undefined,
  segments: readonly string[]
): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      if (!hasOwn(current, segment)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => deepEqual(value, b[index]));
  }

  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  if (aKeys.length !== Object.keys(bRecord).length) return false;
  return aKeys.every((key) => hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]));
}

/** Deep copy of JSON data, so callers can never mutate the SDK's own state. */
export function cloneJson<T extends JsonValue | undefined>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
