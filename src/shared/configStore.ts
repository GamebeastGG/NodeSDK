import type { ConfigPath, ParsedConfigPath } from "./json";
import { cloneJson, deepEqual, formatConfigPath, parseConfigPath, resolvePath } from "./json";
import type { Logger } from "./logger";
import type { Unsubscribe } from "./listeners";
import { invokeSafely } from "./listeners";
import type { JsonValue } from "./wire";

interface PathListener {
  key: string;
  segments: readonly string[];
  /** `observe` listeners also fire for the first value; `onChanged` listeners only for changes. */
  includeInitial: boolean;
  callback: (value: JsonValue | undefined) => void;
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Resolve `segments` in `document`. Without a fallback, returns a copy of the value (or
 * `undefined`). With one, returns the fallback when the value is missing, `null`, or of a
 * different JSON type (logged once per label).
 */
export function readValue(
  document: JsonValue | undefined,
  segments: readonly string[],
  fallback: unknown,
  label: string,
  logger: Logger
): unknown {
  const value = resolvePath(document, segments);
  if (fallback === undefined) return cloneJson(value);
  if (value === undefined || value === null) return fallback;
  if (kindOf(value) !== kindOf(fallback)) {
    logger.warnOnce(
      `type:${label}`,
      `Configuration value '${label}' is ${kindOf(value)}, but the fallback is ` +
        `${kindOf(fallback)}; returning the fallback.`
    );
    return fallback;
  }
  return cloneJson(value);
}

/**
 * Configuration documents keyed by normalized alias, with dot-path reads and change listeners.
 * Values handed out are deep copies, so callers can never corrupt the state the SDK diffs against.
 */
export class ConfigStore {
  private readonly documents = new Map<string, JsonValue>();
  private readonly listeners = new Set<PathListener>();

  constructor(private readonly logger: Logger) {}

  has(key: string): boolean {
    return this.documents.has(key);
  }

  keys(): string[] {
    return [...this.documents.keys()];
  }

  document(key: string): JsonValue | undefined {
    return this.documents.get(key);
  }

  /**
   * Read the value at `path`. With a `fallback`, the fallback is returned when the value is
   * missing, `null`, or of a different JSON type than the fallback (logged once per path).
   */
  read(parsed: ParsedConfigPath, path: ConfigPath, fallback?: unknown): unknown {
    return readValue(
      this.documents.get(parsed.key),
      parsed.segments,
      fallback,
      formatConfigPath(path),
      this.logger
    );
  }

  /** Replace (or with `undefined`, remove) a document and notify affected listeners. */
  set(key: string, document: JsonValue | undefined): void {
    const wasLoaded = this.documents.has(key);
    const previous = this.documents.get(key);
    if (document === undefined) {
      if (!wasLoaded) return;
      this.documents.delete(key);
    } else {
      this.documents.set(key, document);
    }

    for (const listener of [...this.listeners]) {
      if (listener.key !== key || !this.listeners.has(listener)) continue;
      const next = resolvePath(document, listener.segments);
      if (!wasLoaded) {
        if (listener.includeInitial) this.fire(listener, next);
        continue;
      }
      if (!deepEqual(resolvePath(previous, listener.segments), next)) this.fire(listener, next);
    }
  }

  /**
   * Listen to the value at `path`. `observe` (includeInitial) fires immediately when the document
   * is already loaded, then on every change; `onChanged` fires only on changes after the first load.
   */
  listen(
    parsed: ParsedConfigPath,
    includeInitial: boolean,
    callback: (value: JsonValue | undefined) => void
  ): Unsubscribe {
    const listener: PathListener = {
      key: parsed.key,
      segments: parsed.segments,
      includeInitial,
      callback,
    };
    this.listeners.add(listener);
    if (includeInitial && this.documents.has(parsed.key)) {
      this.fire(listener, resolvePath(this.documents.get(parsed.key), parsed.segments));
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  clearListeners(): void {
    this.listeners.clear();
  }

  private fire(listener: PathListener, value: JsonValue | undefined): void {
    invokeSafely(this.logger, "Configuration listener", () => listener.callback(cloneJson(value)));
  }
}

/** Parse a path, logging (rather than throwing) when it is unusable. */
export function parsePathOrLog(
  path: ConfigPath,
  logger: Logger,
  method: string
): ParsedConfigPath | undefined {
  const parsed = parseConfigPath(path);
  if (!parsed) {
    logger.error(
      `${method} requires a configuration path such as "GameSettings.PlayerSpeed" ` +
        `(got ${JSON.stringify(path)}).`
    );
  }
  return parsed;
}
