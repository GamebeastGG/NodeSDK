import type { ApiClient, FetchResult } from "../shared/api";
import { parsePathOrLog, readValue } from "../shared/configStore";
import type { Properties } from "../shared/context";
import { sanitizeProperties } from "../shared/context";
import { toAliasSlug } from "../shared/environment";
import type { ConfigPath } from "../shared/json";
import { formatConfigPath } from "../shared/json";
import type { Unsubscribe } from "../shared/listeners";
import type { Logger } from "../shared/logger";
import type {
  ConfigurationResponse,
  EvaluateConfigurationBody,
  ExperimentAssignmentMetadata,
  JsonValue,
  UnitType,
} from "../shared/wire";
import { normalizeDistinctId as normalizeUnitId } from "../shared/ids";
import type { ConfigurationInfo, SnapshotService } from "./snapshot";

const DEFAULT_CACHE_MAX_ENTRIES = 10_000;

/** Where an evaluated configuration's value came from. */
export type EvaluationSource =
  /** Evaluated by the backend for this unit (fresh, or confirmed unchanged). */
  | "evaluated"
  /** Evaluation failed; this is the unit's last evaluated value. */
  | "stale"
  /** Evaluation failed and nothing was cached; this is the unevaluated base configuration. */
  | "base"
  /** Evaluation failed and no configuration is available. `get` returns fallbacks. */
  | "unavailable";

/** A configuration evaluated for one user or server: experiment changes already merged in. */
export interface EvaluatedConfiguration {
  readonly source: EvaluationSource;
  readonly configurationId: number | null;
  readonly name: string | null;
  readonly hash: string | null;
  /** The whole document (a copy). `undefined` when `source` is `"unavailable"`. */
  readonly value: JsonValue | undefined;
  /** Experiments that shaped this value; empty for `"base"` and `"unavailable"`. */
  readonly experiments: readonly ExperimentAssignmentMetadata[];
  /** Why evaluation failed, when `source` is not `"evaluated"`. */
  readonly error: string | undefined;
  /**
   * Read a value inside the document. `path` is relative to the document root — `"PlayerSpeed"`,
   * `"UI.ButtonColor"`, `["key.with.dots"]` — and an empty path returns the whole document.
   */
  get<T = JsonValue>(path?: ConfigPath): T | undefined;
  get<T>(path: ConfigPath, fallback: T): T;
}

export interface EvaluateOptions {
  /** The user (or, with `unitType: "server"`, server) to evaluate for. */
  distinctId: string;
  /** Configuration alias. Omit to evaluate the project's primary configuration. */
  configuration?: string;
  /** Targeting properties of the unit (e.g. `{ plan: "pro" }`). */
  properties?: Properties;
  /** Defaults to `"user"`. */
  unitType?: UnitType;
}

/** Remote configurations on the server. */
export interface ServerConfigs {
  /** True once the configuration snapshot has loaded. */
  readonly isReady: boolean;

  /**
   * Resolves `true` once configurations have loaded, or `false` on a permanent failure (e.g. the
   * API key lacks access) or when `timeoutMs` elapses. Never rejects.
   */
  ready(options?: { timeoutMs?: number }): Promise<boolean>;

  /**
   * The **base** (unevaluated) value at `path`, whose first segment is the configuration alias:
   * `"GameSettings.PlayerSpeed"`. No experiment is applied — use `evaluate` for per-user values.
   */
  get<T = JsonValue>(path: ConfigPath): T | undefined;
  get<T>(path: ConfigPath, fallback: T): T;

  /** Call `callback` with the current base value as soon as it is available, then on every change. */
  observe<T = JsonValue>(path: ConfigPath, callback: (value: T | undefined) => void): Unsubscribe;

  /** Call `callback` whenever the base value at `path` changes. Does not fire for the initial load. */
  onChanged<T = JsonValue>(path: ConfigPath, callback: (value: T | undefined) => void): Unsubscribe;

  /** Every configuration in the environment. Empty until loaded. */
  list(): ConfigurationInfo[];

  /**
   * Evaluate a configuration for one user or server: the backend resolves (and records) their
   * experiment assignments and returns the document with the assigned groups' changes merged in.
   *
   * Never rejects. If the backend is unreachable the result falls back to the unit's last
   * evaluated value, then to the base configuration — check `source` when that matters.
   */
  evaluate(options: EvaluateOptions): Promise<EvaluatedConfiguration>;

