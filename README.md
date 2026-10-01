# @gamebeast/sdk

The Gamebeast SDK for JavaScript and TypeScript: a **browser client** for web apps and a
**server SDK** for Node.js and other server runtimes. One package with two entry points:

| Import                  | For                                    | API key    |
| ----------------------- | -------------------------------------- | ---------- |
| `@gamebeast/sdk/client` | Browsers, web apps, web workers        | **Public** |
| `@gamebeast/sdk/server` | Node.js ≥ 20, Bun, Deno, edge, lambdas | **Secret** |

Anything in a browser bundle is visible to your users, so never put a secret key in client code.

Both entry points ship ESM and CommonJS builds with type declarations, have no runtime
dependencies, and use the platform `fetch`.

```sh
npm install @gamebeast/sdk
```

## Browser client

```ts
import { GamebeastClient } from "@gamebeast/sdk/client";

export const gamebeast = new GamebeastClient({
  apiKey: "YOUR_PUBLIC_KEY",
  configurations: ["GameSettings"], // loaded right away; they gate configs.ready()
  appVersion: "2.1.0",
});

await gamebeast.configs.ready({ timeoutMs: 3_000 }); // resolves false on timeout, never rejects
const speed = gamebeast.configs.get("GameSettings.PlayerSpeed", 16);

gamebeast.markers.send("level_completed", { level: 3 });
```

Create one instance per page (a module-level singleton works well).

### Identity and sessions

On first visit the client generates an anonymous id and keeps it in `localStorage`, so the same
browser reports as the same user across visits. When the user signs in:

```ts
gamebeast.identify(user.id); // configurations are re-evaluated for this user
gamebeast.resetIdentity(); // on sign-out: back to this browser's anonymous id
```

`identify` is not persisted. Call it again on each page load, or pass `distinctId` in the options.
Sessions are shared across tabs and roll over after `sessionTimeoutMinutes` of inactivity
(default 30).

### Configurations

Configuration values are evaluated **for the current user**. Any experiment the user is enrolled
in is already merged in, so `get` returns what this user should see.

```ts
gamebeast.configs.get("GameSettings.UI.ButtonColor", "blue"); // fallback on missing / wrong type
gamebeast.configs.get(["GameSettings", "key.with.dots"]); // array form for keys containing dots

const stop = gamebeast.configs.observe("GameSettings.PlayerSpeed", (value) => render(value));
gamebeast.configs.onChanged("GameSettings.PlayerSpeed", (value) => toast(`Speed is now ${value}`));
gamebeast.configs.onReady(() => startGame());
await gamebeast.configs.refresh();
```

- The first segment of a path is the configuration alias. A configuration that is not listed in
  `configurations` starts loading the first time you read it; use `observe` to wait for it.
- Values are cached per user and app version. On the next page load they are served immediately
  (so `isReady` can already be `true`), then refreshed in the background.
- While the page is visible, configurations are re-checked every `configRefreshIntervalSeconds`
  (default 60). Change detection is hash-based, so an unchanged configuration costs one small
  `304` round trip. They are also re-checked when the tab becomes visible again.
- `setProperties({ plan: "pro" })` sets targeting properties and re-evaluates. The SDK always adds
  `platform: "web"`, `systemLanguage` and `appVersion`.

### Experiments

Enrollment happens on the backend during evaluation. The client reports what the user is in:

```ts
gamebeast.experiments.assignments;
// [{ experimentId, experimentName, groupId, groupLabel, configuration, source }]
gamebeast.experiments.onAssignmentsChanged((assignments) => analytics.setTraits({ assignments }));
```

### Cohorts

```ts
if (await gamebeast.cohorts.isMember("whales")) showVipOffer();
```

Results are cached for a minute, and concurrent checks share one request. Failures resolve
`false`.

### Markers

Markers are batched (10 per request, or every 10 seconds). When the page is hidden or closed,
buffered markers go out with `fetch` `keepalive` so they survive the unload. If the browser is
offline, they are saved to `localStorage` and sent on the next visit. Failed sends retry with
exponential backoff.

### Server-side rendering

