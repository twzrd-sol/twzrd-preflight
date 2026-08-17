/**
 * Phase 1 harness: exercises the gate hooks directly (no OpenClaw gateway needed).
 * Calls the LIVE free preflight API (no auth, no payments). Run: npm test
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGate } from "../index.js";
import plugin from "../index.js";

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

await t("T10f ClawHub requires pluginApi + openclawVersion; manifest version lockstep", async () => {
  // ClawHub package publish rejects external code plugins that omit
  // openclaw.compat.pluginApi / openclaw.build.openclawVersion. The 0.1.4
  // tarball failed dry-run on exactly those two fields, and its
  // openclaw.plugin.json still said 0.1.3 (package-manifest-version-drift).
  // Read the shipped files — do not re-state the versions in this test.
  const root = new URL("../", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const plugin = JSON.parse(await readFile(new URL("openclaw.plugin.json", root), "utf8"));
  const pluginApi = pkg.openclaw?.compat?.pluginApi;
  const builtAgainst = pkg.openclaw?.build?.openclawVersion;
  assert(typeof pluginApi === "string" && pluginApi.length > 0, "package.json: openclaw.compat.pluginApi missing");
  assert(pluginApi.startsWith(">="), `pluginApi must be a range, got ${pluginApi}`);
  assert(
    typeof builtAgainst === "string" && builtAgainst.length > 0,
    "package.json: openclaw.build.openclawVersion missing",
  );
  assert(plugin.version === pkg.version, `manifest ${plugin.version} != package ${pkg.version}`);
  // The guard must be able to fail, or it is decoration.
  const stripped = { ...pkg, openclaw: { ...(pkg.openclaw ?? {}), compat: {}, build: {} } };
  assert(
    !(typeof stripped.openclaw?.compat?.pluginApi === "string" && stripped.openclaw.compat.pluginApi.length > 0),
    "self-check: missing pluginApi must fail the presence test",
  );
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


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
