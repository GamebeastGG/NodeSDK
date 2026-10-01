import type { FetchLike } from "../src/shared/http";

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  keepalive: boolean;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

/**
 * A scriptable stand-in for the Gamebeast API. Routes are `"METHOD /path"`; unrouted requests
 * answer 404 so a test never silently depends on one it did not declare.
 */
export class FakeBackend {
  readonly requests: RecordedRequest[] = [];
  private readonly routes = new Map<string, Handler>();

  on(route: string, handler: Handler | FakeResponse): this {
    this.routes.set(route, typeof handler === "function" ? handler : () => handler);
    return this;
  }

  requestsTo(route: string): RecordedRequest[] {
    const [method, path] = route.split(" ");
    return this.requests.filter((request) => request.method === method && request.path === path);
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      keepalive: init?.keepalive === true,
    };
    this.requests.push(request);

    const handler = this.routes.get(`${request.method} ${request.path}`);
    const response = handler
      ? await handler(request)
      : { status: 404, body: { errorCode: "NOT_ROUTED" } };
    const status = response.status ?? 200;
    const body =
      status === 304 || response.body === undefined ? null : JSON.stringify(response.body);
    return new Response(body, { status, headers: response.headers ?? {} });
  };
}

/** Let pending promise callbacks (and chained ones) run. */
export async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

export function silentLogger() {
  const lines: Array<{ level: string; message: string }> = [];
  return {
    lines,
    logger: {
      debug: (message: string) => lines.push({ level: "debug", message }),
      warn: (message: string) => lines.push({ level: "warn", message }),
      error: (message: string) => lines.push({ level: "error", message }),
    },
  };
}

export function configurationResponse(
  configuration: unknown,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    hash: "hash-1",
    configurationId: 1,
    name: "Game Settings",
    configuration,
    privacy: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    experiments: [],
    requiredProperties: [],
    ...overrides,
  };
}

/** A 200 reply carrying an evaluated configuration. */
export function evaluated(
  configuration: unknown,
  overrides: Record<string, unknown> = {}
): FakeResponse {
  return { body: configurationResponse(configuration, overrides) };
}
