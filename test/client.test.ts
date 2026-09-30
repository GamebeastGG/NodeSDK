// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GamebeastClient } from "../src/client";
import type { GamebeastClientOptions } from "../src/client";
import { SDK_VERSION } from "../src/shared/version";
import { FakeBackend, configurationResponse, evaluated, silentLogger } from "./helpers";

const clients: GamebeastClient[] = [];

function createClient(backend: FakeBackend, options: Partial<GamebeastClientOptions> = {}) {
  const { logger, lines } = silentLogger();
  const client = new GamebeastClient({
    apiKey: "gb_pk_test",
    fetch: backend.fetch,
    logger,
    apiUrl: "https://api.test",
    ...options,
  });
  clients.push(client);
  return { client, lines };
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  localStorage.clear();
  setVisibility("visible");
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.shutdown()));
  vi.useRealTimers();
});

describe("GamebeastClient configurations", () => {
  it("evaluates declared configurations for an anonymous user and becomes ready", async () => {
    const backend = new FakeBackend().on(
      "POST /sdk/v2/configurations/evaluate",
      evaluated({ PlayerSpeed: 16, UI: { Color: "red" }, Levels: [1, 2, 3] })
    );
    const { client } = createClient(backend, {
      configurations: ["GameSettings"],
      environment: "development",
      appVersion: "2.1.0",
      properties: { plan: "pro" },
    });

    expect(client.configs.isReady).toBe(false);
    expect(await client.configs.ready({ timeoutMs: 1_000 })).toBe(true);

    expect(client.configs.get("GameSettings.PlayerSpeed")).toBe(16);
    expect(client.configs.get("GameSettings.UI.Color", "blue")).toBe("red");
    expect(client.configs.get("GameSettings.Levels.2")).toBe(3);
    expect(client.configs.get("GameSettings.Missing", 5)).toBe(5);
    // Type mismatch against the fallback returns the fallback.
    expect(client.configs.get("GameSettings.PlayerSpeed", "fast")).toBe("fast");

    const [request] = backend.requestsTo("POST /sdk/v2/configurations/evaluate");
    expect(request?.headers).toMatchObject({
      authorization: "gb_pk_test",
      environment: "development",
      sdkversion: `js-web/${SDK_VERSION}`,
      "content-type": "application/json",
    });
    expect(request?.headers.isstudio).toBeUndefined();
    expect(request?.body).toEqual({
      configuration: "GameSettings",
      unit: { type: "user", distinctId: client.distinctId },
      context: {
        schemaVersion: 1,
        properties: {
          platform: "web",
          systemLanguage: navigator.language,
          appVersion: "2.1.0",
          plan: "pro",
        },
      },
    });
    expect(client.isAnonymous).toBe(true);
    expect(client.distinctId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns copies, so callers cannot corrupt SDK state", async () => {
    const backend = new FakeBackend().on(
      "POST /sdk/v2/configurations/evaluate",
      evaluated({ list: [1] })
    );
    const { client } = createClient(backend, { configurations: ["GameSettings"] });
    await client.configs.ready();
    const list = client.configs.get<number[]>("GameSettings.list");
    list?.push(2);
    expect(client.configs.get("GameSettings.list")).toEqual([1]);
  });

  it("fires observe for the initial value and onChanged only for changes", async () => {
    let speed = 1;
    const backend = new FakeBackend().on("POST /sdk/v2/configurations/evaluate", () => ({
      body: configurationResponse({ speed, other: "x" }, { hash: `hash-${speed}` }),
    }));
    const { client } = createClient(backend, { configurations: ["GameSettings"] });

    const observed: unknown[] = [];
    const changed: unknown[] = [];
    client.configs.observe("GameSettings.speed", (value) => observed.push(value));
    client.configs.onChanged("GameSettings.speed", (value) => changed.push(value));
    const otherChanged = vi.fn();
    client.configs.onChanged("GameSettings.other", otherChanged);

    await client.configs.ready();
    expect(observed).toEqual([1]);
    expect(changed).toEqual([]);

    speed = 2;
    await client.configs.refresh();
    expect(observed).toEqual([1, 2]);
    expect(changed).toEqual([2]);
    expect(otherChanged).not.toHaveBeenCalled();

    // An observer registered after load fires immediately.
    const late: unknown[] = [];
    client.configs.observe("GameSettings.speed", (value) => late.push(value));
    expect(late).toEqual([2]);
  });

  it("sends knownHash on refresh and keeps values on 304", async () => {
    const backend = new FakeBackend().on("POST /sdk/v2/configurations/evaluate", (request) =>
      (request.body as { knownHash?: string }).knownHash === "hash-1"
        ? { status: 304 }
        : { body: configurationResponse({ speed: 3 }) }
    );
    const { client } = createClient(backend, { configurations: ["GameSettings"] });
    await client.configs.ready();
    await client.configs.refresh();
    const requests = backend.requestsTo("POST /sdk/v2/configurations/evaluate");
    expect(requests).toHaveLength(2);
    expect((requests[1]?.body as { knownHash?: string }).knownHash).toBe("hash-1");
    expect(client.configs.get("GameSettings.speed")).toBe(3);
  });

  it("serves cached configurations immediately on the next page load", async () => {
    const backend = new FakeBackend().on(
      "POST /sdk/v2/configurations/evaluate",
      evaluated({ speed: 7 })
    );
    const first = createClient(backend, { configurations: ["GameSettings"] }).client;
    await first.configs.ready();
    await first.shutdown();

    const offline = new FakeBackend().on("POST /sdk/v2/configurations/evaluate", { status: 503 });
    const { client } = createClient(offline, { configurations: ["GameSettings"] });
    expect(client.configs.isReady).toBe(true);
    expect(client.configs.get("GameSettings.speed")).toBe(7);
    expect(client.distinctId).toBe(first.distinctId);
  });

  it("does not reuse a cache written for a different user", async () => {
    const backend = new FakeBackend().on(
      "POST /sdk/v2/configurations/evaluate",
      evaluated({ speed: 7 })
    );
    const first = createClient(backend, {
      configurations: ["GameSettings"],
      distinctId: "alice",
    }).client;
    await first.configs.ready();

    const offline = new FakeBackend().on("POST /sdk/v2/configurations/evaluate", { status: 503 });
    const { client } = createClient(offline, {
      configurations: ["GameSettings"],
      distinctId: "bob",
    });
    expect(client.configs.isReady).toBe(false);
    expect(client.configs.get("GameSettings.speed")).toBeUndefined();
  });

  it("loads undeclared configurations on first access", async () => {
    const backend = new FakeBackend().on(
      "POST /sdk/v2/configurations/evaluate",
      evaluated({ enabled: true })
    );
    const { client } = createClient(backend);
    expect(client.configs.isReady).toBe(true);
    expect(client.configs.get("Features.enabled")).toBeUndefined();
    await waitFor(() => client.configs.get("Features.enabled") === true);
    expect(backend.requestsTo("POST /sdk/v2/configurations/evaluate")).toHaveLength(1);
  });

  it("becomes ready when a declared configuration does not exist, rather than hanging", async () => {
    const backend = new FakeBackend().on("POST /sdk/v2/configurations/evaluate", {
      status: 404,
      body: { errorCode: "CONFIGURATION_NOT_FOUND", message: "nope" },
    });
    const { client, lines } = createClient(backend, { configurations: ["Missing"] });
    expect(await client.configs.ready({ timeoutMs: 1_000 })).toBe(true);
    expect(client.configs.get("Missing.x", 1)).toBe(1);
    expect(lines.some((line) => line.level === "warn" && line.message.includes("not found"))).toBe(
      true
    );
  });

  it("ready() resolves false on timeout while a configuration keeps failing", async () => {
    const backend = new FakeBackend().on("POST /sdk/v2/configurations/evaluate", { status: 503 });
    const { client } = createClient(backend, { configurations: ["GameSettings"] });
    expect(await client.configs.ready({ timeoutMs: 20 })).toBe(false);
  });
});

describe("GamebeastClient identity", () => {
  it("re-evaluates for the new user on identify and discards in-flight responses for the old one", async () => {
    let release: (() => void) | undefined;
    const backend = new FakeBackend().on(
      "POST /sdk/v2/configurations/evaluate",
      async (request) => {
        const distinctId = (request.body as { unit: { distinctId: string } }).unit.distinctId;
        if (distinctId !== "alice") {
          await new Promise<void>((resolve) => (release = resolve));
          return { body: configurationResponse({ who: "anonymous" }, { hash: "anon" }) };
        }
        return { body: configurationResponse({ who: "alice" }, { hash: "alice" }) };
      }
    );
    const { client } = createClient(backend, { configurations: ["GameSettings"] });
    await waitFor(() => release !== undefined);

    client.identify("alice");
    release?.();
    await waitFor(() => client.configs.get("GameSettings.who") === "alice");
    expect(client.distinctId).toBe("alice");
    expect(client.isAnonymous).toBe(false);

    const bodies = backend
      .requestsTo("POST /sdk/v2/configurations/evaluate")
      .map((request) => request.body as { unit: { distinctId: string }; knownHash?: string });
    expect(bodies[1]).toMatchObject({ unit: { distinctId: "alice" } });
    expect(bodies[1]?.knownHash).toBeUndefined();
  });

  it("resetIdentity returns to the same anonymous id", async () => {
    const backend = new FakeBackend().on("POST /sdk/v2/configurations/evaluate", evaluated({}));
    const { client } = createClient(backend);
    const anonymous = client.distinctId;
    client.identify("alice");
    client.resetIdentity();
    expect(client.distinctId).toBe(anonymous);
    expect(client.isAnonymous).toBe(true);
  });

  it("rejects invalid ids", () => {
    const { client, lines } = createClient(new FakeBackend());
    const before = client.distinctId;
    client.identify("   ");
    client.identify("x".repeat(257));
    expect(client.distinctId).toBe(before);
    expect(lines.filter((line) => line.level === "error")).toHaveLength(2);
  });
});

describe("GamebeastClient markers", () => {
  it("batches markers with identity, session and v1 headers", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/markers", {
      body: { message: "ok", ingestedMarkersCount: 2, rejectedMarkersCount: 0 },
    });
    const { client } = createClient(backend, { distinctId: "alice" });
    client.markers.send("level_completed", { level: 3 });
    client.markers.send("item_bought");
    await client.flush();

    const [request] = backend.requestsTo("POST /sdk/v1/markers");
    expect(request?.headers).toMatchObject({
      authorization: "gb_pk_test",
      isstudio: "false",
      sdkversion: `js-web/${SDK_VERSION}`,
    });
    expect(request?.keepalive).toBe(true);
    const markers = (request?.body as { markers: Array<Record<string, unknown>> }).markers;
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      eventName: "level_completed",
      distinctId: "alice",
      sessionId: client.sessionId,
      properties: { level: 3 },
    });
    expect(markers[1]).toMatchObject({ eventName: "item_bought", properties: {} });
  });

  it("maps development to isstudio=true", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/markers", { body: {} });
    const { client } = createClient(backend, { environment: "studio" });
    client.markers.send("e");
    await client.flush();
    expect(backend.requestsTo("POST /sdk/v1/markers")[0]?.headers.isstudio).toBe("true");
  });

  it("persists markers when the page is hidden offline and sends them on the next load", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/markers", { body: {} });
    const { client } = createClient(backend);
    client.markers.send("offline_event", { n: 1 });

    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    try {
      window.dispatchEvent(new Event("pagehide"));
    } finally {
      Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    }
    expect(backend.requestsTo("POST /sdk/v1/markers")).toHaveLength(0);

    const next = createClient(backend).client;
    await next.flush();
    const sent = backend.requestsTo("POST /sdk/v1/markers");
    expect(sent).toHaveLength(1);
    expect((sent[0]?.body as { markers: Array<{ eventName: string }> }).markers[0]?.eventName).toBe(
      "offline_event"
    );

    // Storage was claimed: a third page load sends nothing again.
    const third = createClient(backend).client;
    await third.flush();
    expect(backend.requestsTo("POST /sdk/v1/markers")).toHaveLength(1);
  });

  it("sends buffered markers with keepalive when the page is hidden", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/markers", { body: {} });
    const { client } = createClient(backend);
    client.markers.send("before_hide");
    setVisibility("hidden");
    await client.flush();
    const [request] = backend.requestsTo("POST /sdk/v1/markers");
    expect(request?.keepalive).toBe(true);
    expect(localStorage.length).toBeGreaterThan(0); // anonymous id + session, not markers
    for (let index = 0; index < localStorage.length; index += 1) {
      expect(localStorage.key(index)).not.toMatch(/markers$/);
    }
  });

  it("reuses the session across page loads within the timeout", () => {
    const first = createClient(new FakeBackend()).client;
    const second = createClient(new FakeBackend()).client;
    expect(second.sessionId).toBe(first.sessionId);
  });
});

