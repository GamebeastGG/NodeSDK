import type { Logger } from "../shared/logger";
import type { BaseOptions } from "../shared/options";
import { durationMs, positiveNumber, resolveBaseOptions } from "../shared/options";
import { uuidv4 } from "../shared/uuid";
import type { ServerCohorts } from "./cohorts";
import { ServerCohortsService } from "./cohorts";
import type { ServerConfigs } from "./configs";
import { ServerConfigsService } from "./configs";
import type { ServerExperiments } from "./experiments";
import { ServerExperimentsService } from "./experiments";
import type { MarkerQueueSettings, ServerMarkers } from "./markers";
import { ServerMarkersService } from "./markers";
import { SnapshotService } from "./snapshot";
import { validateWithContract } from "./validation";

export interface GamebeastServerOptions extends BaseOptions {
  /**
   * Identifies this process to Gamebeast. Snapshot polling is rate-limited per API key *and*
   * server id, and server-level markers are attributed to it. Defaults to a random id per process.
   */
  serverId?: string;
  /**
   * Keep configurations and experiments current by polling in the background (cheap: unchanged
   * snapshots answer `304`). Set `false` for short-lived processes such as serverless functions and
   * call `configs.refresh()` yourself. Defaults to `true`.
   */
  autoRefresh?: boolean;
  /** Poll interval in seconds. Defaults to the interval the backend advertises (30s); minimum 5. */
  pollIntervalSeconds?: number;
  /**
   * How long (seconds) `configs.evaluate` reuses a unit's evaluation without asking the backend.
   * After that, the backend is asked again with the known hash (a `304` when unchanged). `0`
   * always asks. Defaults to 30.
   */
  evaluationCacheSeconds?: number;
  /** Marker batching. */
  markers?: MarkerQueueSettings;
}

/**
 * The Gamebeast server SDK, for Node.js (>= 20) and other server runtimes with `fetch`.
 *
 * ```ts
 * import { GamebeastServer } from "@gamebeast/sdk/server";
 *
 * const gamebeast = new GamebeastServer({ apiKey: process.env.GAMEBEAST_API_KEY! });
 * await gamebeast.configs.ready();
 *
 * const config = await gamebeast.configs.evaluate({ configuration: "GameSettings", distinctId: user.id });
 * const speed = config.get("PlayerSpeed", 1);
 *
 * gamebeast.markers.send("purchase_completed", { sku: "gems_100" }, { distinctId: user.id });
 * await gamebeast.shutdown(); // on process exit: flushes buffered markers
 * ```
 *
 * Create one instance per process and share it. Its timers never keep the process alive.
 */
export class GamebeastServer {
  /** Remote configurations: base values, and per-user evaluation. */
  readonly configs: ServerConfigs;
  /** Analytics markers. */
  readonly markers: ServerMarkers;
  /** Active experiments and bulk assignment. */
  readonly experiments: ServerExperiments;
  /** Cohort membership. */
  readonly cohorts: ServerCohorts;
  /** The id this process reports as (`serverId` option or a generated one). */
  readonly serverId: string;

  private readonly logger: Logger;
  private readonly snapshot: SnapshotService;
  private readonly configsService: ServerConfigsService;
  private readonly markersService: ServerMarkersService;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: GamebeastServerOptions) {
    const serverId =
      typeof options?.serverId === "string" && options.serverId.trim() !== ""
        ? options.serverId.trim()
        : uuidv4();
    const base = resolveBaseOptions(options, "server", {
      serverId,
      validateResponse: validateWithContract,
    });
    this.logger = base.logger;
    this.serverId = serverId;

    this.snapshot = new SnapshotService({
      api: base.api,
      logger: this.logger,
      autoRefresh: options.autoRefresh !== false,
      pollIntervalSeconds: positiveNumber(options.pollIntervalSeconds),
    });

    this.configsService = new ServerConfigsService({
      api: base.api,
      logger: this.logger,
      snapshot: this.snapshot,
      cacheTtlMs: durationMs(options.evaluationCacheSeconds, 30, 1000),
    });
    this.markersService = new ServerMarkersService(base.api, this.logger, options.markers);

    this.configs = this.configsService;
    this.markers = this.markersService;
    this.experiments = new ServerExperimentsService(base.api, this.logger, this.snapshot);
    this.cohorts = new ServerCohortsService(base.api, this.logger);

    this.snapshot.start();
    this.logger.debug(`Initialized for environment '${base.environment}' as server '${serverId}'.`);
  }

  /** Send buffered markers now. Resolves once the requests have settled. */
  flush(): Promise<void> {
    return this.markersService.flush();
  }

  /**
   * Stop polling and flush buffered markers. Call before the process exits (e.g. on `SIGTERM`).
   * Further markers are dropped.
   */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.snapshot.shutdown();
      this.shutdownPromise = this.markersService.shutdown();
    }
    return this.shutdownPromise;
  }
}
