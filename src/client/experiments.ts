import type { ApiClient } from "../shared/api";
import type { Unsubscribe } from "../shared/listeners";
import { Listeners } from "../shared/listeners";
import type { Logger } from "../shared/logger";
import type {
  ActiveExperiment,
  AssignmentSource,
  ExperimentAssignmentMetadata,
} from "../shared/wire";

/** After a non-retryable catalog failure (e.g. the key lacks `experiments:read`), wait this long. */
const CATALOG_FAILURE_BACKOFF_MS = 10 * 60_000;

/**
 * An experiment the current user is enrolled in. Values read through `configs` already include
 * the assigned group's changes; this is for display, analytics segmentation and debugging.
 */
export interface ExperimentAssignment {
  experimentId: number;
  /** `null` until the experiment catalog has loaded. */
  experimentName: string | null;
  groupId: number;
  /** `null` until the experiment catalog has loaded. */
  groupLabel: string | null;
  /** Normalized alias of the configuration the experiment applies to. */
  configuration: string;
  source: AssignmentSource;
}

export interface ClientExperiments {
  /** Active assignments across every fetched configuration, ordered by experiment id. */
  readonly assignments: readonly ExperimentAssignment[];
  /** Call `callback` with the full list whenever it changes (including when names resolve). */
  onAssignmentsChanged(
    callback: (assignments: readonly ExperimentAssignment[]) => void
  ): Unsubscribe;
}

/**
 * Tracks the assignments echoed on evaluated configuration responses. Enrollment itself happens on
 * the backend during evaluation; names and labels come from `GET /sdk/v2/experiments/active`,
 * fetched (hash-cached) only when an unknown experiment id appears.
 */
export class ClientExperimentsService implements ClientExperiments {
  private readonly byConfiguration = new Map<string, ExperimentAssignmentMetadata[]>();
  private readonly catalog = new Map<number, ActiveExperiment>();
  private catalogHash: string | undefined;
  private catalogInFlight: Promise<void> | undefined;
  private catalogRetryNotBefore = 0;
  private current: readonly ExperimentAssignment[] = [];
  private readonly listeners: Listeners<readonly ExperimentAssignment[]>;
  private stopped = false;

  constructor(
    private readonly api: ApiClient,
    private readonly logger: Logger
  ) {
    this.listeners = new Listeners(logger, "OnAssignmentsChanged");
  }

  get assignments(): readonly ExperimentAssignment[] {
    return this.current;
  }

  onAssignmentsChanged(
    callback: (assignments: readonly ExperimentAssignment[]) => void
  ): Unsubscribe {
    if (typeof callback !== "function") {
      this.logger.error("experiments.onAssignmentsChanged requires a callback.");
      return () => undefined;
    }
    return this.listeners.add(callback);
  }

  /** Called by the configs service with the assignments on each evaluated response. */
  report(configKey: string, assignments: ExperimentAssignmentMetadata[]): void {
    const previous = this.byConfiguration.get(configKey);
    if (previous && sameAssignments(previous, assignments)) return;
    this.byConfiguration.set(configKey, [...assignments]);
    this.rebuild();
    void this.ensureCatalog();
  }

  /** Assignments belong to the previous user; repopulated as re-evaluated configurations land. */
  onIdentityChanged(): void {
    if (this.byConfiguration.size === 0) return;
    this.byConfiguration.clear();
    this.rebuild();
  }

  shutdown(): void {
    this.stopped = true;
    this.listeners.clear();
  }

  private async ensureCatalog(): Promise<void> {
    const unknown = [...this.byConfiguration.values()].some((list) =>
      list.some((assignment) => !this.catalog.has(assignment.experimentId))
    );
    if (!unknown || this.catalogInFlight || Date.now() < this.catalogRetryNotBefore) return;

    this.catalogInFlight = (async () => {
      const result = await this.api.getActiveExperiments("user", this.catalogHash);
      switch (result.status) {
        case "updated":
          this.catalogHash = result.data.hash;
          this.catalog.clear();
          for (const experiment of result.data.experiments)
            this.catalog.set(experiment.id, experiment);
          this.rebuild();
          break;
        case "notModified":
          // Still unknown with an unchanged catalog: the experiment ended or is private. Wait
          // before asking again rather than re-requesting on every evaluation.
          this.catalogRetryNotBefore = Date.now() + 60_000;
          break;
        case "failed": {
          this.catalogRetryNotBefore =
            Date.now() + (result.retryable ? 30_000 : CATALOG_FAILURE_BACKOFF_MS);
          this.logger.warnOnce(
            "experiment-catalog",
            `Experiment names are unavailable (${result.error}); assignments are reported without them.`
          );
          break;
        }
        default: {
          const unreachable: never = result;
          throw new Error(`Unhandled fetch result ${String(unreachable)}`);
        }
      }
    })().finally(() => {
      this.catalogInFlight = undefined;
    });
    await this.catalogInFlight;
  }

  private rebuild(): void {
    if (this.stopped) return;
    const next: ExperimentAssignment[] = [];
    for (const [configuration, list] of this.byConfiguration) {
      for (const assignment of list) {
        const experiment = this.catalog.get(assignment.experimentId);
        const group = experiment?.groups.find((candidate) => candidate.id === assignment.groupId);
        next.push({
          experimentId: assignment.experimentId,
          experimentName: experiment?.name ?? null,
          groupId: assignment.groupId,
          groupLabel: group?.label ?? null,
          configuration,
          source: assignment.source,
        });
      }
    }
    next.sort(
      (a, b) => a.experimentId - b.experimentId || a.configuration.localeCompare(b.configuration)
    );

    if (sameSnapshot(this.current, next)) return;
    this.current = Object.freeze(next.map((entry) => Object.freeze(entry)));
    this.listeners.emit(this.current);
  }
}

function sameAssignments(
  a: ExperimentAssignmentMetadata[],
  b: ExperimentAssignmentMetadata[]
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, index) =>
        entry.experimentId === b[index]?.experimentId &&
        entry.groupId === b[index]?.groupId &&
        entry.assignmentVersion === b[index]?.assignmentVersion
    )
  );
}

function sameSnapshot(
  a: readonly ExperimentAssignment[],
  b: readonly ExperimentAssignment[]
): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        entry.experimentId === other.experimentId &&
        entry.groupId === other.groupId &&
        entry.experimentName === other.experimentName &&
        entry.groupLabel === other.groupLabel &&
        entry.configuration === other.configuration &&
        entry.source === other.source
      );
    })
  );
}