Constructing a `GamebeastClient` during SSR (Next.js, Remix, Nuxt, ...) is safe. With no page
there is no user, so the instance stays inert: reads return their fallbacks, `ready()` resolves
`false`, and markers are dropped. Use `@gamebeast/sdk/server` for server-side evaluation.

### Client options

| Option                         | Default          | Description                                                        |
| ------------------------------ | ---------------- | ------------------------------------------------------------------ |
| `apiKey`                       | —                | Public API key. Required.                                          |
| `environment`                  | `"production"`   | Environment alias, e.g. `"development"` or a custom `"staging"`.   |
| `configurations`               | `[]`             | Aliases to load immediately; they gate readiness.                  |
| `distinctId`                   | anonymous id     | The signed-in user's id.                                           |
| `properties`                   | `{}`             | Targeting properties.                                              |
| `appVersion`                   | —                | Sent as the `appVersion` property; scopes the configuration cache. |
| `configRefreshIntervalSeconds` | `60`             | Background re-check interval. `0` disables it.                     |
| `sessionTimeoutMinutes`        | `30`             | Inactivity before a new session. `0` never rolls over.             |
| `storage`                      | `localStorage`   | A `KeyValueStorage`, or `null` to persist nothing.                 |
| `projectId`                    | —                | For keys that can access several projects.                         |
| `requestTimeoutMs`             | `10000`          | Per-request timeout.                                               |
| `fetch`, `logger`, `debug`     | global / console | Transport and logging hooks.                                       |

## Server SDK

```ts
import { GamebeastServer } from "@gamebeast/sdk/server";

const gamebeast = new GamebeastServer({ apiKey: process.env.GAMEBEAST_SECRET_KEY! });
await gamebeast.configs.ready();

// Per-user values, with the user's experiment groups applied:
const config = await gamebeast.configs.evaluate({
  distinctId: user.id,
  configuration: "GameSettings", // omit for the primary configuration
  properties: { plan: user.plan },
});
const speed = config.get("PlayerSpeed", 16);

gamebeast.markers.send("purchase_completed", { sku: "gems_100" }, { distinctId: user.id });

process.on("SIGTERM", async () => {
  await gamebeast.shutdown(); // flushes buffered markers
  process.exit(0);
});
```

Create one instance per process and share it. Its timers never keep the process alive.

### Base configurations

On startup the server loads a snapshot of every configuration and active experiment. It then
polls a lightweight status endpoint (every 30 seconds by default, as advertised by the backend)
and refetches documents only when one of them changes.

```ts
gamebeast.configs.get("GameSettings.PlayerSpeed", 16); // base value, no experiments applied
gamebeast.configs.observe("GameSettings.MaintenanceMode", (on) => setMaintenance(on === true));
gamebeast.configs.list(); // [{ id, name, alias, hash, isPrimary }]
```

For short-lived processes (serverless functions), pass `autoRefresh: false` and call
`configs.refresh()` when you need current values.

### Evaluating for a user

`configs.evaluate` asks the backend to evaluate a configuration for one unit. The backend resolves
and records experiment assignments, and returns the document with the assigned group's changes
merged in. Results are reused for `evaluationCacheSeconds` (default 30). After that the SDK
revalidates by hash, and an unchanged result costs one `304` round trip.

`evaluate` never rejects. When the backend is unreachable, it falls back step by step; check
`config.source` when the difference matters:

| `source`        | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `"evaluated"`   | Evaluated for this unit (fresh, or confirmed unchanged).           |
| `"stale"`       | Evaluation failed; this is the unit's last evaluated value.        |
| `"base"`        | Evaluation failed with nothing cached; the unevaluated base value. |
| `"unavailable"` | Nothing to serve. `get` returns your fallbacks.                    |

Use `unitType: "server"` to evaluate for a server unit (server-level experiments).

### Experiments

```ts
gamebeast.experiments.list(); // active user experiments, from the snapshot
gamebeast.experiments.list("server");

const assignments = await gamebeast.experiments.assign(
  ["u1", "u2", { distinctId: "u3", properties: { plan: "pro" } }],
  {
    sharedProperties: { region: "eu" },
  }
);
assignments.get("u1"); // [{ experimentId, groupId, status, source, ... }]
```

