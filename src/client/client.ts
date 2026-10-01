import type { ApiClient } from "../shared/api";
import type { Properties } from "../shared/context";
import { sanitizeProperties } from "../shared/context";
import type { Logger } from "../shared/logger";
import type { BaseOptions } from "../shared/options";
import { durationMs, resolveBaseOptions } from "../shared/options";
import type { ContextValue } from "../shared/wire";
import type { ClientCohorts } from "./cohorts";
import { ClientCohortsService } from "./cohorts";
import type { ClientConfigs } from "./configs";
import { ClientConfigsService, isPageVisible } from "./configs";
import type { ClientExperiments } from "./experiments";
import { ClientExperimentsService } from "./experiments";
import type { Identity } from "./identity";
import { SessionTracker, anonymousIdentity } from "./identity";
import { normalizeDistinctId } from "../shared/ids";
import type { ClientMarkers } from "./markers";
import { ClientMarkersService } from "./markers";
import type { KeyValueStorage } from "./storage";
import { SafeStorage, fingerprint } from "./storage";

export interface GamebeastClientOptions extends BaseOptions {
  /**
   * The signed-in user's id. When omitted, the SDK generates an anonymous id on first visit and
   * keeps it in `localStorage`, so the same browser reports as the same user across visits.
   */
  distinctId?: string;
  /**
   * Configurations to load immediately, by alias (e.g. `["GameSettings"]`). They gate
   * `configs.isReady` / `configs.onReady`. Any other configuration loads the first time it is read.
   */
  configurations?: readonly string[];
  /**
   * How often (seconds) to re-check configurations while the page is visible. Change detection is
   * hash-based, so an unchanged configuration is a cheap round trip. `0` disables background
   * refresh (`configs.refresh()` still works). Defaults to 60.
   */
  configRefreshIntervalSeconds?: number;
  /**
   * Targeting properties for the current user (e.g. `{ plan: "pro", accountAgeDays: 12 }`), sent
   * with every configuration evaluation. Update later with `setProperties`.
   */
  properties?: Properties;
  /**
   * Your app's version, sent as the `appVersion` targeting property. Configurations cached by a
   * different version are discarded.
   */
  appVersion?: string;
  /**
   * Minutes of inactivity after which a new session starts. Sessions are shared across tabs.
   * `0` keeps one session until the browser storage is cleared. Defaults to 30.
   */
  sessionTimeoutMinutes?: number;
  /**
   * Where to keep the anonymous id, session and caches. Defaults to `localStorage` (falling back to
   * memory where it is unavailable). Pass `null` to keep nothing beyond the page's lifetime.
   */
  storage?: KeyValueStorage | null;
}

/**
 * True when there is no page and no browser worker: server-side rendering in Node, Deno, Bun or an
 * edge runtime. Browser workers (dedicated/shared/service) define `importScripts`; edge runtimes
 * that mimic the worker API (e.g. Cloudflare Workers) do not.
 */
function isServerSideRender(): boolean {
  const scope = globalThis as { window?: unknown; document?: unknown; importScripts?: unknown };
  return (
    scope.window === undefined &&
    scope.document === undefined &&
    typeof scope.importScripts !== "function"
  );
}

interface PageEvents {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * The Gamebeast browser SDK.
 *
 * ```ts
 * import { GamebeastClient } from "@gamebeast/sdk/client";
 *
 * const gamebeast = new GamebeastClient({ apiKey: "…", configurations: ["GameSettings"] });
 * gamebeast.markers.send("level_completed", { level: 3 });
 * const speed = gamebeast.configs.get("GameSettings.PlayerSpeed", 1);
 * ```
 *
 * Safe to construct during server-side rendering: browser APIs are only touched when present.
 * Create one instance per page (a module-level singleton works well).
 */
export class GamebeastClient {
  /** Remote configurations, evaluated for the current user. */
  readonly configs: ClientConfigs;
  /** Analytics markers. */
  readonly markers: ClientMarkers;
  /** The experiments the current user is enrolled in. */
  readonly experiments: ClientExperiments;
  /** Cohort membership for the current user. */
  readonly cohorts: ClientCohorts;

  private readonly logger: Logger;
  private readonly api: ApiClient;
  private readonly storage: SafeStorage;
  private readonly session: SessionTracker;
  private readonly configsService: ClientConfigsService;
  private readonly markersService: ClientMarkersService;
  private readonly experimentsService: ClientExperimentsService;
  private readonly appVersion: string | undefined;
  private identity: Identity;
  private userProperties: Record<string, ContextValue>;
  private readonly detachPageEvents: () => void;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: GamebeastClientOptions) {
    const base = resolveBaseOptions(options, "web");
    this.logger = base.logger;
    this.api = base.api;
    this.storage = new SafeStorage(options.storage);
    this.appVersion =
      typeof options.appVersion === "string" && options.appVersion !== ""
        ? options.appVersion
        : undefined;

    const prefix = `gamebeast:${fingerprint(`${options.apiKey.trim()}|${options.projectId ?? ""}`)}:${base.environment}`;

    this.identity = this.resolveInitialIdentity(options.distinctId);
    this.userProperties = sanitizeProperties(options.properties, this.logger);

    // Rendering on the server: there is no user here, only an anonymous id minted per render. Every
    // service is built inert (reads return fallbacks, markers are dropped) and nothing is started.
    const inert = isServerSideRender();

    this.session = new SessionTracker(
      this.storage,
      durationMs(options.sessionTimeoutMinutes, 30, 60_000)
    );

    this.experimentsService = new ClientExperimentsService(this.api, this.logger);
    this.cohorts = new ClientCohortsService({
      api: this.api,
      logger: this.logger,
      distinctId: () => this.identity.distinctId,
      inert,
    });

    this.configsService = new ClientConfigsService(
      {
        api: this.api,
        logger: this.logger,
        storage: this.storage,
        cachePrefix: prefix,
        appVersion: this.appVersion,
        refreshIntervalMs: durationMs(options.configRefreshIntervalSeconds, 60, 1000),
        distinctId: () => this.identity.distinctId,
        properties: () => this.evaluationProperties(),
        reportAssignments: (key, assignments) => this.experimentsService.report(key, assignments),
        inert,
      },
      options.configurations ?? []
    );

    this.markersService = new ClientMarkersService({
      api: this.api,
      logger: this.logger,
      storage: this.storage,
      storageKey: `${prefix}:markers`,
      stamp: () => ({ distinctId: this.identity.distinctId, sessionId: this.session.touch() }),
      inert,
    });

    this.configs = this.configsService;
    this.markers = this.markersService;
    this.experiments = this.experimentsService;

    if (inert) {
      this.detachPageEvents = () => undefined;
      this.logger.debug(
        "Running outside a browser: GamebeastClient is inert here. Use @gamebeast/sdk/server on servers."
      );
      return;
    }
    this.detachPageEvents = this.attachPageEvents();
    this.markersService.restorePersisted();
    this.configsService.start();

    this.logger.debug(
      `Initialized for environment '${base.environment}' as ` +
        `${this.identity.isAnonymous ? "anonymous" : "identified"} user '${this.identity.distinctId}'.`
    );
  }

