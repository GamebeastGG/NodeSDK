import type { FetchLike } from "./http";
import { ApiClient, DEFAULT_API_URL } from "./api";
import {
  DEVELOPMENT_ENVIRONMENT,
  PRODUCTION_ENVIRONMENT,
  normalizeEnvironment,
  toLegacyEnvironment,
} from "./environment";
import type { GamebeastLogger } from "./logger";
import { Logger } from "./logger";

/** Options shared by the browser and server SDKs. */
export interface BaseOptions {
  /** Your Gamebeast API key. Required. */
  apiKey: string;
  /**
   * Environment alias as configured in the dashboard: `"production"` (default), `"development"`,
   * or a custom one such as `"staging"`. `"studio"` is accepted as a synonym for `"development"`.
   */
  environment?: string;
  /**
   * For keys that can access several projects: the id of the project to act on. Single-project
   * keys do not need it.
   */
  projectId?: number;
  /** Override the Gamebeast API base URL. Leave unset for production use. */
  apiUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 10 seconds. */
  requestTimeoutMs?: number;
  /** Custom `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Where SDK log lines go. Defaults to the console. */
  logger?: GamebeastLogger;
  /** Log debug lines (requests, cache hits, refreshes). Warnings and errors are always logged. */
  debug?: boolean;
}

export interface ResolvedBase {
  logger: Logger;
  environment: string;
  api: ApiClient;
}

/**
 * Validate options common to both SDKs. Misconfiguration throws immediately (a missing key or an
 * unusable environment is a programming error, not a runtime condition to limp along with).
 */
export function resolveBaseOptions(
  options: BaseOptions,
  flavor: "web" | "server",
  extras: { serverId?: string } = {}
): ResolvedBase {
  if (options === null || typeof options !== "object") {
    throw new TypeError("[Gamebeast] Options are required, e.g. { apiKey: '...' }.");
  }
  if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") {
    throw new TypeError("[Gamebeast] `apiKey` is required.");
  }

  const environment = normalizeEnvironment(options.environment ?? PRODUCTION_ENVIRONMENT);
  if (environment === undefined) {
    throw new TypeError(
      `[Gamebeast] Invalid environment '${String(options.environment)}'. ` +
        "Use an alias from your dashboard, e.g. 'production' or 'development'."
    );
  }

  if (
    options.projectId !== undefined &&
    (!Number.isInteger(options.projectId) || options.projectId <= 0)
  ) {
    throw new TypeError("[Gamebeast] `projectId` must be a positive integer.");
  }

  const fetchImpl =
    options.fetch ?? (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
  if (!fetchImpl) {
    throw new TypeError(
      "[Gamebeast] No global `fetch` is available in this runtime; pass one via the `fetch` option."
    );
  }

  const logger = new Logger(options.logger, options.debug === true);

  if (!toLegacyEnvironment(environment).supported) {
    logger.warn(
      `Environment '${environment}': configurations and experiments use it, but markers and cohort ` +
        `checks can only target '${PRODUCTION_ENVIRONMENT}' or '${DEVELOPMENT_ENVIRONMENT}' and are ` +
        `sent to '${DEVELOPMENT_ENVIRONMENT}'.`
    );
  }

  const api = new ApiClient({
    apiKey: options.apiKey.trim(),
    environment,
    apiUrl: options.apiUrl ?? DEFAULT_API_URL,
    fetch: fetchImpl,
    flavor,
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    ...(extras.serverId !== undefined ? { serverId: extras.serverId } : {}),
    ...(options.requestTimeoutMs !== undefined ? { timeoutMs: options.requestTimeoutMs } : {}),
  });

  return { logger, environment, api };
}

/** `value` when it is a finite number above zero, otherwise `undefined`. */
export function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * A duration option in `unitMs` units, as milliseconds: `defaultValue` when omitted, and `0`
 * (disabled) for `0` or any unusable value.
 */
export function durationMs(
  value: number | undefined,
  defaultValue: number,
  unitMs: number
): number {
  return (positiveNumber(value ?? defaultValue) ?? 0) * unitMs;
}