`assign` batches 250 units per request. If any batch fails it rejects with a `GamebeastError`
(carrying `status`, `errorCode` and `retryable`), because a partial answer would read as "not
enrolled" for the missing units.

### Cohorts

```ts
await gamebeast.cohorts.isMember("whales", user.id); // false on failure; never rejects
await gamebeast.cohorts.getMembership("whales", ids); // Map<id, boolean>; rejects on failure
```

Checks for the same cohort that arrive within a few milliseconds share one request. Results are
cached for a minute.

### Markers

```ts
gamebeast.markers.send("match_started", { mode: "ranked" }, { distinctId: user.id, sessionId });
gamebeast.markers.send("server_restarted"); // server-level marker: no user
await gamebeast.flush();
```

Batched 100 per request or every 5 seconds (configurable via `markers`). Transient failures retry
with backoff. During an outage the buffer is capped at 10,000 markers, and the oldest are dropped
first.

### Server options

| Option                     | Default            | Description                                                              |
| -------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `apiKey`                   | —                  | Secret API key. Required.                                                |
| `environment`              | `"production"`     | Environment alias.                                                       |
| `serverId`                 | random per process | Identifies this instance; used for rate limiting and marker attribution. |
| `autoRefresh`              | `true`             | Poll for configuration and experiment changes.                           |
| `pollIntervalSeconds`      | backend (30)       | Override the poll interval (minimum 5).                                  |
| `evaluationCacheSeconds`   | `30`               | How long `evaluate` reuses a result. `0` always asks.                    |
| `markers`                  | —                  | `{ maxBatchSize, flushIntervalMs, maxBufferedMarkers }`.                 |
| `projectId`                | —                  | For keys that can access several projects.                               |
| `requestTimeoutMs`         | `10000`            | Per-request timeout.                                                     |
| `fetch`, `logger`, `debug` | global / console   | Transport and logging hooks.                                             |

## Targeting properties

Properties (both SDKs) must be scalars (`string`, `number`, `boolean`, `null`), `Date`s (sent as
epoch milliseconds), or arrays of up to 100 values of one scalar type. At most 100 properties are
sent. Invalid entries are dropped with a warning instead of failing the call.

## Errors and logging

The SDK never throws from reads, `send`, or `evaluate`. Problems are logged, and you get a fallback.
Misconfiguration (a missing `apiKey`, an invalid `environment`) throws from the constructor.
Warnings and errors go to the console by default. Pass `logger` to route them elsewhere, and
`debug: true` to also see requests, cache hits and refreshes.

## Migrating from `@gamebeast/node`

This package replaces `@gamebeast/node` (0.x):

| `@gamebeast/node`                                 | `@gamebeast/sdk/server`                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Gamebeast.setup({ ... })`                        | `const gamebeast = new GamebeastServer({ apiKey, ... })`                                           |
| `Gamebeast.getConfig(name)` / `configs.getConfig` | `gamebeast.configs.get(path)` or `await gamebeast.configs.evaluate({ distinctId, configuration })` |
| `markers.sendMarker(name, value)`                 | `gamebeast.markers.send(name, properties)`                                                         |
| `markers.sendUserMarker(userId, name, value)`     | `gamebeast.markers.send(name, properties, { distinctId: userId })`                                 |

Call `await gamebeast.shutdown()` before the process exits so buffered markers are delivered.

## Development

```sh
npm install
npm test               # vitest
npm run typecheck
npm run lint
npm run format:check
npm run build          # tsup → dist (ESM + CJS + .d.ts)
npm run check:package  # publint + are-the-types-wrong
```

### The API contract

Request and response shapes come from
[`@gamebeast/sdk-contract`](https://www.npmjs.com/package/@gamebeast/sdk-contract), the same package
core-backend declares its `/sdk/*` routes with (`packages/sdk-contract` in service-monorepo), along
with `toAliasSlug` and the request limits. `src/shared/wire.ts` only maps the SDK's names onto it.
Don't define wire shapes here: change the contract, release it, then bump the dependency.

The browser entry imports only type-only imports and `@gamebeast/sdk-contract/core` (no Zod), so
the schemas stay out of its bundle.

Publishing runs from a GitHub release (`.github/workflows/publish.yml`). `prepublishOnly` runs
every check above first.
