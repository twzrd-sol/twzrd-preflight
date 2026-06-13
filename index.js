/**
 * twzrd-preflight — OpenClaw plugin (Phase 1)
 *
 * Gates payment-shaped tool calls on TWZRD trust:
 *   before_tool_call → match payment intent → POST /v1/intel/preflight (free)
 *   → block when readiness_card.decision === "block" (enforce mode).
 *   after_tool_call → observe x402 402 envelopes → cache origin → payTo wallet
 *   so the follow-up payment call is gated against a real Solana pubkey.
 *
 * Coverage (honest): MCP payment tools + exec/curl x402 payments +
 *   custom matchers (configSchema.matchers array).
 * NOT covered: ClawRouter proxy settlements (sign inside localhost:8402,
 * invisible to tool hooks — needs the upstream onBeforePayment hook).
 *
 * Gate rule: decision === "block" only. NEVER gate on can_spend (free tier
 * defaults can_spend:false for unknown wallets; unknown = warn/45 = allow).
 *
 * Privacy: tool call metadata (toolName, seller_wallet, resource_name,
 * price_usdc) is sent to intel.twzrd.xyz for trust scoring. No payload
 * content or full params are forwarded. See https://intel.twzrd.xyz/privacy.
 */

const DEFAULTS = {
  mode: "shadow", // off | shadow | enforce
  failMode: "open", // open | closed
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
};
const EXEC_TOOLS = new Set(["exec", "bash", "shell", "system.run", "run"]);
const PAYMENTISH_TOOL = /agentcash|x402|pay/i;

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

export function createGate(rawCfg = {}, logger = console) {
  const cfg = { ...DEFAULTS, ...rawCfg };
  const log = {
    info: (...a) => logger.info?.("[twzrd-preflight]", ...a),
    warn: (...a) => logger.warn?.("[twzrd-preflight]", ...a),
  };
  const selfHost = host(cfg.endpoint);
  /** origin -> { wallet, ts } learned from observed 402 envelopes */
  const payToByOrigin = new Map();
  /** cacheKey -> { decision, ts } */
  const decisionCache = new Map();
  const stats = { evaluated: 0, blocked: 0, wouldBlock: 0, apiFailures: 0 };
  /** last preflight request body — test/debug introspection */
  let lastRequest = null;

  function fresh(entry) {
    return entry && Date.now() - entry.ts < cfg.cacheTtlMs;
  }

  /**
   * Extract a payment intent from a tool call, or null when the call is not
   * payment-shaped. Conservative on purpose: a failed parse means NO gate
   * (never block on our own extraction bugs).
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
      if (!wallet) return null;
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

  /** POST the free preflight. Returns "allow"|"warn"|"block", or null on failure. */
  async function preflight(intent, toolName) {
    const key = intent.sellerWallet ?? intent.origin;
    const cached = decisionCache.get(key);
    if (fresh(cached)) return cached.decision;

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
      const res = await fetch(`${cfg.endpoint}/v1/intel/preflight`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const card = json.readiness_card ?? {};
      const decision = card.decision ?? "warn";
      decisionCache.set(key, { decision, ts: Date.now(), card });
      return decision;
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

  async function beforeToolCall(event /*, ctx */) {
    if (cfg.mode === "off") return;
    const intent = matchIntent(event.toolName, event.params ?? {});
    if (!intent) return;
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

    const decision = await preflight(intent, event.toolName);
    if (decision === null) {
      // API unreachable → failMode applies.
      if (cfg.failMode === "closed") {
        if (verdict("trust API unreachable (failMode=closed)", intent, event.toolName)) {
          return {
            block: true,
            blockReason:
              "TWZRD trust gate: trust API unreachable and failMode=closed — payment not evaluated.",
          };
        }
      }
      return; // fail-open
    }
    if (decision === "block") {
      const key = intent.sellerWallet ?? intent.origin;
      if (verdict("decision=block", intent, event.toolName)) {
        return { block: true, blockReason: renderReason(intent, key) };
      }
    }
    // allow | warn → proceed.
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
    "Trust gate for agent payments: blocks payment-shaped tool calls when TWZRD preflight says the counterparty is not safe to pay.",
  register(api) {
    const gate = createGate(api.pluginConfig ?? {}, api.logger ?? console);
    api.on("before_tool_call", (event, ctx) => gate.beforeToolCall(event, ctx), { priority: 10 });
    api.on("after_tool_call", (event, ctx) => gate.afterToolCall(event, ctx));
    api.logger?.info?.(
      `[twzrd-preflight] registered (mode=${(api.pluginConfig ?? {}).mode ?? DEFAULTS.mode})`,
    );
  },
};

export default plugin;
