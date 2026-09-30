/**
 * Wire types for the Gamebeast SDK HTTP API, mirroring the core-backend Zod schemas:
 *
 * - `sdk/v2/sdk.v2.schema.ts`                          — v2 error envelope
 * - `sdk/v2/configurations/configurations.v2.schema.ts` — configuration fetch / evaluate
 * - `sdk/v2/bootstrap/bootstrap.v2.schema.ts`          — `/bootstrap` and `/status` snapshots
 * - `sdk/v2/experiments/experiments.v2.schema.ts`      — assignments, bulk, active catalog
 * - `sdk/v1/ingestion/markers/*`                       — marker ingestion (`none` / `unity` platforms)
 * - `sdk/v1/cohorts/sdkCohorts.controller.ts`          — cohort membership (actual response shape)
 */

/** Any JSON value. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type UnitType = "user" | "server";
export type AssignmentSource = "weightedHash" | "roundRobin" | "manual";

// --- Errors -------------------------------------------------------------------------------------

export interface SdkV2ErrorResponse {
  errorCode: string;
  message: string;
}

// --- Configurations -----------------------------------------------------------------------------

export interface ExperimentAssignmentMetadata {
  experimentId: number;
  groupId: number;
  assignmentVersion: number;
  source: AssignmentSource;
  exposureProxyRecorded: boolean;
}

/** `GET /sdk/v2/configurations` and `POST /sdk/v2/configurations/evaluate` (200). */
export interface ConfigurationResponse {
  hash: string;
  configurationId: number;
  name: string | null;
  configuration: JsonValue;
  /** Paths (as key segments) flagged private in the dashboard. */
  privacy: string[][];
  updatedAt: string;
  experiments: ExperimentAssignmentMetadata[];
  requiredProperties: string[];
}

/** Scalar or homogeneous scalar array — the only value shapes a targeting context accepts. */
export type ContextValue = string | number | boolean | null | string[] | number[] | boolean[];

export interface EvaluationContextBody {
  schemaVersion: 1;
  properties?: Record<string, ContextValue>;
}

export interface EvaluateConfigurationBody {
  configuration?: string;
  unit: { type: UnitType; distinctId: string };
  context?: EvaluationContextBody;
  knownHash?: string;
}

// --- Experiments --------------------------------------------------------------------------------

export interface SdkExperimentGroup {
  id: number;
  label: string;
  /** Allocation weight in basis points; `null` for round-robin experiments. */
  weight: number | null;
  ordinal: number;
}

export interface SdkExperimentDescriptor {
  id: number;
  name: string;
  unitType: UnitType;
  assignmentMode: "weightedHash" | "roundRobin";
  baseConfigurationId: number;
  autoAssignment: boolean;
  permanentEnrollment: boolean;
  requiredProperties: string[];
  startsAt: string;
  endsAt: string | null;
  groups: SdkExperimentGroup[];
}

export interface ChangesetOperation {
  op: "set" | "add" | "delete";
  path: string[];
  value?: unknown;
}

export interface ActiveExperiment extends Omit<SdkExperimentDescriptor, "groups"> {
  groups: Array<SdkExperimentGroup & { changeset: { operations: ChangesetOperation[] } }>;
}

/** `GET /sdk/v2/experiments/active` (200). */
export interface ActiveExperimentsResponse {
  hash: string;
  requiredProperties: string[];
  experiments: ActiveExperiment[];
}

export interface AssignmentEntry {
  experimentId: number;
  groupId: number;
  automaticGroupId: number | null;
  overrideGroupId: number | null;
  status: "active" | "unenrolled";
  source: AssignmentSource;
  assignmentVersion: number;
}

export interface BulkAssignUnit {
  distinctId: string;
  context?: { properties?: Record<string, ContextValue> };
}

export interface BulkAssignBody {
  unitType: UnitType;
  sharedContext?: EvaluationContextBody;
  units: BulkAssignUnit[];
}

/** `POST /sdk/v2/experiments/assignments/bulk` (200). */
export interface BulkAssignResponse {
  assignments: Record<string, AssignmentEntry[]>;
}

// --- Snapshot (bootstrap / status) --------------------------------------------------------------

export interface SnapshotConfigurationSummary {
  id: number;
  name: string | null;
  alias: string | null;
  hash: string;
}

export interface SnapshotConfiguration extends SnapshotConfigurationSummary {
  configuration: JsonValue;
  privacy: string[][];
}

export interface SnapshotPolling {
  intervalSeconds: number;
  jitterRatio: number;
}

/** `GET /sdk/v2/status` (200). */
export interface StatusResponse {
  hash: string;
  configurations: SnapshotConfigurationSummary[];
  primaryConfigurationId: number | null;
  experiments: { user: SdkExperimentDescriptor[]; server: SdkExperimentDescriptor[] };
  requiredProperties: string[];
  polling: SnapshotPolling;
}

/** `GET /sdk/v2/bootstrap` (200). */
export interface BootstrapResponse extends Omit<StatusResponse, "configurations"> {
  configurations: SnapshotConfiguration[];
}

// --- Markers ------------------------------------------------------------------------------------

/**
 * One marker as `POST /sdk/v1/markers` validates it for `none`/`unity`/`discord` projects.
 * `timestamp` is epoch milliseconds (values below 10^12 are read as seconds by the backend).
 */
export interface MarkerPayload {
  markerId: string;
  timestamp: number;
  eventName: string;
  distinctId?: string;
  sessionId?: string;
  properties: Record<string, unknown>;
}

export interface IngestMarkersResponse {
  message: string;
  ingestedMarkersCount: number;
  rejectedMarkersCount: number;
  staleMarkersCount?: number;
  rejectedMarkers?: Array<{ marker: unknown; reason: string }>;
  errorCode?: string;
}

// --- Cohorts ------------------------------------------------------------------------------------

/**
 * `POST /sdk/v1/cohorts/membership` (200), as the controller actually sends it. The route's
 * declared OpenAPI schema is a bare array, which does not match what is served; the SDK accepts
 * both so it keeps working if the backend is later aligned with its schema.
 */
export interface CohortMembershipResponse {
  cohortExists: boolean;
  users: Array<{ userId: string; isMember: boolean }>;
}