  /** The current user's id: the one passed to `identify` / options, or the anonymous id. */
  get distinctId(): string {
    return this.identity.distinctId;
  }

  /** True while the SDK is using its generated anonymous id. */
  get isAnonymous(): boolean {
    return this.identity.isAnonymous;
  }

  /** The current session id, shared by every tab of this site. */
  get sessionId(): string {
    return this.session.id;
  }

  /**
   * Switch to a signed-in user. Configurations are re-evaluated for them right away and experiment
   * assignments follow. Markers already recorded keep the id they were recorded under. The id is
   * not persisted: call `identify` again on the next page load (or pass `distinctId` in options).
   */
  identify(distinctId: string): void {
    const normalized = normalizeDistinctId(distinctId);
    if (normalized === undefined) {
      this.logger.error("identify requires a non-empty distinct id of at most 256 characters.");
      return;
    }
    if (!this.identity.isAnonymous && normalized === this.identity.distinctId) return;
    this.setIdentity({ distinctId: normalized, isAnonymous: false });
  }

  /** Return to this browser's anonymous id (e.g. after sign-out). */
  resetIdentity(): void {
    if (this.identity.isAnonymous) return;
    this.setIdentity(anonymousIdentity(this.storage));
  }

  /**
   * Replace the targeting properties (merged over the SDK's defaults: `platform`, `systemLanguage`
   * and `appVersion`). Configurations are re-evaluated so targeted experiments see the new values.
   */
  setProperties(properties: Properties): void {
    this.userProperties = sanitizeProperties(properties, this.logger);
    this.configsService.onPropertiesChanged();
  }

  /** Send buffered markers now. Resolves once the requests have settled. */
  flush(): Promise<void> {
    return this.markersService.flush();
  }

  /**
   * Stop background work, flush markers and remove page listeners. Further markers are dropped.
   * Mainly for tests and single-page apps that tear the SDK down; pages do not need to call it.
   */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.detachPageEvents();
      this.configsService.shutdown();
      this.experimentsService.shutdown();
      this.shutdownPromise = this.markersService.shutdown();
    }
    return this.shutdownPromise;
  }

  private resolveInitialIdentity(distinctId: string | undefined): Identity {
    if (distinctId !== undefined && distinctId !== null) {
      const normalized = normalizeDistinctId(distinctId);
      if (normalized !== undefined) return { distinctId: normalized, isAnonymous: false };
      this.logger.error("Ignoring invalid `distinctId` option; using the anonymous id instead.");
    }
    return anonymousIdentity(this.storage);
  }

  private setIdentity(identity: Identity): void {
    this.identity = identity;
    this.experimentsService.onIdentityChanged();
    this.configsService.onIdentityChanged();
    this.logger.debug(`Identity changed to '${identity.distinctId}'.`);
  }

  /** SDK defaults (named like the Unity SDK's, so one targeting rule covers both), then the app's. */
  private evaluationProperties(): Record<string, ContextValue> {
    const defaults: Record<string, ContextValue> = { platform: "web" };
    const navigatorLike = (globalThis as { navigator?: { language?: string } }).navigator;
    if (typeof navigatorLike?.language === "string" && navigatorLike.language !== "") {
      defaults.systemLanguage = navigatorLike.language;
    }
    if (this.appVersion !== undefined) defaults.appVersion = this.appVersion;
    return { ...defaults, ...this.userProperties };
  }

  private attachPageEvents(): () => void {
    const doc = (globalThis as { document?: PageEvents }).document;
    const win = (globalThis as { window?: PageEvents }).window;
    if (!doc || !win || typeof doc.addEventListener !== "function") return () => undefined;

    const online = () =>
      (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false;
    const onHidden = () => this.markersService.onPageHidden(online());
    const onVisibility = () => {
      if (isPageVisible()) {
        this.markersService.restorePersisted();
        this.configsService.onPageVisible();
      } else {
        onHidden();
      }
    };
    const onOnline = () => this.markersService.restorePersisted();

    doc.addEventListener("visibilitychange", onVisibility);
    win.addEventListener("pagehide", onHidden);
    win.addEventListener("online", onOnline);
    return () => {
      doc.removeEventListener("visibilitychange", onVisibility);
      win.removeEventListener("pagehide", onHidden);
      win.removeEventListener("online", onOnline);
    };
  }
}
