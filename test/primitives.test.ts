import { describe, expect, it } from "vitest";
import { Latch } from "../src/shared/latch";
import { Logger } from "../src/shared/logger";
import { LruCache } from "../src/shared/lruCache";
import { SingleFlight } from "../src/shared/singleFlight";
import { silentLogger } from "./helpers";

describe("Latch", () => {
  const create = () => new Latch(new Logger(silentLogger().logger), "test");

  it("resolves waiters and onReady callbacks once ready", async () => {
    const latch = create();
    const calls: string[] = [];
    latch.onReady(() => calls.push("before"));
    const waiting = latch.wait();
    latch.settle(true);
    latch.settle(true);
    expect(await waiting).toBe(true);
    latch.onReady(() => calls.push("after"));
    expect(calls).toEqual(["before", "after"]);
    expect(await latch.wait()).toBe(true);
  });

  it("resolves false on timeout and on settle(false), but can still become ready", async () => {
    const latch = create();
    expect(await latch.wait(5)).toBe(false);
    const waiting = latch.wait();
    latch.settle(false);
    expect(await waiting).toBe(false);
    expect(await latch.wait()).toBe(false);
    latch.settle(true);
    expect(latch.isReady).toBe(true);
    latch.settle(false);
    expect(await latch.wait()).toBe(true);
  });

  it("drops onReady callbacks when it settles false", () => {
    const latch = create();
    let called = false;
    latch.onReady(() => (called = true));
    latch.settle(false);
    latch.settle(true);
    expect(called).toBe(false);
  });
});

describe("LruCache", () => {
  it("evicts the least recently written entry", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 3);
    cache.set("c", 4);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(3);
    expect(cache.get("c")).toBe(4);
  });

  it("stores nothing with a capacity of 0", () => {
    const cache = new LruCache<string, number>(0);
    cache.set("a", 1);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("SingleFlight", () => {
  it("shares one in-flight task per key and forgets it once settled", async () => {
    const flight = new SingleFlight<string, number>();
    let runs = 0;
    const task = async () => ++runs;
    const [first, second] = await Promise.all([flight.run("k", task), flight.run("k", task)]);
    expect([first, second]).toEqual([1, 1]);
    expect(await flight.run("other", task)).toBe(2);
    expect(await flight.run("k", task)).toBe(3);
  });
});
