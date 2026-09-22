// index.js
//
// TWZRD preflight plugin entry point.
//
// Exports:
//   - wrapFetchWithTwzrdPreflight: wraps a fetch function to intercept 402s.
//   - runPreflight: runs a single preflight evaluation (used by CLI and tests).
//
// Fail-closed by default: any error in the gate evaluation results in a
// block decision with zero spend.

import {
  evaluateGate,
  isWashFlagged,
  computeSpendCap,
} from "twzrd-x402-gate";

// ---------------------------------------------------------------------------
// Configuration defaults (fail-closed, enforce, refuseWashFlagged on).
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  enforce: true,
  failClosed: true,
  refuseWashFlagged: true,
  shadow: false,
  failOpen: false,
  washOff: false,
});

// ---------------------------------------------------------------------------
// runPreflight: single preflight evaluation.
//
// @param {object} opts
// @param {string} opts.resourceUri - The resource URI being accessed.
// @param {string} opts.method - HTTP method (GET, POST, etc.).
// @param {number} opts.transportStatus - HTTP status from the transport layer.
// @param {object} [opts.transportBody] - Parsed transport response body.
// @param {object} opts.fixture - Merchant/telemetry fixture (reputation, etc.).
// @returns {Promise<object>} Preflight result with all invariants.
// ---------------------------------------------------------------------------

export async function runPreflight(opts) {
  const {
    resourceUri,
    method,
    transportStatus,
    transportBody,
    fixture,
  } = opts;

  const eventSequence = [];
  eventSequence.push("raw_request_start");
  eventSequence.push("raw_response");

  // --- Phase I: Transport layer validation ---
  // A 405 (method_not_allowed) or any non-402/non-2xx status halts
  // execution pre-signature. No gate evaluation, no spend.
  if (transportStatus === 405) {
    eventSequence.push("twzrd_preflight_start");
    eventSequence.push("twzrd_preflight_result");
    eventSequence.push("payment_blocked");
    return {
      halted: true,
      haltReason: "transport_refusal",
      transportStatus,
      transportBody: transportBody ?? null,
      policyAction: "block",
      enforcementReason: "transport_refusal",
      recommendedSpendCapUsdc: 0,
      signerInvocationCount: 0,
      cryptographicSpendUsdc: 0,
      canSpend: false,
      reputationTier: fixture?.reputationTier ?? null,
      washLabel: fixture?.washLabel ?? null,
      trustScore: fixture?.trustScore ?? null,
      captivePayerPct: fixture?.captivePayerPct ?? null,
      eventSequence,
      resourceUri,
      method,
    };
  }

  // Non-402 responses pass through without gating.
  if (transportStatus !== 402) {
    return {
      halted: false,
      transportStatus,
      policyAction: "pass",
      enforcementReason: "non_402_passthrough",
      recommendedSpendCapUsdc: 0,
      signerInvocationCount: 0,
      cryptographicSpendUsdc: 0,
      canSpend: false,
      reputationTier: fixture?.reputationTier ?? null,
      washLabel: fixture?.washLabel ?? null,
      trustScore: fixture?.trustScore ?? null,
      captivePayerPct: fixture?.captivePayerPct ?? null,
      eventSequence,
      resourceUri,
      method,
    };
  }

  // --- Phase II: Gate telemetry ingestion (402) ---
  eventSequence.push("initial_402_receipt");
  eventSequence.push("twzrd_preflight_start");

  // Evaluate the gate using the twzrd-x402-gate library.
  // Fail-closed: any error here results in a block.
  let gateResult;
  try {
    gateResult = await evaluateGate({
      resourceUri,
      method,
      fixture,
    });
  } catch (err) {
    // Fail-closed: gate evaluation error => block, zero spend.
    eventSequence.push("twzrd_preflight_result");
    eventSequence.push("payment_blocked");
    return {
      halted: true,
      haltReason: "gate_evaluation_error",
      transportStatus,
      policyAction: "block",
      enforcementReason: "twzrd_decision_block",
      recommendedSpendCapUsdc: 0,
      signerInvocationCount: 0,
      cryptographicSpendUsdc: 0,
      canSpend: false,
      reputationTier: fixture?.reputationTier ?? null,
      washLabel: fixture?.washLabel ?? null,
      trustScore: fixture?.trustScore ?? null,
      captivePayerPct: fixture?.captivePayerPct ?? null,
      eventSequence,
      resourceUri,
      method,
      error: err.message,
    };
  }

  eventSequence.push("twzrd_preflight_result");

  // --- Phase III: Enforcement & state invariants ---
  const washFlagged = isWashFlagged(fixture);
  const refuseWash = DEFAULTS.refuseWashFlagged && !DEFAULTS.washOff;

  let policyAction;
  let enforcementReason;
  let recommendedSpendCapUsdc;
  let canSpend;

  if (washFlagged && refuseWash) {
    // Wash-flagged merchant: block, zero spend.
    policyAction = "block";
    enforcementReason = "twzrd_decision_block";
    recommendedSpendCapUsdc = 0;
    canSpend = false;
    eventSequence.push("payment_blocked");
  } else if (gateResult.decision === "allow") {
    // Trusted merchant: allow, spend cap = requested spend.
    policyAction = "allow";
    enforcementReason = "twzrd_decision_allow";
    recommendedSpendCapUsdc =
      (fixture?.requestedSpendMicroUsdc ?? 0) / 1_000_000;
    canSpend = true;
  } else {
    // Gate says block (e.g., low trust score, high captive payer pct).
    policyAction = "block";
    enforcementReason = "twzrd_decision_block";
    recommendedSpendCapUsdc = 0;
    canSpend = false;
    eventSequence.push("payment_blocked");
  }

  // Signer invocation count: 0 if blocked, 1 if allowed (signer would be called).
  const signerInvocationCount = canSpend ? 1 : 0;

  // Cryptographic spend: 0 if blocked, requested spend if allowed.
  // In the hostile fixture case, this is always 0.
  const cryptographicSpendUsdc = canSpend
    ? (fixture?.requestedSpendMicroUsdc ?? 0) / 1_000_000
    : 0;

  return {
    halted: false,
    transportStatus,
    policyAction,
    enforcementReason,
    recommendedSpendCapUsdc,
    signerInvocationCount,
    cryptographicSpendUsdc,
    canSpend,
    reputationTier: fixture?.reputationTier ?? null,
    washLabel: fixture?.washLabel ?? null,
    trustScore: fixture?.trustScore ?? null,
    captivePayerPct: fixture?.captivePayerPct ?? null,
    eventSequence,
    resourceUri,
    method,
  };
}

