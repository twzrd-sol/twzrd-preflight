// Shared guard vectors (twzrd-trust docs/vectors), run through this plugin's before_tool_call
// hook.
//
// Each vector is the evidence intel serves, the buyer's policy, and the outcome every pre-sign
// guard must reach: whether the payment goes ahead (pays) and the twzrd.payment_decision.v1
// decision and reason_code. The fixture is a vendored copy, so SOURCE records where it came
// from, and the first test fails if the fixture changes without SOURCE changing with it.
//
// The hook gates a tool call, not a signer: pays means the hook let the call run. Each vector is
// played twice: as an exec curl that names the seller wallet and price, and as a payment-named
// tool (x402_pay) whose execute is a spy the host calls only when the hook lets it run. Intel is
// a stub at cfg.fetch serving the vector's preflight and merchant card; any other request fails
// the vector, and global fetch throws for the whole run.
//
// The decision and reason_code are the ones the hook reports to cfg.onDecision, once per call.
// KNOWN_DIVERGENCE pins a vector the hook disagrees with, with the outcome it reaches, the way
// twzrd-trust pins plugin-trustgate. A new divergence fails, one that changes shape fails, and
// one that goes away fails until it is removed from the list. It is empty: the hook copies the
// gate 0.13.0 rules every applicable vector exercises.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createGate } from "../index.js";

const GUARD = "twzrd-preflight";
const FIXTURE = new URL("./fixtures/twzrd.payment_decision.v1.guard-vectors.json", import.meta.url);
/** Where the vendored fixture was copied from. Re-copy it and update all three together. */
const SOURCE = {
  repo: "twzrd-sol/twzrd-trust",
  path: "docs/vectors/twzrd.payment_decision.v1.guard-vectors.json",
  commit: "7c3bdc023dd279a159aa9c613a3c77fe5c7662e0",
  sha256: "9b36af94b04c653fb7dc8cb88111faffe2c0f043983e54e10d48de5a29d44370",
};
const RAW = readFileSync(FIXTURE);
const FILE = JSON.parse(RAW.toString("utf8"));
const INTEL = "https://intel.vectors.invalid";
const QUIET = { info() {}, warn() {} };

/** Vector policy keys this hook has a rule for, and the config each maps to. */
const POLICY_CONFIG = {
  fail_open: (v) => ({ failMode: v ? "open" : "closed" }),
  refuse_wash_flagged: (v) => ({ refuseWashFlagged: v }),
  refuse_unevaluated: (v) => ({ refuseUnevaluated: v }),
  refuse_uncapped_warn: (v) => ({ refuseUncappedWarn: v }),
  refuse_wash_unknown: (v) => ({ refuseWashUnknown: v }),
};
/** Vector policy keys the hook has no rule for. A key in neither list fails the run. */
const NO_EQUIVALENT = ["min_trust_score", "gate_on_can_spend", "wash_max_usdc"];

/** What the hook does on each vector it disagrees with, and why. */
const KNOWN_DIVERGENCE = {};

function gateConfig(policy) {
  const cfg = {};
  for (const [key, value] of Object.entries(policy)) {
    if (POLICY_CONFIG[key]) Object.assign(cfg, POLICY_CONFIG[key](value));
    else assert.ok(NO_EQUIVALENT.includes(key), `vector policy key ${key} is new; map it or list it in NO_EQUIVALENT`);
  }
  return cfg;
}

function serve(evidence) {
  if (evidence.error) throw new TypeError(`fetch failed (${evidence.error})`);
  return new Response(JSON.stringify(evidence.body ?? {}), {
    status: evidence.status,
    headers: { "content-type": "application/json" },
  });
}

/** The two ways a vector is played: an exec curl, and a payment-named tool. */
const CALLS = {
  exec: (v, payTo) => ({
    toolName: "exec",
    params: {
      command:
        `curl -s -X POST https://seller.vectors.invalid/x402/item -H 'content-type: application/json' ` +
        `-d '{"resource_name":"vector ${v.id}","seller_wallet":"${payTo}","price_usdc":${FILE.challenge.price_usdc}}'`,
    },
  }),
  x402_pay: (v, payTo) => ({
    toolName: "x402_pay",
    params: { seller_wallet: payTo, price_usdc: FILE.challenge.price_usdc, resource_name: `vector ${v.id}` },
  }),
};

