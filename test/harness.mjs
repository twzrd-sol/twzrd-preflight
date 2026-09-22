// test/harness.mjs
//
// TWZRD preflight test harness.
//
// Two suites:
//   1. Unit / integration checks against the local wrap-fetch + gate logic.
//   2. Third-party environment preflight (issue #2): a deterministic,
//      fail-closed run against a controlled hostile fixture
//      (tier_wash_demo) that must end with can_spend=false and
//      cryptographic spend == 0.
//
// The third-party suite is OFF by default (it performs real network I/O).
// Enable it with:
//   TWZRD_PREFLIGHT_3P=1 node test/harness.mjs
//
// It is fully deterministic: the hostile fixture is pinned (URL, wallet,
// model version, reputation tier, trust score, wash label) and every
// invariant from the verified execution trace is asserted.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Load the plugin entry points.
// ---------------------------------------------------------------------------
const { wrapFetchWithTwzrdPreflight } = await import(
  pathToFileURL(path.join(root, "wrap-fetch.js"))
);
const { runPreflight } = await import(pathToFileURL(path.join(root, "index.js")));

function pathToFileURL(p) {
  return new URL(`file://${p}`).href;
}

// ---------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------

// The controlled hostile fixture from the verified execution trace.
const HOSTILE_FIXTURE = Object.freeze({
  resourceUri: "https://three.ws/api/x402/model-check",
  payTo: "wwwwwDxFWRn7grgr3Esrsg5C6NvDoDHSA4gaCffccrU",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  modelVersion: "corpus_teaser_v1:provider_reputation_v1",
  reputationTier: "tier_wash_demo",
  trustScore: 30,
  washLabel: "wash_shaped",
  captivePayerPct: 100,
  behavioralObservations: 9,
  requestedSpendMicroUsdc: 1000, // $0.001
  schema: "twzrd.gate_eval_refuse.v1",
  pkgVersion: "0.8.8",
});

// A benign, well-reputed merchant used to prove the gate does NOT
// over-block legitimate traffic (the "fail-closed, not fail-dead" property).
const BENIGN_FIXTURE = Object.freeze({
  resourceUri: "https://example.com/api/ok",
  payTo: "BENIGN_WALLET_PLACEHOLDER",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  modelVersion: "corpus_teaser_v1:provider_reputation_v1",
  reputationTier: "tier_trusted",
  trustScore: 92,
  washLabel: "none",
  captivePayerPct: 0,
  behavioralObservations: 120,
  requestedSpendMicroUsdc: 1000,
});

// ---------------------------------------------------------------------------
// Suite 1: local unit / integration checks (no network).
// ---------------------------------------------------------------------------

async function suiteLocal() {
  console.log("\n== Suite 1: local unit / integration ==");

  // 1a. wrapFetchWithTwzrdPreflight must return a fetch-compatible function.
  const wrapped = wrapFetchWithTwzrdPreflight(globalThis.fetch, {
    enforce: true,
    failClosed: true,
    refuseWashFlagged: true,
  });
  assert.equal(typeof wrapped, "function", "wrapped fetch must be a function");
  console.log("  ok: wrapFetchWithTwzrdPreflight returns a function");

  // 1b. A non-402 response must pass through untouched (no gate invocation).
  const passthrough = await wrapped("https://example.com/200", {
    method: "GET",
  });
  assert.equal(passthrough.status, 200, "non-402 must pass through");
  console.log("  ok: non-402 response passes through without gating");

  // 1c. A 402 from a wash-flagged merchant must be refused (fail-closed).
  const hostile402 = await wrapped("https://three.ws/api/x402/model-check", {
    method: "GET",
    __twzrdFixture: HOSTILE_FIXTURE, // injected by the test transport
  });
  assert.equal(hostile402.status, 402, "hostile 402 must remain 402 (no payment)");
  assert.equal(hostile402.__twzrdDecision, "block", "hostile 402 must be blocked");
  assert.equal(hostile402.__twzrdSpendUsdc, 0, "no spend on hostile 402");
  console.log("  ok: hostile 402 refused, decision=block, spend=0");

  // 1d. A 402 from a trusted merchant must be allowed to proceed to signer.
  const benign402 = await wrapped("https://example.com/api/ok", {
    method: "GET",
    __twzrdFixture: BENIGN_FIXTURE,
  });
  assert.equal(benign402.__twzrdDecision, "allow", "benign 402 must be allowed");
  console.log("  ok: benign 402 allowed to proceed to signer");

  // 1e. runPreflight must be exported and callable.
  assert.equal(typeof runPreflight, "function", "runPreflight must be exported");
  console.log("  ok: runPreflight exported");
}

// ---------------------------------------------------------------------------
// Suite 2: third-party environment preflight (issue #2).
//
// Deterministic, fail-closed run against the pinned hostile fixture.
// Asserts every invariant from the verified execution trace:
//   - transport refusal (405) halts pre-signature
//   - wash-flagged merchant is blocked
//   - signer invocation count == 0
//   - cryptographic spend == 0
//   - can_spend == false
// ---------------------------------------------------------------------------

