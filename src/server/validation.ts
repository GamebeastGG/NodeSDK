import {
  ActiveExperimentsResponseSchema,
  BulkAssignResponseSchema,
  GetCohortMembershipResponseSchema,
  SdkBootstrapV2ResponseSchema,
  SdkConfigurationV2ResponseSchema,
  SdkStatusV2ResponseSchema,
} from "@gamebeast/sdk-contract";
import type { z } from "zod";

import type { ResponseKind, ResponseTypes, ResponseValidator } from "../shared/validation";

const SCHEMAS: { [K in ResponseKind]: z.ZodType } = {
  configuration: SdkConfigurationV2ResponseSchema,
  status: SdkStatusV2ResponseSchema,
  bootstrap: SdkBootstrapV2ResponseSchema,
  activeExperiments: ActiveExperimentsResponseSchema,
  bulkAssign: BulkAssignResponseSchema,
  cohortMembership: GetCohortMembershipResponseSchema,
};

const MAX_REPORTED_ISSUES = 3;

function describeIssues(error: z.ZodError): string {
  const described = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  const remaining = error.issues.length - described.length;
  if (remaining > 0) described.push(`and ${remaining} more`);
  return described.join("; ");
}

/**
 * Validates responses with the backend's own schemas from `@gamebeast/sdk-contract`. Unknown keys
 * are stripped rather than rejected, so a backend that adds fields keeps working with this SDK.
 */
export const validateWithContract: ResponseValidator = <K extends ResponseKind>(
  kind: K,
  body: unknown
) => {
  const result = SCHEMAS[kind].safeParse(body);
  if (result.success) return { ok: true, data: result.data as ResponseTypes[K] };
  return { ok: false, issues: describeIssues(result.error) };
};
