/**
 * Phase 1 harness: exercises the gate hooks directly (no OpenClaw gateway needed).
 * Calls the LIVE free preflight API (no auth, no payments). Run: npm test
 */
import { createGate } from "../index.js";
import plugin from "../index.js";

const QUIET = { info() {}, warn() {} };
// Live-verified today: this resource+wallet pair returns decision=block (score 31).
const BLOCK_RESOURCE = "Jupiter Quote Preview";
const BLOCK_WALLET = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
// Live-verified today: unknown-but-valid pubkey returns decision=warn (score 45).
const UNKNOWN_WALLET = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";

const curlCmd = (wallet, resource, price) =>
  `curl -s -X POST https://api.example-x402.dev/v1/thing -H 'content-type: application/json' ` +
  `-d '{"resource_name":"${resource}","seller_wallet":"${wallet}","price_usdc":${price},"agent_intent":"buy"}'`;

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log("twzrd-preflight Phase 1 harness (live free API)\n");

await t("T1 non-payment tool is ignored (no API call)", async () => {
  const g = createGate({ mode: "enforce" }, QUIET);
  const r = await g.beforeToolCall({ toolName: "read_file", params: { path: "/tmp/x" } });
  assert(r === undefined, `expected undefined, got ${JSON.stringify(r)}`);
  assert(g.stats.evaluated === 0, "should not have evaluated");
  assert(g.lastRequest === null, "should not have called the API");
});

await t("T2 enforce: exec curl to known-block seller → block", async () => {
  const g = createGate({ mode: "enforce" }, QUIET);
  const r = await g.beforeToolCall({
    toolName: "exec",
    params: { command: curlCmd(BLOCK_WALLET, BLOCK_RESOURCE, 0.05) },
  });
  assert(r?.block === true, `expected block, got ${JSON.stringify(r)}`);
  assert(/decision=block/.test(r.blockReason), "reason should cite decision=block");
  assert(g.stats.blocked === 1, "blocked counter");
});

await t("T3 shadow: same call → allowed, would-block recorded", async () => {
  const g = createGate({ mode: "shadow" }, QUIET);
  const r = await g.beforeToolCall({
    toolName: "exec",
    params: { command: curlCmd(BLOCK_WALLET, BLOCK_RESOURCE, 0.05) },
  });
  assert(r === undefined, `shadow must not block, got ${JSON.stringify(r)}`);
  assert(g.stats.wouldBlock === 1, "wouldBlock counter");
});

await t("T4 enforce: unknown wallet → warn → allowed", async () => {
  const g = createGate({ mode: "enforce" }, QUIET);
  const r = await g.beforeToolCall({
    toolName: "exec",
    params: { command: curlCmd(UNKNOWN_WALLET, "Some Unknown Thing", 0.05) },
  });
  assert(r === undefined, `warn must not block, got ${JSON.stringify(r)}`);
});

await t("T5 enforce: local maxPriceUsdc cap blocks without API call", async () => {
  const g = createGate({ mode: "enforce", maxPriceUsdc: 0.01 }, QUIET);
  const r = await g.beforeToolCall({
    toolName: "exec",
    params: { command: curlCmd(UNKNOWN_WALLET, "Some Unknown Thing", 0.05) },
  });
  assert(r?.block === true, `expected price-cap block, got ${JSON.stringify(r)}`);
  assert(/maxPriceUsdc/.test(r.blockReason), "reason should cite the cap");
  assert(g.lastRequest === null, "cap must short-circuit before the API");
});

await t("T6 402 payTo cache → local denylist block on follow-up call", async () => {
  const g = createGate({ mode: "enforce", denyWallets: [BLOCK_WALLET] }, QUIET);
  await g.afterToolCall({
    toolName: "agentcash_fetch",
    params: { url: "https://api.example-x402.dev/v1/thing" },
    result: {
      status: 402,
      body: { accepts: [{ scheme: "exact", payTo: BLOCK_WALLET, amount: "50000" }] },
    },
  });
  assert(g._caches.payToByOrigin.has("https://api.example-x402.dev"), "payTo should be cached");
  const r = await g.beforeToolCall({
    toolName: "agentcash_fetch",
    params: { url: "https://api.example-x402.dev/v1/thing", price_usdc: 0.05 },
  });
  assert(r?.block === true, `expected denylist block, got ${JSON.stringify(r)}`);
  assert(g.lastRequest === null, "denylist must short-circuit before the API");
});

