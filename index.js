/**
 * twzrd-preflight — OpenClaw plugin (0.5.0)
 *
 * Two seams:
 *   1) wrapFetchWithTwzrdPreflight — HTTP 402 intercept (install = intercept).
 *      Wash-flagged payTo throws before the caller can attach payment / sign.
 *   2) before_tool_call — payment-shaped tool matchers (MCP + exec/curl x402).
 *
 * Factory defaults: enforce, fail-closed, refuseWashFlagged, refuseWashUnknown,
 * refuseUncappedWarn and refuseUnevaluated on. Shadow / fail-open / each opt-out is opt-in.
 *
 * Gate rules for tool calls, copied from twzrd-x402-gate 0.13.0, which this plugin pins:
 * a card that is missing or says block refuses; a warn is paid only under its own
 * recommended_cap_usdc at a known price; a seller intel never evaluated refuses; a
 * wash_flagged payTo refuses; a merchant card without full, fresh wash coverage refuses.
 * NEVER gate on can_spend alone (free tier defaults can_spend:false for unknown).
 * A payment-shaped call whose payee cannot be read is refused (refuseUnparsedPayments).
 *
 * Privacy: tool call metadata (toolName, seller_wallet, resource_name,
 * price_usdc) is sent to intel.twzrd.xyz for trust scoring. No payload
 * content or full params are forwarded. See https://intel.twzrd.xyz/privacy.
 */

import { readFileSync } from "fs";
import { applyWashFlaggedPolicy, fetchMerchantCard } from "twzrd-x402-gate";
import {
  buildRefuse,
  wrapFetchWithTwzrdPreflight,
  getLastRefuse,
  resetLastRefuse,
  TwzrdPaymentBlockedError,
  installTwzrdFetchWrap,
} from "./wrap-fetch.js";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);
const CALLER = `twzrd-preflight/${pkg.version}`;

export const DEFAULTS = {
  mode: "enforce", // off | shadow | enforce — shadow is opt-in
  failMode: "closed", // closed = fail-closed; open is opt-in
  refuseWashFlagged: true, // wash_flagged payTo refuses; opt out with false
  refuseWashUnknown: true, // merchant card without full, fresh wash coverage refuses; opt out with false
  refuseUncappedWarn: true, // warn with no recommended_cap_usdc or no known price refuses; opt out with false
  refuseUnevaluated: true, // seller intel never evaluated refuses; false pays it up to the card's cap
  refuseUnparsedPayments: true, // payment-shaped call with no readable payee refuses; opt out with false
  timeoutMs: 5000,
  maxPriceUsdc: null,
  endpoint: "https://intel.twzrd.xyz",
  denyWallets: [],
  allowWallets: [],
  cacheTtlMs: 60 * 60 * 1000,
  matchers: [],
};

