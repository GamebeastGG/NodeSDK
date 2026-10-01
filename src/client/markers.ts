import type { ApiClient } from "../shared/api";
import type { Logger } from "../shared/logger";
import type { MarkerProperties } from "../shared/markers";
import { buildMarker } from "../shared/markers";
import { MarkerQueue } from "../shared/markerQueue";
import type { MarkerPayload } from "../shared/wire";
import type { SafeStorage } from "./storage";

const MAX_BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BUFFERED_MARKERS = 500;

/** Markers sent from the browser. */
export interface ClientMarkers {
  /**
   * Record a marker (analytics event) for the current user and session. Markers are batched and
   * sent automatically: every few seconds, when a batch fills, and when the page is hidden.
   *
   * @param eventName Event name, e.g. `"level_completed"`.
   * @param properties Optional JSON-serializable object, e.g. `{ level: 3 }`.
   */
  send(eventName: string, properties?: MarkerProperties): void;

  /** Send everything buffered now. Resolves once the requests have settled. */
  flush(): Promise<void>;
}

function isMarkerPayload(value: unknown): value is MarkerPayload {
  if (typeof value !== "object" || value === null) return false;
  const marker = value as Partial<MarkerPayload>;
  return (
    typeof marker.markerId === "string" &&
    typeof marker.eventName === "string" &&
    typeof marker.timestamp === "number" &&
    typeof marker.properties === "object" &&
    marker.properties !== null
  );
}

export interface ClientMarkersDeps {
  api: ApiClient;
  logger: Logger;
  storage: SafeStorage;
  storageKey: string;
  /** The user and session to attribute a new marker to. */
  stamp: () => { distinctId: string; sessionId: string };
  /** Server-side rendering: accept and ignore markers. */
  inert: boolean;
}

/**
 * Browser marker delivery. In flight requests use `keepalive`, so they complete even if the page
 * unloads; markers that cannot be sent when the page is hidden (offline, or over the keepalive
 * budget) move to `localStorage` and are sent on the next page load or when the tab returns.
 *
 * The backend does not deduplicate markers, so a marker lives in exactly one place at a time:
 * memory, a request, or storage. Storage is claimed (read and cleared) before it is re-sent.
 */
export class ClientMarkersService implements ClientMarkers {
  private readonly queue: MarkerQueue;

  constructor(private readonly deps: ClientMarkersDeps) {
    this.queue = new MarkerQueue({
      send: (markers, options) => deps.api.postMarkers(markers, options),
      logger: deps.logger,
      maxBatchSize: MAX_BATCH_SIZE,
      flushIntervalMs: FLUSH_INTERVAL_MS,
      maxBufferedMarkers: MAX_BUFFERED_MARKERS,
      keepalive: true,
    });
  }

  send(eventName: string, properties?: MarkerProperties): void {
    if (this.deps.inert) {
      this.deps.logger.debug(
        `Marker '${eventName}' ignored: markers are only sent from the browser.`
      );
      return;
    }
    const marker = buildMarker(eventName, properties, this.deps.stamp(), this.deps.logger);
    if (marker) this.queue.enqueue(marker);
  }

  flush(): Promise<void> {
    return this.queue.flush();
  }

  /** Send markers a previous page (or this tab, while hidden) could not deliver. */
  restorePersisted(): void {
    const stored = this.deps.storage.getJson<unknown>(this.deps.storageKey);
    if (stored === undefined) return;
    this.deps.storage.remove(this.deps.storageKey);
    const markers = Array.isArray(stored) ? stored.filter(isMarkerPayload) : [];
    if (markers.length === 0) return;
    this.deps.logger.debug(`Restored ${markers.length} marker(s) saved by an earlier page.`);
    this.queue.restore(markers);
  }

  /** The page is being hidden or unloaded. */
  onPageHidden(online: boolean): void {
    const leftover = this.queue.drainForUnload(online);
    if (leftover.length === 0) return;

    const existing = this.deps.storage.getJson<unknown>(this.deps.storageKey);
    const merged = [
      ...(Array.isArray(existing) ? existing.filter(isMarkerPayload) : []),
      ...leftover,
    ];
    const kept = merged.slice(-MAX_BUFFERED_MARKERS);
    if (kept.length < merged.length) {
      this.deps.logger.error(
        `Marker storage full; dropped the ${merged.length - kept.length} oldest marker(s).`
      );
    }
    if (!this.deps.storage.setJson(this.deps.storageKey, kept)) {
      this.deps.logger.error(`Could not save ${leftover.length} unsent marker(s); they are lost.`);
    }
  }

  shutdown(): Promise<void> {
    return this.queue.shutdown();
  }
}
