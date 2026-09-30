import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpResponse } from "../src/shared/http";
import { Logger } from "../src/shared/logger";
import { MarkerQueue } from "../src/shared/markerQueue";
import type { MarkerPayload } from "../src/shared/wire";
import { silentLogger } from "./helpers";

function marker(index: number): MarkerPayload {
  return {
    markerId: `m${index}`,
    timestamp: 1_800_000_000_000,
    eventName: "e",
    properties: { index },
  };
}

function setup(
  responses: Array<HttpResponse | Error>,
  overrides: Partial<ConstructorParameters<typeof MarkerQueue>[0]> = {}
) {
  const sent: MarkerPayload[][] = [];
  const keepalive: boolean[] = [];
  const { logger, lines } = silentLogger();
  const queue = new MarkerQueue({
    send: async (markers, options) => {
      sent.push(markers);
      keepalive.push(options.keepalive);
      const next = responses.shift() ?? {
        status: 200,
        body: { ingestedMarkersCount: markers.length, rejectedMarkersCount: 0 },
      };
      if (next instanceof Error) throw next;
      return next;
    },
    logger: new Logger(logger),
    maxBatchSize: 3,
    flushIntervalMs: 1_000,
    maxBufferedMarkers: 10,
    retryBaseDelayMs: 100,
    ...overrides,
  });
  return { queue, sent, keepalive, lines };
}

describe("MarkerQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends immediately when a batch fills", async () => {
    const { queue, sent } = setup([]);
    for (let index = 0; index < 3; index += 1) queue.enqueue(marker(index));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(3);
  });

  it("sends a partial batch after the flush interval", async () => {
    const { queue, sent } = setup([]);
    queue.enqueue(marker(1));
    await vi.advanceTimersByTimeAsync(999);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
  });

  it("retries retryable failures with exponential backoff", async () => {
    const { queue, sent } = setup([
      { status: 503, body: undefined },
      { status: 0, body: undefined, transportError: "offline" },
    ]);
    queue.enqueue(marker(1));
    await queue.flush();
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(3);
    expect(queue.bufferedCount).toBe(0);
  });

  it("honours retry-after when it is longer than the backoff", async () => {
    const { queue, sent } = setup([{ status: 429, body: undefined, retryAfterSeconds: 5 }]);
    queue.enqueue(marker(1));
    await queue.flush();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
  });

  it("drops permanent rejections without retrying", async () => {
    const { queue, sent, lines } = setup([
      { status: 403, body: { errorCode: "SUBSCRIPTION_LIMIT_EXCEEDED", message: "blocked" } },
    ]);
    queue.enqueue(marker(1));
    await queue.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
    expect(queue.bufferedCount).toBe(0);
    expect(
      lines.some(
        (line) => line.level === "error" && line.message.includes("SUBSCRIPTION_LIMIT_EXCEEDED")
      )
    ).toBe(true);
  });

  it("gives up after the maximum attempts", async () => {
    const { queue, sent } = setup(
      Array.from({ length: 10 }, () => ({ status: 500, body: undefined })),
      {
        maxSendAttempts: 3,
      }
    );
    queue.enqueue(marker(1));
    await queue.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(3);
    expect(queue.bufferedCount).toBe(0);
  });

  it("treats a thrown send as a transport error", async () => {
    const { queue, sent } = setup([new Error("boom")]);
    queue.enqueue(marker(1));
    await queue.flush();
    expect(queue.bufferedCount).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(2);
  });

  it("drops the oldest markers when the buffer is full", async () => {
    const { queue } = setup([], { maxBatchSize: 100 });
    for (let index = 0; index < 15; index += 1) queue.enqueue(marker(index));
    const unsent = queue.takeUnsent();
    expect(unsent.map((entry) => entry.markerId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `m${index + 5}`)
    );
  });

  it("flush() sends batches waiting in backoff immediately", async () => {
    const { queue, sent } = setup([{ status: 500, body: undefined }]);
    queue.enqueue(marker(1));
    await queue.flush();
    expect(queue.bufferedCount).toBe(1);
    await queue.flush();
    expect(sent).toHaveLength(2);
    expect(queue.bufferedCount).toBe(0);
  });

  it("shutdown() flushes and then refuses markers", async () => {
    const { queue, sent } = setup([]);
    queue.enqueue(marker(1));
    await queue.shutdown();
    expect(sent).toHaveLength(1);
    queue.enqueue(marker(2));
    await queue.flush();
    expect(sent).toHaveLength(1);
  });

  it("uses keepalive only within the 60 KiB in-flight budget", async () => {
    const big = (id: string) => ({
      ...marker(1),
      markerId: id,
      properties: { blob: "x".repeat(25_000) },
    });
    const { queue, keepalive } = setup([], { keepalive: true, maxBatchSize: 1 });
    // Batch size 1: each enqueue dispatches immediately, so all three are in flight together.
    queue.enqueue(big("a"));
    queue.enqueue(big("b"));
    queue.enqueue(big("c"));
    await vi.advanceTimersByTimeAsync(0);
    expect(keepalive).toEqual([true, true, false]);
  });

  it("drainForUnload keeps batches over the keepalive budget for the caller to persist", () => {
    const big = (id: string) => ({
      ...marker(1),
      markerId: id,
      properties: { blob: "x".repeat(25_000) },
    });
    const { queue, sent } = setup([], {
      keepalive: true,
      maxBatchSize: 5,
      flushIntervalMs: 60_000,
    });
    queue.enqueue(big("a"));
    queue.enqueue(big("b"));
    queue.enqueue(big("c"));
    // One ~75 KiB batch exceeds the 60 KiB budget, so it is returned rather than sent.
    const leftover = queue.drainForUnload(true);
    expect(sent).toHaveLength(0);
    expect(leftover.map((entry) => entry.markerId)).toEqual(["a", "b", "c"]);
    expect(queue.bufferedCount).toBe(0);
  });

  it("drainForUnload returns everything when offline", () => {
    const { queue, sent } = setup([], { keepalive: true });
    queue.enqueue(marker(1));
    queue.enqueue(marker(2));
    expect(queue.drainForUnload(false).map((entry) => entry.markerId)).toEqual(["m1", "m2"]);
    expect(sent).toHaveLength(0);
    expect(queue.bufferedCount).toBe(0);
  });
});
