import type { ApiClient, Failure } from "../shared/api";
import { ConfigStore } from "../shared/configStore";
import { toAliasSlug } from "../shared/environment";
import { Latch } from "../shared/latch";
import type { Logger } from "../shared/logger";
import type { TimerHandle } from "../shared/timers";
import { startTimeout, stopTimer, withJitter } from "../shared/timers";
import type {
  BootstrapResponse,
  JsonValue,
  SdkExperimentDescriptor,
  StatusResponse,
} from "../shared/wire";

const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_JITTER = 0.2;
/** Never poll faster than this, whatever the backend or options say. */
const MIN_POLL_SECONDS = 5;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Before the first load, failed attempts retry from this floor rather than the poll interval. */
const INITIAL_RETRY_MS = 2_000;

/** Summary of one configuration in the current snapshot. */
export interface ConfigurationInfo {
  id: number;
  name: string | null;
  /** Normalized alias; `null` for a configuration without one (not addressable by path). */
  alias: string | null;
  hash: string;
  isPrimary: boolean;
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
 *
 * Documents live in `store`, keyed by normalized alias; everything else is plain state.
 */
export class SnapshotService {
  readonly store: ConfigStore;
  private info: ConfigurationInfo[] = [];
  private experimentsByUnit: {
    user: SdkExperimentDescriptor[];
    server: SdkExperimentDescriptor[];
  } = { user: [], server: [] };
  private readonly readiness: Latch;
  private loaded_ = false;
  private statusHash: string | undefined;
  private pollSeconds = DEFAULT_POLL_SECONDS;
  private jitterRatio = DEFAULT_JITTER;
  private consecutiveFailures = 0;
  private retryAfterMs = 0;
  private timer: TimerHandle | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly deps: SnapshotDeps) {
    this.store = new ConfigStore(deps.logger);
    this.readiness = new Latch(deps.logger, "Snapshot ready");
  }

  get loaded(): boolean {
    return this.loaded_;
  }

  /** Every configuration in the snapshot. Empty until loaded. */
  get configurations(): readonly ConfigurationInfo[] {
    return this.info;
  }

  get experiments(): {
    user: readonly SdkExperimentDescriptor[];
    server: readonly SdkExperimentDescriptor[];
  } {
    return this.experimentsByUnit;
  }

  start(): void {
    void this.poll().finally(() => this.scheduleNext());
  }

  /** Resolves `true` once the snapshot has loaded; `false` on a permanent failure or timeout. */
  ready(timeoutMs?: number): Promise<boolean> {
    return this.readiness.wait(timeoutMs);
  }

  /**
   * Check for changes now. A request already in flight may predate the change the caller cares
   * about, so this waits it out and then asks again; concurrent callers share that follow-up.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    await this.poll();
  }

  shutdown(): void {
    this.stopped = true;
    stopTimer(this.timer);
    this.readiness.settle(this.loaded_);
    this.store.clearListeners();
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

  private async doRefresh(): Promise<void> {
    if (!this.loaded_) {
      await this.loadBootstrap();
      return;
    }

    const result = await this.deps.api.getStatus(this.statusHash);
    switch (result.status) {
      case "notModified":
        this.consecutiveFailures = 0;
        return;
      case "updated":
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
        if (!result.retryable && !this.loaded_) this.readiness.settle(false);
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
      const key = configuration.alias === null ? "" : toAliasSlug(configuration.alias);
      if (key !== "") documents.set(key, configuration.configuration);
    }

    const previousKeys = this.store.keys();
    this.info = snapshot.configurations.map(({ id, name, alias, hash }) => ({
      id,
      name,
      alias: alias === null ? null : toAliasSlug(alias),
      hash,
      isPrimary: false,
    }));
    this.applyEnvironment(snapshot);
    // Listeners fired below may read through `configs.get`, which requires `loaded`.
    this.loaded_ = true;

    for (const [key, document] of documents) this.store.set(key, document);
    for (const key of previousKeys) if (!documents.has(key)) this.store.set(key, undefined);

    this.deps.logger.debug(`Loaded ${documents.size} configuration(s).`);
    this.readiness.settle(true);
  }

  /** The parts of the snapshot that do not need the documents: primary flag and experiments. */
  private applyEnvironment(status: StatusResponse | BootstrapResponse): void {
    this.experimentsByUnit = status.experiments;
    this.info = this.info.map((entry) => ({
      ...entry,
      isPrimary: entry.id === status.primaryConfigurationId,
    }));
  }

  private documentsChanged(status: StatusResponse): boolean {
    if (this.info.length !== status.configurations.length) return true;
    const byId = new Map(this.info.map((entry) => [entry.id, entry]));
    return status.configurations.some((summary) => {
      const current = byId.get(summary.id);
      const alias = summary.alias === null ? null : toAliasSlug(summary.alias);
      return !current || current.hash !== summary.hash || current.alias !== alias;
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

  private scheduleNext(): void {
    if (this.stopped || !this.deps.autoRefresh) return;
    const baseSeconds = Math.max(
      MIN_POLL_SECONDS,
      this.deps.pollIntervalSeconds ?? this.pollSeconds
    );
    let delayMs = withJitter(baseSeconds * 1000, this.jitterRatio);
    if (this.consecutiveFailures > 0) {
      // Before the first load, retry quickly; afterwards back off exponentially from the interval.
      const floor = this.loaded_ ? baseSeconds * 1000 : INITIAL_RETRY_MS;
      delayMs = Math.min(MAX_BACKOFF_MS, floor * 2 ** Math.min(this.consecutiveFailures - 1, 8));
      delayMs = withJitter(delayMs, 0.2);
    }
    delayMs = Math.max(delayMs, this.retryAfterMs);
    this.retryAfterMs = 0;
    this.timer = startTimeout(() => {
      void this.poll().finally(() => this.scheduleNext());
    }, delayMs);
  }
}
