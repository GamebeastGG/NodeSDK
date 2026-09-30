import type { ApiClient } from "../shared/api";
import { ConfigStore, parsePathOrLog } from "../shared/configStore";
import { toAliasSlug } from "../shared/environment";
import type { ConfigPath } from "../shared/json";
import type { Unsubscribe } from "../shared/listeners";
import { Listeners } from "../shared/listeners";
import type { Logger } from "../shared/logger";
import { describeError } from "../shared/logger";
import type { TimerHandle } from "../shared/timers";
import { startInterval, startTimeout, stopTimer } from "../shared/timers";
import { SDK_VERSION } from "../shared/version";
import type {
  ConfigurationResponse,
  ContextValue,
  ExperimentAssignmentMetadata,
  JsonValue,
} from "../shared/wire";
import type { SafeStorage } from "./storage";

/** How often configurations that have never loaded are retried, independent of the refresh cadence. */
const UNLOADED_RETRY_MS = 10_000;

/** Remote configurations, evaluated for the current user. */
export interface ClientConfigs {
  /**
   * True once every configuration listed in the `configurations` option has loaded (from cache or
   * the network) or failed permanently (for example, it does not exist). Configurations fetched on
   * demand do not affect readiness.
   */
  readonly isReady: boolean;

  /**
   * The value at `path`, whose first segment is the configuration alias:
   * `"GameSettings.PlayerSpeed"`, `"GameSettings.Levels.0"`, or `["GameSettings", "key.with.dots"]`.
   * A bare alias returns the whole document.
   *
   * Returns `undefined` when the path is missing or the configuration has not loaded yet (an
   * unknown configuration starts loading on first access; use `observe` to wait for it). The type
   * parameter is not checked at runtime — pass a `fallback` to get type-safe reads.
   */
  get<T = JsonValue>(path: ConfigPath): T | undefined;
  /**
   * The value at `path`, or `fallback` when it is missing, `null`, not loaded yet, or of a
   * different JSON type than `fallback`.
   */
  get<T>(path: ConfigPath, fallback: T): T;

  /** Call `callback` with the current value as soon as it is available, then on every change. */
  observe<T = JsonValue>(path: ConfigPath, callback: (value: T | undefined) => void): Unsubscribe;

  /** Call `callback` whenever the value at `path` changes. Does not fire for the initial load. */
  onChanged<T = JsonValue>(path: ConfigPath, callback: (value: T | undefined) => void): Unsubscribe;

  /** Call `callback` once `isReady` becomes true (immediately if it already is). */
  onReady(callback: () => void): Unsubscribe;

  /**
   * Resolves `true` once ready, or `false` if `timeoutMs` elapses first. Never rejects.
   */
  ready(options?: { timeoutMs?: number }): Promise<boolean>;

  /** Re-fetch every known configuration now. Resolves when the requests have settled. */
  refresh(): Promise<void>;
}

interface ConfigState {
  alias: string;
  key: string;
  requiredForReady: boolean;
  hash: string | undefined;
  loaded: boolean;
  /** No point retrying on the fast unloaded-retry timer (not found, rejected key, ...). */
  permanentFailure: boolean;
  inFlight: Promise<void> | undefined;
  retryNotBefore: number;
}

interface CacheEntry {
  sdkVersion: string;
  appVersion: string | null;
  distinctId: string;
  response: ConfigurationResponse;
}

export interface ClientConfigsDeps {
  api: ApiClient;
  logger: Logger;
  storage: SafeStorage;
  cachePrefix: string;
  appVersion: string | undefined;
  refreshIntervalMs: number;
  distinctId: () => string;
  properties: () => Record<string, ContextValue>;
  reportAssignments: (configKey: string, assignments: ExperimentAssignmentMetadata[]) => void;
}

export class ClientConfigsService implements ClientConfigs {
  private readonly store: ConfigStore;
  private readonly states = new Map<string, ConfigState>();
  private readonly readyListeners: Listeners<void>;
  private readonly readyWaiters = new Set<(value: boolean) => void>();
  private ready_ = false;
  private generation = 0;
  private lastRefreshAt = 0;
  private refreshTimer: TimerHandle | undefined;
  private retryTimer: TimerHandle | undefined;
  private stopped = false;

  constructor(
    private readonly deps: ClientConfigsDeps,
    declared: readonly string[]
  ) {
    this.store = new ConfigStore(deps.logger);
    this.readyListeners = new Listeners<void>(deps.logger, "OnReady");
    for (const alias of declared) {
      const trimmed = typeof alias === "string" ? alias.trim() : "";
      const key = toAliasSlug(trimmed);
      if (key === "") {
        deps.logger.error(`Ignoring invalid configuration alias ${JSON.stringify(alias)}.`);
        continue;
      }
      this.register(trimmed, key, true);
    }
    this.checkReady();
  }

