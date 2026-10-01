import type { FetchLike, HttpResponse } from "./http";
import {
  describeResponse,
  errorCodeOf,
  isNotModified,
  isRetryable,
  isSuccess,
  sendRequest,
} from "./http";
import { toLegacyEnvironment } from "./environment";
import { SDK_VERSION } from "./version";
import type {
  ActiveExperimentsResponse,
  BootstrapResponse,
  BulkAssignBody,
  BulkAssignResponse,
  CohortMembershipResponse,
  ConfigurationResponse,
  EvaluateConfigurationBody,
  MarkerPayload,
  StatusResponse,
  UnitType,
} from "./wire";

export const DEFAULT_API_URL = "https://api.gamebeast.gg";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface ApiClientOptions {
  apiKey: string;
  /** Normalized environment alias. */
  environment: string;
  apiUrl: string;
  fetch: FetchLike;
  /** For multi-project secret keys: which project to act on. */
  projectId?: number;
  /** Instance id sent as `server-id` (snapshot rate limiting) and `serverid` (markers). */
  serverId?: string;
  /** Appended to the `sdkversion` header, e.g. `web` → `js-web/1.0.0`. */
  flavor: "web" | "server";
  timeoutMs?: number;
}

/** Outcome of a hash-aware read. */
export type FetchResult<T> =
  | { status: "updated"; data: T }
  | { status: "notModified" }
  | { status: "notFound"; error: string }
  | {
      status: "failed";
      error: string;
      retryable: boolean;
      /** HTTP status; absent for transport errors and malformed responses. */
      httpStatus?: number;
      errorCode?: string;
      retryAfterSeconds?: number;
    };

