import { afterEach, describe, expect, it, vi } from "vitest";
import { GamebeastServer } from "../src/server";
import type { GamebeastServerOptions } from "../src/server";
import { GamebeastError } from "../src/shared/errors";
import { SDK_VERSION } from "../src/shared/version";
import { FakeBackend, evaluated, silentLogger } from "./helpers";

const servers: GamebeastServer[] = [];

function createServer(backend: FakeBackend, options: Partial<GamebeastServerOptions> = {}) {
  const { logger, lines } = silentLogger();
  const server = new GamebeastServer({
    apiKey: "gb_sk_test",
    fetch: backend.fetch,
    logger,
    apiUrl: "https://api.test",
    serverId: "server-1",
    autoRefresh: false,
    ...options,
  });
  servers.push(server);
  return { server, lines };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.shutdown()));
  vi.useRealTimers();
});

const experiment = {
  id: 5,
  name: "Speed test",
  unitType: "user" as const,
  assignmentMode: "weightedHash" as const,
  baseConfigurationId: 1,
  autoAssignment: true,
  permanentEnrollment: false,
  requiredProperties: [],
  startsAt: "2026-01-01T00:00:00.000Z",
  endsAt: null,
  groups: [{ id: 51, label: "Fast", weight: 5000, ordinal: 1 }],
};

interface SnapshotDocument {
  id: number;
  alias: string | null;
  hash: string;
  configuration: unknown;
}

function bootstrap(documents: SnapshotDocument[], overrides: Record<string, unknown> = {}) {
  return {
    hash: `boot-${documents.map((document) => document.hash).join("-")}`,
    configurations: documents.map((document) => ({
      id: document.id,
      name: document.alias === null ? null : `${document.alias} name`,
      alias: document.alias,
      hash: document.hash,
      configuration: document.configuration,
      privacy: [],
    })),
    primaryConfigurationId: documents[0]?.id ?? null,
    experiments: { user: [experiment], server: [] },
    requiredProperties: [],
    polling: { intervalSeconds: 30, jitterRatio: 0.2 },
    ...overrides,
  };
}

function status(documents: SnapshotDocument[], overrides: Record<string, unknown> = {}) {
  const { configurations, ...rest } = bootstrap(documents, overrides);
  return {
    ...rest,
    hash: `status-${documents.map((document) => document.hash).join("-")}`,
    configurations: configurations.map(({ id, name, alias, hash }) => ({ id, name, alias, hash })),
  };
}

const gameSettings: SnapshotDocument = {
  id: 1,
  alias: "GameSettings",
  hash: "h1",
  configuration: { PlayerSpeed: 16, UI: { Color: "red" } },
};