  /** Begin fetching and schedule background refreshes. */
  start(): void {
    void this.refreshAll();
    if (this.deps.refreshIntervalMs > 0) {
      this.refreshTimer = startInterval(() => {
        if (isPageVisible()) void this.refreshAll();
      }, this.deps.refreshIntervalMs);
    }
    this.retryTimer = startInterval(() => this.retryUnloaded(), UNLOADED_RETRY_MS);
  }

  get isReady(): boolean {
    return this.ready_;
  }

  get<T = JsonValue>(path: ConfigPath): T | undefined;
  get<T>(path: ConfigPath, fallback: T): T;
  get<T>(path: ConfigPath, fallback?: T): T | undefined {
    const parsed = parsePathOrLog(path, this.deps.logger, "configs.get");
    if (!parsed) return fallback;
    const state = this.ensure(parsed.alias, parsed.key);
    if (!state.loaded) {
      this.deps.logger.debug(
        `Configuration '${parsed.alias}' has not loaded yet; use observe() or onReady() to wait for it.`
      );
      return fallback;
    }
    return this.store.read(parsed, path, fallback) as T | undefined;
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

  onReady(callback: () => void): Unsubscribe {
    if (typeof callback !== "function") {
      this.deps.logger.error("configs.onReady requires a callback.");
      return () => undefined;
    }
    if (this.ready_) {
      try {
        callback();
      } catch (error) {
        this.deps.logger.error(`OnReady callback threw: ${describeError(error)}`);
      }
      return () => undefined;
    }
    let unsubscribe: Unsubscribe = () => undefined;
    unsubscribe = this.readyListeners.add(() => {
      unsubscribe();
      callback();
    });
    return unsubscribe;
  }

  ready(options: { timeoutMs?: number } = {}): Promise<boolean> {
    if (this.ready_) return Promise.resolve(true);
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: TimerHandle | undefined;
      let unsubscribe: Unsubscribe = () => undefined;
      const finish = (value: boolean) => {
        stopTimer(timer);
        unsubscribe();
        this.readyWaiters.delete(finish);
        resolve(value);
      };
      unsubscribe = this.readyListeners.add(() => finish(true));
      this.readyWaiters.add(finish);
      if (options.timeoutMs !== undefined) {
        timer = startTimeout(() => finish(this.ready_), options.timeoutMs);
      }
    });
  }

  /**
   * An explicit refresh must observe the latest server state, so it waits out any request already
   * in flight (which may predate the change the caller cares about) and then fetches again.
   * Concurrent callers still share that follow-up request.
   */
  async refresh(): Promise<void> {
    this.lastRefreshAt = Date.now();
    await Promise.all([...this.states.values()].map((state) => this.refreshAfterInFlight(state)));
  }

  /** Background refresh: joins a request already in flight rather than queueing another. */
  private refreshAll(): Promise<void> {
    this.lastRefreshAt = Date.now();
    return Promise.all([...this.states.values()].map((state) => this.refreshState(state))).then(
      () => undefined
    );
  }

  /** The tab became visible again: configurations may have changed while it was in the background. */
  onPageVisible(): void {
    if (this.deps.refreshIntervalMs > 0 && Date.now() - this.lastRefreshAt >= 5_000) {
      void this.refreshAll();
    }
  }

  /**
   * Evaluated content is per user: discard in-flight responses (via the generation), drop hashes
   * so every configuration refetches in full, and refresh for the new user. Current values keep
   * serving until the re-evaluated ones land.
   */
  onIdentityChanged(): void {
    this.generation += 1;
    for (const state of this.states.values()) {
      state.hash = undefined;
      state.retryNotBefore = 0;
      void this.refreshAfterInFlight(state);
    }
  }

  /** Targeting properties changed: re-evaluate so targeted experiments see them. */
  onPropertiesChanged(): void {
    for (const state of this.states.values()) void this.refreshAfterInFlight(state);
  }

  shutdown(): void {
    this.stopped = true;
    stopTimer(this.refreshTimer);
    stopTimer(this.retryTimer);
    for (const finish of [...this.readyWaiters]) finish(this.ready_);
    this.store.clearListeners();
    this.readyListeners.clear();
  }

  // --- internals ------------------------------------------------------------------------------

  private listen<T>(
    path: ConfigPath,
    includeInitial: boolean,
    callback: (value: T | undefined) => void,
    method: string
  ): Unsubscribe {
    const parsed = parsePathOrLog(path, this.deps.logger, method);
    if (!parsed || typeof callback !== "function") {
      if (parsed) this.deps.logger.error(`${method} requires a callback.`);
      return () => undefined;
    }
    this.ensure(parsed.alias, parsed.key);
    return this.store.listen(parsed, includeInitial, (value) => callback(value as T | undefined));
  }

  private ensure(alias: string, key: string): ConfigState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const state = this.register(alias, key, false);
    this.deps.logger.debug(`Configuration '${alias}' was not preloaded; fetching it on demand.`);
    if (!this.stopped) void this.refreshState(state);
    return state;
  }

  private register(alias: string, key: string, requiredForReady: boolean): ConfigState {
    const existing = this.states.get(key);
    if (existing) {
      existing.requiredForReady ||= requiredForReady;
      return existing;
    }

    const state: ConfigState = {
      alias,
      key,
      requiredForReady,
      hash: undefined,
      loaded: false,
      permanentFailure: false,
      inFlight: undefined,
      retryNotBefore: 0,
    };
    this.states.set(key, state);

    const cached = this.loadCache(key);
    if (cached) {
      this.apply(state, cached, false);
      this.deps.logger.debug(`Loaded cached configuration '${alias}'.`);
    }
    return state;
  }

  private refreshState(state: ConfigState): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (state.inFlight) return state.inFlight;
    const promise = this.fetchState(state).finally(() => {
      state.inFlight = undefined;
    });
    state.inFlight = promise;
    return promise;
  }

  private async refreshAfterInFlight(state: ConfigState): Promise<void> {
    if (state.inFlight) await state.inFlight;
    await this.refreshState(state);
  }

  private async fetchState(state: ConfigState): Promise<void> {
    const generation = this.generation;
    const properties = this.deps.properties();
    const body = {
      configuration: state.alias,
      unit: { type: "user" as const, distinctId: this.deps.distinctId() },
      ...(Object.keys(properties).length > 0
        ? { context: { schemaVersion: 1 as const, properties } }
        : {}),
      ...(state.hash !== undefined ? { knownHash: state.hash } : {}),
    };

    const result = await this.deps.api.evaluateConfiguration(body);
    // The identity changed while this request was in flight: it was evaluated for the previous user.
    if (generation !== this.generation || this.stopped) return;

    switch (result.status) {
      case "updated":
        state.permanentFailure = false;
        this.apply(state, result.data, true);
        this.deps.logger.debug(
          `Configuration '${state.alias}' updated (hash ${result.data.hash}).`
        );
        break;
      case "notModified":
        this.deps.logger.debug(`Configuration '${state.alias}' unchanged.`);
        break;
      case "notFound":
        state.permanentFailure = true;
        this.deps.logger.warnOnce(
          `not-found:${state.key}`,
          `Configuration '${state.alias}' was not found in this environment (${result.error}).`
        );
        break;
      case "failed":
        state.permanentFailure = !result.retryable;
        if (result.retryAfterSeconds !== undefined) {
          state.retryNotBefore = Date.now() + result.retryAfterSeconds * 1000;
        }
        if (result.retryable) {
          this.deps.logger.warn(
            `Refreshing configuration '${state.alias}' failed (${result.error}); will retry.`
          );
        } else {
          this.deps.logger.error(
            `Configuration '${state.alias}' could not be fetched: ${result.error}.`
          );
        }
        break;
      default: {
        const unreachable: never = result;
        throw new Error(`Unhandled fetch result ${String(unreachable)}`);
      }
    }
    this.checkReady();
  }

  private apply(state: ConfigState, response: ConfigurationResponse, persist: boolean): void {
    state.hash = response.hash;
    state.loaded = true;
    if (persist) this.saveCache(state.key, response);
    this.deps.reportAssignments(state.key, response.experiments ?? []);
    this.store.set(state.key, response.configuration);
    this.checkReady();
  }

  private retryUnloaded(): void {
    if (this.stopped || !isPageVisible()) return;
    const now = Date.now();
    for (const state of this.states.values()) {
      if (
        !state.loaded &&
        !state.permanentFailure &&
        !state.inFlight &&
        now >= state.retryNotBefore
      ) {
        void this.refreshState(state);
      }
    }
  }

  private checkReady(): void {
    if (this.ready_) return;
    for (const state of this.states.values()) {
      if (state.requiredForReady && !state.loaded && !state.permanentFailure) return;
    }
    this.ready_ = true;
    this.readyListeners.emit();
    this.readyListeners.clear();
  }

  private cacheKey(key: string): string {
    return `${this.deps.cachePrefix}:config:${key}`;
  }

  private loadCache(key: string): ConfigurationResponse | undefined {
    const entry = this.deps.storage.getJson<CacheEntry>(this.cacheKey(key));
    if (
      !entry ||
      entry.sdkVersion !== SDK_VERSION ||
      entry.appVersion !== (this.deps.appVersion ?? null) ||
      entry.distinctId !== this.deps.distinctId() ||
      typeof entry.response?.hash !== "string" ||
      !("configuration" in entry.response)
    ) {
      return undefined;
    }
    return entry.response;
  }

  private saveCache(key: string, response: ConfigurationResponse): void {
    const entry: CacheEntry = {
      sdkVersion: SDK_VERSION,
      appVersion: this.deps.appVersion ?? null,
      distinctId: this.deps.distinctId(),
      response,
    };
    if (!this.deps.storage.setJson(this.cacheKey(key), entry)) {
      this.deps.logger.debug(
        `Could not cache configuration '${key}' (storage unavailable or full).`
      );
    }
  }
}

export function isPageVisible(): boolean {
  const doc = (globalThis as { document?: { visibilityState?: string } }).document;
  return doc?.visibilityState !== "hidden";
}
