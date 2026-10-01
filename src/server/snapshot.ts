import type { ApiClient, Failure } from "../shared/api";
import { ConfigStore, parsePathOrLog } from "../shared/configStore";
import { toAliasSlug } from "../shared/environment";
import type { ConfigPath } from "../shared/json";
import type { Unsubscribe } from "../shared/listeners";
import { Listeners } from "../shared/listeners";
import type { Logger } from "../shared/logger";
import type { TimerHandle } from "../shared/timers";
import { startTimeout, stopTimer, withJitter } from "../shared/timers";
import type {
  BootstrapResponse,
  JsonValue,
  SdkExperimentDescriptor,
  SnapshotConfigurationSummary,
  StatusResponse,
} from "../shared/wire";

const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_JITTER = 0.2;
/** Never poll faster than this, whatever the backend or options say. */
const MIN_POLL_SECONDS = 5;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Summary of one configuration in the current snapshot. */
export interface ConfigurationInfo {
  id: number;
  name: string | null;
  /** Normalized alias; `null` for a configuration without one (not addressable by path). */
  alias: string | null;
  hash: string;
  isPrimary: boolean;
}

export interface SnapshotState {
  configurations: Map<string, JsonValue>;
  summaries: SnapshotConfigurationSummary[];
  primaryConfigurationId: number | null;
  experiments: { user: SdkExperimentDescriptor[]; server: SdkExperimentDescriptor[] };
  requiredProperties: string[];
}

export interface SnapshotDeps {
  api: ApiClient;
  logger: Logger;
  /** `false` disables background polling; `refresh()` still works. */
  autoRefresh: boolean;
  /** Overrides the backend-advertised poll interval. */
  pollIntervalSeconds: number | undefined;
}

/**
 * The environment snapshot (every configuration document plus active experiments), loaded with
 * `GET /sdk/v2/bootstrap` and kept current by polling `GET /sdk/v2/status`, which answers `304`
 * while nothing has changed. Documents are refetched only when a configuration's hash moves.
 */
export class SnapshotService {
  readonly store: ConfigStore;
  private state: SnapshotState | undefined;
  private statusHash: string | undefined;
  private pollSeconds = DEFAULT_POLL_SECONDS;
  private jitterRatio = DEFAULT_JITTER;
  private consecutiveFailures = 0;
  private timer: TimerHandle | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly changeListeners: Listeners<void>;
  private readonly readyWaiters = new Set<(loaded: boolean) => void>();
  private settled = false;
  private stopped = false;

  constructor(private readonly deps: SnapshotDeps) {
    this.store = new ConfigStore(deps.logger);
    this.changeListeners = new Listeners(deps.logger, "Snapshot change");
  }

  get loaded(): boolean {
    return this.state !== undefined;
  }

  get current(): SnapshotState | undefined {
    return this.state;
  }

  start(): void {
    void this.poll().finally(() => this.scheduleNext());
  }

