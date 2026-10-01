/**
 * `@gamebeast/sdk/server` — the Gamebeast SDK for Node.js and other server runtimes.
 *
 * Use a **secret** API key here and never ship it to browsers.
 */
export { GamebeastServer } from "./server";
export type { GamebeastServerOptions } from "./server";
export type {
  ServerConfigs,
  EvaluatedConfiguration,
  EvaluateOptions,
  EvaluationSource,
} from "./configs";
export type { ConfigurationInfo } from "./snapshot";
export type { ServerExperiments, AssignUnit, AssignOptions } from "./experiments";
export type { ServerCohorts } from "./cohorts";
export type { ServerMarkers, ServerMarkerOptions, MarkerQueueSettings } from "./markers";
export { GamebeastError } from "../shared/errors";

export type { ConfigPath } from "../shared/json";
export type { Unsubscribe } from "../shared/listeners";
export type { GamebeastLogger } from "../shared/logger";
export type { FetchLike } from "../shared/http";
export type { MarkerProperties } from "../shared/markers";
export type { Properties, PropertyValue } from "../shared/context";
export type {
  JsonValue,
  JsonObject,
  UnitType,
  AssignmentEntry,
  AssignmentSource,
  ExperimentAssignmentMetadata,
  SdkExperimentDescriptor,
  SdkExperimentGroup,
} from "../shared/wire";
export { SDK_VERSION } from "../shared/version";