describe("GamebeastServer snapshot", () => {
  it("loads base configurations from bootstrap with server headers", async () => {
    const backend = new FakeBackend().on("GET /sdk/v2/bootstrap", {
      body: bootstrap([gameSettings]),
    });
    const { server } = createServer(backend, { environment: "staging" });

    expect(await server.configs.ready({ timeoutMs: 1_000 })).toBe(true);
    expect(server.configs.isReady).toBe(true);
    expect(server.configs.get("GameSettings.PlayerSpeed")).toBe(16);
    expect(server.configs.get("gamesettings.UI.Color", "blue")).toBe("red");
    expect(server.configs.get("GameSettings.Missing", 3)).toBe(3);
    expect(server.configs.list()).toEqual([
      { id: 1, name: "GameSettings name", alias: "gamesettings", hash: "h1", isPrimary: true },
    ]);
    expect(server.experiments.list()).toEqual([experiment]);
    expect(server.experiments.list("server")).toEqual([]);

    const [request] = backend.requestsTo("GET /sdk/v2/bootstrap");
    expect(request?.headers).toMatchObject({
      authorization: "gb_sk_test",
      environment: "staging",
      sdkversion: `js-server/${SDK_VERSION}`,
      "server-id": "server-1",
    });
    expect(request?.headers["if-none-match"]).toBeUndefined();
  });

  it("warns once for an unknown alias and returns the fallback", async () => {
    const backend = new FakeBackend().on("GET /sdk/v2/bootstrap", {
      body: bootstrap([gameSettings]),
    });
    const { server, lines } = createServer(backend);
    await server.configs.ready();
    expect(server.configs.get("Nope.x", 1)).toBe(1);
    expect(server.configs.get("Nope.y", 2)).toBe(2);
    expect(lines.filter((line) => line.message.includes("'Nope'"))).toHaveLength(1);
  });

  it("returns fallbacks before the snapshot loads", () => {
    const { server } = createServer(new FakeBackend().on("GET /sdk/v2/bootstrap", { status: 503 }));
    expect(server.configs.isReady).toBe(false);
    expect(server.configs.get("GameSettings.PlayerSpeed", 1)).toBe(1);
    expect(server.configs.list()).toEqual([]);
  });

  it("polls status, refetches bootstrap only when a document hash moves, and notifies listeners", async () => {
    let documents = [gameSettings];
    const backend = new FakeBackend()
      .on("GET /sdk/v2/bootstrap", () => ({ body: bootstrap(documents) }))
      .on("GET /sdk/v2/status", (request) => {
        const current = status(documents);
        return request.headers["if-none-match"] === `"${current.hash}"`
          ? { status: 304 }
          : { body: current };
      });
    const { server } = createServer(backend);
    await server.configs.ready();

    const observed: unknown[] = [];
    const changed: unknown[] = [];
    server.configs.observe("GameSettings.PlayerSpeed", (value) => observed.push(value));
    server.configs.onChanged("GameSettings.PlayerSpeed", (value) => changed.push(value));
    expect(observed).toEqual([16]);

    // First poll: no hash held yet, same documents → no bootstrap refetch.
    await server.configs.refresh();
    expect(backend.requestsTo("GET /sdk/v2/bootstrap")).toHaveLength(1);
    // Second poll: sends the status hash and gets a 304.
    await server.configs.refresh();
    const statusRequests = backend.requestsTo("GET /sdk/v2/status");
    expect(statusRequests[1]?.headers["if-none-match"]).toBe(`"${status(documents).hash}"`);

    documents = [
      { ...gameSettings, hash: "h2", configuration: { PlayerSpeed: 20, UI: { Color: "red" } } },
    ];
    await server.configs.refresh();
    expect(backend.requestsTo("GET /sdk/v2/bootstrap")).toHaveLength(2);
    expect(server.configs.get("GameSettings.PlayerSpeed")).toBe(20);
    expect(observed).toEqual([16, 20]);
    expect(changed).toEqual([20]);
  });

  it("applies experiment-only changes from status without refetching documents", async () => {
    let experiments = { user: [experiment], server: [] as unknown[] };
    const backend = new FakeBackend()
      .on("GET /sdk/v2/bootstrap", { body: bootstrap([gameSettings]) })
      .on("GET /sdk/v2/status", () => ({
        body: status([gameSettings], { experiments, hash: "s" }),
      }));
    const { server } = createServer(backend);
    await server.configs.ready();
    experiments = { user: [], server: [{ ...experiment, unitType: "server" }] };
    // A status hash that differs each call so the SDK reads the body.
    backend.on("GET /sdk/v2/status", () => ({
      body: { ...status([gameSettings], { experiments }), hash: `s-${Math.random()}` },
    }));
    await server.configs.refresh();
    expect(server.experiments.list()).toEqual([]);
    expect(server.experiments.list("server")).toHaveLength(1);
    expect(backend.requestsTo("GET /sdk/v2/bootstrap")).toHaveLength(1);
  });

  it("drops documents that disappear from the snapshot", async () => {
    let documents = [
      gameSettings,
      { id: 2, alias: "Shop", hash: "s1", configuration: { price: 5 } },
    ];
    const backend = new FakeBackend()
      .on("GET /sdk/v2/bootstrap", () => ({ body: bootstrap(documents) }))
      .on("GET /sdk/v2/status", () => ({ body: status(documents) }));
    const { server } = createServer(backend);
    await server.configs.ready();
    expect(server.configs.get("Shop.price")).toBe(5);
    const shop: unknown[] = [];
    server.configs.onChanged("Shop.price", (value) => shop.push(value));

    documents = [gameSettings];
    await server.configs.refresh();
    expect(server.configs.get("Shop.price", 0)).toBe(0);
    expect(shop).toEqual([undefined]);
  });

  it("retries a failed bootstrap on the next poll instead of trusting the new status hash", async () => {
    let documents = [gameSettings];
    let bootstrapFails = false;
    const backend = new FakeBackend()
      .on("GET /sdk/v2/bootstrap", () =>
        bootstrapFails ? { status: 503 } : { body: bootstrap(documents) }
      )
      .on("GET /sdk/v2/status", (request) => {
        const current = status(documents);
        return request.headers["if-none-match"] === `"${current.hash}"`
          ? { status: 304 }
          : { body: current };
      });
    const { server } = createServer(backend);
    await server.configs.ready();

    documents = [{ ...gameSettings, hash: "h2", configuration: { PlayerSpeed: 99 } }];
    bootstrapFails = true;
    await server.configs.refresh();
    expect(server.configs.get("GameSettings.PlayerSpeed")).toBe(16);

    bootstrapFails = false;
    await server.configs.refresh();
    expect(server.configs.get("GameSettings.PlayerSpeed")).toBe(99);
  });

  it("ready() resolves false on a permanent failure and on timeout", async () => {
    const forbidden = new FakeBackend().on("GET /sdk/v2/bootstrap", {
      status: 403,
      body: { errorCode: "FORBIDDEN", message: "no" },
    });
    const { server, lines } = createServer(forbidden);
    expect(await server.configs.ready({ timeoutMs: 1_000 })).toBe(false);
    expect(lines.some((line) => line.level === "error")).toBe(true);

    const down = new FakeBackend().on("GET /sdk/v2/bootstrap", { status: 503 });
    const second = createServer(down).server;
    expect(await second.configs.ready({ timeoutMs: 20 })).toBe(false);
  });

  it("polls in the background with the backend-advertised interval", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend()
      .on("GET /sdk/v2/bootstrap", {
        body: bootstrap([gameSettings], { polling: { intervalSeconds: 10, jitterRatio: 0 } }),
      })
      .on("GET /sdk/v2/status", { status: 304 });
    const { server } = createServer(backend, { autoRefresh: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(server.configs.isReady).toBe(true);
    expect(backend.requestsTo("GET /sdk/v2/status")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.requestsTo("GET /sdk/v2/status")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.requestsTo("GET /sdk/v2/status")).toHaveLength(2);

    await server.shutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backend.requestsTo("GET /sdk/v2/status")).toHaveLength(2);
  });

  it("never polls faster than every 5 seconds", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend()
      .on("GET /sdk/v2/bootstrap", {
        body: bootstrap([gameSettings], { polling: { intervalSeconds: 1, jitterRatio: 0 } }),
      })
      .on("GET /sdk/v2/status", { status: 304 });
    createServer(backend, { autoRefresh: true });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(backend.requestsTo("GET /sdk/v2/status")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(backend.requestsTo("GET /sdk/v2/status")).toHaveLength(1);
  });

  it("retries the initial bootstrap quickly after a transient failure", async () => {
    vi.useFakeTimers();
    let fail = true;
    const backend = new FakeBackend().on("GET /sdk/v2/bootstrap", () =>
      fail ? { status: 503 } : { body: bootstrap([gameSettings]) }
    );
    const { server } = createServer(backend, { autoRefresh: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(server.configs.isReady).toBe(false);
    fail = false;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(server.configs.isReady).toBe(true);
  });
});

describe("GamebeastServer configs.evaluate", () => {
  function evaluateBackend() {
    return new FakeBackend().on("GET /sdk/v2/bootstrap", { body: bootstrap([gameSettings]) });
  }

  it("evaluates for a unit with context and returns experiment metadata", async () => {
    const assignment = {
      experimentId: 5,
      groupId: 51,
      assignmentVersion: 1,
      source: "weightedHash" as const,
      exposureProxyRecorded: true,
    };
    const backend = evaluateBackend().on(
      "POST /sdk/v2/configurations/evaluate",
      evaluated({ PlayerSpeed: 20, list: [1] }, { experiments: [assignment], name: "GameSettings" })
    );
    const { server } = createServer(backend);
    const result = await server.configs.evaluate({
      distinctId: "alice",
      configuration: "GameSettings",
      properties: { plan: "pro", joined: new Date(1_700_000_000_000) },
    });

    expect(result.source).toBe("evaluated");
    expect(result.error).toBeUndefined();
    expect(result.get("PlayerSpeed", 1)).toBe(20);
    expect(result.get("PlayerSpeed", "fast")).toBe("fast");
    expect(result.get(["list", "0"])).toBe(1);
    expect(result.get()).toEqual({ PlayerSpeed: 20, list: [1] });
    expect(result.experiments).toEqual([assignment]);
    expect(result.configurationId).toBe(1);
    expect(result.hash).toBe("hash-1");

    // Values are copies.
    (result.value as { list: number[] }).list.push(2);
    expect(result.get("list")).toEqual([1]);

    const [request] = backend.requestsTo("POST /sdk/v2/configurations/evaluate");
    expect(request?.body).toEqual({
      unit: { type: "user", distinctId: "alice" },
      configuration: "GameSettings",
      context: { schemaVersion: 1, properties: { plan: "pro", joined: 1_700_000_000_000 } },
    });
  });

  it("omits configuration to evaluate the primary, and supports server units", async () => {
    const backend = evaluateBackend().on(
      "POST /sdk/v2/configurations/evaluate",
      evaluated({ a: 1 })
    );
    const { server } = createServer(backend);
    await server.configs.evaluate({ distinctId: "server-9", unitType: "server" });
    expect(backend.requestsTo("POST /sdk/v2/configurations/evaluate")[0]?.body).toEqual({
      unit: { type: "server", distinctId: "server-9" },
    });
  });

  it("reuses evaluations within the cache window and shares concurrent requests", async () => {
    vi.useFakeTimers();
    const backend = evaluateBackend().on("POST /sdk/v2/configurations/evaluate", (request) =>
      (request.body as { knownHash?: string }).knownHash === "hash-1"
        ? { status: 304 }
        : evaluated({ a: 1 })
    );
    const { server } = createServer(backend, { evaluationCacheSeconds: 30 });
    const options = {
      distinctId: "alice",
      configuration: "GameSettings",
      properties: { b: 1, a: 2 },
    };
    const [first, second] = await Promise.all([
      server.configs.evaluate(options),
      server.configs.evaluate(options),
    ]);
    expect(first.get("a")).toBe(1);
    expect(second.get("a")).toBe(1);
    // Property order does not affect the cache key.
    await server.configs.evaluate({ ...options, properties: { a: 2, b: 1 } });
    expect(backend.requestsTo("POST /sdk/v2/configurations/evaluate")).toHaveLength(1);

    // Different properties or users are separate evaluations.
    await server.configs.evaluate({ ...options, properties: { a: 3 } });
    await server.configs.evaluate({ ...options, distinctId: "bob" });
    expect(backend.requestsTo("POST /sdk/v2/configurations/evaluate")).toHaveLength(3);

    vi.advanceTimersByTime(31_000);
    const revalidated = await server.configs.evaluate(options);
    const requests = backend.requestsTo("POST /sdk/v2/configurations/evaluate");
    expect(requests).toHaveLength(4);
    expect((requests[3]?.body as { knownHash?: string }).knownHash).toBe("hash-1");
    expect(revalidated.source).toBe("evaluated");
    expect(revalidated.get("a")).toBe(1);
  });

  it("always asks the backend when evaluationCacheSeconds is 0", async () => {
    const backend = evaluateBackend().on(
      "POST /sdk/v2/configurations/evaluate",
      evaluated({ a: 1 })
    );
    const { server } = createServer(backend, { evaluationCacheSeconds: 0 });
    await server.configs.evaluate({ distinctId: "alice" });
    await server.configs.evaluate({ distinctId: "alice" });
    const requests = backend.requestsTo("POST /sdk/v2/configurations/evaluate");
    expect(requests).toHaveLength(2);
    expect((requests[1]?.body as { knownHash?: string }).knownHash).toBeUndefined();
  });

  it("falls back to the stale evaluation, then the base configuration, then unavailable", async () => {
    vi.useFakeTimers();
    let fail = false;
    const backend = evaluateBackend().on("POST /sdk/v2/configurations/evaluate", () =>
      fail ? { status: 503 } : evaluated({ PlayerSpeed: 20 })
    );
    const { server } = createServer(backend);
    await vi.advanceTimersByTimeAsync(0);
    await server.configs.ready();

    await server.configs.evaluate({ distinctId: "alice", configuration: "GameSettings" });
    fail = true;
    vi.advanceTimersByTime(31_000);

    const stale = await server.configs.evaluate({
      distinctId: "alice",
      configuration: "GameSettings",
    });
    expect(stale.source).toBe("stale");
    expect(stale.get("PlayerSpeed")).toBe(20);
    expect(stale.error).toMatch(/503/);

    const base = await server.configs.evaluate({
      distinctId: "bob",
      configuration: "GameSettings",
    });
    expect(base.source).toBe("base");
    expect(base.get("PlayerSpeed")).toBe(16);
    expect(base.experiments).toEqual([]);

    const primary = await server.configs.evaluate({ distinctId: "bob" });
    expect(primary.source).toBe("base");
    expect(primary.configurationId).toBe(1);

    const missing = await server.configs.evaluate({ distinctId: "bob", configuration: "Other" });
    expect(missing.source).toBe("unavailable");
    expect(missing.value).toBeUndefined();
    expect(missing.get("x", 7)).toBe(7);
  });

  it("reports a configuration that does not exist as unavailable", async () => {
    const backend = evaluateBackend().on("POST /sdk/v2/configurations/evaluate", {
      status: 404,
      body: { errorCode: "CONFIGURATION_NOT_FOUND", message: "nope" },
    });
    const { server, lines } = createServer(backend);
    const result = await server.configs.evaluate({ distinctId: "alice", configuration: "Nope" });
    expect(result.source).toBe("unavailable");
    expect(lines.some((line) => line.level === "warn" && line.message.includes("'Nope'"))).toBe(
      true
    );
  });

  it("rejects invalid input without a request and without throwing", async () => {
    const backend = evaluateBackend();
    const { server, lines } = createServer(backend);
    const noId = await server.configs.evaluate({ distinctId: "" });
    expect(noId.source).toBe("unavailable");
    const badType = await server.configs.evaluate({
      distinctId: "a",
      unitType: "team" as unknown as "user",
    });
    expect(badType.source).toBe("unavailable");
    const badAlias = await server.configs.evaluate({ distinctId: "a", configuration: "!!!" });
    expect(badAlias.source).toBe("unavailable");
    expect(backend.requestsTo("POST /sdk/v2/configurations/evaluate")).toHaveLength(0);
    expect(lines.filter((line) => line.level === "error")).toHaveLength(3);
  });

  it("drops invalid targeting properties with a log line", async () => {
    const backend = evaluateBackend().on("POST /sdk/v2/configurations/evaluate", evaluated({}));
    const { server, lines } = createServer(backend);
    await server.configs.evaluate({
      distinctId: "alice",
      properties: {
        ok: true,
        nested: { no: 1 } as unknown as string,
        mixed: [1, "a"] as unknown as number[],
      },
    });
    const body = backend.requestsTo("POST /sdk/v2/configurations/evaluate")[0]?.body as {
      context: { properties: Record<string, unknown> };
    };
    expect(body.context.properties).toEqual({ ok: true });
    expect(lines.filter((line) => line.level !== "debug").length).toBeGreaterThanOrEqual(2);
  });
});

describe("GamebeastServer experiments.assign", () => {
  const entry = (experimentId: number) => ({
    experimentId,
    groupId: 51,
    automaticGroupId: 51,
    overrideGroupId: null,
    status: "active" as const,
    source: "weightedHash" as const,
    assignmentVersion: 1,
  });

  it("batches by 250, dedupes, merges shared context and fills missing units with []", async () => {
    const backend = new FakeBackend()
      .on("GET /sdk/v2/bootstrap", { body: bootstrap([gameSettings]) })
      .on("POST /sdk/v2/experiments/assignments/bulk", (request) => {
        const units = (request.body as { units: Array<{ distinctId: string }> }).units;
        return {
          body: {
            assignments: Object.fromEntries(
              units
                .filter((unit) => unit.distinctId !== "u-3")
                .map((unit) => [unit.distinctId, [entry(5)]])
            ),
          },
        };
      });
    const { server, lines } = createServer(backend);
    const units = Array.from({ length: 300 }, (_, index) => `u-${index}`);
    const result = await server.experiments.assign(
      [...units, { distinctId: "u-0", properties: { plan: "pro" } }, ""],
      { sharedProperties: { region: "eu" } }
    );

    const requests = backend.requestsTo("POST /sdk/v2/experiments/assignments/bulk");
    expect(requests).toHaveLength(2);
    const firstBody = requests[0]?.body as {
      unitType: string;
      sharedContext: unknown;
      units: Array<{ distinctId: string; context?: unknown }>;
    };
    expect(firstBody.unitType).toBe("user");
    expect(firstBody.sharedContext).toEqual({ schemaVersion: 1, properties: { region: "eu" } });
    expect(firstBody.units).toHaveLength(250);
    expect(firstBody.units[0]).toEqual({
      distinctId: "u-0",
      context: { properties: { plan: "pro" } },
    });
    expect((requests[1]?.body as { units: unknown[] }).units).toHaveLength(50);

    expect(result.size).toBe(300);
    expect(result.get("u-1")).toEqual([entry(5)]);
    expect(result.get("u-3")).toEqual([]);
    expect(lines.some((line) => line.level === "error")).toBe(true); // the empty id
  });

  it("resolves an empty map without a request for no valid units", async () => {
    const backend = new FakeBackend();
    const { server } = createServer(backend);
    expect((await server.experiments.assign([])).size).toBe(0);
    expect(backend.requestsTo("POST /sdk/v2/experiments/assignments/bulk")).toHaveLength(0);
  });

  it("rejects with a GamebeastError carrying the HTTP details on failure", async () => {
    const backend = new FakeBackend().on("POST /sdk/v2/experiments/assignments/bulk", {
      status: 429,
      body: { errorCode: "RATE_LIMITED", message: "slow down" },
    });
    const { server } = createServer(backend);
    const error = await server.experiments
      .assign(["a"], { unitType: "server" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GamebeastError);
    expect(error).toMatchObject({ status: 429, errorCode: "RATE_LIMITED", retryable: true });
    expect(
      (
        backend.requestsTo("POST /sdk/v2/experiments/assignments/bulk")[0]?.body as {
          unitType: string;
        }
      ).unitType
    ).toBe("server");
    await expect(
      server.experiments.assign(["a"], { unitType: "team" as unknown as "user" })
    ).rejects.toThrow(/unitType/);
  });
});

describe("GamebeastServer cohorts", () => {
  it("coalesces concurrent checks into one request and caches results", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/cohorts/membership", (request) => {
      const ids = (request.body as { userIds: string[] }).userIds;
      return {
        body: {
          cohortExists: true,
          users: ids.map((userId) => ({ userId, isMember: userId !== "bob" })),
        },
      };
    });
    const { server } = createServer(backend, { environment: "development" });
    const [alice, bob, many] = await Promise.all([
      server.cohorts.isMember("whales", "alice"),
      server.cohorts.isMember("whales", "bob"),
      server.cohorts.getMembership("whales", ["carol", "alice"]),
    ]);
    expect(alice).toBe(true);
    expect(bob).toBe(false);
    expect([...many]).toEqual([
      ["carol", true],
      ["alice", true],
    ]);

    const requests = backend.requestsTo("POST /sdk/v1/cohorts/membership");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers).toMatchObject({ isstudio: "true", authorization: "gb_sk_test" });
    expect((requests[0]?.body as { userIds: string[] }).userIds.sort()).toEqual([
      "alice",
      "bob",
      "carol",
    ]);

    expect(await server.cohorts.isMember("whales", "bob")).toBe(false);
    expect(backend.requestsTo("POST /sdk/v1/cohorts/membership")).toHaveLength(1);
  });

  it("accepts the documented bare-array response shape", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/cohorts/membership", {
      body: [{ userId: 42, isMember: true }],
    });
    const { server } = createServer(backend);
    expect(await server.cohorts.isMember("whales", "42")).toBe(true);
  });

  it("treats a missing cohort as not a member and warns once", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/cohorts/membership", {
      body: { cohortExists: false, users: [] },
    });
    const { server, lines } = createServer(backend);
    expect(await server.cohorts.isMember("ghosts", "a")).toBe(false);
    expect(await server.cohorts.isMember("ghosts", "b")).toBe(false);
    expect(lines.filter((line) => line.message.includes("'ghosts' does not exist"))).toHaveLength(
      1
    );
  });

  it("isMember resolves false on failure while getMembership rejects", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/cohorts/membership", { status: 500 });
    const { server } = createServer(backend);
    expect(await server.cohorts.isMember("whales", "a")).toBe(false);
    await expect(server.cohorts.getMembership("whales", ["a"])).rejects.toBeInstanceOf(
      GamebeastError
    );
    await expect(server.cohorts.getMembership("  ", ["a"])).rejects.toThrow(/cohort name/);
  });
});

