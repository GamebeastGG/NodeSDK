import {
  MARKER_SERVER_ID_MAX_LENGTH,
  SDK_SERVER_ID_MAX_LENGTH,
} from "@gamebeast/sdk-contract/core";

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

/** A request the backend did not satisfy. */
export interface Failure {
  status: "failed";
  error: string;
  retryable: boolean;
  /** HTTP status; absent for transport errors and malformed responses. */
  httpStatus?: number;
  errorCode?: string;
  retryAfterSeconds?: number;
}

/** Outcome of a plain request. */
export type Result<T> = { status: "ok"; data: T } | Failure;

/** Outcome of a hash-aware read: `notModified` when the caller's known hash is still current. */
export type ConditionalResult<T> =
  { status: "updated"; data: T } | { status: "notModified" } | Failure;

/** Outcome of a configuration read, which can also name a configuration that does not exist. */
export type ConfigurationResult =
  ConditionalResult<ConfigurationResponse> | { status: "notFound"; error: string };

/** Turns a response body into `T`, or `undefined` when it does not have the expected shape. */
type Decoder<T> = (body: unknown) => T | undefined;

interface RequestSpec {
  method: "GET" | "POST";
  /** Path under `/sdk/`, e.g. `v2/status`. The version selects how the environment is sent. */
  path: `v1/${string}` | `v2/${string}`;
  headers?: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: unknown;
  keepalive?: boolean;
}

function failed(response: HttpResponse): Failure {
  const result: Failure = {
    status: "failed",
    error: describeResponse(response),
    retryable: isRetryable(response),
  };
  if (response.transportError === undefined) result.httpStatus = response.status;
  const errorCode = errorCodeOf(response.body);
  if (errorCode !== undefined) result.errorCode = errorCode;
  if (response.retryAfterSeconds !== undefined)
    result.retryAfterSeconds = response.retryAfterSeconds;
  return result;
}

