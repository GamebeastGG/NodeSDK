import type { HttpResponse } from "./http";
import { describeResponse, errorCodeOf, isRetryable, isSuccess } from "./http";
import type { Logger } from "./logger";
import { describeError } from "./logger";
import type { TimerHandle } from "./timers";
import { startTimeout, stopTimer } from "./timers";
import type { IngestMarkersResponse, MarkerPayload } from "./wire";

/**
 * Browsers cap the combined body size of in-flight `keepalive` requests at 64 KiB; a request over
 * the remaining budget is rejected outright. Stay a little under it.
 */
const KEEPALIVE_BUDGET_BYTES = 60 * 1024;

export interface MarkerQueueOptions {
  send(markers: MarkerPayload[], options: { keepalive: boolean }): Promise<HttpResponse>;
  logger: Logger;
  /** Markers per request. Reaching it triggers an immediate flush. */
  maxBatchSize: number;
  /** How long a marker may wait in the buffer before the batch is sent anyway. */
  flushIntervalMs: number;
  /** Bound on everything buffered (waiting + awaiting retry). The oldest markers are dropped first. */
  maxBufferedMarkers: number;
  /** Total attempts per batch, including the first. */
  maxSendAttempts?: number;
  /** First retry delay; doubles per attempt. */
  retryBaseDelayMs?: number;
  /**
   * Send with `fetch` `keepalive` (browser), so a request in flight when the page unloads is
   * still delivered.
   */
  keepalive?: boolean;
}

interface RetryBatch {
  markers: MarkerPayload[];
  nextAttempt: number;
  timer: TimerHandle | undefined;
  /** Set after a transport failure with `keepalive`, in case the runtime rejects it outright. */
  disableKeepalive: boolean;
}

function utf8Length(text: string): number {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
  return text.length * 3;
}

function rejectionReason(entry: unknown): string {
  return typeof entry === "object" && entry !== null && "reason" in entry
    ? String(entry.reason)
    : "unknown";
}

/**
 * Buffers markers and posts them to `/sdk/v1/markers` in batches.
 *
 * Delivery rules (shared by the browser and server SDKs):
 *
 * - A batch is sent when it reaches `maxBatchSize`, when its oldest marker has waited
 *   `flushIntervalMs`, or on an explicit `flush()`.
 * - Transport errors, timeouts, 408, 429 and 5xx retry with exponential backoff (honouring
 *   `retry-after`), up to `maxSendAttempts`.
 * - Any other 4xx (invalid markers, a blocked subscription, a bad key) is permanent: the batch is
 *   dropped and logged, since resending cannot succeed.
 *
 * The backend does not deduplicate markers by id, so the queue never sends the same marker twice
 * on purpose: a marker is either in memory, in flight, or handed off via `takeUnsent()`.
 */
