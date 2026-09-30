/**
 * HTTP 402 intercept for twzrd-preflight.
 *
 * Thin wrapper around twzrd-x402-gate@0.11.2 policy (the same steps as the gate's
 * own wrapFetchWithTwzrdGate): on 402, read the requirements (v2 PAYMENT-REQUIRED
 * header first, then the body) and approve EVERY distinct accepts[] entry via
 * preflight + merchant_card wash refuse. Denied 402s throw before the caller can
 * attach a payment / invoke a signer. Non-402 responses pass through with no intel
 * call.
 *
 * Public 0.11.2 APIs used here: priceUsdcFromAmountMicro, requirementAsset,
 * resolveConfig, resolveRequirementFields, twzrdApprovePayment.
 * resolveRequirementFields reports `conflict` (amount_field_conflict,
 * amount_malformed, payto_field_conflict) and leaves the field undefined; that is
 * refused here, never resolved by precedence. The gate's paymentRequiredFromResponse
 * and distinctOffers are not package exports, so their logic is mirrored below. createTwzrdBeforePaymentHook is the PayAI
 * beforePayment seat, not this wrap.
 */
import {
  priceUsdcFromAmountMicro,
  requirementAsset,
  resolveConfig,
  resolveRequirementFields,
  twzrdApprovePayment,
} from "twzrd-x402-gate";

/** Same limits and reason code as the gate's own wrappers (twzrd-x402-gate 0.11.2). */
export const MAX_DISTINCT_OFFERS = 8;
export const TOO_MANY_PAYMENT_OPTIONS = "too_many_payment_options";

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
    const url = requestUrl(input);

    // x402 v2 puts the requirements in the PAYMENT-REQUIRED header (base64 JSON), and a v2
    // payer reads it before the body. Read it the same way, or a v2 402 has no offer here.
    let paymentRequired;
    try {
      paymentRequired = await paymentRequiredFrom(resp);
    } catch (err) {
      refuseAndThrow({ payTo: null, url, reason: err.message });
    }
    if (paymentRequired === null) return resp; // no header, no JSON body: nothing payable

    // The payer picks which accepts[] entry it pays, so every distinct entry must pass
    // before the payer sees the 402 (gate 0.11.2). One free approval per entry.
    const offers = distinctOffers(paymentRequired.accepts);
    if (offers.length === 0) {
      refuseAndThrow({ payTo: null, url, reason: "twzrd_unidentifiable_payment_recipient" });
    }
    if (offers.length > MAX_DISTINCT_OFFERS) {
      refuseAndThrow({ payTo: null, url, reason: TOO_MANY_PAYMENT_OPTIONS });
    }
    for (const offer of offers) {
      const f = resolveRequirementFields(offer);
      // amount vs maxAmountRequired or payTo vs pay_to disagree, or the amount is not an
      // ASCII base-unit integer: there is no single price/recipient. Refuse regardless of
      // failMode, never resolve by precedence.
      if (f.conflict) refuseAndThrow({ payTo: f.payTo ?? null, url, reason: f.conflict });
      const approval = await twzrdApprovePayment(
        {
          resourceUrl: offer.resource ?? url,
          payTo: f.payTo,
          // With the requirement, a non-USDC asset has no USD price (gate 0.11.1).
          priceUsdc: priceUsdcFromAmountMicro(f.amount, offer),
          agentIntent: "twzrd-preflight-wrapFetch_402_gate",
          chain: offer.network,
          asset: requirementAsset(offer),
        },
        cfg,
      );
      if (!approval.approved) {
        refuseAndThrow({
          payTo: f.payTo ?? null,
          url,
          reason: approval.reason,
          verdict: approval.verdict ?? "block",
        });
      }
    }
    return resp;
  };
}

function refuseAndThrow({ payTo, url, reason, verdict = "block" }) {
  const refuse = buildRefuse({ payTo, url, reason, verdict });
  lastRefuse = refuse;
  throw new TwzrdPaymentBlockedError(
    `[twzrd-preflight] payment blocked: ${reason} payTo=${payTo ?? undefined} url=${url}`,
    refuse,
  );
}

/**
 * The 402's payment requirements: the v2 PAYMENT-REQUIRED header first, then the JSON body.
 * Returns null when there is neither. An undecodable header is refused, not skipped.
 */
async function paymentRequiredFrom(resp) {
  const header = resp.headers.get("PAYMENT-REQUIRED");
  if (header) {
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      throw new Error("undecodable PAYMENT-REQUIRED header");
    }
    if (!decoded || typeof decoded !== "object") {
      throw new Error("PAYMENT-REQUIRED header is not an object");
    }
    return decoded;
  }
  try {
    return await resp.clone().json();
  } catch {
    return null;
  }
}

/** Distinct offer objects, keyed the way the gate keys them (recipient, amount, asset, network, conflict). */
function distinctOffers(accepts) {
  if (!Array.isArray(accepts)) return [];
  const seen = new Set();
  const out = [];
  for (const e of accepts) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
    const f = resolveRequirementFields(e);
    const key = [
      f.payTo ?? String(e.payTo ?? e.pay_to ?? ""),
      f.amount ?? String(e.amount ?? e.maxAmountRequired ?? ""),
      String(e.asset ?? ""),
      String(e.network ?? "").toLowerCase(),
      f.conflict ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
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