function malformed(what: string): Failure {
  return { status: "failed", error: `unexpected ${what} response shape`, retryable: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHash(value: unknown): value is Record<string, unknown> & { hash: string } {
  return isObject(value) && typeof value.hash === "string" && value.hash.length > 0;
}

const decodeConfiguration: Decoder<ConfigurationResponse> = (body) =>
  hasHash(body) && "configuration" in body ? (body as unknown as ConfigurationResponse) : undefined;

const decodeStatus: Decoder<StatusResponse> = (body) =>
  hasHash(body) &&
  Array.isArray(body.configurations) &&
  isObject(body.experiments) &&
  isObject(body.polling)
    ? (body as unknown as StatusResponse)
    : undefined;

const decodeBootstrap: Decoder<BootstrapResponse> = (body) => {
  const status = decodeStatus(body);
  if (!status) return undefined;
  const documentsPresent = status.configurations.every(
    (entry) => isObject(entry) && "configuration" in entry
  );
  return documentsPresent ? (status as unknown as BootstrapResponse) : undefined;
};

const decodeActiveExperiments: Decoder<ActiveExperimentsResponse> = (body) =>
  hasHash(body) && Array.isArray(body.experiments)
    ? (body as unknown as ActiveExperimentsResponse)
    : undefined;

const decodeBulkAssign: Decoder<BulkAssignResponse> = (body) =>
  isObject(body) && isObject(body.assignments)
    ? { assignments: body.assignments as BulkAssignResponse["assignments"] }
    : undefined;

/**
 * Accepts both the served shape (`{ cohortExists, users: [...] }`) and the documented bare array,
 * keeping only well-formed entries.
 */
const decodeCohortMembership: Decoder<CohortMembershipResponse> = (body) => {
  const rawUsers: unknown = Array.isArray(body) ? body : isObject(body) ? body.users : undefined;
  if (!Array.isArray(rawUsers)) return undefined;
  const users: CohortMembershipResponse["users"] = [];
  for (const entry of rawUsers) {
    if (isObject(entry) && entry.userId !== undefined && typeof entry.isMember === "boolean") {
      users.push({ userId: String(entry.userId), isMember: entry.isMember });
    }
  }
  const cohortExists =
    isObject(body) && typeof body.cohortExists === "boolean" ? body.cohortExists : true;
  return { cohortExists, users };
};

function ifNoneMatch(knownHash: string | undefined): Record<string, string> {
  return knownHash ? { "if-none-match": `"${knownHash}"` } : {};
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

  /** `POST /sdk/v1/markers`. Returns the raw response; the marker queue decides retry vs drop. */
  postMarkers(
    markers: MarkerPayload[],
    options: { keepalive?: boolean } = {}
  ): Promise<HttpResponse> {
    const serverId = this.options.serverId;
    return this.send({
      method: "POST",
      path: "v1/markers",
      headers:
        serverId !== undefined ? { serverid: serverId.slice(0, MARKER_SERVER_ID_MAX_LENGTH) } : {},
      body: { markers },
      keepalive: options.keepalive === true,
    });
  }

  /**
   * `POST /sdk/v2/configurations/evaluate` — the configuration evaluated for one unit: active
   * experiments are resolved (assignment persisted, exposure recorded) and their changes arrive
   * merged in. `knownHash` lets the server answer `304` when nothing changed.
   */
  async evaluateConfiguration(body: EvaluateConfigurationBody): Promise<ConfigurationResult> {
    const response = await this.send({
      method: "POST",
      path: "v2/configurations/evaluate",
      body,
    });
    return this.toConfigurationResult(response, body.knownHash);
  }

  /** `GET /sdk/v2/bootstrap` — every configuration document plus active experiments. */
  async getBootstrap(): Promise<Result<BootstrapResponse>> {
    const response = await this.send({
      method: "GET",
      path: "v2/bootstrap",
      headers: this.serverIdHeader(),
    });
    return this.decode(response, decodeBootstrap, "bootstrap");
  }

  /** `GET /sdk/v2/status` — the bootstrap snapshot without documents, for polling. */
  async getStatus(knownHash: string | undefined): Promise<ConditionalResult<StatusResponse>> {
    const response = await this.send({
      method: "GET",
      path: "v2/status",
      headers: { ...this.serverIdHeader(), ...ifNoneMatch(knownHash) },
    });
    return this.decodeConditional(response, knownHash, decodeStatus, "status");
  }

  /** `GET /sdk/v2/experiments/active` — active experiments (with changesets) for one unit type. */
  async getActiveExperiments(
    unitType: UnitType,
    knownHash: string | undefined
  ): Promise<ConditionalResult<ActiveExperimentsResponse>> {
    const response = await this.send({
      method: "GET",
      path: "v2/experiments/active",
      headers: ifNoneMatch(knownHash),
      query: { "unit-type": unitType },
    });
    return this.decodeConditional(
      response,
      knownHash,
      decodeActiveExperiments,
      "active experiments"
    );
  }

  /** `POST /sdk/v2/experiments/assignments/bulk` — resolve assignments for up to 250 units. */
  async bulkAssign(body: BulkAssignBody): Promise<Result<BulkAssignResponse>> {
    const response = await this.send({
      method: "POST",
      path: "v2/experiments/assignments/bulk",
      body,
    });
    return this.decode(response, decodeBulkAssign, "bulk assignment");
  }

  /** `POST /sdk/v1/cohorts/membership`. */
  async checkCohortMembership(
    cohortName: string,
    userIds: string[]
  ): Promise<Result<CohortMembershipResponse>> {
    const response = await this.send({
      method: "POST",
      path: "v1/cohorts/membership",
      body: { cohortName, userIds },
    });
    return this.decode(response, decodeCohortMembership, "cohort membership");
  }

  // --- pipeline -------------------------------------------------------------------------------

  private send(spec: RequestSpec): Promise<HttpResponse> {
    return sendRequest(this.options.fetch, {
      method: spec.method,
      url: `${this.baseUrl}/sdk/${spec.path}`,
      headers: { ...this.baseHeaders(spec.path), ...spec.headers },
      query: spec.query,
      body: spec.body,
      timeoutMs: this.timeoutMs,
      keepalive: spec.keepalive === true,
    });
  }

  /**
   * Authentication and environment headers. `/sdk/v2/*` takes the environment as an alias;
   * `/sdk/v1/*` only understands the `isstudio` boolean, and defaults a missing one to `true`
   * (development), so it is always sent explicitly.
   */
  private baseHeaders(path: RequestSpec["path"]): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: this.options.apiKey,
      sdkversion: this.sdkVersionHeader,
    };
    if (path.startsWith("v2/")) {
      headers.environment = this.options.environment;
    } else {
      headers.isstudio = toLegacyEnvironment(this.options.environment).isStudio ? "true" : "false";
    }
    if (this.options.projectId !== undefined)
      headers["project-id"] = String(this.options.projectId);
    return headers;
  }

  private serverIdHeader(): Record<string, string> {
    const serverId = this.options.serverId;
    return serverId !== undefined
      ? { "server-id": serverId.slice(0, SDK_SERVER_ID_MAX_LENGTH) }
      : {};
  }

  /** A plain request: success with a well-formed body, or a failure. */
  private decode<T>(response: HttpResponse, decoder: Decoder<T>, what: string): Result<T> {
    if (isNotModified(response)) {
      // Never asked for (no hash was sent); treat as a transient oddity.
      return { status: "failed", error: "unexpected 304", retryable: true };
    }
    if (!isSuccess(response)) return failed(response);
    const data = decoder(response.body);
    return data === undefined ? malformed(what) : { status: "ok", data };
  }

  /** A hash-aware read. A matching hash answered with 200 rather than 304 is still "unchanged". */
  private decodeConditional<T extends { hash: string }>(
    response: HttpResponse,
    knownHash: string | undefined,
    decoder: Decoder<T>,
    what: string
  ): ConditionalResult<T> {
    if (isNotModified(response)) return { status: "notModified" };
    const result = this.decode(response, decoder, what);
    if (result.status === "failed") return result;
    if (knownHash !== undefined && result.data.hash === knownHash) return { status: "notModified" };
    return { status: "updated", data: result.data };
  }

  private toConfigurationResult(
    response: HttpResponse,
    knownHash: string | undefined
  ): ConfigurationResult {
    if (response.status === 404 || errorCodeOf(response.body) === "CONFIGURATION_NOT_FOUND") {
      return { status: "notFound", error: describeResponse(response) };
    }
    return this.decodeConditional(response, knownHash, decodeConfiguration, "configuration");
  }
}