// ---------------------------------------------------------------------------
// wrapFetchWithTwzrdPreflight: wraps a fetch function to intercept 402s.
//
// @param {Function} originalFetch - The original fetch function.
// @param {object} [config] - Optional config overrides.
// @returns {Function} Wrapped fetch function.
// ---------------------------------------------------------------------------

export function wrapFetchWithTwzrdPreflight(originalFetch, config = {}) {
  const cfg = { ...DEFAULTS, ...config };

  return async function wrappedFetch(url, options = {}) {
    // Perform the original fetch.
    let response;
    try {
      response = await originalFetch(url, options);
    } catch (err) {
      // Network error: fail-closed => rethrow (no payment attempted).
      throw err;
    }

    // Non-402: pass through untouched.
    if (response.status !== 402) {
      return response;
    }

    // 402: run preflight.
    // In production, the fixture would be extracted from the 402 response
    // body. In tests, it may be injected via options.__twzrdFixture.
    const fixture =
      options.__twzrdFixture ??
      (await extractFixtureFrom402(response));

    const result = await runPreflight({
      resourceUri: url,
      method: options.method ?? "GET",
      transportStatus: 402,
      fixture,
    });

    // Attach preflight metadata to the response for downstream consumers.
    response.__twzrdDecision = result.policyAction;
    response.__twzrdSpendUsdc = result.cryptographicSpendUsdc;
    response.__twzrdCanSpend = result.canSpend;
    response.__twzrdEventSequence = result.eventSequence;

    // If blocked, return the 402 response as-is (no payment attached).
    // If allowed, the caller (signer) would attach payment here.
    // In this plugin, we return the response and let the caller decide.
    return response;
  };
}

// ---------------------------------------------------------------------------
// extractFixtureFrom402: parses a 402 response body into a fixture.
//
// In production, this would parse the x402 payment-required response.
// For test purposes, the fixture is injected directly.
// ---------------------------------------------------------------------------

async function extractFixtureFrom402(response) {
  try {
    const body = await response.json();
    return {
      resourceUri: body.resourceUri ?? null,
      payTo: body.payTo ?? null,
      network: body.network ?? null,
      modelVersion: body.modelVersion ?? null,
      reputationTier: body.reputationTier ?? null,
      trustScore: body.trustScore ?? null,
      washLabel: body.washLabel ?? null,
      captivePayerPct: body.captivePayerPct ?? null,
      behavioralObservations: body.behavioralObservations ?? null,
      requestedSpendMicroUsdc: body.requestedSpendMicroUsdc ?? 0,
      schema: body.schema ?? null,
      pkgVersion: body.pkgVersion ?? null,
    };
  } catch {
    // Unparseable 402 body: fail-closed => treat as wash-flagged.
    return {
      reputationTier: "unknown",
      washLabel: "unparseable",
      trustScore: 0,
      captivePayerPct: 100,
      requestedSpendMicroUsdc: 0,
    };
  }
}

// Re-export for convenience.
export { DEFAULTS };