async function runVector(v, call) {
  const payTo = FILE.challenge.pay_to;
  const unexpected = [];
  const sellers = [];
  const fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input.url);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url === `${INTEL}/v1/intel/preflight`) {
      sellers.push(JSON.parse(init.body).seller_wallet);
      return serve(v.evidence.preflight);
    }
    if (method === "GET" && url === `${INTEL}/v1/intel/merchant_card/${payTo}?full=true` && v.evidence.merchant_card) {
      return serve(v.evidence.merchant_card);
    }
    unexpected.push(`${method} ${url}`);
    throw new TypeError(`vector runner: unexpected intel request ${method} ${url}`);
  };
  const decisions = [];
  const gate = createGate(
    {
      mode: "enforce",
      endpoint: INTEL,
      fetch,
      timeoutMs: 2000,
      onDecision: (d) => decisions.push(d),
      ...gateConfig({ ...FILE.policy_baseline, ...v.policy }),
    },
    QUIET,
  );
  // A minimal host: the tool runs (its execute, and so its signer) only when the hook lets it.
  const execute = { calls: 0 };
  const event = CALLS[call](v, payTo);
  const r = await gate.beforeToolCall(event);
  if (!r?.block) execute.calls += 1;
  const pays = !r?.block;
  const d = decisions[0];
  const observed = { pays, decision: d?.decision, reason_code: d?.reason_code };
  return { observed, decisions, r, execute, unexpected, sellers };
}

const vectors = FILE.vectors.filter((v) => v.applies_to.includes(GUARD));

test("guard vectors: the vendored fixture is the recorded copy, and covers this guard", () => {
  const sha256 = createHash("sha256").update(RAW).digest("hex");
  assert.equal(sha256, SOURCE.sha256, `fixture changed; re-copy it from ${SOURCE.repo} ${SOURCE.path} and update SOURCE`);
  assert.equal(FILE.schema, "twzrd.guard_vectors.v1");
  assert.equal(FILE.decision_contract, "twzrd.payment_decision.v1");
  assert.ok(FILE.guards[GUARD], `${GUARD} is not a declared guard in the vector file`);
  const ids = new Set(FILE.vectors.map((v) => v.id));
  for (const id of Object.keys(KNOWN_DIVERGENCE)) assert.ok(ids.has(id), `KNOWN_DIVERGENCE names a vector that does not exist: ${id}`);
  for (const v of FILE.vectors) {
    const applies = v.applies_to.includes(GUARD);
    assert.ok(applies !== Boolean(v.not_applicable?.[GUARD]), `[vector ${v.id}] must either apply to ${GUARD} or say why not`);
  }
  assert.ok(vectors.length > 0, "no vector applies to this guard");
});

for (const v of vectors) {
  for (const call of Object.keys(CALLS)) {
    test(`guard vector ${v.id} (${v.covers}): ${GUARD} via ${call}`, async (t) => {
      const at = `[vector ${v.id}] ${GUARD} via ${call}`;
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        throw new TypeError(`vector runner: global fetch is not allowed (${String(input?.url ?? input)})`);
      };
      let run;
      try {
        run = await runVector(v, call);
      } finally {
        globalThis.fetch = realFetch;
      }
      const { observed, decisions, r, execute, unexpected, sellers } = run;
      assert.deepEqual(unexpected, [], `${at}: fetched something the vector does not serve`);
      assert.ok(sellers.every((s) => s === FILE.challenge.pay_to), `${at}: preflight asked about ${JSON.stringify(sellers)}`);
      assert.equal(decisions.length, 1, `${at}: onDecision fired ${decisions.length} times, expected once`);
      assert.equal(decisions[0].pays, observed.pays, `${at}: onDecision says pays=${decisions[0].pays}, the hook did the opposite`);
      if (!observed.pays) {
        // The refusal reached nothing that could sign.
        assert.equal(execute.calls, 0, `${at}: refused, but the tool ran`);
        assert.equal(r.refuse?.signer_invocation_count, 0, `${at}: refusal transcript must record signer_invocation_count 0`);
        assert.equal(r.refuse?.usdc_spent, 0, `${at}: refusal transcript must record usdc_spent 0`);
        assert.equal(r.refuse?.twzrd_reason, decisions[0].twzrd_reason, `${at}: transcript and onDecision disagree on the reason`);
      } else {
        assert.equal(execute.calls, 1, `${at}: let through, but the tool did not run`);
      }
      const expected = { pays: v.expect.pays, decision: v.expect.decision, reason_code: v.expect.reason_code };
      const known = KNOWN_DIVERGENCE[v.id];
      if (!known) {
        assert.deepEqual(observed, expected, `${at}: reached ${JSON.stringify(observed)}, expected ${JSON.stringify(expected)}`);
        t.diagnostic(`twzrd_reason ${decisions[0].twzrd_reason}`);
        return;
      }
      const { why, ...pinned } = known;
      assert.notDeepEqual(observed, expected, `${at}: now agrees with the vector; remove it from KNOWN_DIVERGENCE`);
      assert.deepEqual(observed, pinned, `${at}: diverges differently than recorded (${why})`);
      t.diagnostic(`known divergence: ${why}`);
    });
  }
}

test("guard vectors: twzrd-preflight tally", (t) => {
  const diverge = vectors.filter((v) => KNOWN_DIVERGENCE[v.id]).length;
  t.diagnostic(`${GUARD}: agrees on ${vectors.length - diverge} of ${vectors.length} vectors, ${diverge} known divergences`);
});
