import type { ApiClient } from "../shared/api";
import type { Logger } from "../shared/logger";

const CACHE_TTL_MS = 60_000;

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

export class ClientCohortsService implements ClientCohorts {
  private readonly cache = new Map<string, { isMember: boolean; fetchedAt: number }>();
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private generation = 0;
  private disabled = false;

  constructor(
    private readonly api: ApiClient,
    private readonly logger: Logger,
    private readonly distinctId: () => string
  ) {}

  /** Server-side rendering: answer `false` without calling the backend. */
  disable(): void {
    this.disabled = true;
  }

  isMember(cohortName: string): Promise<boolean> {
    if (this.disabled) return Promise.resolve(false);
    if (typeof cohortName !== "string" || cohortName.trim() === "") {
      this.logger.error("cohorts.isMember requires a cohort name.");
      return Promise.resolve(false);
    }
    const name = cohortName.trim();

    const cached = this.cache.get(name);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS)
      return Promise.resolve(cached.isMember);

    const existing = this.inFlight.get(name);
    if (existing) return existing;

    const promise = this.check(name).finally(() => {
      if (this.inFlight.get(name) === promise) this.inFlight.delete(name);
    });
    this.inFlight.set(name, promise);
    return promise;
  }

  /** Membership is per user: forget everything cached for the previous one. */
  onIdentityChanged(): void {
    this.generation += 1;
    this.cache.clear();
    this.inFlight.clear();
  }

  private async check(name: string): Promise<boolean> {
    const generation = this.generation;
    const userId = this.distinctId();
    const result = await this.api.checkCohortMembership(name, [userId]);

    if (result.status === "failed") {
      this.logger.warn(
        `Cohort check for '${name}' failed (${result.error}); treating as not a member.`
      );
      return false;
    }

    if (!result.data.cohortExists) {
      this.logger.warnOnce(`cohort-missing:${name}`, `Cohort '${name}' does not exist.`);
    }
    const isMember = result.data.users.some((entry) => entry.userId === userId && entry.isMember);
    // Identity changed mid-request: report the answer, but do not cache it for the new user.
    if (generation === this.generation) this.cache.set(name, { isMember, fetchedAt: Date.now() });
    return isMember;
  }
}
