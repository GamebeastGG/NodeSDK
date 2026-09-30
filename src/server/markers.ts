import type { ApiClient } from "../shared/api";
import { normalizeDistinctId } from "../shared/ids";
import type { Logger } from "../shared/logger";
import type { MarkerFields, MarkerProperties } from "../shared/markers";
import { buildMarker } from "../shared/markers";
import { MarkerQueue } from "../shared/markerQueue";

export interface MarkerQueueSettings {
  /** Markers per request. Default 100. */
  maxBatchSize?: number;
  /** Longest a marker waits before its batch is sent, in milliseconds. Default 5000. */
  flushIntervalMs?: number;
  /** Bound on buffered markers during an outage; the oldest are dropped first. Default 10000. */
  maxBufferedMarkers?: number;
}

export interface ServerMarkerOptions extends MarkerFields {
  /**
   * The user the marker is about. Omit for a server-level marker (one not tied to a user).
   */
  distinctId?: string;
}

export interface ServerMarkers {
  /**
   * Record a marker. Batched and sent in the background; call `flush()` (or the SDK's
   * `shutdown()`) before the process exits so nothing buffered is lost.
   *
   * @param eventName Event name, e.g. `"purchase_completed"`.
   * @param properties Optional JSON-serializable object.
   * @param options The user, session and timestamp to attribute the marker to.
   */
  send(eventName: string, properties?: MarkerProperties, options?: ServerMarkerOptions): void;

  /** Send everything buffered now. Resolves once the requests have settled. */
  flush(): Promise<void>;
}

export class ServerMarkersService implements ServerMarkers {
  private readonly queue: MarkerQueue;

  constructor(
    api: ApiClient,
    private readonly logger: Logger,
    settings: MarkerQueueSettings = {}
  ) {
    this.queue = new MarkerQueue({
      send: (markers) => api.postMarkers(markers),
      logger,
      maxBatchSize: positive(settings.maxBatchSize, 100),
      flushIntervalMs: positive(settings.flushIntervalMs, 5_000),
      maxBufferedMarkers: positive(settings.maxBufferedMarkers, 10_000),
    });
  }

  send(eventName: string, properties?: MarkerProperties, options: ServerMarkerOptions = {}): void {
    const fields: MarkerFields = {};
    if (options.distinctId !== undefined) {
      const id = normalizeDistinctId(options.distinctId);
      if (id === undefined) {
        this.logger.error(
          `Marker '${String(eventName)}' has an invalid distinctId; marker dropped.`
        );
        return;
      }
      fields.distinctId = id;
    }
    if (options.sessionId !== undefined) fields.sessionId = String(options.sessionId);
    if (options.timestamp !== undefined) fields.timestamp = options.timestamp;

    const marker = buildMarker(eventName, properties, fields, this.logger);
    if (marker) this.queue.enqueue(marker);
  }

  flush(): Promise<void> {
    return this.queue.flush();
  }

  shutdown(): Promise<void> {
    return this.queue.shutdown();
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
