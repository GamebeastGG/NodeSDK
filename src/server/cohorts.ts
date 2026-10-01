import type { ApiClient } from "../shared/api";
import { GamebeastError } from "../shared/errors";
import { normalizeDistinctId } from "../shared/ids";
import type { Logger } from "../shared/logger";
import { LruCache } from "../shared/lruCache";
import type { TimerHandle } from "../shared/timers";
import { startTimeout } from "../shared/timers";

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 50_000;
/** Checks for the same cohort arriving within this window share one request. */
const COALESCE_WINDOW_MS = 10;
/** Upper bound on ids per request, to keep bodies and backend work per call reasonable. */
const MAX_IDS_PER_REQUEST = 1_000;

export interface ServerCohorts {
  /**
   * Whether `distinctId` is in the named cohort. Resolves `false` when the cohort does not exist or
   * the check fails (failures are logged); never rejects.
   */
  isMember(cohortName: string, distinctId: string): Promise<boolean>;

  /**
   * Membership for many ids at once. Rejects with a `GamebeastError` when the check fails. Ids in
   * a cohort that does not exist resolve to `false`.
   */
  getMembership(cohortName: string, distinctIds: readonly string[]): Promise<Map<string, boolean>>;
}

interface PendingBatch {
  ids: Set<string>;
  waiters: Array<{
    resolve: (value: Map<string, boolean>) => void;
    reject: (error: unknown) => void;
  }>;
  timer: TimerHandle;
}

/**
 * Cohort membership backed by `POST /sdk/v1/cohorts/membership`, which is rate-limited to 60
 * requests per minute per API key. Results are cached per (cohort, id) and concurrent checks for
 * the same cohort are coalesced into one request.
 */
export class ServerCohortsService implements ServerCohorts {
  private readonly cache = new LruCache<string, { isMember: boolean; fetchedAt: number }>(
    CACHE_MAX_ENTRIES
  );
  private readonly pending = new Map<string, PendingBatch>();

  constructor(
    private readonly api: ApiClient,
    private readonly logger: Logger
  ) {}

  async isMember(cohortName: string, distinctId: string): Promise<boolean> {
    try {
      const membership = await this.getMembership(cohortName, [distinctId]);
      const id = normalizeDistinctId(distinctId);
      return id !== undefined && membership.get(id) === true;
    } catch (error) {
      this.logger.warn(
        `Cohort check for '${String(cohortName)}' failed (${error instanceof Error ? error.message : String(error)}); ` +
          "treating as not a member."
      );
      return false;
    }
  }

  async getMembership(
    cohortName: string,
    distinctIds: readonly string[]
  ): Promise<Map<string, boolean>> {
    if (typeof cohortName !== "string" || cohortName.trim() === "") {
      throw new GamebeastError("cohorts: a cohort name is required.");
    }
    if (!Array.isArray(distinctIds))
      throw new GamebeastError("cohorts.getMembership expects an array of ids.");
    const name = cohortName.trim();

    const result = new Map<string, boolean>();
    const missing = new Set<string>();
    const now = Date.now();
    for (const raw of distinctIds) {
      const id = normalizeDistinctId(raw);
      if (id === undefined) {
        this.logger.error(`cohorts: skipping invalid distinct id ${JSON.stringify(raw)}.`);
        continue;
      }
      const cached = this.cache.get(cacheKey(name, id));
      if (cached && now - cached.fetchedAt < CACHE_TTL_MS) result.set(id, cached.isMember);
      else missing.add(id);
    }
    if (missing.size === 0) return result;

    const fetched = await this.enqueue(name, missing);
    for (const id of missing) result.set(id, fetched.get(id) === true);
    return result;
  }

  private enqueue(name: string, ids: Set<string>): Promise<Map<string, boolean>> {
    return new Promise((resolve, reject) => {
      let batch = this.pending.get(name);
      if (!batch) {
        const created: PendingBatch = {
          ids: new Set(),
          waiters: [],
          timer: startTimeout(() => {
            this.pending.delete(name);
            void this.run(name, created);
          }, COALESCE_WINDOW_MS),
        };
        batch = created;
        this.pending.set(name, created);
      }
      for (const id of ids) batch.ids.add(id);
      batch.waiters.push({ resolve, reject });
    });
  }

  private async run(name: string, batch: PendingBatch): Promise<void> {
    const ids = [...batch.ids];
    const membership = new Map<string, boolean>();
    try {
      for (let start = 0; start < ids.length; start += MAX_IDS_PER_REQUEST) {
        const chunk = ids.slice(start, start + MAX_IDS_PER_REQUEST);
        const result = await this.api.checkCohortMembership(name, chunk);
        if (result.status === "failed") {
          throw GamebeastError.fromFailure(`cohort check for '${name}' failed`, result);
        }
        if (!result.data.cohortExists) {
          this.logger.warnOnce(`cohort-missing:${name}`, `Cohort '${name}' does not exist.`);
        }
        const fetchedAt = Date.now();
        for (const entry of result.data.users) membership.set(entry.userId, entry.isMember);
        for (const id of chunk) {
          this.cache.set(cacheKey(name, id), { isMember: membership.get(id) === true, fetchedAt });
        }
      }
    } catch (error) {
      for (const waiter of batch.waiters) waiter.reject(error);
      return;
    }
    for (const waiter of batch.waiters) waiter.resolve(membership);
  }
}

function cacheKey(name: string, id: string): string {
  return `${name}\u0000${id}`;
}
