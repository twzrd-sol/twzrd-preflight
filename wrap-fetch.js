// wrap-fetch.js
//
// Re-exports wrapFetchWithTwzrdPreflight from index.js for direct import.
// This file exists as a stable import target for the OpenClaw plugin system.

export { wrapFetchWithTwzrdPreflight, runPreflight, DEFAULTS } from "./index.js";
