import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeProperties } from "../src/shared/context";
import { normalizeEnvironment, toLegacyEnvironment } from "../src/shared/environment";
import { deepEqual, parseConfigPath, resolvePath } from "../src/shared/json";
import { Logger } from "../src/shared/logger";
import { buildMarker } from "../src/shared/markers";
import { uuidv4 } from "../src/shared/uuid";
import { SDK_VERSION } from "../src/shared/version";
import { silentLogger } from "./helpers";

describe("parseConfigPath", () => {
  it("splits the alias from the document path and normalizes the alias like the backend", () => {
    expect(parseConfigPath("Game Settings.Player.Speed")).toEqual({
      alias: "Game Settings",
      key: "game-settings",
      segments: ["Player", "Speed"],
    });
    expect(parseConfigPath(["GameSettings", "key.with.dots"])?.segments).toEqual(["key.with.dots"]);
    expect(parseConfigPath("GameSettings")?.segments).toEqual([]);
  });

  it("rejects unusable paths", () => {
    expect(parseConfigPath("")).toBeUndefined();
    expect(parseConfigPath(".Speed")).toBeUndefined();
    expect(parseConfigPath("!!!.Speed")).toBeUndefined();
    expect(parseConfigPath([])).toBeUndefined();
    expect(parseConfigPath(42 as unknown as string)).toBeUndefined();
    expect(parseConfigPath(["a", 1 as unknown as string])).toBeUndefined();
  });
});

describe("resolvePath", () => {
  const document = { a: { b: [10, { c: "deep" }] }, n: null };

  it("walks objects and array indices", () => {
    expect(resolvePath(document, ["a", "b", "0"])).toBe(10);
    expect(resolvePath(document, ["a", "b", "1", "c"])).toBe("deep");
    expect(resolvePath(document, [])).toBe(document);
    expect(resolvePath(document, ["n"])).toBeNull();
  });

  it("returns undefined for missing paths and never reaches prototypes", () => {
    expect(resolvePath(document, ["a", "missing"])).toBeUndefined();
    expect(resolvePath(document, ["a", "b", "7"])).toBeUndefined();
    expect(resolvePath(document, ["a", "b", "-1"])).toBeUndefined();
    expect(resolvePath(document, ["a", "b", "length"])).toBeUndefined();
    expect(resolvePath(document, ["constructor"])).toBeUndefined();
    expect(resolvePath(document, ["__proto__"])).toBeUndefined();
  });
});

describe("deepEqual", () => {
  it("compares JSON structurally", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, [])).toBe(false);
  });
});

describe("environments", () => {
  it("normalizes aliases like the backend, including the studio synonym", () => {
    expect(normalizeEnvironment("Production")).toBe("production");
    expect(normalizeEnvironment("studio")).toBe("development");
    expect(normalizeEnvironment("My Staging")).toBe("my-staging");
    expect(normalizeEnvironment("!!")).toBeUndefined();
  });

  it("maps to the v1 isstudio flag", () => {
    expect(toLegacyEnvironment("production")).toEqual({ supported: true, isStudio: false });
    expect(toLegacyEnvironment("development")).toEqual({ supported: true, isStudio: true });
    expect(toLegacyEnvironment("staging").supported).toBe(false);
  });
});

describe("sanitizeProperties", () => {
  it("keeps valid values, converts dates, and drops what the backend would reject", () => {
    const { logger, lines } = silentLogger();
    const result = sanitizeProperties(
      {
        plan: "pro",
        age: 12,
        vip: false,
        none: null,
        tags: ["a", "b"],
        joined: new Date(1_700_000_000_000),
        skipped: undefined,
        mixed: ["a", 1] as unknown as string[],
        nested: { a: 1 } as unknown as string,
        infinite: Number.POSITIVE_INFINITY,
        ["x".repeat(129)]: 1,
      },
      new Logger(logger)
    );
    expect(result).toEqual({
      plan: "pro",
      age: 12,
      vip: false,
      none: null,
      tags: ["a", "b"],
      joined: 1_700_000_000_000,
    });
    expect(lines.filter((line) => line.level === "warn")).toHaveLength(4);
  });

  it("caps the property count at 100", () => {
    const input = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [`p${index}`, index])
    );
    expect(Object.keys(sanitizeProperties(input, new Logger(silentLogger().logger)))).toHaveLength(
      100
    );
  });
});

describe("buildMarker", () => {
  const logger = () => new Logger(silentLogger().logger);

  it("builds the none/unity wire shape with a dashed uuid and ms timestamp", () => {
    const marker = buildMarker(
      "level_completed",
      { level: 3 },
      { distinctId: "u1", sessionId: "s1" },
      logger()
    );
    expect(marker).toMatchObject({
      eventName: "level_completed",
      distinctId: "u1",
      sessionId: "s1",
      properties: { level: 3 },
    });
    expect(marker?.markerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(marker!.timestamp).toBeGreaterThan(1e12);
  });

  it("snapshots properties so later mutation does not leak in", () => {
    const properties = { items: ["a"] };
    const marker = buildMarker("e", properties, {}, logger());
    properties.items.push("b");
    expect(marker?.properties).toEqual({ items: ["a"] });
  });

  it("drops invalid markers instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(buildMarker("", {}, {}, logger())).toBeUndefined();
    expect(buildMarker("e", 5, {}, logger())).toBeUndefined();
    expect(buildMarker("e", [1], {}, logger())).toBeUndefined();
    expect(buildMarker("e", cyclic, {}, logger())).toBeUndefined();
    expect(buildMarker("e", {}, { timestamp: Number.NaN }, logger())).toBeUndefined();
  });
});

describe("uuidv4", () => {
  it("falls back to getRandomValues when randomUUID is unavailable (insecure contexts)", () => {
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    try {
      expect(uuidv4()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        value: original,
        configurable: true,
      });
    }
  });
});

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
