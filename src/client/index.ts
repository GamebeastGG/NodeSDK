/**
 * `@gamebeast/sdk/client` — the Gamebeast SDK for browsers and web apps.
 *
 * Use a **public** API key here: anything in a browser bundle is visible to your users.
 */
export { GamebeastClient } from "./client";
export type { GamebeastClientOptions } from "./client";
export type { ClientConfigs } from "./configs";
export type { ClientMarkers } from "./markers";
export type { ClientExperiments, ExperimentAssignment } from "./experiments";
export type { ClientCohorts } from "./cohorts";
export type { KeyValueStorage } from "./storage";

export type { ConfigPath } from "../shared/json";
export type { Unsubscribe } from "../shared/listeners";
export type { GamebeastLogger } from "../shared/logger";
export type { FetchLike } from "../shared/http";
export type { MarkerProperties } from "../shared/markers";
export type { Properties, PropertyValue } from "../shared/context";
export type { JsonValue, JsonObject, AssignmentSource } from "../shared/wire";
export { SDK_VERSION } from "../shared/version";
