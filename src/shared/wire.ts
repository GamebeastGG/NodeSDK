/**
 * Wire types for the Gamebeast SDK HTTP API.
 *
 * Every shape here comes from `@gamebeast/sdk-contract`, the package core-backend declares its
 * `/sdk/*` routes with, so this file only maps the SDK's names onto the contract. Do not define a
 * request or response shape here: change it in the contract (service-monorepo,
 * `packages/sdk-contract`) and bump the dependency.
 *
 * Type-only imports: these are erased at build time, so the browser bundle never loads the schemas.
 */
import type {
  ActiveChangesetOperation,
  ActiveExperimentsResponse as ContractActiveExperimentsResponse,
  ActiveSdkExperiment,
  AssignmentSource as ContractAssignmentSource,
  BulkAssignResponse as ContractBulkAssignResponse,
  BulkAssignV2Body,
  ContextValue as ContractContextValue,
  EvaluateConfigurationV2Body,
  ExperimentAssignmentMetadata as ContractExperimentAssignmentMetadata,
  GetCohortMembershipResponse,
  IngestMarkersInvalid,
  IngestMarkersSuccess,
  PropertiesEvaluationContext,
  SdkAssignmentEntryV2,
  SdkBootstrapV2Response,
  SdkConfigurationV2Response,
  SdkExperimentDescriptor as ContractSdkExperimentDescriptor,
  SdkExperimentGroup as ContractSdkExperimentGroup,
  SdkMarkerPayload,
  SdkStatusV2Response,
  SdkUnitType,
  SdkV2ErrorResponse as ContractSdkV2ErrorResponse,
  SnapshotConfiguration as ContractSnapshotConfiguration,
  SnapshotConfigurationSummary as ContractSnapshotConfigurationSummary,
  SnapshotPolling as ContractSnapshotPolling,
} from "@gamebeast/sdk-contract";

/** Any JSON value. Part of the SDK's public API (configuration values), not a wire shape. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type UnitType = SdkUnitType;
export type AssignmentSource = ContractAssignmentSource;
export type ContextValue = ContractContextValue;

// --- Errors -------------------------------------------------------------------------------------

export type SdkV2ErrorResponse = ContractSdkV2ErrorResponse;

// --- Configurations -----------------------------------------------------------------------------

export type ExperimentAssignmentMetadata = ContractExperimentAssignmentMetadata;

/**
 * `GET /sdk/v2/configurations` and `POST /sdk/v2/configurations/evaluate` (200). `configuration`
 * is narrowed to the SDK's `JsonValue`, which is what the contract's `z.json()` validates.
 */
export type ConfigurationResponse = Omit<SdkConfigurationV2Response, "configuration"> & {
  configuration: JsonValue;
};

export type EvaluationContextBody = PropertiesEvaluationContext;
export type EvaluateConfigurationBody = EvaluateConfigurationV2Body;

// --- Experiments --------------------------------------------------------------------------------

export type SdkExperimentGroup = ContractSdkExperimentGroup;
export type SdkExperimentDescriptor = ContractSdkExperimentDescriptor;
export type ChangesetOperation = ActiveChangesetOperation;
export type ActiveExperiment = ActiveSdkExperiment;
/** `GET /sdk/v2/experiments/active` (200). */
export type ActiveExperimentsResponse = ContractActiveExperimentsResponse;

export type AssignmentEntry = SdkAssignmentEntryV2;
export type BulkAssignBody = BulkAssignV2Body;
export type BulkAssignUnit = BulkAssignV2Body["units"][number];
/** `POST /sdk/v2/experiments/assignments/bulk` (200). */
export type BulkAssignResponse = ContractBulkAssignResponse;

// --- Snapshot (bootstrap / status) --------------------------------------------------------------

export type SnapshotConfigurationSummary = ContractSnapshotConfigurationSummary;
export type SnapshotConfiguration = Omit<ContractSnapshotConfiguration, "configuration"> & {
  configuration: JsonValue;
};
export type SnapshotPolling = ContractSnapshotPolling;

/** `GET /sdk/v2/status` (200). */
export type StatusResponse = SdkStatusV2Response;

/** `GET /sdk/v2/bootstrap` (200). */
export type BootstrapResponse = Omit<SdkBootstrapV2Response, "configurations"> & {
  configurations: SnapshotConfiguration[];
};

// --- Markers ------------------------------------------------------------------------------------

/** One marker as the SDK sends it to `POST /sdk/v1/markers`. `timestamp` is epoch milliseconds. */
export type MarkerPayload = SdkMarkerPayload;

/**
 * `POST /sdk/v1/markers` body on any outcome: the 200 counts, or the 400 (every marker rejected)
 * and 403 envelopes. Read defensively: an error response may carry only part of it.
 */
export type IngestMarkersResponse = Partial<IngestMarkersSuccess & IngestMarkersInvalid>;

// --- Cohorts ------------------------------------------------------------------------------------

/** `POST /sdk/v1/cohorts/membership` (200). */
export type CohortMembershipResponse = GetCohortMembershipResponse;