async function suiteThirdParty() {
  console.log("\n== Suite 2: third-party environment preflight (issue #2) ==");

  // 2a. Transport-layer validation: a 405 (method_not_allowed) must halt
  //     execution pre-signature. No gate evaluation, no spend.
  const transportResult = await runPreflight({
    resourceUri: HOSTILE_FIXTURE.resourceUri,
    method: "POST",
    transportStatus: 405,
    transportBody: { error: "method_not_allowed" },
    fixture: HOSTILE_FIXTURE,
  });

  assert.equal(transportResult.halted, true, "405 must halt pre-signature");
  assert.equal(transportResult.haltReason, "transport_refusal", "405 halt reason");
  assert.equal(transportResult.signerInvocationCount, 0, "no signer on 405");
  assert.equal(transportResult.cryptographicSpendUsdc, 0, "no spend on 405");
  assert.equal(transportResult.canSpend, false, "can_spend=false on 405");
  console.log("  ok: transport 405 halts pre-signature, spend=0");

  // 2b. Gate telemetry ingestion: a 402 from the wash-flagged hostile
  //     fixture must be blocked with zero spend.
  const gateResult = await runPreflight({
    resourceUri: HOSTILE_FIXTURE.resourceUri,
    method: "GET",
    transportStatus: 402,
    fixture: HOSTILE_FIXTURE,
  });

  assert.equal(gateResult.policyAction, "block", "hostile 402 must be blocked");
  assert.equal(
    gateResult.enforcementReason,
    "twzrd_decision_block",
    "enforcement reason must be twzrd_decision_block"
  );
  assert.equal(
    gateResult.recommendedSpendCapUsdc,
    0,
    "recommended spend cap must be 0 for wash-flagged"
  );
  assert.equal(gateResult.signerInvocationCount, 0, "no signer on block");
  assert.equal(gateResult.cryptographicSpendUsdc, 0, "no spend on block");
  assert.equal(gateResult.canSpend, false, "can_spend=false on block");
  assert.equal(
    gateResult.reputationTier,
    HOSTILE_FIXTURE.reputationTier,
    "reputation tier must be echoed"
  );
  assert.equal(
    gateResult.washLabel,
    HOSTILE_FIXTURE.washLabel,
    "wash label must be echoed"
  );
  assert.equal(
    gateResult.trustScore,
    HOSTILE_FIXTURE.trustScore,
    "trust score must be echoed"
  );
  assert.equal(
    gateResult.captivePayerPct,
    HOSTILE_FIXTURE.captivePayerPct,
    "captive payer pct must be echoed"
  );
  console.log("  ok: hostile 402 blocked, spend=0, can_spend=false");

  // 2c. Event sequence must match the verified trace.
  const expectedEvents = [
    "raw_request_start",
    "raw_response",
    "initial_402_receipt",
    "twzrd_preflight_start",
    "twzrd_preflight_result",
    "payment_blocked",
  ];
  assert.deepEqual(
    gateResult.eventSequence,
    expectedEvents,
    "event sequence must match verified trace"
  );
  console.log("  ok: event sequence matches verified trace");

  // 2d. Determinism: running the same preflight twice must produce
  //     identical results (fail-closed protocol is deterministic).
  const gateResult2 = await runPreflight({
    resourceUri: HOSTILE_FIXTURE.resourceUri,
    method: "GET",
    transportStatus: 402,
    fixture: HOSTILE_FIXTURE,
  });
  assert.deepEqual(
    gateResult,
    gateResult2,
    "preflight must be deterministic"
  );
  console.log("  ok: preflight is deterministic (identical on re-run)");

  // 2e. Benign merchant must NOT be blocked (fail-closed, not fail-dead).
  const benignResult = await runPreflight({
    resourceUri: BENIGN_FIXTURE.resourceUri,
    method: "GET",
    transportStatus: 402,
    fixture: BENIGN_FIXTURE,
  });
  assert.equal(benignResult.policyAction, "allow", "benign 402 must be allowed");
  assert.equal(benignResult.canSpend, true, "can_spend=true for benign");
  assert.equal(
    benignResult.recommendedSpendCapUsdc,
    BENIGN_FIXTURE.requestedSpendMicroUsdc / 1_000_000,
    "benign spend cap equals requested spend"
  );
  console.log("  ok: benign 402 allowed (fail-closed, not fail-dead)");

  // 2f. Cryptographic spend invariant: across ALL runs, total spend must be 0
  //     for the hostile fixture (the core invariant of the issue).
  const totalHostileSpend =
    transportResult.cryptographicSpendUsdc + gateResult.cryptographicSpendUsdc;
  assert.equal(
    totalHostileSpend,
    0,
    "cryptographic spend invariant: total hostile spend must be 0"
  );
  console.log("  ok: cryptographic spend invariant holds (total=0)");
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

const enableThirdParty = process.env.TWZRD_PREFLIGHT_3P === "1";

let failures = 0;

try {
  await suiteLocal();
} catch (err) {
  failures++;
  console.error("  FAIL:", err.message);
}

if (enableThirdParty) {
  try {
    await suiteThirdParty();
  } catch (err) {
    failures++;
    console.error("  FAIL:", err.message);
  }
} else {
  console.log("\n== Suite 2: SKIPPED (set TWZRD_PREFLIGHT_3P=1 to enable) ==");
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll tests passed.");
  process.exit(0);
}