describe("GamebeastClient experiments and cohorts", () => {
  it("reports assignments from evaluated responses, enriched with catalog names", async () => {
    const backend = new FakeBackend()
      .on(
        "POST /sdk/v2/configurations/evaluate",
        evaluated(
          { speed: 20 },
          {
            experiments: [
              {
                experimentId: 5,
                groupId: 51,
                assignmentVersion: 1,
                source: "weightedHash",
                exposureProxyRecorded: true,
              },
            ],
          }
        )
      )
      .on("GET /sdk/v2/experiments/active", {
        body: {
          hash: "cat-1",
          requiredProperties: [],
          experiments: [
            {
              id: 5,
              name: "Speed test",
              unitType: "user",
              assignmentMode: "weightedHash",
              baseConfigurationId: 1,
              autoAssignment: true,
              permanentEnrollment: false,
              requiredProperties: [],
              startsAt: "2026-01-01T00:00:00.000Z",
              endsAt: null,
              groups: [
                { id: 51, label: "Fast", weight: 5000, ordinal: 1, changeset: { operations: [] } },
              ],
            },
          ],
        },
      });
    const { client } = createClient(backend, { configurations: ["GameSettings"] });
    const updates: unknown[] = [];
    client.experiments.onAssignmentsChanged((assignments) => updates.push(assignments));

    await waitFor(() => client.experiments.assignments[0]?.experimentName === "Speed test");
    expect(client.experiments.assignments).toEqual([
      {
        experimentId: 5,
        experimentName: "Speed test",
        groupId: 51,
        groupLabel: "Fast",
        configuration: "gamesettings",
        source: "weightedHash",
      },
    ]);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(backend.requestsTo("GET /sdk/v2/experiments/active")[0]?.query.get("unit-type")).toBe(
      "user"
    );
  });

  it("checks cohort membership once per minute and shares concurrent checks", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/cohorts/membership", (request) => ({
      body: {
        cohortExists: true,
        users: [{ userId: (request.body as { userIds: string[] }).userIds[0], isMember: true }],
      },
    }));
    const { client } = createClient(backend, { distinctId: "alice" });
    const [a, b] = await Promise.all([
      client.cohorts.isMember("whales"),
      client.cohorts.isMember("whales"),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(await client.cohorts.isMember("whales")).toBe(true);
    expect(backend.requestsTo("POST /sdk/v1/cohorts/membership")).toHaveLength(1);
    expect(backend.requestsTo("POST /sdk/v1/cohorts/membership")[0]?.body).toEqual({
      cohortName: "whales",
      userIds: ["alice"],
    });

    client.identify("bob");
    await client.cohorts.isMember("whales");
    expect(backend.requestsTo("POST /sdk/v1/cohorts/membership")).toHaveLength(2);
  });

  it("resolves false when the cohort check fails", async () => {
    const backend = new FakeBackend().on("POST /sdk/v1/cohorts/membership", { status: 429 });
    const { client } = createClient(backend);
    expect(await client.cohorts.isMember("whales")).toBe(false);
  });
});

describe("GamebeastClient options", () => {
  it("throws on missing api key and invalid environment", () => {
    expect(() => new GamebeastClient({ apiKey: "" })).toThrow(/apiKey/);
    expect(
      () => new GamebeastClient({ apiKey: "k", environment: "!!!", fetch: new FakeBackend().fetch })
    ).toThrow(/environment/);
  });
});
