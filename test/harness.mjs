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

/** Concatenate every .d.ts under a dir (one level deep is enough for openclaw/dist). */
async function collectDts(dir) {
  let out = "";
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".d.ts")) {
      out += await readFile(path.join(dir, e.name), "utf8");
    }
  }
  return out;
}

const QUIET = { info() {}, warn() {} };
// Live-verified today: this resource+wallet pair returns decision=block (score 31).
const BLOCK_RESOURCE = "Jupiter Quote Preview";
const BLOCK_WALLET = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
// Live-verified today: unknown-but-valid pubkey returns decision=warn (score 45).
const UNKNOWN_WALLET = "GFpLvocNdEjnSsLH3VJQL6wGcjGxTbUBrj6fqN3Qe1Gs";

const LIVE = process.env.TWZRD_PREFLIGHT_LIVE === "1";
const INTEL = "https://intel.twzrd.xyz";
/**
 * What intel answers for the two recorded sellers; the offline stub serves these. The warn
 * card carries a recommended cap, so a priced call under it pays (refuseUncappedWarn).
 */
const RECORDED_CARDS = {
  [BLOCK_WALLET]: { decision: "block", trust_score: 31, can_spend: false },
  [UNKNOWN_WALLET]: { decision: "warn", trust_score: 45, can_spend: false, recommended_cap_usdc: 0.05 },
};
/** A merchant card with full wash coverage and no finding. */
const CLEAN_MERCHANT_CARD = { wash_flagged: false, wash_confidence: "full", ring_evaluated: true, wash_stale: false };
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Requests the offline stub had no recorded answer for; TX fails on any. */
const unrecorded = [];

if (!LIVE) {
  const realFetch = globalThis.fetch.bind(globalThis);
  // Installed before any test runs. createGate and the gate read globalThis.fetch when
  // they are called, not when they are imported, so every default-fetch path sees this.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return realFetch(input, init);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url.origin === INTEL && method === "POST" && url.pathname === "/v1/intel/preflight") {
      const seller = JSON.parse(init?.body ?? "{}").seller_wallet;
      if (RECORDED_CARDS[seller]) return jsonResponse({ readiness_card: { ...RECORDED_CARDS[seller], seller_wallet: seller } });
    }
    const card = url.origin === INTEL && method === "GET" && /^\/v1\/intel\/merchant_card\/([^/]+)$/.exec(url.pathname);
    if (card && RECORDED_CARDS[decodeURIComponent(card[1])]) return jsonResponse(CLEAN_MERCHANT_CARD);
    unrecorded.push(`${method} ${url.href}`);
    throw new TypeError(`offline harness: no recorded answer for ${method} ${url.href}`);
  };
}

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

console.log(`twzrd-preflight Phase 1 harness (${LIVE ? "live free API" : "offline, intel stubbed"})\n`);

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
    params: { url: "https://api.example-x402.dev/v1/other", price_usdc: 0.01 },
  });
  assert(r === undefined, `warn under its cap must allow, got ${JSON.stringify(r)}`);
  assert(
    g.lastRequest?.seller_wallet === UNKNOWN_WALLET,
    `preflight should receive the cached payTo wallet, got ${JSON.stringify(g.lastRequest)}`,
  );
});

