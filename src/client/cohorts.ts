import type { ApiClient } from "../shared/api";
import type { Logger } from "../shared/logger";
import { LruCache } from "../shared/lruCache";
import { SingleFlight } from "../shared/singleFlight";

const CACHE_TTL_MS = 60_000;
/** A browser checks a handful of cohorts for a handful of identities; this is a loose bound. */
const CACHE_MAX_ENTRIES = 500;

export interface ClientCohorts {
  /**
   * Whether the current user is in the named dashboard cohort. Resolves `false` when the cohort
   * does not exist or the check fails (failures are logged); never rejects.
   *
   * Results are cached for a minute and concurrent checks share one request: the endpoint is
   * limited to 60 requests per minute per API key, and membership is recomputed by the backend,
   * so treat it as eventually consistent.
   */
  isMember(cohortName: string): Promise<boolean>;
}

export interface ClientCohortsDeps {
  api: ApiClient;
  logger: Logger;
  distinctId: () => string;
  /** Server-side rendering: answer `false` without calling the backend. */
  inert: boolean;
}

/**
 * Cached and in-flight checks are keyed by (user, cohort), so an identity change needs no
 * invalidation: the new user simply misses the cache, and a check still in flight for the previous
 * user can only populate the previous user's entry.
 */
export class ClientCohortsService implements ClientCohorts {
  private readonly cache = new LruCache<string, { isMember: boolean; fetchedAt: number }>(
    CACHE_MAX_ENTRIES
  );
  private readonly inFlight = new SingleFlight<string, boolean>();

  constructor(private readonly deps: ClientCohortsDeps) {}

  isMember(cohortName: string): Promise<boolean> {
    if (this.deps.inert) return Promise.resolve(false);
    if (typeof cohortName !== "string" || cohortName.trim() === "") {
      this.deps.logger.error("cohorts.isMember requires a cohort name.");
      return Promise.resolve(false);
    }
    const name = cohortName.trim();
    const userId = this.deps.distinctId();
    const key = `${userId}\u0000${name}`;

    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return Promise.resolve(cached.isMember);
    }
    return this.inFlight.run(key, () => this.check(key, name, userId));
  }

  private async check(key: string, name: string, userId: string): Promise<boolean> {
    const result = await this.deps.api.checkCohortMembership(name, [userId]);
    if (result.status === "failed") {
      this.deps.logger.warn(
        `Cohort check for '${name}' failed (${result.error}); treating as not a member.`
      );
      return false;
    }
    if (!result.data.cohortExists) {
      this.deps.logger.warnOnce(`cohort-missing:${name}`, `Cohort '${name}' does not exist.`);
    }
    const isMember = result.data.users.some((entry) => entry.userId === userId && entry.isMember);
    this.cache.set(key, { isMember, fetchedAt: Date.now() });
    return isMember;
  }
}
