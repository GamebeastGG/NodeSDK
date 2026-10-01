import { BULK_ASSIGN_MAX_IDS } from "@gamebeast/sdk-contract/core";

import type { ApiClient } from "../shared/api";
import type { Properties } from "../shared/context";
import { sanitizeProperties } from "../shared/context";
import { GamebeastError } from "../shared/errors";
import { normalizeDistinctId } from "../shared/ids";
import type { Logger } from "../shared/logger";
import type {
  AssignmentEntry,
  BulkAssignUnit,
  SdkExperimentDescriptor,
  UnitType,
} from "../shared/wire";
import type { SnapshotService } from "./snapshot";

/** Backend cap on units per bulk request. */
export const BULK_ASSIGN_MAX_UNITS = BULK_ASSIGN_MAX_IDS;

/** A unit for `experiments.assign`: an id, or an id with its own targeting properties. */
export type AssignUnit = string | { distinctId: string; properties?: Properties };

export interface AssignOptions {
  /** Defaults to `"user"`. */
  unitType?: UnitType;
  /** Properties shared by every unit (each unit's own properties win per key). */
  sharedProperties?: Properties;
}

export interface ServerExperiments {
  /** Active experiments for a unit type, from the configuration snapshot. Empty until loaded. */
  list(unitType?: UnitType): readonly SdkExperimentDescriptor[];

  /**
   * Resolve experiment assignments for many units at once (the backend enrolls them exactly as
   * evaluation would, and records exposure). Requests are split into batches of 250.
   *
   * Resolves to a map from distinct id to that unit's active assignments; every valid id is
   * present. Rejects with a `GamebeastError` if any batch fails, because a partial answer would
   * read as "not enrolled" for the missing units.
   */
  assign(
    units: readonly AssignUnit[],
    options?: AssignOptions
  ): Promise<Map<string, AssignmentEntry[]>>;
}

export class ServerExperimentsService implements ServerExperiments {
  constructor(
    private readonly api: ApiClient,
    private readonly logger: Logger,
    private readonly snapshot: SnapshotService
  ) {}

  list(unitType: UnitType = "user"): readonly SdkExperimentDescriptor[] {
    return this.snapshot.experiments[unitType === "server" ? "server" : "user"];
  }

  async assign(
    units: readonly AssignUnit[],
    options: AssignOptions = {}
  ): Promise<Map<string, AssignmentEntry[]>> {
    const unitType = options.unitType ?? "user";
    if (unitType !== "user" && unitType !== "server") {
      throw new GamebeastError(`experiments.assign: unitType must be "user" or "server".`);
    }
    if (!Array.isArray(units))
      throw new GamebeastError("experiments.assign expects an array of units.");

    // Deduplicate: the last entry for an id wins, like a map literal.
    const byId = new Map<string, BulkAssignUnit>();
    for (const unit of units) {
      const rawId = typeof unit === "object" && unit !== null ? unit.distinctId : unit;
      const distinctId = normalizeDistinctId(rawId);
      if (distinctId === undefined) {
        this.logger.error(
          `experiments.assign: skipping invalid distinct id ${JSON.stringify(rawId)}.`
        );
        continue;
      }
      const properties =
        typeof unit === "object" && unit !== null
          ? sanitizeProperties(unit.properties, this.logger)
          : {};
      byId.set(
        distinctId,
        Object.keys(properties).length > 0
          ? { distinctId, context: { properties } }
          : { distinctId }
      );
    }

    const results = new Map<string, AssignmentEntry[]>();
    if (byId.size === 0) return results;

    const shared = sanitizeProperties(options.sharedProperties, this.logger);
    const sharedContext =
      Object.keys(shared).length > 0
        ? { schemaVersion: 1 as const, properties: shared }
        : undefined;
    const all = [...byId.values()];

    for (let start = 0; start < all.length; start += BULK_ASSIGN_MAX_UNITS) {
      const batch = all.slice(start, start + BULK_ASSIGN_MAX_UNITS);
      const result = await this.api.bulkAssign({
        unitType,
        ...(sharedContext ? { sharedContext } : {}),
        units: batch,
      });
      if (result.status === "failed") {
        throw GamebeastError.fromFailure("experiments.assign failed", result);
      }
      for (const unit of batch) {
        results.set(unit.distinctId, result.data.assignments[unit.distinctId] ?? []);
      }
    }
    return results;
  }
}