await t("T7a API unreachable + failMode=open → allow", async () => {
  const g = createGate(
    { mode: "enforce", failMode: "open", endpoint: "http://127.0.0.1:9", timeoutMs: 800 },
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

// T10 used to build its own `api` stub with an `.on()` method and assert the
// plugin called it. That passed for months while the plugin was DEAD on every
// recent OpenClaw build: `OpenClawPluginApi` has no `.on`, so the real
// `register()` threw `TypeError: api.on is not a function` and the gate never
// installed. The test asserted that our mock matched our mock.
//
// The stub below is derived from openclaw@2026.7.1-2's actual
// `OpenClawPluginApi` type: hooks register through `registerHook(events,
// handler, opts)`. It deliberately does NOT define `.on`, so a regression back
// to the old call fails loudly here instead of shipping green.
const OPENCLAW_CONTRACT_VERIFIED_AGAINST = "2026.7.1-2";

function makeOpenClawApiStub(pluginConfig = { mode: "shadow" }) {
  const hooks = {};
  const opts = {};
  return {
    hooks,
    opts,
    api: {
      id: "twzrd-preflight",
      name: "TWZRD Preflight",
      source: "test",
      registrationMode: "full",
      config: {},
      pluginConfig,
      logger: QUIET,
      // Present on the real API. NOTE: no `on` — that is the whole point.
      registerHook(events, handler, o) {
        for (const e of Array.isArray(events) ? events : [events]) {
          hooks[e] = handler;
          opts[e] = o;
        }
      },
      registerTool() {},
    },
  };
}

await t("T10 plugin registers both hooks via registerHook (real OpenClaw contract)", async () => {
  const { api, hooks, opts } = makeOpenClawApiStub();
  assert(api.on === undefined, "stub must not offer .on — the real API has no such member");

  plugin.register(api); // must not throw

  assert(typeof hooks.before_tool_call === "function", "before_tool_call registered");
  assert(typeof hooks.after_tool_call === "function", "after_tool_call registered");
  // OpenClawPluginHookOptions = { entry, name, description, register } — no `priority`.
  for (const e of ["before_tool_call", "after_tool_call"]) {
    assert(!("priority" in (opts[e] ?? {})), `${e}: 'priority' is not a valid hook option`);
  }
  const r = await hooks.before_tool_call(
    { toolName: "exec", params: { command: curlCmd(BLOCK_WALLET, BLOCK_RESOURCE, 0.05) } },
    {},
  );
  assert(r === undefined, "shadow via real register() must not block");
});

await t("T10b source guard: plugin must never call api.on(", async () => {
  // Source-level, so it cannot rot the way a hand-written stub can.
  // Comments are stripped first: prose ABOUT the old call (like the one above
  // the fix in index.js) must not trip the guard. A check that fires on its own
  // documentation is the "cries wolf" failure mode that gets guards deleted.
  const raw = await readFile(new URL("../index.js", import.meta.url), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert(
    !/\bapi\s*\.\s*on\s*\(/.test(code),
    "index.js calls api.on( — OpenClawPluginApi has no .on; use api.registerHook(...)",
  );
  assert(/api\s*\.\s*registerHook\s*\(/.test(code), "index.js must register via api.registerHook(");
  // The guard must be able to fail, or it is decoration.
  assert(
    /\bapi\s*\.\s*on\s*\(/.test('api.on("before_tool_call", h, { priority: 10 });'),
    "self-check: the api.on matcher must detect the old call form",
  );
});

await t("T10c contract check against the installed openclaw package (skips if absent)", async () => {
  // The only assertion that can detect the vendor moving again. Optional so the
  // suite still runs without openclaw installed — but when it IS installed, the
  // claim is derived from their shipped types, not from our belief about them.
  // Resolve by FILESYSTEM path, not import.meta.resolve: openclaw's package
  // `exports` map does not expose "./package.json", so the resolve form throws
  // even when the package IS installed — the test then skipped while reporting
  // PASS. That is the same hollow-gate bug this whole file exists to kill.
  const dir = path.join(fileURLToPath(new URL("../", import.meta.url)), "node_modules", "openclaw");
  let pkgRaw;
  try {
    pkgRaw = await readFile(path.join(dir, "package.json"), "utf8");
  } catch {
    console.log("  SKIP T10c (openclaw not installed — run `npm i -D openclaw` to enable)");
    return;
  }
  const pkg = JSON.parse(pkgRaw);
  const types = await collectDts(path.join(dir, "dist"));
  assert(/registerHook\s*:/.test(types), `openclaw@${pkg.version}: registerHook missing from types`);
  assert(
    /\bbefore_tool_call\b/.test(types),
    `openclaw@${pkg.version}: before_tool_call event no longer present`,
  );
  if (pkg.version !== OPENCLAW_CONTRACT_VERIFIED_AGAINST) {
    console.log(
      `  NOTE: openclaw ${pkg.version} != verified ${OPENCLAW_CONTRACT_VERIFIED_AGAINST} — contract re-checked above and still matches`,
    );
  }
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


await t("T10d package.json declares openclaw.extensions (npm install path)", async () => {
  // Without this field `openclaw plugins install twzrd-preflight` fails: the
  // loader reports the manifest as `missing` and never reaches index.js. Path
  // loading (plugins.load.paths) worked regardless, which is why the gap went
  // unnoticed — the install path is the one users are told to use.
  //
  // Contract, read from openclaw@2026.7.1-2's own manifest module:
  //   "openclaw.extensions must be an array"
  //   "openclaw.extensions[i] must be a non-empty string"
  //   entries must stay inside the plugin directory
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(pkgUrl, "utf8"));
  const ext = pkg.openclaw?.extensions;
  assert(Array.isArray(ext), "package.json: openclaw.extensions must be an array");
  assert(ext.length > 0, "package.json: openclaw.extensions must not be empty");
  for (const e of ext) {
    assert(typeof e === "string" && e.length > 0, `openclaw.extensions entry not a string: ${e}`);
    assert(!e.startsWith("/") && !e.includes(".."), `entry must stay inside the plugin dir: ${e}`);
    // The declared entry must actually exist, and must ship in the tarball.
    await readFile(new URL(`../${e.replace(/^\.\//, "")}`, import.meta.url), "utf8");
    const shipped = (pkg.files ?? []).some((f) => f === e.replace(/^\.\//, ""));
    assert(shipped, `openclaw.extensions entry "${e}" is not listed in package.json files[]`);
  }
});

await t("T10e openclaw's own manifest reader accepts our package.json (skips if absent)", async () => {
  // Strongest available check: hand our real package.json to openclaw's shipped
  // manifest module and require status "ok". Verified 2026-08-02 that removing
  // the field flips this to status "missing" — i.e. it can fail.
  const dir = path.join(fileURLToPath(new URL("../", import.meta.url)), "node_modules", "openclaw");
  let files;
  try {
    files = await readdir(path.join(dir, "dist"));
  } catch {
    console.log("  SKIP T10e (openclaw not installed — run `npm i -D openclaw` to enable)");
    return;
  }
  // The reader lives in a hash-named chunk: manifest-<hash>.js up to 2026.7.x,
  // package-manifest-<hash>.mjs from 2026.9.x. Match only hash-named chunks, never
  // manifest-command-aliases.runtime.js and friends (the old /^manifest-.*\.js$/ picked
  // one of those on 2026.9.7 and found no status function).
  const manifestFiles = files.filter((f) => /^(package-)?manifest-[A-Za-z0-9_-]{8}\.m?js$/.test(f));
  assert(manifestFiles.length > 0, "openclaw dist: manifest module not found (vendor layout changed?)");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const statuses = [];
  for (const file of manifestFiles) {
    const mod = await import(path.join(dir, "dist", file));
    for (const f of Object.values(mod)) {
      if (typeof f !== "function") continue;
      let r;
      try {
        r = f(pkg, dir);
      } catch {
        r = undefined;
      }
      if (r && typeof r === "object" && "status" in r) statuses.push(r);
    }
  }
  assert(statuses.length > 0, "no manifest status function found in openclaw dist");
  assert(
    statuses.some((r) => r.status === "ok"),
    `openclaw manifest reader rejected our package.json: ${JSON.stringify(statuses)}`,
  );
});


await t("T12 factory defaults are enforce + fail-closed + wash refuse", async () => {
  assert(DEFAULTS.mode === "enforce", `mode default ${DEFAULTS.mode}`);
  assert(DEFAULTS.failMode === "closed", `failMode default ${DEFAULTS.failMode}`);
  assert(DEFAULTS.refuseWashFlagged === true, "refuseWashFlagged must default true");
  assert(DEFAULTS.refuseUnparsedPayments === true, "refuseUnparsedPayments must default true");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const pluginManifest = JSON.parse(
    await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  assert(pkg.version === "0.5.0", `package.json version ${pkg.version}`);
  assert(pluginManifest.version === "0.5.0", `plugin manifest version ${pluginManifest.version}`);
  assert(pkg.dependencies?.["twzrd-x402-gate"] === "0.13.0", `gate pin ${pkg.dependencies?.["twzrd-x402-gate"]}`);
  assert(pluginManifest.configSchema.properties.mode.default === "enforce", "manifest mode default");
  assert(
    pluginManifest.configSchema.properties.failMode.default === "closed",
    "manifest failMode default",
  );
  assert(
    pluginManifest.configSchema.properties.refuseWashFlagged.default === true,
    "manifest refuseWashFlagged default",
  );
  assert(
    pluginManifest.configSchema.properties.refuseUnparsedPayments?.default === true,
    "manifest refuseUnparsedPayments default",
  );
  for (const key of ["refuseWashUnknown", "refuseUncappedWarn", "refuseUnevaluated"]) {
    assert(DEFAULTS[key] === true, `${key} must default true`);
    assert(pluginManifest.configSchema.properties[key]?.default === true, `manifest ${key} default`);
  }
});

await t("T13 injected 402 wash-flagged payTo throws; no pay retry; refuse transcript", async () => {
  resetLastRefuse();
  const WASH_PAYTO = "WashWashWashWashWashWashWashWashWashWash1111";
  let resourceCalls = 0;
  let intelCalls = 0;
  const RESOURCE = "https://seller.example/x402/item";

  const innerFetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(RESOURCE) || url.includes("seller.example")) {
      resourceCalls += 1;
      return new Response(
        JSON.stringify({
          accepts: [
            {
              scheme: "exact",
              network: "solana",
              payTo: WASH_PAYTO,
              maxAmountRequired: "50000",
              resource: RESOURCE,
            },
          ],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`inner fetch unexpected url ${url}`);
  };

  const intelFetch = async (input, init) => {
    intelCalls += 1;
    const url = typeof input === "string" ? input : input.url;
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && url.includes("/preflight")) {
      return new Response(
        JSON.stringify({
          readiness_card: {
            decision: "warn",
            trust_score: 50,
            can_spend: false,
            seller_wallet: WASH_PAYTO,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/merchant_card/")) {
      return new Response(JSON.stringify({ wash_flagged: true, merchant: WASH_PAYTO }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`intel fetch unexpected ${init?.method} ${url}`);
  };

  const gated = wrapFetchWithTwzrdPreflight(innerFetch, {
    fetch: intelFetch,
    refuseWashFlagged: true,
    failMode: "closed",
    endpoint: "https://intel.twzrd.xyz",
  });

  let threw = null;
  try {
    await gated(RESOURCE);
    // A caller that got a 402 back would retry with payment — that must not happen.
    resourceCalls += 1;
    await gated(RESOURCE, { headers: { "PAYMENT-SIGNATURE": "would-sign" } });
  } catch (err) {
    threw = err;
  }

  assert(threw instanceof TwzrdPaymentBlockedError, `expected TwzrdPaymentBlockedError, got ${threw}`);
  assert(resourceCalls === 1, `resource fetch must run once (no pay retry), got ${resourceCalls}`);
  assert(intelCalls >= 1, "intel must be consulted on 402");
  const refuse = threw.refuse ?? getLastRefuse();
  assert(refuse?.schema === "twzrd.gate_eval_refuse.v1", `schema ${refuse?.schema}`);
  assert(refuse.signer_invocation_count === 0, "signer_invocation_count");
  assert(refuse.usdc_spent === 0, "usdc_spent");
  assert(refuse.closes_external_adoption_metric === false, "must not claim EXTERNAL_RUN");
});

await t("T14 HTTP 200 never calls intel", async () => {
  let intelCalls = 0;
  const innerFetch = async () =>
    new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  const intelFetch = async () => {
    intelCalls += 1;
    throw new Error("intel must not be called on 200");
  };
  const gated = wrapFetchWithTwzrdPreflight(innerFetch, { fetch: intelFetch });
  const resp = await gated("https://example.com/ok");
  assert(resp.status === 200, `status ${resp.status}`);
  assert(intelCalls === 0, `intelCalls ${intelCalls}`);
});

await t("T15 default createGate is fail-closed without passing failMode", async () => {
  const g = createGate({ endpoint: "http://127.0.0.1:9", timeoutMs: 800 }, QUIET);
  const r = await g.beforeToolCall({
    toolName: "exec",
    params: { command: curlCmd(UNKNOWN_WALLET, "X", 0.05) },
  });
  assert(r?.block === true, `default fail-closed must block, got ${JSON.stringify(r)}`);
});

await t("T16 plugin empty config registers enforce (not shadow)", async () => {
  const { api, hooks } = makeOpenClawApiStub({});
  plugin.register(api);
  assert(typeof hooks.before_tool_call === "function", "hook registered");
});

const WASH_PAYTO = "WashWashWashWashWashWashWashWashWashWash1111";
const WASH_RESOURCE = "https://seller.example/x402/item";

function makeWashIntelFetch(counter) {
  return async (input, init) => {
    counter.intelCalls += 1;
    const url = typeof input === "string" ? input : input.url;
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && url.includes("/preflight")) {
      return new Response(
        JSON.stringify({
          readiness_card: {
            decision: "warn",
            trust_score: 50,
            can_spend: false,
            seller_wallet: WASH_PAYTO,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/merchant_card/")) {
      return new Response(JSON.stringify({ wash_flagged: true, merchant: WASH_PAYTO }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`intel fetch unexpected ${init?.method} ${url}`);
  };
}

await t("T17 installed twzrd-x402-gate is exact 0.13.0 + 0.13.0 APIs export", async () => {
  const dir = path.join(fileURLToPath(new URL("../", import.meta.url)), "node_modules", "twzrd-x402-gate");
  const gatePkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  assert(gatePkg.version === "0.13.0", `installed gate ${gatePkg.version}`);
  assert(GATE_CLIENT_VERSION === "0.13.0", `CLIENT_VERSION ${GATE_CLIENT_VERSION}`);
  assert(typeof createTwzrdBeforePaymentHook === "function", "createTwzrdBeforePaymentHook export");
  assert(
    typeof gatePkg.bin?.["twzrd-gate-eval-refuse"] === "string",
    "refuse binary declared in gate package.json",
  );
  const wrapRaw = await readFile(new URL("../wrap-fetch.js", import.meta.url), "utf8");
  const wrapCode = wrapRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert(
    !/\bpaymentRequiredFromResponse\b/.test(wrapCode),
    "wrap-fetch must not import paymentRequiredFromResponse (not a 0.13.0 package export)",
  );
});

await t("T18 createTwzrdBeforePaymentHook wash abort (injected; no signer / no USDC)", async () => {
  const counter = { intelCalls: 0 };
  const hook = createTwzrdBeforePaymentHook({
    fetch: makeWashIntelFetch(counter),
    refuseWashFlagged: true,
    failOpen: false,
    intelBase: "https://intel.twzrd.xyz",
    attribution: { integration: "twzrd-preflight-harness", runId: "t18-hook-wash" },
  });
  const result = await hook({
    payTo: WASH_PAYTO,
    network: "solana",
    maxAmountRequired: "50000",
    resource: WASH_RESOURCE,
  });
  assert(result?.abort === true, `expected abort, got ${JSON.stringify(result)}`);
  assert(/wash/i.test(result.reason ?? ""), `reason should cite wash, got ${result.reason}`);
  assert(counter.intelCalls >= 1, "hook must consult intel");
});

await t("T19 refuse binary present; missing-peer spawn is exit 2 (not a live dogfood run)", async () => {
  const bin = path.join(
    fileURLToPath(new URL("../", import.meta.url)),
    "node_modules",
    "twzrd-x402-gate",
    "bin",
    "twzrd-gate-eval-refuse.js",
  );
  const src = await readFile(bin, "utf8");
  assert(src.includes("twzrd.gate_eval_refuse.v1"), "refuse bin must emit gate_eval_refuse.v1");
  assert(
    src.includes("closes_external_adoption_metric: false"),
    "refuse bin must not claim EXTERNAL_RUN",
  );
  const ran = spawnSync(process.execPath, [bin], { encoding: "utf8" });
  assert(ran.status === 2, `expected missing-peer exit 2, got ${ran.status}\n${ran.stderr}`);
  assert(/missing peer/.test(ran.stderr ?? ""), `stderr should cite missing peer: ${ran.stderr}`);
});

/** 402 whose single accepts[] entry carries `fields`; counts resource + intel calls. */
function make402Harness(fields) {
  const counter = { resource: 0, intel: 0 };
  const RESOURCE = "https://seller.example/x402/conflict";
  const innerFetch = async () => {
    counter.resource += 1;
    return new Response(
      JSON.stringify({
        accepts: [{ scheme: "exact", network: "solana", resource: RESOURCE, ...fields }],
      }),
      { status: 402, headers: { "content-type": "application/json" } },
    );
  };
  const intelFetch = async () => {
    counter.intel += 1;
    throw new Error("intel must not be consulted for a conflicted offer");
  };
  return { counter, RESOURCE, innerFetch, intelFetch };
}

for (const [label, fields, reason] of [
  ["amount vs maxAmountRequired", { payTo: UNKNOWN_WALLET, amount: "1000", maxAmountRequired: "5000000" }, "amount_field_conflict"],
  ["payTo vs pay_to", { payTo: UNKNOWN_WALLET, pay_to: BLOCK_WALLET, amount: "1000" }, "payto_field_conflict"],
]) {
  await t(`T20 conflicting 402 offer (${label}) refuses before intel; no pay`, async () => {
    resetLastRefuse();
    const h = make402Harness(fields);
    const gated = wrapFetchWithTwzrdPreflight(h.innerFetch, {
      fetch: h.intelFetch,
      failMode: "open", // conflict must refuse even when the caller opted into fail-open
      endpoint: "https://intel.twzrd.xyz",
    });
    let threw = null;
    try {
      await gated(h.RESOURCE);
    } catch (err) {
      threw = err;
    }
    assert(threw instanceof TwzrdPaymentBlockedError, `expected TwzrdPaymentBlockedError, got ${threw}`);
    assert(threw.message.includes(reason), `message should cite ${reason}: ${threw.message}`);
    assert(h.counter.intel === 0, `intel calls ${h.counter.intel}`);
    assert(h.counter.resource === 1, `resource calls ${h.counter.resource}`);
    const refuse = threw.refuse ?? getLastRefuse();
    assert(refuse?.reason === reason || JSON.stringify(refuse).includes(reason), `refuse reason ${JSON.stringify(refuse)}`);
    assert(refuse.signer_invocation_count === 0 && refuse.usdc_spent === 0, "no signer / no USDC");
  });
}

/** Preflight answers warn; merchant_card is down (503). */
function makeCardOutageFetch(counter) {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && url.includes("/preflight")) {
      counter.preflight += 1;
      return new Response(
        JSON.stringify({ readiness_card: { decision: "warn", trust_score: 50, can_spend: true, recommended_cap_usdc: 0.05 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/merchant_card/")) {
      counter.card += 1;
      return new Response("upstream down", { status: 503 });
    }
    throw new Error(`unexpected ${init?.method} ${url}`);
  };
}

await t("T21 merchant_card outage + failMode=closed → block (wash check not skipped)", async () => {
  const counter = { preflight: 0, card: 0 };
  const g = createGate(
    { mode: "enforce", failMode: "closed", fetch: makeCardOutageFetch(counter) },
    QUIET,
  );
  const r = await g.beforeToolCall({
    toolName: "exec",
    params: { command: curlCmd(UNKNOWN_WALLET, "X", 0.05) },
  });
  assert(counter.preflight === 1 && counter.card >= 1, `calls ${JSON.stringify(counter)}`);
  assert(r?.block === true, `fail-closed must block on card outage, got ${JSON.stringify(r)}`);
  assert(/merchant_card/.test(r.blockReason), `reason should cite merchant_card: ${r.blockReason}`);
  assert(r.refuse?.reason === "twzrd_card_unreachable" || JSON.stringify(r.refuse).includes("twzrd_card_unreachable"),
    `refuse reason ${JSON.stringify(r.refuse)}`);
  assert(g.stats.apiFailures === 1, `apiFailures ${g.stats.apiFailures}`);
});

await t("T21b merchant_card outage + failMode=open → allow (wash unknown)", async () => {
  const counter = { preflight: 0, card: 0 };
  const g = createGate(
    { mode: "enforce", failMode: "open", fetch: makeCardOutageFetch(counter) },
    QUIET,
  );
  const r = await g.beforeToolCall({
    toolName: "exec",
    params: { command: curlCmd(UNKNOWN_WALLET, "X", 0.05) },
  });
  assert(r === undefined, `fail-open must allow, got ${JSON.stringify(r)}`);
  assert(counter.card >= 1, "card lookup attempted");
});

// ---- x402 v2 header, every offer, asset (gate 0.11.x parity) ----
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CLEAN_PAYTO = "CLeanCLeanCLeanCLeanCLeanCLeanCLeanCLean1111";
const DIRTY_PAYTO = "DirtyDirtyDirtyDirtyDirtyDirtyDirtyDirty1111";
const PARTIAL_COVERAGE = { wash_flagged: false, wash_confidence: "partial_inbound_only", ring_evaluated: true, wash_stale: false };
const FULL_COVERAGE = { wash_flagged: false, wash_confidence: "full", ring_evaluated: true, wash_stale: false };

/**
 * Intel mock: every seller is an evaluated allow with full, fresh wash coverage; DIRTY_PAYTO
 * is wash-flagged. Gate 0.13.0 refuses less than full coverage by default (refuseWashUnknown).
 */
function makeOfferIntel(counter) {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    counter.intel += 1;
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && url.includes("/preflight")) {
      const body = JSON.parse(init?.body ?? "{}");
      const seller = body.seller_wallet ?? body.payTo ?? body.pay_to;
      counter.preflightSellers.push(seller);
      return new Response(
        JSON.stringify({
          readiness_card: {
            decision: "allow",
            trust_score: 85,
            score: 85,
            can_spend: true,
            recommended_cap_usdc: 1,
            seller_wallet: seller,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/merchant_card/")) {
      const wash = url.includes(DIRTY_PAYTO);
      return new Response(JSON.stringify({ ...FULL_COVERAGE, wash_flagged: wash }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected ${init?.method} ${url}`);
  };
}

const offer = (payTo, extra = {}) => ({
  scheme: "exact",
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  payTo,
  amount: "10000",
  asset: USDC_SOL,
  resource: "https://seller.example/x402/v2",
  ...extra,
});

/** 402 carrying `accepts` in the v2 PAYMENT-REQUIRED header (base64 JSON), body `{}`. */
function header402(accepts, headerOverride) {
  const header =
    headerOverride ?? Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64");
  return async () =>
    new Response("{}", {
      status: 402,
      headers: { "content-type": "application/json", "PAYMENT-REQUIRED": header },
    });
}

async function runGated(innerFetch, counter, opts = {}) {
  resetLastRefuse();
  const gated = wrapFetchWithTwzrdPreflight(innerFetch, {
    fetch: makeOfferIntel(counter),
    endpoint: "https://intel.twzrd.xyz",
    ...opts,
  });
  try {
    return { resp: await gated("https://seller.example/x402/v2"), err: null };
  } catch (err) {
    return { resp: null, err };
  }
}

await t("T22 v2 header-only 402 is read from PAYMENT-REQUIRED (clean seller passes)", async () => {
  const counter = { intel: 0, preflightSellers: [] };
  const { resp, err } = await runGated(header402([offer(CLEAN_PAYTO)]), counter);
  assert(err === null, `clean v2 offer must pass, got ${err?.message}`);
  assert(resp?.status === 402, `402 returned to the payer, got ${resp?.status}`);
  assert(counter.preflightSellers.includes(CLEAN_PAYTO), `intel saw ${JSON.stringify(counter.preflightSellers)}`);
});

await t("T23 every offer is checked: clean first + wash-flagged second → block", async () => {
  const counter = { intel: 0, preflightSellers: [] };
  const { err } = await runGated(header402([offer(CLEAN_PAYTO), offer(DIRTY_PAYTO)]), counter);
  assert(err instanceof TwzrdPaymentBlockedError, `expected block, got ${err}`);
  assert(err.message.includes(DIRTY_PAYTO), `refusal must name the dirty payTo: ${err.message}`);
  assert((err.refuse ?? getLastRefuse())?.pay_to === DIRTY_PAYTO, "refuse transcript pay_to");
});

await t("T23b every offer is checked in a body-only (v1) 402 too", async () => {
  const counter = { intel: 0, preflightSellers: [] };
  const inner = async () =>
    new Response(JSON.stringify({ accepts: [offer(CLEAN_PAYTO), offer(DIRTY_PAYTO)] }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  const { err } = await runGated(inner, counter);
  assert(err instanceof TwzrdPaymentBlockedError, `expected block (dirty second offer), got ${err}`);
  assert(err.message.includes(DIRTY_PAYTO), `refusal must name the dirty payTo: ${err.message}`);
});

await t("T24 non-USDC asset on Solana → twzrd_non_usdc_asset before intel", async () => {
  const counter = { intel: 0, preflightSellers: [] };
  const other = offer(CLEAN_PAYTO, { asset: "So11111111111111111111111111111111111111112" });
  const { err } = await runGated(header402([other]), counter, { failMode: "open" });
  assert(err instanceof TwzrdPaymentBlockedError, `expected block, got ${err}`);
  assert(err.message.includes("twzrd_non_usdc_asset"), `reason: ${err.message}`);
  assert(counter.intel === 0, `intel must not be called, got ${counter.intel}`);
});

await t("T25 more than 8 distinct offers → too_many_payment_options", async () => {
  const counter = { intel: 0, preflightSellers: [] };
  const many = Array.from({ length: 9 }, (_, i) => offer(CLEAN_PAYTO, { amount: String(1000 + i) }));
  const { err } = await runGated(header402(many), counter);
  assert(err instanceof TwzrdPaymentBlockedError, `expected block, got ${err}`);
  assert(err.message.includes("too_many_payment_options"), `reason: ${err.message}`);
  assert(counter.intel === 0, `intel must not be called, got ${counter.intel}`);
});

await t("T26 undecodable PAYMENT-REQUIRED header → block, no intel", async () => {
  const counter = { intel: 0, preflightSellers: [] };
  const { err } = await runGated(header402([], "%%%not-base64-json%%%"), counter, { failMode: "open" });
  assert(err instanceof TwzrdPaymentBlockedError, `expected block, got ${err}`);
  assert(/PAYMENT-REQUIRED/.test(err.message), `reason should cite the header: ${err.message}`);
  assert(counter.intel === 0, `intel must not be called, got ${counter.intel}`);
});

await t("T27 malformed amount (decimal) → amount_malformed before intel", async () => {
  const counter = { intel: 0, preflightSellers: [] };
  const { err } = await runGated(header402([offer(CLEAN_PAYTO, { amount: "0.01" })]), counter, { failMode: "open" });
  assert(err instanceof TwzrdPaymentBlockedError, `expected block, got ${err}`);
  assert(err.message.includes("amount_malformed"), `reason: ${err.message}`);
  assert(counter.intel === 0, `intel must not be called, got ${counter.intel}`);
});

await t("T28 bare \"USDC\" symbol is not a mint → twzrd_non_usdc_asset before intel", async () => {
  const counter = { intel: 0, preflightSellers: [] };
  const { err } = await runGated(header402([offer(CLEAN_PAYTO, { asset: "USDC" })]), counter, { failMode: "open" });
  assert(err instanceof TwzrdPaymentBlockedError, `expected block, got ${err}`);
  assert(err.message.includes("twzrd_non_usdc_asset"), `reason: ${err.message}`);
  assert(counter.intel === 0, `intel must not be called, got ${counter.intel}`);
});

await t("T29 clean offer + sibling with no recipient → refused whole", async () => {
  const counter = { intel: 0, preflightSellers: [] };
  const noRecipient = offer(undefined, { network: "eip155:8453", amount: "20000" });
  delete noRecipient.payTo;
  const { err } = await runGated(header402([offer(CLEAN_PAYTO), noRecipient]), counter, { failMode: "open" });
  assert(err instanceof TwzrdPaymentBlockedError, `expected block, got ${err}`);
  assert(err.message.includes("twzrd_unidentifiable_payment_recipient"), `reason: ${err.message}`);
});

// ---- gate 0.13.0: the 402 wrap's refuseWashUnknown, refuseUncappedWarn, refuseUnevaluated (on by default) ----
/** makeOfferIntel, but every merchant_card answers with `card` (wash coverage fields included). */
function makeCardIntel(counter, card) {
  const base = makeOfferIntel(counter);
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/merchant_card/")) {
      counter.intel += 1;
      return new Response(JSON.stringify(card), { status: 200, headers: { "content-type": "application/json" } });
    }
    return base(input, init);
  };
}

/** Run `fn` with one environment variable set (or removed), then put it back. */
async function withEnv(name, value, fn) {
  const had = Object.hasOwn(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

await t("T30 refuseWashUnknown is on by default in the 402 wrap: partial wash coverage refuses, refuseWashUnknown:false passes it", async () => {
  await withEnv("TWZRD_REFUSE_WASH_UNKNOWN", undefined, async () => {
    const counter = { intel: 0, preflightSellers: [] };
    const partial = await runGated(header402([offer(CLEAN_PAYTO)]), counter, { fetch: makeCardIntel(counter, PARTIAL_COVERAGE) });
    assert(partial.err instanceof TwzrdPaymentBlockedError, `expected block, got ${partial.err}`);
    assert(partial.err.message.includes("twzrd_wash_unknown"), `reason: ${partial.err.message}`);
    const optedOut = await runGated(header402([offer(CLEAN_PAYTO)]), counter, {
      fetch: makeCardIntel(counter, PARTIAL_COVERAGE),
      refuseWashUnknown: false,
    });
    assert(optedOut.err === null, `opted out, partial coverage must pass, got ${optedOut.err?.message}`);
    assert(optedOut.resp?.status === 402, `402 returned to the payer, got ${optedOut.resp?.status}`);
  });
});

await t("T31 TWZRD_REFUSE_WASH_UNKNOWN=0 reaches the 402 wrap (partial passes) unless the option says true, and never the tool-call hook", async () => {
  await withEnv("TWZRD_REFUSE_WASH_UNKNOWN", "0", async () => {
    const counter = { intel: 0, preflightSellers: [] };
    const envOff = await runGated(header402([offer(CLEAN_PAYTO)]), counter, { fetch: makeCardIntel(counter, PARTIAL_COVERAGE) });
    assert(envOff.err === null, `env off, partial coverage must pass the wrap, got ${envOff.err?.message}`);
    assert(envOff.resp?.status === 402, `402 returned to the payer, got ${envOff.resp?.status}`);
    const optionOn = await runGated(header402([offer(CLEAN_PAYTO)]), counter, {
      fetch: makeCardIntel(counter, PARTIAL_COVERAGE),
      refuseWashUnknown: true,
    });
    assert(optionOn.err instanceof TwzrdPaymentBlockedError, `the option overrides the env var, got ${optionOn.err}`);
    assert(optionOn.err.message.includes("twzrd_wash_unknown"), `reason: ${optionOn.err.message}`);
    // The before_tool_call hook has its own refuseWashUnknown (on by default) and does not read
    // the gate's env var: with it set to 0, the hook still refuses partial coverage.
    const g = createGate(
      { mode: "enforce", fetch: makeCardIntel({ intel: 0, preflightSellers: [] }, PARTIAL_COVERAGE) },
      QUIET,
    );
    const r = await g.beforeToolCall({ toolName: "exec", params: { command: curlCmd(CLEAN_PAYTO, "Clean thing", 0.01) } });
    assert(r?.block === true && r.refuse?.twzrd_reason === "twzrd_wash_unknown", `tool hook must refuse partial coverage, got ${JSON.stringify(r)}`);
  });
});

/** makeOfferIntel, but every preflight answers with `card` as the readiness card (full wash coverage). */
function makeReadinessIntel(counter, card) {
  const base = makeOfferIntel(counter);
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && url.includes("/preflight")) {
      counter.intel += 1;
      return new Response(JSON.stringify({ readiness_card: card }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return base(input, init);
  };
}

await t("T49 refuseUncappedWarn and refuseUnevaluated are on in the 402 wrap; plugin opts turn each off", async () => {
  await withEnv("TWZRD_REFUSE_UNCAPPED_WARN", undefined, () =>
    withEnv("TWZRD_REFUSE_UNEVALUATED", undefined, async () => {
      const counter = { intel: 0, preflightSellers: [] };
      const uncapped = { decision: "warn", trust_score: 60, score: 60 };
      const warn = await runGated(header402([offer(CLEAN_PAYTO)]), counter, { fetch: makeReadinessIntel(counter, uncapped) });
      assert(warn.err instanceof TwzrdPaymentBlockedError, `uncapped warn must refuse, got ${warn.err}`);
      assert(warn.err.message.includes("twzrd_warn_no_cap"), `reason: ${warn.err.message}`);
      const warnOff = await runGated(header402([offer(CLEAN_PAYTO)]), counter, {
        fetch: makeReadinessIntel(counter, uncapped),
        refuseUncappedWarn: false,
      });
      assert(warnOff.err === null, `refuseUncappedWarn:false must pass, got ${warnOff.err?.message}`);

      const unevaluated = { decision: "warn", trust_score: 45, score: null, null_reason: "unknown_subject", recommended_cap_usdc: 0.05 };
      const unev = await runGated(header402([offer(CLEAN_PAYTO)]), counter, { fetch: makeReadinessIntel(counter, unevaluated) });
      assert(unev.err instanceof TwzrdPaymentBlockedError, `unevaluated must refuse, got ${unev.err}`);
      assert(unev.err.message.includes("twzrd_unevaluated_"), `reason: ${unev.err.message}`);
      const unevOff = await runGated(header402([offer(CLEAN_PAYTO)]), counter, {
        fetch: makeReadinessIntel(counter, unevaluated),
        refuseUnevaluated: false,
      });
      assert(unevOff.err === null, `refuseUnevaluated:false pays it within the cap, got ${unevOff.err?.message}`);
      assert(unevOff.resp?.status === 402, `402 returned to the payer, got ${unevOff.resp?.status}`);
    }),
  );
});

// ---- a payment-shaped call whose payee cannot be read is refused, not skipped ----
const PAID_URL = "https://api.example-x402.dev/v1/thing";
const SIGNED = "eyJ4NDAyVmVyc2lvbiI6Mn0"; // stand-in payment payload; the hook never decodes it
/** An intel fetch that must not be reached; counts the attempt so the test can fail on it. */
function noIntel(counter) {
  return async (input) => {
    counter.intel += 1;
    throw new Error(`intel must not be called: ${typeof input === "string" ? input : input.url}`);
  };
}

for (const [label, command] of [
  ["v1 X-PAYMENT", `curl -s ${PAID_URL} -H 'X-PAYMENT: ${SIGNED}'`],
  ["v2 PAYMENT-SIGNATURE", `curl -s -H "PAYMENT-SIGNATURE: ${SIGNED}" ${PAID_URL}`],
  ["wget --header=", `wget -qO- --header='X-PAYMENT: ${SIGNED}' ${PAID_URL}`],
  ["-H with no space", `curl -s ${PAID_URL} -H"X-PAYMENT: ${SIGNED}"`],
]) {
  await t(`T32 exec sending a signed payment (${label}) with no readable payee → block, no intel`, async () => {
    const counter = { intel: 0 };
    const g = createGate({ mode: "enforce", failMode: "open", fetch: noIntel(counter) }, QUIET);
    const r = await g.beforeToolCall({ toolName: "exec", params: { command } });
    assert(r?.block === true, `expected block, got ${JSON.stringify(r)}`);
    assert(/signed x402 payment to https:\/\/api\.example-x402\.dev/.test(r.blockReason), `reason: ${r.blockReason}`);
    assert(/refuseUnparsedPayments: false/.test(r.blockReason), "reason names the opt-out");
    // The header was signed before this hook ran: no transcript claiming zero signer calls.
    assert(r.refuse === undefined, `signed command must carry no refuse transcript, got ${JSON.stringify(r.refuse)}`);
    assert(counter.intel === 0 && g.lastRequest === null, "no intel call");
    assert(g.stats.unparsed === 1 && g.stats.blocked === 1 && g.stats.evaluated === 0, `stats ${JSON.stringify(g.stats)}`);
  });
}

await t("T33 exec sending a signed payment to an origin whose 402 was seen → gated on that payTo", async () => {
  const g = createGate({ mode: "enforce" }, QUIET);
  await g.afterToolCall({
    toolName: "exec",
    params: { command: `curl -s ${PAID_URL}` },
    result: `HTTP/1.1 402 {"accepts":[{"payTo":"${BLOCK_WALLET}","amount":"50000"}]}`,
  });
  const r = await g.beforeToolCall({
    toolName: "exec",
    params: { command: `curl -s ${PAID_URL} -H 'X-PAYMENT: ${SIGNED}'` },
  });
  assert(g.lastRequest?.seller_wallet === BLOCK_WALLET, `preflight must get the cached payTo, got ${JSON.stringify(g.lastRequest)}`);
  assert(r?.block === true && /decision=block/.test(r.blockReason), `expected decision block, got ${JSON.stringify(r)}`);
  assert(r.refuse === undefined, "signed command: no refuse transcript");
  assert(g.stats.unparsed === 0 && g.stats.evaluated === 1, `stats ${JSON.stringify(g.stats)}`);

  const g2 = createGate({ mode: "enforce" }, QUIET);
  await g2.afterToolCall({
    toolName: "exec",
    params: { command: `curl -s ${PAID_URL}` },
    result: `HTTP/1.1 402 {"accepts":[{"payTo":"${UNKNOWN_WALLET}","amount":"50000"}]}`,
  });
  const r2 = await g2.beforeToolCall({
    toolName: "exec",
    params: { command: `curl -s ${PAID_URL} -H 'X-PAYMENT: ${SIGNED}'` },
  });
  // The command names no price, so a warn cannot be held to its cap (refuseUncappedWarn).
  assert(r2?.block === true && /twzrd_warn_unknown_price/.test(r2.blockReason), `cached warn payTo, no price: ${JSON.stringify(r2)}`);
  assert(/refuseUncappedWarn: false/.test(r2.blockReason), `blockReason names the opt-out: ${r2.blockReason}`);
  assert(r2.refuse === undefined, "signed command: no refuse transcript");

  const g3 = createGate({ mode: "enforce", refuseUncappedWarn: false }, QUIET);
  await g3.afterToolCall({
    toolName: "exec",
    params: { command: `curl -s ${PAID_URL}` },
    result: `HTTP/1.1 402 {"accepts":[{"payTo":"${UNKNOWN_WALLET}","amount":"50000"}]}`,
  });
  const r3 = await g3.beforeToolCall({
    toolName: "exec",
    params: { command: `curl -s ${PAID_URL} -H 'X-PAYMENT: ${SIGNED}'` },
  });
  assert(r3 === undefined, `cached warn payTo with refuseUncappedWarn off must pass, got ${JSON.stringify(r3)}`);
});

await t("T34 payment-named tool with its URL outside origin/url → block before the tool (and its signer) runs", async () => {
  const counter = { intel: 0 };
  const g = createGate({ mode: "enforce", fetch: noIntel(counter) }, QUIET);
  const r = await g.beforeToolCall({ toolName: "x402_pay", params: { endpoint: PAID_URL, max_usdc: 0.05 } });
  assert(r?.block === true, `expected block, got ${JSON.stringify(r)}`);
  assert(/x402_pay is a payment tool/.test(r.blockReason) && /matcher/.test(r.blockReason), `reason: ${r.blockReason}`);
  assert(r.refuse?.twzrd_reason === "twzrd_unparsed_payment", `refuse ${JSON.stringify(r.refuse)}`);
  assert(r.refuse.signer_invocation_count === 0 && r.refuse.usdc_spent === 0, "no signer / no USDC");
  assert(counter.intel === 0, "no intel call");
  // A matcher naming the payee param turns the refusal into a normal check.
  const g2 = createGate({ mode: "enforce", matchers: [{ tool: "x402_pay", walletParam: "payee", priceParam: "max_usdc" }] }, QUIET);
  const r2 = await g2.beforeToolCall({ toolName: "x402_pay", params: { endpoint: PAID_URL, payee: UNKNOWN_WALLET, max_usdc: 0.05 } });
  assert(r2 === undefined && g2.stats.unparsed === 0, `matcher path must check, not refuse: ${JSON.stringify(r2)}`);
  assert(g2.lastRequest?.seller_wallet === UNKNOWN_WALLET, `matcher payee sent to preflight: ${JSON.stringify(g2.lastRequest)}`);
});

for (const [label, toolName, params] of [
  ["exec curl with no payment header", "exec", { command: `curl -s ${PAID_URL}` }],
  ["exec grep for the header name (no URL)", "exec", { command: `grep -rn "X-PAYMENT:" src/` }],
  ["exec sending X-PAYMENT-RESPONSE", "exec", { command: `curl -s ${PAID_URL} -H 'X-PAYMENT-RESPONSE: ${SIGNED}'` }],
  ["'pay' inside a word (payload)", "inspect_payload", { target: PAID_URL }],
  ["'pay' inside a word (taxpayer)", "taxpayer_lookup", { source: PAID_URL }],
  ["payment-named tool with no URL", "agentcash_get_balance", {}],
  ["loop guard: signed payment aimed at intel itself", "exec", { command: `curl -s https://intel.twzrd.xyz/v1/intel/quick/x -H 'X-PAYMENT: ${SIGNED}'` }],
]) {
  await t(`T35 not payment-shaped or not ours: ${label} → no gate`, async () => {
    const counter = { intel: 0 };
    const g = createGate({ mode: "enforce", fetch: noIntel(counter) }, QUIET);
    const r = await g.beforeToolCall({ toolName, params });
    assert(r === undefined, `expected no gate, got ${JSON.stringify(r)}`);
    assert(g.stats.unparsed === 0 && counter.intel === 0, `stats ${JSON.stringify(g.stats)} intel ${counter.intel}`);
  });
}

await t("T36 shadow logs an unparsed payment as a would-block; refuseUnparsedPayments:false restores 0.4.3", async () => {
  const command = `curl -s ${PAID_URL} -H 'X-PAYMENT: ${SIGNED}'`;
  const shadow = createGate({ mode: "shadow", fetch: noIntel({ intel: 0 }) }, QUIET);
  const r = await shadow.beforeToolCall({ toolName: "exec", params: { command } });
  assert(r === undefined && shadow.stats.wouldBlock === 1 && shadow.stats.unparsed === 1, `shadow ${JSON.stringify(shadow.stats)}`);
  const off = createGate({ mode: "enforce", refuseUnparsedPayments: false, fetch: noIntel({ intel: 0 }) }, QUIET);
  for (const call of [
    { toolName: "exec", params: { command } },
    { toolName: "x402_pay", params: { endpoint: PAID_URL } },
  ]) {
    const r2 = await off.beforeToolCall(call);
    assert(r2 === undefined, `opted out must not refuse ${call.toolName}, got ${JSON.stringify(r2)}`);
  }
  assert(off.stats.unparsed === 0 && off.stats.blocked === 0, `off ${JSON.stringify(off.stats)}`);
});

// ---- the gate 0.13.0 rules: caps, unevaluated sellers, missing cards, wash coverage ----
const RULE_PAYTO = "RuLeRuLeRuLeRuLeRuLeRuLeRuLeRuLeRuLe11111";
const WARN_CAPPED = { decision: "warn", trust_score: 50, score: 0.5, can_spend: true, recommended_cap_usdc: 0.05 };
const UNEVALUATED = { decision: "warn", trust_score: 45, score: null, null_reason: "unknown_subject", can_spend: false, recommended_cap_usdc: 0.1 };
/**
 * Intel serving one preflight body and one merchant card (null answers 404) for any seller.
 * A readiness card is wrapped as { readiness_card }; pass { body } to serve a raw body.
 */
function ruleIntel(readiness, merchantCard = FULL_COVERAGE) {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (String(init?.method ?? "GET").toUpperCase() === "POST" && url.includes("/v1/intel/preflight")) {
      return jsonResponse(readiness?.body ?? { readiness_card: readiness });
    }
    if (url.includes("/merchant_card/")) {
      return merchantCard === null ? jsonResponse({ detail: "not found" }, 404) : jsonResponse(merchantCard);
    }
    throw new Error(`unexpected ${init?.method} ${url}`);
  };
}
/** One exec curl to RULE_PAYTO at `price` (null names no price), with every onDecision call recorded. */
async function ruleCall(readiness, { price = 0.01, merchantCard = FULL_COVERAGE, ...cfg } = {}) {
  const decisions = [];
  const g = createGate(
    { mode: "enforce", ...cfg, fetch: ruleIntel(readiness, merchantCard), onDecision: (d) => decisions.push(d) },
    QUIET,
  );
  const command =
    price === null
      ? `curl -s -X POST https://api.example-x402.dev/v1/thing -d '{"seller_wallet":"${RULE_PAYTO}"}'`
      : curlCmd(RULE_PAYTO, "Rule thing", price);
  const r = await g.beforeToolCall({ toolName: "exec", params: { command } });
  return { r, decisions, d: decisions[0], g };
}
/** The call was refused under `reason`, its blockReason names `optOut`, and onDecision saw it. */
function assertRefused({ r, decisions }, reason, optOut, decision) {
  assert(r?.block === true, `expected block, got ${JSON.stringify(r)}`);
  assert(r.refuse?.twzrd_reason === reason, `refuse reason ${r.refuse?.twzrd_reason}, expected ${reason}`);
  assert(r.refuse.signer_invocation_count === 0 && r.refuse.usdc_spent === 0, "no signer / no USDC");
  assert(r.blockReason.includes(reason) && r.blockReason.includes(optOut), `blockReason must cite ${reason} and ${optOut}: ${r.blockReason}`);
  assert(decisions.length === 1, `onDecision once, got ${decisions.length}`);
  const d = decisions[0];
  assert(d.decision === decision[0] && d.reason_code === decision[1] && d.twzrd_reason === reason && d.pays === false,
    `onDecision ${JSON.stringify(d)}`);
}
/** The call was let through, and onDecision recorded it as `decision`. */
function assertPaid({ r, decisions }, decision, reason) {
  assert(r === undefined, `expected pass, got ${JSON.stringify(r)}`);
  assert(decisions.length === 1, `onDecision once, got ${decisions.length}`);
  const d = decisions[0];
  assert(d.decision === decision[0] && d.reason_code === decision[1] && d.pays === true, `onDecision ${JSON.stringify(d)}`);
  if (reason) assert(d.twzrd_reason === reason, `twzrd_reason ${d.twzrd_reason}, expected ${reason}`);
}

await t("T37 warn with no recommended cap → twzrd_warn_no_cap; refuseUncappedWarn:false pays it", async () => {
  const uncapped = { decision: "warn", trust_score: 50, score: 0.5, can_spend: true };
  assertRefused(await ruleCall(uncapped), "twzrd_warn_no_cap", "refuseUncappedWarn: false", ["block", "INTEL_BLOCK"]);
  assertPaid(await ruleCall(uncapped, { refuseUncappedWarn: false }), ["warn", "INTEL_WARN"], "twzrd_warn_allowed");
});

await t("T38 warn under its cap but no price named → twzrd_warn_unknown_price; refuseUncappedWarn:false pays it", async () => {
  assertRefused(await ruleCall(WARN_CAPPED, { price: null }), "twzrd_warn_unknown_price", "refuseUncappedWarn: false", ["block", "INTEL_BLOCK"]);
  assertPaid(await ruleCall(WARN_CAPPED, { price: null, refuseUncappedWarn: false }), ["warn", "INTEL_WARN"]);
});

await t("T39 a price above the card's recommended cap → twzrd_over_recommended_cap (warn and allow), before the merchant card", async () => {
  const over = await ruleCall(WARN_CAPPED, { price: 0.1 });
  assertRefused(over, "twzrd_over_recommended_cap_0.1_gt_0.05", "allowWallets", ["block", "INTEL_BLOCK"]);
  const allowCapped = { decision: "allow", trust_score: 80, score: 0.8, can_spend: true, recommended_cap_usdc: 0.02 };
  assertRefused(await ruleCall(allowCapped, { price: 0.03 }), "twzrd_over_recommended_cap_0.03_gt_0.02", "allowWallets", ["block", "INTEL_BLOCK"]);
  // The cap is intel's, so refuseUncappedWarn:false does not lift it.
  assertRefused(await ruleCall(WARN_CAPPED, { price: 0.1, refuseUncappedWarn: false }), "twzrd_over_recommended_cap_0.1_gt_0.05", "allowWallets", ["block", "INTEL_BLOCK"]);
  assertPaid(await ruleCall(WARN_CAPPED, { price: 0.05 }), ["warn", "INTEL_WARN"], "twzrd_warn_allowed");
});

await t("T40 seller intel never evaluated → twzrd_unevaluated_subject_<null_reason> (score null alone too)", async () => {
  assertRefused(await ruleCall(UNEVALUATED), "twzrd_unevaluated_subject_unknown_subject", "refuseUnevaluated: false", ["block", "UNKNOWN_ABOVE_LIMIT"]);
  const scoreNull = { decision: "allow", trust_score: 60, score: null, can_spend: true, recommended_cap_usdc: 1 };
  assertRefused(await ruleCall(scoreNull), "twzrd_unevaluated_subject_score_null", "refuseUnevaluated: false", ["block", "UNKNOWN_ABOVE_LIMIT"]);
});

await t("T41 refuseUnevaluated:false pays an unevaluated seller within its cap only, recorded as UNKNOWN_UNDER_LIMIT", async () => {
  const opted = { refuseUnevaluated: false };
  assertPaid(await ruleCall(UNEVALUATED, { ...opted, price: 0.05 }), ["warn", "UNKNOWN_UNDER_LIMIT"], "twzrd_unevaluated_within_cap_0.05_le_0.1");
  assertRefused(await ruleCall(UNEVALUATED, { ...opted, price: 0.2 }), "twzrd_unevaluated_over_cap_0.2_gt_0.1", "allowWallets", ["block", "UNKNOWN_ABOVE_LIMIT"]);
  assertRefused(await ruleCall(UNEVALUATED, { ...opted, price: null }), "twzrd_unevaluated_unknown_price_unknown_subject", "allowWallets", ["block", "UNKNOWN_ABOVE_LIMIT"]);
  const { recommended_cap_usdc, ...uncapped } = UNEVALUATED;
  assertRefused(await ruleCall(uncapped, opted), "twzrd_unevaluated_no_cap_unknown_subject", "allowWallets", ["block", "UNKNOWN_ABOVE_LIMIT"]);
});

await t("T42 no readiness card, or a decision this gate does not know → twzrd_decision_<decision>", async () => {
  assertRefused(await ruleCall({ body: {} }), "twzrd_decision_undefined", "allowWallets", ["block", "INTEL_BLOCK"]);
  assertRefused(await ruleCall({ body: { readiness_card: null } }), "twzrd_decision_undefined", "allowWallets", ["block", "INTEL_BLOCK"]);
  assertRefused(await ruleCall({ decision: "maybe", trust_score: 90, score: 0.9, recommended_cap_usdc: 1 }), "twzrd_decision_maybe", "allowWallets", ["block", "INTEL_BLOCK"]);
  // The local allowlist is the operator's way past it, and is not an intel outcome.
  const allowed = await ruleCall({ body: {} }, { allowWallets: [RULE_PAYTO] });
  assert(allowed.r === undefined && allowed.decisions.length === 0, `allowlisted: ${JSON.stringify(allowed)}`);
});

for (const [label, merchantCard] of [
  ["wash_flagged null", { wash_flagged: null, wash_confidence: "full", ring_evaluated: true }],
  ["partial confidence", PARTIAL_COVERAGE],
  ["stale evidence", { ...FULL_COVERAGE, wash_stale: true }],
  ["ring not evaluated", { ...FULL_COVERAGE, ring_evaluated: false }],
  ["confidence (not wash_confidence) partial", { wash_flagged: false, confidence: "partial", ring_evaluated: true }],
  ["no confidence at all", { wash_flagged: false, ring_evaluated: true }],
  ["merchant card 404", null],
]) {
  await t(`T43 wash coverage not full and fresh (${label}) → twzrd_wash_unknown; refuseWashUnknown:false pays it`, async () => {
    assertRefused(await ruleCall(WARN_CAPPED, { merchantCard }), "twzrd_wash_unknown", "refuseWashUnknown: false", ["block", "INTEL_BLOCK"]);
    assertPaid(await ruleCall(WARN_CAPPED, { merchantCard, refuseWashUnknown: false }), ["warn", "INTEL_WARN"]);
  });
}

await t("T44 full coverage read from confidence passes; refuseWashFlagged:false skips the merchant card, and refuseWashUnknown with it", async () => {
  assertPaid(await ruleCall(WARN_CAPPED, { merchantCard: { wash_flagged: false, confidence: "full", ring_evaluated: true } }), ["warn", "INTEL_WARN"]);
  let cardReads = 0;
  const g = createGate(
    {
      mode: "enforce",
      refuseWashFlagged: false,
      fetch: async (input, init) => {
        if (String(input?.url ?? input).includes("/merchant_card/")) cardReads += 1;
        return ruleIntel(WARN_CAPPED, PARTIAL_COVERAGE)(input, init);
      },
    },
    QUIET,
  );
  const r = await g.beforeToolCall({ toolName: "exec", params: { command: curlCmd(RULE_PAYTO, "Rule thing", 0.01) } });
  assert(r === undefined && cardReads === 0, `wash off: ${JSON.stringify(r)}, card reads ${cardReads}`);
});

await t("T45 wash_flagged on a card already refused is recorded as WASH_FLAGGED", async () => {
  const flagged = { ...FULL_COVERAGE, wash_flagged: true };
  assertRefused(await ruleCall({ decision: "warn", trust_score: 50, score: 0.5 }, { merchantCard: flagged }), "twzrd_warn_no_cap", "refuseUncappedWarn: false", ["block", "WASH_FLAGGED"]);
  assertRefused(await ruleCall(WARN_CAPPED, { merchantCard: flagged }), "twzrd_wash_flagged", "refuseWashFlagged: false", ["block", "WASH_FLAGGED"]);
});

await t("T46 shadow: every new refusal is a would-block, and the call runs", async () => {
  const cases = [
    [{ decision: "warn", trust_score: 50, score: 0.5 }, {}],
    [WARN_CAPPED, { price: null }],
    [WARN_CAPPED, { price: 0.1 }],
    [UNEVALUATED, {}],
    [{ body: {} }, {}],
    [WARN_CAPPED, { merchantCard: PARTIAL_COVERAGE }],
  ];
  for (const [readiness, opts] of cases) {
    const run = await ruleCall(readiness, { ...opts, mode: "shadow" });
    assert(run.r === undefined, `shadow must not block: ${JSON.stringify(run.r)}`);
    assert(run.g.stats.wouldBlock === 1 && run.g.stats.blocked === 0, `stats ${JSON.stringify(run.g.stats)}`);
    assert(run.d?.decision === "block" && run.d.pays === true, `shadow onDecision ${JSON.stringify(run.d)}`);
  }
});

await t("T47 onDecision: allow, block and outages map onto payment_decision.v1; a throwing callback changes nothing", async () => {
  const allowCard = { decision: "allow", trust_score: 80, score: 0.8, can_spend: true, recommended_cap_usdc: 1 };
  assertPaid(await ruleCall(allowCard), ["allow", "ALLOW"], "twzrd_allow");
  // decision=block keeps its rendered reason; the transcript and onDecision carry the gate's.
  const blocked = await ruleCall({ decision: "block", trust_score: 20, score: 0.2 });
  assert(blocked.r?.block === true && /decision=block/.test(blocked.r.blockReason), `block: ${JSON.stringify(blocked.r)}`);
  assert(blocked.r.refuse?.twzrd_reason === "twzrd_decision_block", `block transcript ${JSON.stringify(blocked.r.refuse)}`);
  assert(blocked.d?.decision === "block" && blocked.d.reason_code === "INTEL_BLOCK" && blocked.d.twzrd_reason === "twzrd_decision_block",
    `block onDecision ${JSON.stringify(blocked.d)}`);
  // Outages: preflight down (closed refuses, open pays) and merchant card down (closed refuses).
  const down = async () => {
    throw new TypeError("fetch failed (ECONNREFUSED)");
  };
  for (const [failMode, pays] of [["closed", false], ["open", true]]) {
    const decisions = [];
    const g = createGate({ mode: "enforce", failMode, fetch: down, onDecision: (d) => decisions.push(d) }, QUIET);
    const r = await g.beforeToolCall({ toolName: "exec", params: { command: curlCmd(RULE_PAYTO, "Rule thing", 0.01) } });
    assert((r === undefined) === pays, `failMode ${failMode}: ${JSON.stringify(r)}`);
    assert(decisions[0]?.decision === "unavailable" && decisions[0].reason_code === "INTEL_UNAVAILABLE" && decisions[0].pays === pays,
      `failMode ${failMode} onDecision ${JSON.stringify(decisions)}`);
  }
  const cardDown = [];
  const gc = createGate({ mode: "enforce", fetch: makeCardOutageFetch({ preflight: 0, card: 0 }), onDecision: (d) => cardDown.push(d) }, QUIET);
  const rc = await gc.beforeToolCall({ toolName: "exec", params: { command: curlCmd(RULE_PAYTO, "Rule thing", 0.01) } });
  assert(rc?.block === true && cardDown[0]?.reason_code === "INTEL_UNAVAILABLE" && cardDown[0].twzrd_reason === "twzrd_card_unreachable",
    `card outage onDecision ${JSON.stringify(cardDown)}`);
  const cardDownOpen = [];
  const go = createGate(
    { mode: "enforce", failMode: "open", fetch: makeCardOutageFetch({ preflight: 0, card: 0 }), onDecision: (d) => cardDownOpen.push(d) },
    QUIET,
  );
  const ro = await go.beforeToolCall({ toolName: "exec", params: { command: curlCmd(RULE_PAYTO, "Rule thing", 0.01) } });
  assert(ro === undefined && cardDownOpen[0]?.decision === "unavailable" && cardDownOpen[0].pays === true,
    `card outage, failMode open: ${JSON.stringify(ro)} ${JSON.stringify(cardDownOpen)}`);
  // A callback that throws, or rejects, never changes the verdict.
  for (const onDecision of [
    () => {
      throw new Error("telemetry down");
    },
    async () => {
      throw new Error("telemetry down");
    },
  ]) {
    const paid = createGate({ mode: "enforce", fetch: ruleIntel(WARN_CAPPED), onDecision }, QUIET);
    const r1 = await paid.beforeToolCall({ toolName: "exec", params: { command: curlCmd(RULE_PAYTO, "Rule thing", 0.01) } });
    assert(r1 === undefined, `throwing onDecision must not refuse: ${JSON.stringify(r1)}`);
    const refused = createGate({ mode: "enforce", fetch: ruleIntel(UNEVALUATED), onDecision }, QUIET);
    const r2 = await refused.beforeToolCall({ toolName: "exec", params: { command: curlCmd(RULE_PAYTO, "Rule thing", 0.01) } });
    assert(r2?.block === true, `throwing onDecision must not pass a refusal: ${JSON.stringify(r2)}`);
  }
});

await t("T48 the card is cached, the verdict is not: the same seller is re-evaluated at each call's price", async () => {
  let preflights = 0;
  const g = createGate(
    {
      mode: "enforce",
      fetch: async (input, init) => {
        if (String(input?.url ?? input).includes("/v1/intel/preflight")) preflights += 1;
        return ruleIntel(WARN_CAPPED)(input, init);
      },
    },
    QUIET,
  );
  const under = await g.beforeToolCall({ toolName: "exec", params: { command: curlCmd(RULE_PAYTO, "Rule thing", 0.01) } });
  const over = await g.beforeToolCall({ toolName: "exec", params: { command: curlCmd(RULE_PAYTO, "Rule thing", 0.5) } });
  assert(under === undefined, `under cap must pass: ${JSON.stringify(under)}`);
  assert(over?.block === true && over.refuse?.twzrd_reason === "twzrd_over_recommended_cap_0.5_gt_0.05", `over cap must refuse: ${JSON.stringify(over)}`);
  assert(preflights === 1, `one preflight for both calls, got ${preflights}`);
});

await t("TX offline: every intel request was one the stub has a recorded answer for", async () => {
  if (LIVE) {
    console.log("  SKIP TX (live run)");
    return;
  }
  assert(unrecorded.length === 0, `unrecorded requests: ${unrecorded.join(", ")}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
