/**
 * The SDK version, sent to the backend as the `sdkversion` header and stamped on disk caches so a
 * cache written by a different SDK build is discarded. Keep in sync with `package.json` — the
 * `version` test fails if the two drift.
 */
export const SDK_VERSION = "1.0.0";
