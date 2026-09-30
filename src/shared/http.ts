import { describeError } from "./logger";

/** The `fetch` signature the SDK needs. Injectable for tests and non-standard runtimes. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs: number;
  /** Let the request outlive the page (browser `pagehide` flush). Body must stay under 64 KiB. */
  keepalive?: boolean;
}

/**
 * Raw HTTP outcome. Protocol errors (4xx/5xx) are returned rather than thrown, so callers can react
 * to specific statuses (`304`, `404`, `429`). Network failures and timeouts set `transportError`.
 */
export interface HttpResponse {
  status: number;
  /** Parsed JSON body; `undefined` for empty or non-JSON bodies. */
  body: unknown;
  /** Seconds from a `retry-after` header, when present and numeric. */
  retryAfterSeconds?: number;
  transportError?: string;
}

export function isSuccess(response: HttpResponse): boolean {
  return response.transportError === undefined && response.status >= 200 && response.status < 300;
}

export function isNotModified(response: HttpResponse): boolean {
  return response.transportError === undefined && response.status === 304;
}

/**
 * Whether a failed request is worth retrying: transport errors, timeouts, 408, 429 and 5xx are;
 * any other 4xx is a permanent rejection (bad input, auth, billing) that no retry will fix.
 */
export function isRetryable(response: HttpResponse): boolean {
  if (response.transportError !== undefined) return true;
  if (response.status === 408 || response.status === 429) return true;
  return response.status >= 500;
}

export function describeResponse(response: HttpResponse): string {
  if (response.transportError !== undefined) return `transport error: ${response.transportError}`;
  const code = errorCodeOf(response.body);
  const message = errorMessageOf(response.body);
  const detail = [code, message].filter(Boolean).join(": ");
  return detail ? `HTTP ${response.status} (${detail})` : `HTTP ${response.status}`;
}

export function errorCodeOf(body: unknown): string | undefined {
  if (body && typeof body === "object" && "errorCode" in body) {
    const code = (body as { errorCode: unknown }).errorCode;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorMessageOf(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

function buildUrl(url: string, query: HttpRequest["query"]): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.append(key, value);
  }
  const search = params.toString();
  if (!search) return url;
  return url + (url.includes("?") ? "&" : "?") + search;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, (date - Date.now()) / 1000);
}

/**
 * Thin wrapper around `fetch`: JSON in/out, a hard timeout (a hung request would otherwise pin
 * in-flight de-dupe slots forever), and no throwing — every outcome is an `HttpResponse`.
 */
export async function sendRequest(
  fetchImpl: FetchLike,
  request: HttpRequest
): Promise<HttpResponse> {
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), request.timeoutMs) : undefined;

  const headers: Record<string, string> = { accept: "application/json", ...request.headers };
  const init: RequestInit = { method: request.method, headers };
  if (request.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(request.body);
  }
  if (controller) init.signal = controller.signal;
  if (request.keepalive) init.keepalive = true;

  try {
    const response = await fetchImpl(buildUrl(request.url, request.query), init);
    const text = await response.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    const result: HttpResponse = { status: response.status, body };
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    if (retryAfter !== undefined) result.retryAfterSeconds = retryAfter;
    return result;
  } catch (error) {
    const aborted = controller?.signal.aborted === true;
    return {
      status: 0,
      body: undefined,
      transportError: aborted ? `timed out after ${request.timeoutMs}ms` : describeError(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
