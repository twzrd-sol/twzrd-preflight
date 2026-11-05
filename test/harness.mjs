/**
 * Phase 1 harness: exercises the gate hooks directly (no OpenClaw gateway needed).
 *
 * Offline by default (npm test): intel is a stub at globalThis.fetch that answers for the
 * two recorded sellers below and nothing else. Loopback passes through, because T7a, T7b
 * and T15 point at 127.0.0.1:9 to get a refused connection. Any other request fails the
 * run in TX. T19 spawns the gate's refuse binary, which exits at its missing-peer check
 * before it fetches anything.
 *
 * TWZRD_PREFLIGHT_LIVE=1 npm test calls the LIVE free preflight API instead (no auth, no
 * payments), so the recorded answers can be re-checked against intel.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spawnSync } from "node:child_process";
import {
  createGate,
  DEFAULTS,
  wrapFetchWithTwzrdPreflight,
  getLastRefuse,
  resetLastRefuse,
  TwzrdPaymentBlockedError,
} from "../index.js";
import plugin from "../index.js";
import {
  CLIENT_VERSION as GATE_CLIENT_VERSION,
  createTwzrdBeforePaymentHook,
} from "twzrd-x402-gate";