export class MarkerQueue {
  private pending: MarkerPayload[] = [];
  private retries: RetryBatch[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private flushTimer: TimerHandle | undefined;
  private keepaliveBytesInFlight = 0;
  private stopped = false;

  private readonly maxSendAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(private readonly options: MarkerQueueOptions) {
    this.maxSendAttempts = Math.max(1, options.maxSendAttempts ?? 5);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 2_000;
  }

  /** Markers waiting to be sent or awaiting a retry (not those currently in flight). */
  get bufferedCount(): number {
    return this.pending.length + this.retries.reduce((sum, batch) => sum + batch.markers.length, 0);
  }

  enqueue(marker: MarkerPayload): void {
    if (this.stopped) {
      this.options.logger.warn(`Marker '${marker.eventName}' dropped: the SDK has been shut down.`);
      return;
    }
    this.pending.push(marker);
    this.enforceBufferCap();

    if (this.pending.length >= this.options.maxBatchSize) {
      this.flushPending();
    } else if (this.flushTimer === undefined) {
      this.flushTimer = startTimeout(() => {
        this.flushTimer = undefined;
        this.flushPending();
      }, this.options.flushIntervalMs);
    }
  }

  /** Send markers recovered from storage right away. */
  restore(markers: MarkerPayload[]): void {
    if (markers.length === 0 || this.stopped) return;
    for (let start = 0; start < markers.length; start += this.options.maxBatchSize) {
      this.dispatch(markers.slice(start, start + this.options.maxBatchSize), 1, false);
    }
  }

  /**
   * Send everything buffered now — waiting markers and batches in retry backoff — and resolve
   * once every request (including ones already in flight) has settled. Failures that are still
   * retryable stay queued.
   */
  async flush(): Promise<void> {
    this.flushPending();
    this.sendRetriesNow();
    await this.settle();
  }

  /**
   * Remove and return everything not yet handed to the network, so the caller can persist it.
   * Cancels pending timers. The queue no longer owns these markers.
   */
  takeUnsent(): MarkerPayload[] {
    stopTimer(this.flushTimer);
    this.flushTimer = undefined;
    const unsent: MarkerPayload[] = [];
    for (const batch of this.retries) {
      stopTimer(batch.timer);
      unsent.push(...batch.markers);
    }
    unsent.push(...this.pending);
    this.retries = [];
    this.pending = [];
    return unsent;
  }

  /**
   * The page may be about to unload: send whatever fits in the `keepalive` budget (those requests
   * outlive the page) and return the rest for the caller to persist. When `online` is false nothing
   * is sent, since the requests would only fail.
   */
  drainForUnload(online: boolean): MarkerPayload[] {
    const unsent = this.takeUnsent();
    if (!online || !this.options.keepalive) return unsent;

    const leftover: MarkerPayload[] = [];
    for (let start = 0; start < unsent.length; start += this.options.maxBatchSize) {
      const batch = unsent.slice(start, start + this.options.maxBatchSize);
      const bytes = utf8Length(JSON.stringify({ markers: batch }));
      if (this.keepaliveBytesInFlight + bytes <= KEEPALIVE_BUDGET_BYTES) {
        // `sendBatch` reserves its keepalive bytes synchronously, before its first await.
        this.dispatch(batch, 1, false);
      } else {
        leftover.push(...batch);
      }
    }
    return leftover;
  }

  /** Flush, then refuse further markers. Anything still undeliverable is dropped and logged. */
  async shutdown(): Promise<void> {
    await this.flush();
    this.stopped = true;
    const undelivered = this.takeUnsent();
    if (undelivered.length > 0) {
      this.options.logger.error(
        `Dropped ${undelivered.length} marker(s) that could not be delivered before shutdown.`
      );
    }
  }

  private async settle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private flushPending(): void {
    stopTimer(this.flushTimer);
    this.flushTimer = undefined;
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.options.maxBatchSize);
      this.dispatch(batch, 1, false);
    }
  }

  private sendRetriesNow(): void {
    const batches = this.retries;
    this.retries = [];
    for (const batch of batches) {
      stopTimer(batch.timer);
      this.dispatch(batch.markers, batch.nextAttempt, batch.disableKeepalive);
    }
  }

  private dispatch(markers: MarkerPayload[], attempt: number, disableKeepalive: boolean): void {
    const promise = this.sendBatch(markers, attempt, disableKeepalive).finally(() => {
      this.inFlight.delete(promise);
    });
    this.inFlight.add(promise);
  }

  private async sendBatch(
    markers: MarkerPayload[],
    attempt: number,
    disableKeepalive: boolean
  ): Promise<void> {
    let keepaliveBytes = 0;
    if (this.options.keepalive && !disableKeepalive) {
      const bytes = utf8Length(JSON.stringify({ markers }));
      if (this.keepaliveBytesInFlight + bytes <= KEEPALIVE_BUDGET_BYTES) keepaliveBytes = bytes;
    }
    this.keepaliveBytesInFlight += keepaliveBytes;

    let response: HttpResponse;
    try {
      response = await this.options.send(markers, { keepalive: keepaliveBytes > 0 });
    } catch (error) {
      response = { status: 0, body: undefined, transportError: describeError(error) };
    } finally {
      this.keepaliveBytesInFlight -= keepaliveBytes;
    }

    const logger = this.options.logger;

    if (isSuccess(response)) {
      logger.debug(`Sent ${markers.length} marker(s).`);
      this.reportRejections(response.body);
      return;
    }

    if (!isRetryable(response)) {
      logger.error(`Dropped ${markers.length} marker(s): ${describeResponse(response)}.`);
      this.reportRejections(response.body);
      return;
    }

    if (attempt >= this.maxSendAttempts || this.stopped) {
      logger.error(
        `Dropped ${markers.length} marker(s) after ${attempt} attempt(s): ${describeResponse(response)}.`
      );
      return;
    }

    const backoffMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
    const delayMs = Math.max(backoffMs, (response.retryAfterSeconds ?? 0) * 1000);
    logger.warn(
      `Failed to send ${markers.length} marker(s) (${describeResponse(response)}); retrying in ` +
        `${Math.round(delayMs / 1000)}s (attempt ${attempt} of ${this.maxSendAttempts}).`
    );

    const batch: RetryBatch = {
      markers,
      nextAttempt: attempt + 1,
      timer: undefined,
      disableKeepalive:
        disableKeepalive || (keepaliveBytes > 0 && response.transportError !== undefined),
    };
    batch.timer = startTimeout(() => {
      const index = this.retries.indexOf(batch);
      if (index === -1) return;
      this.retries.splice(index, 1);
      this.dispatch(batch.markers, batch.nextAttempt, batch.disableKeepalive);
    }, delayMs);
    this.retries.push(batch);
    this.enforceBufferCap();
  }

  private reportRejections(body: unknown): void {
    if (typeof body !== "object" || body === null) return;
    const response = body as Record<keyof IngestMarkersResponse, unknown>;
    const rejected =
      typeof response.rejectedMarkersCount === "number" ? response.rejectedMarkersCount : 0;
    if (rejected > 0) {
      const reasons = Array.isArray(response.rejectedMarkers)
        ? [...new Set(response.rejectedMarkers.map(rejectionReason))].slice(0, 3)
        : [];
      const code = errorCodeOf(body);
      this.options.logger.warn(
        `The backend rejected ${rejected} marker(s)` +
          (code ? ` (${code})` : "") +
          (reasons.length > 0 ? `: ${reasons.join("; ")}` : ".")
      );
    }
    if (typeof response.staleMarkersCount === "number" && response.staleMarkersCount > 0) {
      this.options.logger.warn(
        `The backend discarded ${response.staleMarkersCount} marker(s) as too old to ingest.`
      );
    }
  }

  /** Keep memory bounded during long outages: drop the oldest markers first. */
  private enforceBufferCap(): void {
    let excess = this.bufferedCount - this.options.maxBufferedMarkers;
    if (excess <= 0) return;
    const dropped = excess;

    while (excess > 0 && this.retries.length > 0) {
      const oldest = this.retries[0] as RetryBatch;
      if (oldest.markers.length <= excess) {
        stopTimer(oldest.timer);
        this.retries.shift();
        excess -= oldest.markers.length;
      } else {
        oldest.markers = oldest.markers.slice(excess);
        excess = 0;
      }
    }
    if (excess > 0) this.pending.splice(0, excess);

    this.options.logger.error(`Marker buffer full; dropped the ${dropped} oldest marker(s).`);
  }
}