function failed<T>(response: HttpResponse, error = describeResponse(response)): FetchResult<T> {
  const result: FetchResult<T> = { status: "failed", error, retryable: isRetryable(response) };
  if (response.transportError === undefined) result.httpStatus = response.status;
  const errorCode = errorCodeOf(response.body);
  if (errorCode !== undefined) result.errorCode = errorCode;
  if (response.retryAfterSeconds !== undefined)
    result.retryAfterSeconds = response.retryAfterSeconds;
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHash(value: unknown): value is { hash: string } {
  return isObject(value) && typeof value.hash === "string" && value.hash.length > 0;
}

function isConfigurationResponse(value: unknown): value is ConfigurationResponse {
  return hasHash(value) && "configuration" in value;
}

function isSnapshot(value: unknown): value is StatusResponse {
  if (!hasHash(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return (
    Array.isArray(record.configurations) && isObject(record.experiments) && isObject(record.polling)
  );
}

/**
 * Typed access to the Gamebeast SDK HTTP API. Owns the base URL, authentication and environment
 * headers. One instance per SDK instance.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly sdkVersionHeader: string;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = options.apiUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sdkVersionHeader = `js-${options.flavor}/${SDK_VERSION}`;
  }

  get environment(): string {
    return this.options.environment;
  }

  /** Headers for `/sdk/v2/*`: the environment travels as an alias. */
  private v2Headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: this.options.apiKey,
      environment: this.options.environment,
      sdkversion: this.sdkVersionHeader,
    };
    if (this.options.projectId !== undefined)
      headers["project-id"] = String(this.options.projectId);
    return { ...headers, ...extra };
  }

  /**
   * Headers for `/sdk/v1/*`, which select the environment with the `isstudio` boolean only. The
   * backend defaults a missing `isstudio` to `true` (development), so it is always sent explicitly.
   */
  private v1Headers(extra?: Record<string, string>): Record<string, string> {
    const legacy = toLegacyEnvironment(this.options.environment);
    const headers: Record<string, string> = {
      authorization: this.options.apiKey,
      isstudio: legacy.isStudio ? "true" : "false",
      sdkversion: this.sdkVersionHeader,
    };
    if (this.options.projectId !== undefined)
      headers["project-id"] = String(this.options.projectId);
    return { ...headers, ...extra };
  }

  /** `POST /sdk/v1/markers`. Returns the raw response; the marker queue decides retry vs drop. */
  postMarkers(
    markers: MarkerPayload[],
    options: { keepalive?: boolean } = {}
  ): Promise<HttpResponse> {
    const extra: Record<string, string> = {};
    if (this.options.serverId !== undefined) extra.serverid = this.options.serverId.slice(0, 100);
    return sendRequest(this.options.fetch, {
      method: "POST",
      url: `${this.baseUrl}/sdk/v1/markers`,
      headers: this.v1Headers(extra),
      body: { markers },
      timeoutMs: this.timeoutMs,
      keepalive: options.keepalive === true,
    });
  }

  /**
   * `POST /sdk/v2/configurations/evaluate` — the configuration evaluated for one unit: active
   * experiments are resolved (assignment persisted, exposure recorded) and their changes arrive
   * merged in. `knownHash` lets the server answer `304` when nothing changed.
   */
  async evaluateConfiguration(
    body: EvaluateConfigurationBody
  ): Promise<FetchResult<ConfigurationResponse>> {
    const response = await sendRequest(this.options.fetch, {
      method: "POST",
      url: `${this.baseUrl}/sdk/v2/configurations/evaluate`,
      headers: this.v2Headers(),
      body,
      timeoutMs: this.timeoutMs,
    });
    return this.toConfigurationResult(response, body.knownHash);
  }

  /** `GET /sdk/v2/configurations` without identity — the unevaluated base configuration. */
  async getBaseConfiguration(
    alias: string | undefined,
    knownHash: string | undefined
  ): Promise<FetchResult<ConfigurationResponse>> {
    const headers = this.v2Headers(knownHash ? { "if-none-match": `"${knownHash}"` } : undefined);
    const response = await sendRequest(this.options.fetch, {
      method: "GET",
      url: `${this.baseUrl}/sdk/v2/configurations`,
      headers,
      query: { configuration: alias },
      timeoutMs: this.timeoutMs,
    });
    return this.toConfigurationResult(response, knownHash);
  }

  private toConfigurationResult(
    response: HttpResponse,
    knownHash: string | undefined
  ): FetchResult<ConfigurationResponse> {
    if (isNotModified(response)) return { status: "notModified" };
    if (response.status === 404 || errorCodeOf(response.body) === "CONFIGURATION_NOT_FOUND") {
      return { status: "notFound", error: describeResponse(response) };
    }
    if (!isSuccess(response)) return failed(response);
    if (!isConfigurationResponse(response.body)) {
      return {
        status: "failed",
        error: "unexpected configuration response shape",
        retryable: true,
      };
    }
    // A matching hash answered with 200 rather than 304 is still "unchanged".
    if (knownHash !== undefined && response.body.hash === knownHash)
      return { status: "notModified" };
    return { status: "updated", data: response.body };
  }

  /** `GET /sdk/v2/bootstrap` — every configuration document plus active experiments. */
  getBootstrap(knownHash?: string): Promise<FetchResult<BootstrapResponse>> {
    return this.getSnapshot<BootstrapResponse>("bootstrap", knownHash);
  }

  /** `GET /sdk/v2/status` — the bootstrap snapshot without documents, for polling. */
  getStatus(knownHash?: string): Promise<FetchResult<StatusResponse>> {
    return this.getSnapshot<StatusResponse>("status", knownHash);
  }

  private async getSnapshot<T extends StatusResponse | BootstrapResponse>(
    kind: "bootstrap" | "status",
    knownHash: string | undefined
  ): Promise<FetchResult<T>> {
    const extra: Record<string, string> = {};
    if (this.options.serverId !== undefined)
      extra["server-id"] = this.options.serverId.slice(0, 128);
    if (knownHash) extra["if-none-match"] = `"${knownHash}"`;
    const response = await sendRequest(this.options.fetch, {
      method: "GET",
      url: `${this.baseUrl}/sdk/v2/${kind}`,
      headers: this.v2Headers(extra),
      timeoutMs: this.timeoutMs,
    });
    if (isNotModified(response)) return { status: "notModified" };
    if (!isSuccess(response)) return failed(response);
    if (!isSnapshot(response.body)) {
      return { status: "failed", error: `unexpected ${kind} response shape`, retryable: true };
    }
    if (knownHash !== undefined && response.body.hash === knownHash)
      return { status: "notModified" };
    return { status: "updated", data: response.body as T };
  }

  /** `GET /sdk/v2/experiments/active` — active experiments (with changesets) for one unit type. */
  async getActiveExperiments(
    unitType: UnitType,
    knownHash?: string
  ): Promise<FetchResult<ActiveExperimentsResponse>> {
    const headers = this.v2Headers(knownHash ? { "if-none-match": `"${knownHash}"` } : undefined);
    const response = await sendRequest(this.options.fetch, {
      method: "GET",
      url: `${this.baseUrl}/sdk/v2/experiments/active`,
      headers,
      query: { "unit-type": unitType },
      timeoutMs: this.timeoutMs,
    });
    if (isNotModified(response)) return { status: "notModified" };
    if (!isSuccess(response)) return failed(response);
    if (
      !hasHash(response.body) ||
      !Array.isArray((response.body as { experiments?: unknown }).experiments)
    ) {
      return {
        status: "failed",
        error: "unexpected active experiments response shape",
        retryable: true,
      };
    }
    if (knownHash !== undefined && response.body.hash === knownHash)
      return { status: "notModified" };
    return { status: "updated", data: response.body as ActiveExperimentsResponse };
  }

  /** `POST /sdk/v2/experiments/assignments/bulk` — resolve assignments for up to 250 units. */
  async bulkAssign(body: BulkAssignBody): Promise<FetchResult<BulkAssignResponse>> {
    const response = await sendRequest(this.options.fetch, {
      method: "POST",
      url: `${this.baseUrl}/sdk/v2/experiments/assignments/bulk`,
      headers: this.v2Headers(),
      body,
      timeoutMs: this.timeoutMs,
    });
    if (!isSuccess(response)) return failed(response);
    const assignments = isObject(response.body) ? response.body.assignments : undefined;
    if (!isObject(assignments)) {
      return {
        status: "failed",
        error: "unexpected bulk assignment response shape",
        retryable: true,
      };
    }
    return {
      status: "updated",
      data: { assignments: assignments as BulkAssignResponse["assignments"] },
    };
  }

  /**
   * `POST /sdk/v1/cohorts/membership`. Accepts both the served shape
   * (`{ cohortExists, users: [...] }`) and the documented bare array.
   */
  async checkCohortMembership(
    cohortName: string,
    userIds: string[]
  ): Promise<FetchResult<CohortMembershipResponse>> {
    const response = await sendRequest(this.options.fetch, {
      method: "POST",
      url: `${this.baseUrl}/sdk/v1/cohorts/membership`,
      headers: this.v1Headers(),
      body: { cohortName, userIds },
      timeoutMs: this.timeoutMs,
    });
    if (!isSuccess(response)) return failed(response);

    const body = response.body;
    const rawUsers: unknown = Array.isArray(body) ? body : isObject(body) ? body.users : undefined;
    if (!Array.isArray(rawUsers)) {
      return {
        status: "failed",
        error: "unexpected cohort membership response shape",
        retryable: true,
      };
    }
    const users: CohortMembershipResponse["users"] = [];
    for (const entry of rawUsers) {
      if (isObject(entry) && entry.userId !== undefined && typeof entry.isMember === "boolean") {
        users.push({ userId: String(entry.userId), isMember: entry.isMember });
      }
    }
    const cohortExists =
      isObject(body) && typeof body.cohortExists === "boolean" ? body.cohortExists : true;
    return { status: "updated", data: { cohortExists, users } };
  }
}
