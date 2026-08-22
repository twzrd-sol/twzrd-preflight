/**
 * HTTP 402 intercept for twzrd-preflight.
 *
 * Thin wrapper around twzrd-x402-gate policy (wrap-equivalent): on 402, evaluate
 * payTo via preflight + merchant_card wash refuse. Denied 402s throw before the
 * caller can attach a payment / invoke a signer. Non-402 responses pass through
 * with no intel call.
 *
 * Does not reimplement wash scoring — uses twzrdApprovePayment / refuseWashFlagged.
 */
import {
  payToFromRequirements,
  pickRequirements,
  priceUsdcFromAmountMicro,
  resolveConfig,
  twzrdApprovePayment,
} from "twzrd-x402-gate";

/** @type {object | null} */
let lastRefuse = null;

export function getLastRefuse() {
  return lastRefuse;
}

export function resetLastRefuse() {
  lastRefuse = null;
}

export function buildRefuse({
  payTo = null,
  url = null,
  reason = null,
  verdict = "block",
} = {}) {
  return {
    schema: "twzrd.gate_eval_refuse.v1",
    lineage: "twzrd-preflight-wrap-fetch",
    closes_external_adoption_metric: false,
    note: "Mechanism proof — not EXTERNAL_RUN. Foreign install + this wrap is the Path B seat.",
    pay_to: payTo,
    target_url: url,
    twzrd_decision: verdict,
    twzrd_reason: reason,
    signer_invocation_count: 0,
    usdc_spent: 0,
  };
}

export class TwzrdPaymentBlockedError extends Error {
  /**
   * @param {string} message
   * @param {object} refuse
   */
  constructor(message, refuse) {
    super(message);
    this.name = "TwzrdPaymentBlockedError";
    this.refuse = refuse;
  }
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Map plugin opts onto twzrd-x402-gate resolveConfig.
 * Defaults: refuseWashFlagged on, fail-closed (failOpen false).
 */
export function gateConfigFromPluginOpts(opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const failMode = opts.failMode ?? "closed";
  const refuseWashFlagged = opts.refuseWashFlagged ?? true;
  return resolveConfig({
    intelBase: opts.endpoint ?? opts.intelBase,
    fetch: fetchImpl,
    failOpen: failMode === "open",
    refuseWashFlagged,
    attribution: {
      integration: "twzrd-preflight",
      runId: opts.runId ?? `preflight-${Date.now().toString(16)}`,
    },
  });
}

/**
 * Wrap an injected (or real) fetch. Inner fetch is the resource client;
 * intel/merchant_card use `opts.fetch` (defaults to global fetch).
 *
 * Tests MUST inject both so the unit under test is this wrap, not a mock of it.
 *
 * @param {typeof fetch} innerFetch
 * @param {object} [opts]
 * @returns {typeof fetch}
 */
export function wrapFetchWithTwzrdPreflight(innerFetch, opts = {}) {
  if (typeof innerFetch !== "function") {
    throw new TypeError("wrapFetchWithTwzrdPreflight: innerFetch must be a function");
  }
  const cfg = gateConfigFromPluginOpts(opts);

  return async (input, init) => {
    const resp = await innerFetch(input, init);
    if (resp.status !== 402) return resp;

    let body = {};
    try {
      body = await resp.clone().json();
    } catch {
      return resp;
    }

    const first = pickRequirements(body.accepts);
    const { payTo, resource, amountMicro } = payToFromRequirements(first);
    const url = requestUrl(input);
    const priceUsdc = priceUsdcFromAmountMicro(amountMicro);

    const approval = await twzrdApprovePayment(
      {
        resourceUrl: resource ?? url,
        payTo,
        priceUsdc,
        agentIntent: "twzrd-preflight-wrapFetch_402_gate",
        chain: first?.network,
      },
      cfg,
    );

    if (!approval.approved) {
      const refuse = buildRefuse({
        payTo,
        url,
        reason: approval.reason,
        verdict: approval.verdict ?? "block",
      });
      lastRefuse = refuse;
      throw new TwzrdPaymentBlockedError(
        `[twzrd-preflight] payment blocked: ${approval.reason} payTo=${payTo} url=${url}`,
        refuse,
      );
    }
    return resp;
  };
}

/**
 * Optional operator one-liner when OpenClaw has no HTTP hook:
 * `globalThis.fetch = installTwzrdFetchWrap(opts)` — still not a silent monkeypatch
 * of the gateway; the operator assigns it.
 */
export function installTwzrdFetchWrap(opts = {}) {
  const inner = (opts.innerFetch ?? globalThis.fetch).bind(globalThis);
  return wrapFetchWithTwzrdPreflight(inner, opts);
}