const BASE58 = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const RE = {
  sellerWallet: new RegExp(`"seller_wallet"\\s*:\\s*"(${BASE58})"`),
  payToJson: new RegExp(`"payTo"\\s*:\\s*"(${BASE58})"`),
  payToKv: new RegExp(`payTo=(${BASE58})`),
  price: /"price_usdc"\s*:\s*([0-9.]+)/,
  resourceName: /"resource_name"\s*:\s*"([^"]{1,128})"/,
  url: /https?:\/\/[^\s"'<>]+/g,
  // curl/wget sending an x402 payment header (not X-PAYMENT-RESPONSE): the header is the
  // signed payment, so the command pays whoever that payment names.
  paymentHeader: /(?:^|\s)(?:-H|--header)(?:\s+|=)?['"]?\s*(?:payment-signature|x-payment)\s*:/i,
};
const EXEC_TOOLS = new Set(["exec", "bash", "shell", "system.run", "run"]);
const PAYMENTISH_TOOL = /agentcash|x402|pay/i;
const PAYMENT_WORDS = new Set(["pay", "pays", "payment", "payments"]);

/**
 * Payment-named: agentcash or x402 anywhere in the name, or pay, pays, payment or payments as
 * a whole word (agentcash_fetch, x402fetch, make_payment, fetchWithPayment). Not
 * inspect_payload or taxpayer_lookup, which PAYMENTISH_TOOL also matches. Only the refusal of
 * a call with no readable payee uses this narrower test.
 */
function paymentNamed(toolName) {
  const name = String(toolName ?? "");
  if (/agentcash|x402/i.test(name)) return true;
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  return words.some((w) => PAYMENT_WORDS.has(w));
}

function host(u) {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

function originOf(u) {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

function finiteNumber(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * True when intel says it did not evaluate this seller: a null_reason, or score present and
 * null. Copy of twzrd-x402-gate 0.13.0 isUnevaluatedCard (src/policy.ts).
 */
function isUnevaluatedCard(card) {
  if (typeof card.null_reason === "string" && card.null_reason.trim() !== "") return true;
  return "score" in card && card.score === null;
}

/**
 * The readiness card rules of twzrd-x402-gate 0.13.0 evaluateReadinessCard (src/policy.ts),
 * copied (with the differences below) and with the gate's reason strings. Pure: no network.
 *
 * Differences from the gate. This plugin has no preflightMinScore or gateOnCanSpend, so a low
 * trust_score or can_spend false alone never refuses. A card with no decision is refused by
 * name, twzrd_decision_undefined, where the gate reads it as warn and refuses it on score. A
 * decision outside allow, warn and block is refused, twzrd_decision_<decision>, where the gate
 * approves it.
 *
 * Returns { approved, verdict, reason, unevaluated, recommendedCapUsdc }. A price above an
 * approved card's cap is checked after this, by overRecommendedCap, as in the gate.
 */
export function evaluateReadinessCard(card, { priceUsdc = null, refuseUncappedWarn = true, refuseUnevaluated = true } = {}) {
  const c = card && typeof card === "object" ? card : {};
  const decision = c.decision;
  const cap = finiteNumber(c.recommended_cap_usdc) !== null && c.recommended_cap_usdc >= 0 ? c.recommended_cap_usdc : null;
  const price = finiteNumber(priceUsdc);
  if (decision === "block") return { approved: false, verdict: "block", reason: "twzrd_decision_block", unevaluated: false };
  if (isUnevaluatedCard(c)) {
    const nullReason = c.null_reason ?? "score_null";
    const refuse = (reason) => ({ approved: false, verdict: "unknown", reason, unevaluated: true, recommendedCapUsdc: cap });
    if (refuseUnevaluated !== false) return refuse(`twzrd_unevaluated_subject_${nullReason}`);
    if (decision !== "allow" && decision !== "warn") return refuse(`twzrd_unevaluated_subject_${nullReason}`);
    if (cap === null) return refuse(`twzrd_unevaluated_no_cap_${nullReason}`);
    if (price === null) return refuse(`twzrd_unevaluated_unknown_price_${nullReason}`);
    if (price > cap) return refuse(`twzrd_unevaluated_over_cap_${price}_gt_${cap}`);
    return {
      approved: true,
      verdict: "warn",
      reason: `twzrd_unevaluated_within_cap_${price}_le_${cap}`,
      unevaluated: true,
      recommendedCapUsdc: cap,
    };
  }
  if (decision !== "allow" && decision !== "warn") {
    return { approved: false, verdict: "block", reason: `twzrd_decision_${decision}`, unevaluated: false };
  }
  if (decision === "warn" && refuseUncappedWarn !== false) {
    if (cap === null) return { approved: false, verdict: "block", reason: "twzrd_warn_no_cap", unevaluated: false };
    if (price === null) return { approved: false, verdict: "block", reason: "twzrd_warn_unknown_price", unevaluated: false };
  }
  return {
    approved: true,
    verdict: decision,
    reason: decision === "warn" ? "twzrd_warn_allowed" : "twzrd_allow",
    unevaluated: false,
    recommendedCapUsdc: cap,
  };
}

/** The gate's over-cap refusal (twzrdApprovePayment): an approved card, priced above its cap. */
export function overRecommendedCap(evaluation, priceUsdc) {
  const price = finiteNumber(priceUsdc);
  const cap = evaluation?.recommendedCapUsdc;
  if (!evaluation?.approved || cap == null || price === null || price <= cap) return null;
  return `twzrd_over_recommended_cap_${price}_gt_${cap}`;
}

/**
 * True only for full, fresh wash coverage: wash_flagged is a boolean, wash_stale is not true,
 * ring_evaluated is not false, and the confidence (wash_confidence, else confidence) is "full".
 * A missing card is not coverage. Copy of twzrd-x402-gate 0.13.0 washEvidenceFromCard plus
 * isWashCoverageAdequate (src/wash-default.ts), which also refuses every confidence but full.
 */
export function isWashCoverageAdequate(mcard) {
  if (!mcard || typeof mcard !== "object") return false;
  if (typeof mcard.wash_flagged !== "boolean") return false;
  if (mcard.wash_stale === true) return false;
  const ring =
    typeof mcard.ring_evaluated === "boolean" ? mcard.ring_evaluated : mcard.circular_flow_signals?.ring_evaluated;
  if (ring === false) return false;
  const raw =
    typeof mcard.wash_confidence === "string" && mcard.wash_confidence.trim()
      ? mcard.wash_confidence
      : typeof mcard.confidence === "string" && mcard.confidence.trim()
        ? mcard.confidence
        : "";
  return raw.trim().toLowerCase() === "full";
}

/**
 * The twzrd.payment_decision.v1 decision and reason_code for one outcome, in the order
 * twzrd-x402-gate 0.13.0 decisionFromApproval (src/payment-decision.ts) applies them.
 */
export function paymentDecisionFor({ approved, reason, verdict, outage = false, washFlagged = false, unevaluated = false }) {
  const r = String(reason ?? "");
  if (/^twzrd_fail_(?:closed|open)\b|^twzrd_card_unreachable/.test(r) || (approved && outage)) {
    return { decision: "unavailable", reason_code: "INTEL_UNAVAILABLE" };
  }
  if (!approved && (washFlagged || /twzrd_wash_flagged/.test(r))) return { decision: "block", reason_code: "WASH_FLAGGED" };
  if (unevaluated) {
    if (approved) return { decision: "warn", reason_code: "UNKNOWN_UNDER_LIMIT" };
    return { decision: "block", reason_code: /^twzrd_unevaluated_/.test(r) ? "UNKNOWN_ABOVE_LIMIT" : "INTEL_BLOCK" };
  }
  if (!approved) return { decision: "block", reason_code: "INTEL_BLOCK" };
  if (verdict === "warn") return { decision: "warn", reason_code: "INTEL_WARN" };
  return { decision: "allow", reason_code: "ALLOW" };
}

/** Why each refusal reason refused, and the config that lets the operator pay anyway. */
function refusalCopy(reason, intent) {
  const payee = intent.sellerWallet ?? intent.origin;
  if (reason === "twzrd_warn_no_cap") {
    return { why: `intel warned on ${payee} and gave no recommended spend cap`, optOut: "refuseUncappedWarn: false" };
  }
  if (reason === "twzrd_warn_unknown_price") {
    return {
      why: `intel warned on ${payee}, and this call names no price to hold to its recommended cap`,
      optOut: "refuseUncappedWarn: false",
    };
  }
  if (reason.startsWith("twzrd_over_recommended_cap_") || reason.startsWith("twzrd_unevaluated_over_cap_")) {
    return { why: `the price is above intel's recommended cap for ${payee}`, optOut: "allowWallets" };
  }
  if (reason.startsWith("twzrd_unevaluated_subject_")) {
    return {
      why: `intel has never evaluated ${payee}`,
      optOut: "refuseUnevaluated: false (which pays it up to the card's recommended cap)",
    };
  }
  if (reason.startsWith("twzrd_unevaluated_")) {
    return { why: `intel has never evaluated ${payee}, and its cap or this call's price is unknown`, optOut: "allowWallets" };
  }
  if (reason.startsWith("twzrd_wash_flagged")) {
    return { why: `intel flags ${payee} for wash trading`, optOut: "refuseWashFlagged: false" };
  }
  if (reason === "twzrd_wash_unknown") {
    return {
      why: `the merchant card for ${payee} does not show full, fresh wash coverage`,
      optOut: "refuseWashUnknown: false",
    };
  }
  return { why: `intel returned no readiness decision this gate pays on for ${payee}`, optOut: "allowWallets" };
}

export function createGate(rawCfg = {}, logger = console) {
  const cfg = { ...DEFAULTS, ...rawCfg };
  if (typeof cfg.fetch !== "function") {
    cfg.fetch = globalThis.fetch.bind(globalThis);
  }
  const log = {
    info: (...a) => logger.info?.("[twzrd-preflight]", ...a),
    warn: (...a) => logger.warn?.("[twzrd-preflight]", ...a),
  };
  const selfHost = host(cfg.endpoint);
  /** origin -> { wallet, ts } learned from observed 402 envelopes */
  const payToByOrigin = new Map();
  /** cacheKey -> { decision, ts } */
  const decisionCache = new Map();
  const stats = { evaluated: 0, blocked: 0, wouldBlock: 0, apiFailures: 0, unparsed: 0 };
  /** last preflight request body — test/debug introspection */
  let lastRequest = null;

  function fresh(entry) {
    return entry && Date.now() - entry.ts < cfg.cacheTtlMs;
  }

  /**
   * Extract a payment intent from a tool call, or null when none can be read. A null
   * here is not yet a pass: beforeToolCall asks unparsedPayment whether the call is
   * still a payment, and refuses it if so.
   */
  function matchIntent(toolName, params) {
    // Loop guard: never gate calls aimed at the trust API itself.
    const paramText = (() => {
      try {
        return JSON.stringify(params);
      } catch {
        return "";
      }
    })();
    if (selfHost && paramText.includes(selfHost)) return null;

    // 1) Explicit seller_wallet param (payment-aware MCP tools).
    if (typeof params?.seller_wallet === "string") {
      return {
        sellerWallet: params.seller_wallet,
        priceUsdc: typeof params.price_usdc === "number" ? params.price_usdc : null,
        resourceName: typeof params.resource_name === "string" ? params.resource_name : null,
        origin: null,
        source: "param:seller_wallet",
      };
    }

    // 2) AgentCash-style MCP tools: counterparty is the origin/url param.
    if (PAYMENTISH_TOOL.test(toolName)) {
      const raw = params?.origin ?? params?.url;
      const origin = typeof raw === "string" ? (originOf(raw) ?? raw) : null;
      if (origin) {
        const cached = payToByOrigin.get(origin);
        return {
          sellerWallet: fresh(cached) ? cached.wallet : null,
          priceUsdc: typeof params.price_usdc === "number" ? params.price_usdc : null,
          resourceName: null,
          origin,
          source: fresh(cached) ? "origin+payTo-cache" : "origin",
        };
      }
      // No origin found in built-in params — fall through to custom matchers.
    }

    // 3) exec/bash command strings: scan for x402 payment markers.
    const command = typeof params?.command === "string" ? params.command : null;
    if ((EXEC_TOOLS.has(toolName) || command) && command) {
      if (selfHost && command.includes(selfHost)) return null; // loop guard
      const wallet = RE.sellerWallet.exec(command)?.[1] ?? RE.payToKv.exec(command)?.[1] ?? null;
      if (!wallet) {
        // A command that sends a signed x402 payment header pays the URL's origin. Its
        // payee is readable only from the payTo this gate saw in that origin's 402.
        const origin = RE.paymentHeader.test(command) ? originOf(command.match(RE.url)?.[0] ?? "") : null;
        const cached = origin ? payToByOrigin.get(origin) : null;
        if (!fresh(cached)) return null;
        return {
          sellerWallet: cached.wallet,
          priceUsdc: null,
          resourceName: null,
          origin,
          source: "exec:payment-header+payTo-cache",
          signed: true,
        };
      }
      const price = RE.price.exec(command)?.[1];
      return {
        sellerWallet: wallet,
        priceUsdc: price ? Number(price) : null,
        resourceName: RE.resourceName.exec(command)?.[1] ?? null,
        origin: null,
        source: "exec:regex",
      };
    }

    // 4) Custom matchers from config — operator-defined tool coverage.
    for (const m of cfg.matchers ?? []) {
      if (!toolName.toLowerCase().includes(m.tool.toLowerCase())) continue;
      const wallet = m.walletParam ? (params?.[m.walletParam] ?? null) : null;
      const rawUrl = m.urlParam ? (params?.[m.urlParam] ?? null) : null;
      const origin = typeof rawUrl === "string" ? (originOf(rawUrl) ?? rawUrl) : null;
      if (!wallet && !origin) continue;
      return {
        sellerWallet: typeof wallet === "string" ? wallet : null,
        priceUsdc: m.priceParam && typeof params?.[m.priceParam] === "number" ? params[m.priceParam] : null,
        resourceName: m.resourceParam && typeof params?.[m.resourceParam] === "string" ? params[m.resourceParam] : null,
        origin,
        source: `matcher:${m.tool}`,
      };
    }

    return null;
  }

  /**
   * For a call matchIntent could not read: why it is still a payment, or null when it is
   * not payment-shaped. Two shapes count:
   *   - an exec command sending a signed x402 payment header to a URL. It was signed before
   *     this hook ran, so refusing it stops the payment being sent, not the signing;
   *   - a payment-named tool (paymentNamed) that carries a URL in a param other than
   *     origin/url. The tool has not run, so its signer has not either.
   */
  function unparsedPayment(toolName, params) {
    let paramText = "";
    try {
      paramText = JSON.stringify(params) ?? "";
    } catch {
      paramText = "";
    }
    if (selfHost && paramText.includes(selfHost)) return null; // loop guard
    const command = typeof params?.command === "string" ? params.command : null;
    if (command) {
      const url = command.match(RE.url)?.[0];
      if (!url || !RE.paymentHeader.test(command)) return null;
      return {
        signed: true,
        target: originOf(url) ?? url,
        why:
          `this command sends a signed x402 payment to ${originOf(url) ?? url}, but names no Solana ` +
          `seller wallet, and this gate has seen no 402 from that origin to read the payee from`,
        fix: "Make the unpaid request first, so the 402's payTo is observed",
      };
    }
    const url = paramText.match(RE.url)?.[0];
    if (!url || !paymentNamed(toolName)) return null;
    return {
      signed: false,
      target: originOf(url) ?? url,
      why: `${toolName} is a payment tool, and its URL is not in an origin or url param this gate reads`,
      fix: "Add a matcher for this tool naming its urlParam or walletParam",
    };
  }

  /**
   * POST the free preflight. Returns the readiness card (an object, {} when intel sent none),
   * or null on failure. The card is cached, not the decision: the outcome also depends on
   * each call's price, so it is evaluated per call.
   */
  async function preflight(intent, toolName) {
    const key = intent.sellerWallet ?? intent.origin;
    const cached = decisionCache.get(key);
    if (fresh(cached)) return cached.card;

    const body = {
      seller_wallet: intent.sellerWallet ?? undefined,
      resource_name: intent.resourceName ?? undefined,
      resource_url: intent.origin ?? undefined,
      price_usdc: intent.priceUsdc ?? undefined,
      agent_intent: `openclaw:before_tool_call:${toolName}:${cfg.mode}`,
    };
    lastRequest = body;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await cfg.fetch(`${cfg.endpoint}/v1/intel/preflight`, {
        method: "POST",
        headers: { 
          "content-type": "application/json",
          "X-Twzrd-Caller": CALLER,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // As twzrd-x402-gate reads it: the readiness_card, else the body itself.
      const raw = json?.readiness_card ?? json;
      const card = raw && typeof raw === "object" ? raw : {};
      decisionCache.set(key, { decision: card.decision, ts: Date.now(), card });
      return card;
    } catch (err) {
      stats.apiFailures += 1;
      log.warn(`preflight unavailable (${err?.message ?? err})`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function renderReason(intent, key) {
    const card = decisionCache.get(key)?.card ?? {};
    const caveats = (card.caveats ?? []).slice(0, 3).join("; ");
    return (
      `TWZRD trust gate: payment to ${intent.sellerWallet ?? intent.origin} blocked — ` +
      `decision=block, trust_score=${card.trust_score ?? "?"}. ${caveats ? `Caveats: ${caveats}. ` : ""}` +
      `Do not retry this payment as-is; the operator must allowlist this counterparty in the ` +
      `twzrd-preflight plugin config to proceed.`
    );
  }

  /** The blockReason for a refusal under one of the 0.13.0 rules: why, and its opt-out. */
  function renderRuleReason(intent, reason) {
    const { why, optOut } = refusalCopy(reason, intent);
    return (
      `TWZRD trust gate: payment to ${intent.sellerWallet ?? intent.origin} blocked (${reason}): ${why}. ` +
      `Do not retry this payment as-is; the operator can set ${optOut} in the twzrd-preflight ` +
      `plugin config to proceed.`
    );
  }

  /**
   * Hand one intel-evaluated outcome to cfg.onDecision as a twzrd.payment_decision.v1
   * decision and reason_code. Telemetry: a callback that throws or rejects never changes
   * the verdict and never reaches the host.
   */
  function reportDecision(intent, outcome, pays) {
    if (typeof cfg.onDecision !== "function") return;
    const { decision, reason_code } = paymentDecisionFor(outcome);
    try {
      Promise.resolve(
        cfg.onDecision({
          decision,
          reason_code,
          twzrd_reason: outcome.reason,
          pays,
          payee: intent.sellerWallet ?? intent.origin,
        }),
      ).catch(() => {});
    } catch {
      /* telemetry */
    }
  }

  function verdict(reason, intent, toolName) {
    if (cfg.mode === "enforce") {
      stats.blocked += 1;
      log.warn(`BLOCK ${toolName} → ${intent.sellerWallet ?? intent.origin} (${reason})`);
      return true;
    }
    stats.wouldBlock += 1;
    log.info(`would-block (shadow) ${toolName} → ${intent.sellerWallet ?? intent.origin} (${reason})`);
    return false;
  }

  /**
   * The gate_eval_refuse transcript records signer_invocation_count 0. A command that
   * already carries a signed payment header was signed before this hook ran, so it gets
   * no transcript.
   */
  function refuseFor(intent, reason) {
    if (intent.signed) return undefined;
    return buildRefuse({ payTo: intent.sellerWallet, reason, verdict: "block" });
  }

  async function beforeToolCall(event /*, ctx */) {
    if (cfg.mode === "off") return;
    const intent = matchIntent(event.toolName, event.params ?? {});
    if (!intent) {
      // Refused whatever failMode says: this is not an outage, there is no payee to ask about.
      const unparsed = cfg.refuseUnparsedPayments ? unparsedPayment(event.toolName, event.params ?? {}) : null;
      if (!unparsed) return;
      stats.unparsed += 1;
      if (verdict(`unparsed payment (${unparsed.why})`, { origin: unparsed.target }, event.toolName)) {
        return {
          block: true,
          blockReason:
            `TWZRD trust gate: ${unparsed.why}, so the payee could not be checked and the call ` +
            `was not run. ${unparsed.fix}, or the operator can set refuseUnparsedPayments: false.`,
          refuse: refuseFor(unparsed, "twzrd_unparsed_payment"),
        };
      }
      return;
    }
    stats.evaluated += 1;

    if (intent.sellerWallet && cfg.allowWallets.includes(intent.sellerWallet)) return;

    if (intent.sellerWallet && cfg.denyWallets.includes(intent.sellerWallet)) {
      if (verdict("local denylist", intent, event.toolName)) {
        return {
          block: true,
          blockReason: `TWZRD trust gate: ${intent.sellerWallet} is on the local denylist.`,
        };
      }
      return;
    }

    if (
      cfg.maxPriceUsdc != null &&
      intent.priceUsdc != null &&
      intent.priceUsdc > cfg.maxPriceUsdc
    ) {
      if (verdict(`price ${intent.priceUsdc} > cap ${cfg.maxPriceUsdc}`, intent, event.toolName)) {
        return {
          block: true,
          blockReason:
            `TWZRD trust gate: payment of ${intent.priceUsdc} USDC exceeds the local ` +
            `maxPriceUsdc cap (${cfg.maxPriceUsdc}).`,
        };
      }
      return;
    }

    const key = intent.sellerWallet ?? intent.origin;
    // A refusal blocks in enforce mode and is a would-block in shadow mode; either way the
    // outcome is reported.
    const settle = (outcome, blockReason) => {
      const refused = !outcome.approved && verdict(outcome.reason, intent, event.toolName);
      reportDecision(intent, outcome, !refused);
      if (!refused) return undefined;
      return { block: true, blockReason: blockReason(), refuse: refuseFor(intent, outcome.reason) };
    };

    const card = await preflight(intent, event.toolName);
    if (card === null) {
      // API unreachable → failMode applies. Default closed.
      if (cfg.failMode === "closed") {
        return settle(
          { approved: false, reason: "twzrd_fail_closed" },
          () => "TWZRD trust gate: trust API unreachable and failMode=closed — payment not evaluated.",
        );
      }
      return settle({ approved: true, reason: "twzrd_fail_open", outage: true }); // fail-open opt-in
    }

    // The readiness card, then its cap, then the merchant card: twzrd-x402-gate 0.13.0's order.
    const evaluation = evaluateReadinessCard(card, {
      priceUsdc: intent.priceUsdc,
      refuseUncappedWarn: cfg.refuseUncappedWarn,
      refuseUnevaluated: cfg.refuseUnevaluated,
    });
    const overCap = overRecommendedCap(evaluation, intent.priceUsdc);
    if (overCap) {
      return settle({ ...evaluation, approved: false, verdict: "block", reason: overCap }, () =>
        renderRuleReason(intent, overCap),
      );
    }

    // The merchant card is read while refuseWashFlagged is on, as in the gate; refuseWashUnknown
    // applies only then. A payee known only by origin has no wallet to look up, and skips it.
    let washFlagged = null;
    let coverageAdequate = null;
    let cardUnreachable = false;
    if (cfg.refuseWashFlagged && intent.sellerWallet) {
      let mcard = null;
      try {
        mcard = await fetchMerchantCard(intent.sellerWallet, {
          intelBase: cfg.endpoint,
          fetch: cfg.fetch,
        });
        // A card that answers 404 (null) is reachable, and is no coverage.
        coverageAdequate = isWashCoverageAdequate(mcard);
      } catch (err) {
        // twzrd-x402-gate >= 0.9.12 throws MerchantCardUnreachableError on outage instead of
        // returning null, so "intel down" can no longer pass as "no wash signal".
        stats.apiFailures += 1;
        log.warn(`merchant_card unavailable (${err?.message ?? err})`);
        // Only tightens: an outage never relabels a payment already refused.
        if (cfg.failMode === "closed" && evaluation.approved) {
          return settle(
            { approved: false, reason: "twzrd_card_unreachable" },
            () =>
              "TWZRD trust gate: merchant_card (wash check) unreachable and failMode=closed — payment not evaluated.",
          );
        }
        // failMode=open (opt-in): wash status unknown, continue on the readiness card.
        cardUnreachable = evaluation.approved;
      }
      if (mcard && typeof mcard.wash_flagged === "boolean") {
        washFlagged = mcard.wash_flagged;
      }
    }
    const wash = applyWashFlaggedPolicy({
      approved: evaluation.approved,
      reason: evaluation.reason,
      washFlagged,
      priceUsdc: intent.priceUsdc,
      refuseWashFlagged: cfg.refuseWashFlagged === true,
    });
    let outcome = {
      ...evaluation,
      approved: wash.approved,
      reason: wash.reason,
      washFlagged: wash.washFlagged,
      outage: cardUnreachable,
    };
    if (!wash.approved && wash.washFlagged === true) outcome.verdict = "block";

    if (outcome.approved && cfg.refuseWashUnknown && coverageAdequate === false) {
      outcome = { ...outcome, approved: false, verdict: "block", reason: "twzrd_wash_unknown" };
    }

    // allow | warn within its cap, with full wash coverage (or wash-off) → proceed. A card that
    // says block keeps the reason this plugin has always rendered.
    return settle(outcome, () =>
      outcome.reason === "twzrd_decision_block" ? renderReason(intent, key) : renderRuleReason(intent, outcome.reason),
    );
  }

  /** Observe results for x402 402 envelopes; cache origin → payTo wallet. */
  async function afterToolCall(event /*, ctx */) {
    if (cfg.mode === "off") return;
    let text;
    try {
      text = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
    } catch {
      return;
    }
    if (!text || text.length > 1_000_000) return;
    const wallet = RE.payToJson.exec(text)?.[1] ?? RE.payToKv.exec(text)?.[1];
    if (!wallet) return;

    // Origin: prefer the request param, fall back to a URL in the result.
    const params = event.params ?? {};
    const fromParams =
      (typeof params.origin === "string" && originOf(params.origin)) ||
      (typeof params.url === "string" && originOf(params.url)) ||
      (typeof params.command === "string" &&
        originOf((params.command.match(RE.url) ?? [])[0] ?? ""));
    const fromResult = originOf((text.match(RE.url) ?? [])[0] ?? "");
    const origin = fromParams || fromResult;
    if (!origin || (selfHost && host(origin) === selfHost)) return;
    payToByOrigin.set(origin, { wallet, ts: Date.now() });
    log.info(`402 observed: ${origin} pays to ${wallet} (cached)`);
  }

  return {
    beforeToolCall,
    afterToolCall,
    stats,
    get lastRequest() {
      return lastRequest;
    },
    _caches: { payToByOrigin, decisionCache },
  };
}

const plugin = {
  id: "twzrd-preflight",
  name: "TWZRD Preflight",
  description:
    "Trust gate on twzrd-x402-gate 0.13.0: wrapFetchWithTwzrdPreflight on HTTP 402 plus payment-shaped tool-call hooks. Defaults: enforce, fail-closed; wash flagged or unknown, an uncapped warn and an unevaluated seller refuse.",
  register(api) {
    const gate = createGate(api.pluginConfig ?? {}, api.logger ?? console);
    // OpenClaw's plugin API registers hooks via `registerHook`, NOT `api.on`.
    //
    // This plugin shipped calling `api.on("before_tool_call", …, { priority: 10 })`.
    // Verified against openclaw@2026.7.1-2: `OpenClawPluginApi` has no `.on`
    // member at all (the only `on`-prefixed one is `onConversationBindingResolved`),
    // so registration threw `TypeError: api.on is not a function` and the gate
    // never installed. It did not degrade quietly — the plugin failed at load.
    //
    // `OpenClawPluginHookOptions` is `{ entry, name, description, register }`;
    // there is no `priority`, so that option was invalid too and is dropped.
    // The event NAMES are unchanged, so only the registration call moves.
    api.registerHook("before_tool_call", (event, ctx) => gate.beforeToolCall(event, ctx), {
      name: "twzrd-preflight:before_tool_call",
      description: "Preflight payment-shaped tool calls against the TWZRD trust gate.",
    });
    api.registerHook("after_tool_call", (event, ctx) => gate.afterToolCall(event, ctx), {
      name: "twzrd-preflight:after_tool_call",
      description: "Learn seller payTo from observed 402 challenges.",
    });
    api.logger?.info?.(
      `[twzrd-preflight] registered (mode=${(api.pluginConfig ?? {}).mode ?? DEFAULTS.mode})`,
    );
  },
};

export {
  wrapFetchWithTwzrdPreflight,
  getLastRefuse,
  resetLastRefuse,
  TwzrdPaymentBlockedError,
  installTwzrdFetchWrap,
  buildRefuse,
};

export default plugin;