describe("GamebeastServer markers and lifecycle", () => {
  it("sends user and server-level markers with the server id", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/markers", {
      body: { ingestedMarkersCount: 2 },
    });
    const { server } = createServer(backend);
    server.markers.send(
      "purchase",
      { sku: "gems" },
      { distinctId: "alice", sessionId: "s1", timestamp: 1_700_000_000_000 }
    );
    server.markers.send("server_tick");
    await server.flush();

    const [request] = backend.requestsTo("POST /sdk/v1/markers");
    expect(request?.headers).toMatchObject({
      serverid: "server-1",
      isstudio: "false",
      sdkversion: `js-server/${SDK_VERSION}`,
    });
    expect(request?.keepalive).toBe(false);
    const markers = (request?.body as { markers: Array<Record<string, unknown>> }).markers;
    expect(markers[0]).toMatchObject({
      eventName: "purchase",
      distinctId: "alice",
      sessionId: "s1",
      timestamp: 1_700_000_000_000,
      properties: { sku: "gems" },
    });
    expect(markers[1]).toMatchObject({ eventName: "server_tick", properties: {} });
    expect(markers[1]?.distinctId).toBeUndefined();
    expect(markers[0]?.markerId).not.toBe(markers[1]?.markerId);
  });

  it("drops markers with an invalid distinctId", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/markers", { body: {} });
    const { server, lines } = createServer(backend);
    server.markers.send("e", {}, { distinctId: "" });
    await server.flush();
    expect(backend.requestsTo("POST /sdk/v1/markers")).toHaveLength(0);
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });

  it("flushes a full batch immediately and the rest on the interval", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend().on("POST /sdk/v1/markers", { body: {} });
    const { server } = createServer(backend, {
      markers: { maxBatchSize: 2, flushIntervalMs: 1_000 },
    });
    server.markers.send("a");
    server.markers.send("b");
    server.markers.send("c");
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.requestsTo("POST /sdk/v1/markers")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backend.requestsTo("POST /sdk/v1/markers")).toHaveLength(2);
  });

  it("shutdown flushes, is idempotent, and drops later markers", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/markers", { body: {} });
    const { server, lines } = createServer(backend);
    server.markers.send("before");
    const first = server.shutdown();
    expect(server.shutdown()).toBe(first);
    await first;
    expect(backend.requestsTo("POST /sdk/v1/markers")).toHaveLength(1);
    server.markers.send("after");
    await server.flush();
    expect(backend.requestsTo("POST /sdk/v1/markers")).toHaveLength(1);
    expect(lines.some((line) => line.message.includes("shut down"))).toBe(true);
  });

  it("generates a server id when none is given and validates options", () => {
    const { server } = createServer(new FakeBackend(), { serverId: undefined });
    expect(server.serverId).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new GamebeastServer({ apiKey: " " })).toThrow(/apiKey/);
    expect(
      () => new GamebeastServer({ apiKey: "k", projectId: 0, fetch: new FakeBackend().fetch })
    ).toThrow(/projectId/);
  });

  it("sends project-id for multi-project keys", async () => {
    const backend = new FakeBackend().on("GET /sdk/v2/bootstrap", {
      body: bootstrap([gameSettings]),
    });
    const { server } = createServer(backend, { projectId: 12 });
    await server.configs.ready();
    expect(backend.requestsTo("GET /sdk/v2/bootstrap")[0]?.headers["project-id"]).toBe("12");
  });
});
