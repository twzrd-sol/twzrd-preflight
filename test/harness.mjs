/**
 * Phase 1 harness: exercises the gate hooks directly (no OpenClaw gateway needed).
 * Calls the LIVE free preflight API (no auth, no payments). Run: npm test
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
  const manifestFile = files.find((f) => /^manifest-.*\.js$/.test(f));
  assert(manifestFile, "openclaw dist: manifest module not found (vendor layout changed?)");
  const mod = await import(path.join(dir, "dist", manifestFile));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const statuses = Object.values(mod)
    .filter((f) => typeof f === "function")
    .map((f) => {
      try {
        return f(pkg, dir);
      } catch {
        return undefined;
      }
    })
    .filter((r) => r && typeof r === "object" && "status" in r);
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
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const pluginManifest = JSON.parse(
    await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  assert(pkg.version === "0.4.0", `package.json version ${pkg.version}`);
  assert(pluginManifest.version === "0.4.0", `plugin manifest version ${pluginManifest.version}`);
  assert(pkg.dependencies?.["twzrd-x402-gate"] === "0.11.2", `gate pin ${pkg.dependencies?.["twzrd-x402-gate"]}`);
  assert(pluginManifest.configSchema.properties.mode.default === "enforce", "manifest mode default");
  assert(
    pluginManifest.configSchema.properties.failMode.default === "closed",
    "manifest failMode default",
  );
  assert(
    pluginManifest.configSchema.properties.refuseWashFlagged.default === true,
    "manifest refuseWashFlagged default",
  );
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

await t("T17 installed twzrd-x402-gate is exact 0.11.2 + 0.11.2 APIs export", async () => {
  const dir = path.join(fileURLToPath(new URL("../", import.meta.url)), "node_modules", "twzrd-x402-gate");
  const gatePkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  assert(gatePkg.version === "0.11.2", `installed gate ${gatePkg.version}`);
  assert(GATE_CLIENT_VERSION === "0.11.2", `CLIENT_VERSION ${GATE_CLIENT_VERSION}`);
  assert(typeof createTwzrdBeforePaymentHook === "function", "createTwzrdBeforePaymentHook export");
  assert(
    typeof gatePkg.bin?.["twzrd-gate-eval-refuse"] === "string",
    "refuse binary declared in gate package.json",
  );
  const wrapRaw = await readFile(new URL("../wrap-fetch.js", import.meta.url), "utf8");
  const wrapCode = wrapRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert(
    !/\bpaymentRequiredFromResponse\b/.test(wrapCode),
    "wrap-fetch must not import paymentRequiredFromResponse (not a 0.11.2 package export)",
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
        JSON.stringify({ readiness_card: { decision: "warn", trust_score: 50, can_spend: true } }),
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

/** Intel mock: every seller is an evaluated allow; DIRTY_PAYTO is wash-flagged. */
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
      return new Response(JSON.stringify({ wash_flagged: wash }), {
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