await t("T6b cache-derived wallet is sent to preflight (allow on warn)", async () => {
  const g = createGate({ mode: "enforce" }, QUIET);
  await g.afterToolCall({
    toolName: "agentcash_fetch",
    params: { url: "https://api.example-x402.dev/v1/thing" },
    result: `HTTP 402 {"accepts":[{"payTo":"${UNKNOWN_WALLET}"}]}`,
  });
  const r = await g.beforeToolCall({
    toolName: "agentcash_fetch",
    params: { url: "https://api.example-x402.dev/v1/other" },
  });
  assert(r === undefined, `warn must allow, got ${JSON.stringify(r)}`);
  assert(
    g.lastRequest?.seller_wallet === UNKNOWN_WALLET,
    `preflight should receive the cached payTo wallet, got ${JSON.stringify(g.lastRequest)}`,
  );
});

await t("T7a API unreachable + failMode=open → allow", async () => {
  const g = createGate(
    { mode: "enforce", endpoint: "http://127.0.0.1:9", timeoutMs: 800 },
    QUIET,
  );
  const r = await g.beforeToolCall({
    toolName: "exec",
    params: { command: curlCmd(UNKNOWN_WALLET, "X", 0.05) },
  });
  assert(r === undefined, `fail-open must allow, got ${JSON.stringify(r)}`);
  assert(g.stats.apiFailures === 1, "apiFailures counter");
});

await t("T7b API unreachable + failMode=closed → block", async () => {
  const g = createGate(
    { mode: "enforce", failMode: "closed", endpoint: "http://127.0.0.1:9", timeoutMs: 800 },
    QUIET,
  );
  const r = await g.beforeToolCall({
    toolName: "exec",
    params: { command: curlCmd(UNKNOWN_WALLET, "X", 0.05) },
  });
  assert(r?.block === true, `fail-closed must block, got ${JSON.stringify(r)}`);
});

await t("T8 loop guard: calls to the trust API itself are never gated", async () => {
  const g = createGate({ mode: "enforce" }, QUIET);
  const r = await g.beforeToolCall({
    toolName: "exec",
    params: {
      command:
        `curl -s -X POST https://intel.twzrd.xyz/v1/intel/preflight ` +
        `-d '{"seller_wallet":"${BLOCK_WALLET}","resource_name":"${BLOCK_RESOURCE}"}'`,
    },
  });
  assert(r === undefined, `loop guard failed: ${JSON.stringify(r)}`);
  assert(g.stats.evaluated === 0, "must not even evaluate");
});

await t("T9 telemetry marker: agent_intent carries hook + tool + mode", async () => {
  const g = createGate({ mode: "enforce" }, QUIET);
  await g.beforeToolCall({
    toolName: "exec",
    params: { command: curlCmd(UNKNOWN_WALLET, "Some Unknown Thing", 0.05) },
  });
  assert(
    g.lastRequest?.agent_intent === "openclaw:before_tool_call:exec:enforce",
    `bad marker: ${g.lastRequest?.agent_intent}`,
  );
});

await t("T10 plugin registers both hooks via the OpenClaw api surface", async () => {
  const hooks = {};
  const api = {
    pluginConfig: { mode: "shadow" },
    logger: QUIET,
    on(name, fn) {
      hooks[name] = fn;
    },
  };
  plugin.register(api);
  assert(typeof hooks.before_tool_call === "function", "before_tool_call registered");
  assert(typeof hooks.after_tool_call === "function", "after_tool_call registered");
  const r = await hooks.before_tool_call(
    { toolName: "exec", params: { command: curlCmd(BLOCK_WALLET, BLOCK_RESOURCE, 0.05) } },
    {},
  );
  assert(r === undefined, "shadow via real register() must not block");
});

await t("T11 custom matcher: walletParam extracted and sent to preflight", async () => {
  const g = createGate(
    {
      mode: "enforce",
      matchers: [{ tool: "payment_send", walletParam: "recipient", priceParam: "amount_usdc", resourceParam: "memo" }],
    },
    QUIET,
  );
  // Unknown wallet → warn → allow, but preflight should have been called with the wallet
  const r = await g.beforeToolCall({
    toolName: "payment_send",
    params: { recipient: UNKNOWN_WALLET, amount_usdc: 0.01, memo: "test payment" },
  });
  assert(r === undefined, `warn must allow, got ${JSON.stringify(r)}`);
  assert(
    g.lastRequest?.seller_wallet === UNKNOWN_WALLET,
    `matcher must forward walletParam to preflight, got ${JSON.stringify(g.lastRequest)}`,
  );
  assert(
    g.lastRequest?.price_usdc === 0.01,
    `matcher must forward priceParam, got ${JSON.stringify(g.lastRequest)}`,
  );
  assert(
    g.lastRequest?.resource_name === "test payment",
    `matcher must forward resourceParam, got ${JSON.stringify(g.lastRequest)}`,
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
