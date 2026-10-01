import type {
  ActiveExperimentsResponse,
  BootstrapResponse,
  BulkAssignResponse,
  CohortMembershipResponse,
  ConfigurationResponse,
  StatusResponse,
} from "./wire";

/** The response bodies the SDK reads, keyed by the name used in contract-mismatch warnings. */
export interface ResponseTypes {
  configuration: ConfigurationResponse;
  status: StatusResponse;
  bootstrap: BootstrapResponse;
  activeExperiments: ActiveExperimentsResponse;
  bulkAssign: BulkAssignResponse;
  cohortMembership: CohortMembershipResponse;
}

export type ResponseKind = keyof ResponseTypes;

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; issues: string };

/**
 * Checks a response body against the backend's contract. Optional: the server entry supplies one
 * built on the `@gamebeast/sdk-contract` schemas; the browser client does not, so the schemas
 * (and Zod) stay out of its bundle and it relies on the structural checks in `ApiClient`.
 */
export type ResponseValidator = <K extends ResponseKind>(
  kind: K,
  body: unknown
) => ValidationResult<ResponseTypes[K]>;