  /** Check the backend for configuration and experiment changes now. */
  refresh(): Promise<void>;
}

interface CacheEntry {
  response: ConfigurationResponse;
  fetchedAt: number;
}

class Evaluated implements EvaluatedConfiguration {
  constructor(
    readonly source: EvaluationSource,
    private readonly document: JsonValue | undefined,
    readonly configurationId: number | null,
    readonly name: string | null,
    readonly hash: string | null,
    readonly experiments: readonly ExperimentAssignmentMetadata[],
    readonly error: string | undefined,
    private readonly logger: Logger
  ) {}

  get value(): JsonValue | undefined {
    return readValue(this.document, [], undefined, "", this.logger) as JsonValue | undefined;
  }

  get<T = JsonValue>(path?: ConfigPath): T | undefined;
  get<T>(path: ConfigPath, fallback: T): T;
  get<T>(path: ConfigPath = [], fallback?: T): T | undefined {
    let segments: string[];
    if (typeof path === "string") segments = path === "" ? [] : path.split(".");
    else if (Array.isArray(path) && path.every((segment) => typeof segment === "string"))
      segments = [...path];
    else {
      this.logger.error(
        `EvaluatedConfiguration.get received an invalid path ${JSON.stringify(path)}.`
      );
      return fallback;
    }
    const label = `${this.name ?? this.configurationId ?? "configuration"}:${formatConfigPath(path)}`;
    return readValue(this.document, segments, fallback, label, this.logger) as T | undefined;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface ServerConfigsDeps {
  api: ApiClient;
  logger: Logger;
  snapshot: SnapshotService;
  /** How long an evaluation is reused without asking the backend. `0` always asks. */
  cacheTtlMs: number;
  cacheMaxEntries?: number;
}

export class ServerConfigsService implements ServerConfigs {
  /** Insertion-ordered, so the first key is the least recently used. */
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<EvaluatedConfiguration>>();
  private readonly maxEntries: number;

  constructor(private readonly deps: ServerConfigsDeps) {
    this.maxEntries = Math.max(0, deps.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);
  }

  get isReady(): boolean {
    return this.deps.snapshot.loaded;
  }

  ready(options: { timeoutMs?: number } = {}): Promise<boolean> {
    return this.deps.snapshot.ready(options.timeoutMs);
  }

  get<T = JsonValue>(path: ConfigPath): T | undefined;
  get<T>(path: ConfigPath, fallback: T): T;
  get<T>(path: ConfigPath, fallback?: T): T | undefined {
    return this.deps.snapshot.read(path, fallback, "configs.get") as T | undefined;
  }

  observe<T = JsonValue>(path: ConfigPath, callback: (value: T | undefined) => void): Unsubscribe {
    return this.listen(path, true, callback, "configs.observe");
  }

  onChanged<T = JsonValue>(
    path: ConfigPath,
    callback: (value: T | undefined) => void
  ): Unsubscribe {
    return this.listen(path, false, callback, "configs.onChanged");
  }

  list(): ConfigurationInfo[] {
    return this.deps.snapshot.configurationInfo();
  }

  refresh(): Promise<void> {
    return this.deps.snapshot.refresh();
  }

  evaluate(options: EvaluateOptions): Promise<EvaluatedConfiguration> {
    const logger = this.deps.logger;
    const unitType: UnitType = options?.unitType ?? "user";
    if (unitType !== "user" && unitType !== "server") {
      logger.error(`configs.evaluate: unitType must be "user" or "server".`);
      return Promise.resolve(this.fallback(options?.configuration, "invalid unitType"));
    }
    const distinctId = normalizeUnitId(options?.distinctId);
    if (distinctId === undefined) {
      logger.error("configs.evaluate requires a distinctId of 1-256 characters.");
      return Promise.resolve(this.fallback(options?.configuration, "invalid distinctId"));
    }
    let alias: string | undefined;
    if (options.configuration !== undefined) {
      alias = typeof options.configuration === "string" ? options.configuration.trim() : "";
      if (toAliasSlug(alias) === "") {
        logger.error(`configs.evaluate received an invalid configuration alias.`);
        return Promise.resolve(this.fallback(undefined, "invalid configuration alias"));
      }
    }
    const properties = sanitizeProperties(options.properties, logger);

    const cacheKey = [
      unitType,
      distinctId,
      alias === undefined ? "" : toAliasSlug(alias),
      stableStringify(properties),
    ].join("\u0000");

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < this.deps.cacheTtlMs) {
      this.touch(cacheKey, cached);
      return Promise.resolve(this.fromResponse("evaluated", cached.response, undefined));
    }

    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const body: EvaluateConfigurationBody = {
      unit: { type: unitType, distinctId },
      ...(alias !== undefined ? { configuration: alias } : {}),
      ...(Object.keys(properties).length > 0
        ? { context: { schemaVersion: 1 as const, properties } }
        : {}),
      ...(cached ? { knownHash: cached.response.hash } : {}),
    };

    const promise = this.deps.api
      .evaluateConfiguration(body)
      .then((result) => this.handle(result, cacheKey, cached, alias))
      .finally(() => {
        if (this.inFlight.get(cacheKey) === promise) this.inFlight.delete(cacheKey);
      });
    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /** Drop cached evaluations (all, or one unit's). */
  clearCache(distinctId?: string): void {
    if (distinctId === undefined) {
      this.cache.clear();
      return;
    }
    for (const key of [...this.cache.keys()]) {
      if (key.split("\u0000")[1] === distinctId) this.cache.delete(key);
    }
  }

  private handle(
    result: FetchResult<ConfigurationResponse>,
    cacheKey: string,
    cached: CacheEntry | undefined,
    alias: string | undefined
  ): EvaluatedConfiguration {
    switch (result.status) {
      case "updated":
        this.store(cacheKey, { response: result.data, fetchedAt: Date.now() });
        return this.fromResponse("evaluated", result.data, undefined);
      case "notModified":
        if (cached) {
          this.store(cacheKey, { response: cached.response, fetchedAt: Date.now() });
          return this.fromResponse("evaluated", cached.response, undefined);
        }
        return this.fallback(alias, "unexpected 304 without a cached evaluation");
      case "notFound":
        this.cache.delete(cacheKey);
        this.deps.logger.warnOnce(
          `evaluate-not-found:${alias ?? ""}`,
          alias === undefined
            ? "configs.evaluate: this environment has no primary configuration."
            : `configs.evaluate: configuration '${alias}' was not found in this environment.`
        );
        return new Evaluated(
          "unavailable",
          undefined,
          null,
          null,
          null,
          [],
          result.error,
          this.deps.logger
        );
      case "failed":
        this.deps.logger.warn(`configs.evaluate failed (${result.error}); using a fallback value.`);
        if (cached) return this.fromResponse("stale", cached.response, result.error);
        return this.fallback(alias, result.error);
      default: {
        const unreachable: never = result;
        throw new Error(`Unhandled fetch result ${String(unreachable)}`);
      }
    }
  }

  private fromResponse(
    source: EvaluationSource,
    response: ConfigurationResponse,
    error: string | undefined
  ): EvaluatedConfiguration {
    return new Evaluated(
      source,
      response.configuration,
      response.configurationId,
      response.name,
      response.hash,
      Object.freeze([...(response.experiments ?? [])]),
      error,
      this.deps.logger
    );
  }

  /** The base configuration from the snapshot, when it has one for this alias (or the primary). */
  private fallback(alias: string | undefined, error: string): EvaluatedConfiguration {
    const state = this.deps.snapshot.current;
    const info = this.deps.snapshot.configurationInfo();
    const match =
      alias === undefined
        ? info.find((entry) => entry.isPrimary)
        : info.find((entry) => entry.alias === toAliasSlug(alias));
    const document = match?.alias ? state?.configurations.get(match.alias) : undefined;
    if (!match || document === undefined) {
      return new Evaluated("unavailable", undefined, null, null, null, [], error, this.deps.logger);
    }
    return new Evaluated(
      "base",
      document,
      match.id,
      match.name,
      match.hash,
      [],
      error,
      this.deps.logger
    );
  }

  private store(key: string, entry: CacheEntry): void {
    if (this.maxEntries === 0 || this.deps.cacheTtlMs <= 0) return;
    this.touch(key, entry);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private touch(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private listen<T>(
    path: ConfigPath,
    includeInitial: boolean,
    callback: (value: T | undefined) => void,
    method: string
  ): Unsubscribe {
    const parsed = parsePathOrLog(path, this.deps.logger, method);
    if (!parsed) return () => undefined;
    if (typeof callback !== "function") {
      this.deps.logger.error(`${method} requires a callback.`);
      return () => undefined;
    }
    return this.deps.snapshot.store.listen(parsed, includeInitial, (value) =>
      callback(value as T | undefined)
    );
  }
}