  /** Resolves `true` once the snapshot has loaded; `false` on a permanent failure or timeout. */
  ready(timeoutMs?: number): Promise<boolean> {
    if (this.state) return Promise.resolve(true);
    if (this.settled || this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: TimerHandle | undefined;
      const finish = (loaded: boolean) => {
        stopTimer(timer);
        this.readyWaiters.delete(finish);
        resolve(loaded);
      };
      this.readyWaiters.add(finish);
      if (timeoutMs !== undefined) timer = startTimeout(() => finish(this.loaded), timeoutMs);
    });
  }

  /** Fires after the snapshot changes (configurations or experiments). */
  onChange(callback: () => void): Unsubscribe {
    return this.changeListeners.add(callback);
  }

  /**
   * Check for changes now. A request already in flight may predate the change the caller cares
   * about, so this waits it out and then asks again; concurrent callers share that follow-up.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    await this.poll();
  }

  /** Background poll: joins a request already in flight rather than queueing another. */
  private poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.doRefresh().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  shutdown(): void {
    this.stopped = true;
    stopTimer(this.timer);
    this.settle(this.loaded);
    this.store.clearListeners();
    this.changeListeners.clear();
  }

  configurationInfo(): ConfigurationInfo[] {
    const state = this.state;
    if (!state) return [];
    return state.summaries.map((summary) => ({
      id: summary.id,
      name: summary.name,
      alias: summary.alias === null ? null : toAliasSlug(summary.alias),
      hash: summary.hash,
      isPrimary: summary.id === state.primaryConfigurationId,
    }));
  }

  /** Read helper for `configs.get`. */
  read(path: ConfigPath, fallback: unknown, method: string): unknown {
    const parsed = parsePathOrLog(path, this.deps.logger, method);
    if (!parsed) return fallback;
    if (!this.state) {
      this.deps.logger.debug(`${method}: configurations have not loaded yet; await ready() first.`);
      return fallback;
    }
    if (!this.store.has(parsed.key)) {
      this.deps.logger.warnOnce(
        `unknown-config:${parsed.key}`,
        `No configuration with alias '${parsed.alias}' exists in this environment.`
      );
      return fallback;
    }
    return this.store.read(parsed, path, fallback);
  }

  private async doRefresh(): Promise<void> {
    if (!this.state) {
      await this.loadBootstrap();
      return;
    }

    const result = await this.deps.api.getStatus(this.statusHash);
    switch (result.status) {
      case "notModified":
        this.consecutiveFailures = 0;
        return;
      case "updated": {
        this.consecutiveFailures = 0;
        this.applyPolling(result.data);
        if (this.documentsChanged(result.data)) {
          // The status hash is only committed once the documents behind it have loaded, so a
          // failed bootstrap is retried on the next poll instead of being masked by a 304.
          if (await this.loadBootstrap()) this.statusHash = result.data.hash;
        } else {
          this.statusHash = result.data.hash;
          this.applyEnvironment(result.data);
        }
        return;
      }
      case "failed":
        this.onFailure(result);
        return;
      default: {
        const unreachable: never = result;
        throw new Error(`Unhandled fetch result ${String(unreachable)}`);
      }
    }
  }

  /** Returns whether a snapshot was applied. */
  private async loadBootstrap(): Promise<boolean> {
    const result = await this.deps.api.getBootstrap();
    if (this.stopped) return false;
    switch (result.status) {
      case "ok":
        this.consecutiveFailures = 0;
        this.applyPolling(result.data);
        this.applyBootstrap(result.data);
        return true;
      case "failed":
        this.onFailure(result);
        if (!result.retryable && !this.state) this.settle(false);
        return false;
      default: {
        const unreachable: never = result;
        throw new Error(`Unhandled fetch result ${String(unreachable)}`);
      }
    }
  }

  private applyBootstrap(snapshot: BootstrapResponse): void {
    const documents = new Map<string, JsonValue>();
    for (const configuration of snapshot.configurations) {
      if (configuration.alias === null) continue;
      const key = toAliasSlug(configuration.alias);
      if (key !== "") documents.set(key, configuration.configuration);
    }

    const previousKeys = this.store.keys();
    this.state = {
      configurations: documents,
      summaries: snapshot.configurations.map(({ id, name, alias, hash }) => ({
        id,
        name,
        alias,
        hash,
      })),
      primaryConfigurationId: snapshot.primaryConfigurationId,
      experiments: snapshot.experiments,
      requiredProperties: snapshot.requiredProperties,
    };

    for (const [key, document] of documents) this.store.set(key, document);
    for (const key of previousKeys) if (!documents.has(key)) this.store.set(key, undefined);

    this.deps.logger.debug(`Loaded ${documents.size} configuration(s).`);
    this.settle(true);
    this.changeListeners.emit();
  }

  private applyEnvironment(status: StatusResponse): void {
    if (!this.state) return;
    const before = JSON.stringify([
      this.state.primaryConfigurationId,
      this.state.experiments,
      this.state.requiredProperties,
    ]);
    this.state.primaryConfigurationId = status.primaryConfigurationId;
    this.state.experiments = status.experiments;
    this.state.requiredProperties = status.requiredProperties;
    const after = JSON.stringify([
      status.primaryConfigurationId,
      status.experiments,
      status.requiredProperties,
    ]);
    if (before !== after) this.changeListeners.emit();
  }

  private documentsChanged(status: StatusResponse): boolean {
    const held = this.state?.summaries ?? [];
    if (held.length !== status.configurations.length) return true;
    const byId = new Map(held.map((summary) => [summary.id, summary]));
    return status.configurations.some((summary) => {
      const current = byId.get(summary.id);
      return !current || current.hash !== summary.hash || current.alias !== summary.alias;
    });
  }

  private applyPolling(snapshot: StatusResponse): void {
    const { intervalSeconds, jitterRatio } = snapshot.polling;
    if (typeof intervalSeconds === "number" && intervalSeconds > 0)
      this.pollSeconds = intervalSeconds;
    if (typeof jitterRatio === "number" && jitterRatio >= 0) this.jitterRatio = jitterRatio;
  }

  private onFailure(failure: Failure): void {
    this.consecutiveFailures += 1;
    this.retryAfterMs = (failure.retryAfterSeconds ?? 0) * 1000;
    const message = `Configuration snapshot refresh failed (${failure.error}).`;
    if (failure.retryable) this.deps.logger.warn(`${message} Will retry.`);
    else this.deps.logger.error(message);
  }

  private retryAfterMs = 0;

  private scheduleNext(): void {
    if (this.stopped || !this.deps.autoRefresh) return;
    const baseSeconds = Math.max(
      MIN_POLL_SECONDS,
      this.deps.pollIntervalSeconds ?? this.pollSeconds
    );
    let delayMs = withJitter(baseSeconds * 1000, this.jitterRatio);
    if (this.consecutiveFailures > 0) {
      // Before the first load, retry quickly; afterwards back off exponentially from the interval.
      const floor = this.state ? baseSeconds * 1000 : 2_000;
      delayMs = Math.min(MAX_BACKOFF_MS, floor * 2 ** Math.min(this.consecutiveFailures - 1, 8));
      delayMs = withJitter(delayMs, 0.2);
    }
    delayMs = Math.max(delayMs, this.retryAfterMs);
    this.retryAfterMs = 0;
    this.timer = startTimeout(() => {
      void this.poll().finally(() => this.scheduleNext());
    }, delayMs);
  }

  private settle(loaded: boolean): void {
    this.settled = true;
    for (const finish of [...this.readyWaiters]) finish(loaded);
  }
}
