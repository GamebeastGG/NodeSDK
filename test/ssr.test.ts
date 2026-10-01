import { afterEach, describe, expect, it, vi } from "vitest";
import { GamebeastClient } from "../src/client";
import { FakeBackend, evaluated, silentLogger } from "./helpers";

// Runs in the plain Node environment: no window, no document, no localStorage — as when a
// framework renders a page on the server.
describe("GamebeastClient during server-side rendering", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function create() {
    const backend = new FakeBackend()
      .on("POST /sdk/v2/configurations/evaluate", evaluated({ speed: 1 }))
      .on("POST /sdk/v1/markers", { body: {} })
      .on("POST /sdk/v1/cohorts/membership", { body: { cohortExists: true, users: [] } });
    const { logger } = silentLogger();
    const client = new GamebeastClient({
      apiKey: "gb_pk_test",
      fetch: backend.fetch,
      logger,
      apiUrl: "https://api.test",
      configurations: ["GameSettings"],
    });
    return { client, backend };
  }

  it("constructs without touching browser APIs and stays inert", async () => {
    const { client, backend } = create();
    expect(client.distinctId).toMatch(/^[0-9a-f-]{36}$/);
    expect(client.configs.get("GameSettings.speed", 5)).toBe(5);
    expect(await client.configs.ready({ timeoutMs: 50 })).toBe(false);
    client.markers.send("render");
    expect(await client.cohorts.isMember("whales")).toBe(false);
    await client.flush();
    await client.shutdown();
    expect(backend.requests).toHaveLength(0);
  });

  it("treats a browser worker (importScripts defined) as a real client", async () => {
    vi.stubGlobal("importScripts", () => undefined);
    const { client, backend } = create();
    expect(await client.configs.ready({ timeoutMs: 1_000 })).toBe(true);
    expect(client.configs.get("GameSettings.speed")).toBe(1);
    await client.shutdown();
    expect(backend.requestsTo("POST /sdk/v2/configurations/evaluate")).toHaveLength(1);
  });
});
