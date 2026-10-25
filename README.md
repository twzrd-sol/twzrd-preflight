# twzrd-preflight

> **Status (2026-10-23): frozen reference implementation.** This plugin is maintained as a
> worked example of a TWZRD seat (a `before_tool_call` hook plus a 402 fetch wrap over
> `twzrd-x402-gate`), pinned at gate **0.12.5**. Its gate pin is no longer bumped on each gate
> release; the live, maintained surface is the gate itself (`twzrd-x402-gate` in
> `twzrd-sol/twzrd-trust`). Operator decision after a 90-day usage review: every call this
> plugin has made to intel fell on its own release and test days, with no external host running
> it. It will be unfrozen when a named OpenClaw or Hermes host adopts it. 0.4.3 is the one
> pin move onto the current gate line.

OpenClaw plugin **0.4.3**: install = intercept. Pin **`twzrd-x402-gate@0.12.5`**
(exact; same line as other TWZRD seats).

**On `main`, not in a release:** the `before_tool_call` hook refuses a payment-shaped call
whose payee it cannot read, where 0.4.3 let it run unchecked. See
[What it covers](#what-it-covers-honest). Opt out with `refuseUnparsedPayments: false`.

0.4.3 moves the gate pin from 0.12.0 to 0.12.5. By default nothing this plugin
decides changes:

- 0.12.1 through 0.12.4 add opt-in buyer-fetch and fulfillment options. This plugin
  does not call `createBuyerFetch` or pass `onFulfillment` / `expectedAmount`.
- 0.12.5 refuses a Solana devnet or testnet named only by its CAIP-2 genesis id when
  `unsupportedNetworkMode` is `strict`. The default stays `observe`. This plugin does
  not set the option. The 402 wrap builds config with `resolveConfig`, so
  `TWZRD_UNSUPPORTED_NETWORK_MODE=strict` reaches that wrap. It does not reach the
  `before_tool_call` hook.
- `refuseWashUnknown` stays opt-in until 0.13.0. This plugin passes no such option.
  `TWZRD_REFUSE_WASH_UNKNOWN=1` still reaches the 402 wrap through `resolveConfig`,
  and not the tool hook. Tests T30 and T31 pin both.

0.4.2 moved the gate pin from 0.11.4 to 0.12.0. By default nothing that release
decided changed:

- 0.12.0 adds an opt-in `refuseWashUnknown`, off in 0.12.x. Opted in, a merchant
  card that answered without full wash coverage (partial or unknown confidence,
  ring not evaluated, stale) refuses with `twzrd_wash_unknown`. This plugin passes
  no such option, so it stays off. The gate's environment switch
  `TWZRD_REFUSE_WASH_UNKNOWN=1` does reach the 402 wrap, because the wrap builds its
  config with the gate's `resolveConfig`. It does not reach the `before_tool_call`
  hook, which applies wash policy itself. Tests T30 and T31 pin both. The gate
  plans to turn the option on by default in 0.13.0, which this exact pin will not
  pick up on its own.
- The gate's own `wrapFetchWithTwzrdGate`, which the 402 wrap here mirrors, is the
  same in 0.11.4 and 0.12.0. 0.12.0's shorter wash-seat timeout applies to
  `createTwzrdWashBeforePaymentHook`, which this plugin does not use.
- 0.11.5 raised the gate's `x402-solana` peer floor to 3.0.1. This plugin does not
  install x402-solana.

0.4.1 moved the pin from 0.11.2, which npm marks deprecated, to 0.11.4 (tests T28
and T29).

`wrapFetchWithTwzrdPreflight` runs TWZRD preflight + merchant_card **wash refuse**
on every HTTP **402** before a signer can attach payment. Defaults: **enforce**,
**fail-closed**, **refuseWashFlagged on**. Shadow / fail-open / wash-off are opt-in.

Since 0.4.0 it reads a 402 the way the payer does and checks every offer the payer
could pick, matching `twzrd-x402-gate@0.12.5`'s own wrapper:

- x402 v2 requirements are read from the `PAYMENT-REQUIRED` header (base64 JSON)
  before the body. An undecodable header is refused. 0.3.0 refused every
  header-only v2 402 as `twzrd_unidentifiable_payment_recipient`.
- **Every** distinct `accepts[]` entry must pass, not just the first. More than 8
  distinct entries are refused (`too_many_payment_options`).
- An offer naming a non-USDC asset on Solana or Base is refused before intel
  (`twzrd_non_usdc_asset`). So is an amount that is not an ASCII base-unit integer
  (`amount_malformed`) and an offer with two different prices or recipients.
- A seller intel has never evaluated is allowed up to the card's cap (currently
  $0.10), per the gate's 0.11.0 policy.

Also gates payment-shaped OpenClaw tool calls (`before_tool_call`).

**Check the seller before you pay:** free ReadinessCard first, then buy a portable signed V7
trust receipt only when you need deeper evidence.

```bash
npx twzrd-preflight <wallet-or-x402-url>
```

## Paid escalation ($0.05 signed V7 receipt)

The free card is a corpus teaser. When the decision is `warn` and you need the full renorm
score plus a portable signed receipt, the card prints the paid route:

- `GET https://intel.twzrd.xyz/v1/intel/trust/{wallet}` — 0.05 USDC via x402 (Solana mainnet):
  full intel + signed V7 receipt (V5 and V6 receipts still verify).
- `GET https://intel.twzrd.xyz/v1/intel/quick/{wallet}` — 0.001 USDC quick tier: score only,
  no receipt.

Any x402-capable client can settle these; every free card includes the exact paid URL for the
wallet it scored.

## How this fits with the rest of TWZRD

This table is maintained in [twzrd-trust](https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/ECOSYSTEM.md) and copied here unchanged, so every TWZRD repository describes the same pieces the same way.

<!-- twzrd:ecosystem:begin (generated by scripts/render-ecosystem.mjs from docs/ecosystem.json; edit that file) -->
**Pre-spend trust for AI agents that buy: check x402 services and product listings before paying.**

| You are | Free | Paid |
|---|---|---|
| an agent about to pay an x402 seller | Readiness card (allow, warn or block), wash flags, seller reputation, offline receipt check. | $0.001 `quickCheck` (seller wash risk, tier and score, no receipt); optional $0.05 trust receipt, a signed V7 receipt when you pay on Solana. |
| an agent about to buy a product from a store | `check_listing(product_url, declared_unit_price)` against a published listing card, and the Agent Shopping Check report. | Optional $0.001 checkout brief for a buyer-approved Shop Pay checkout. |

Each piece below works alone. Plugged into the hosted checks, they form one pre-spend path.

| Piece | On its own | Plugged in | Install |
|---|---|---|---|
| [Hosted checks](https://intel.twzrd.xyz/llms.txt) | Free checks with nothing to install: is this x402 seller safe to pay, and does this store listing match a published card. | The pieces below that screen a payment call it; it is where the decisions and the signed receipts come from. The receipt verifier needs no server. | Add `https://intel.twzrd.xyz/mcp` to an MCP client |
| [`twzrd-x402-gate`](https://www.npmjs.com/package/twzrd-x402-gate) | Wraps an x402 client's pay path: asks the hosted checks about the seller before your signer runs, refuses a block (the signer is never invoked), enforces a spend cap, and can issue a `twzrd.payment_decision.v1` record from its decision, signed with your own signer. | Decisions come from the hosted checks; pairs with `x402-solana` or `@x402/fetch` as the payer. | `npm install twzrd-x402-gate` |
| [`twzrd-preflight`](https://github.com/twzrd-sol/twzrd-preflight) | OpenClaw plugin: assign its wrapped fetch to the client and every 402 that passes through it is checked before a signer can attach payment (enforce and fail-closed by default). | Matches the gate's wrapper and adds OpenClaw tool-call gating, against the hosted checks. Payments outside the wrapped fetch (a ClawRouter proxy, unparsed exec or curl) are not covered. | `npm install twzrd-preflight` |
| [`twzrd-receipt-verifier`](https://github.com/twzrd-sol/twzrd-receipt-verifier) | Verifies a TWZRD receipt offline against a published Ed25519 key: no wallet, no API key, no trust in TWZRD's server. | Checks the signed receipts that the hosted checks issue. | `npx twzrd-receipt-verifier` or `pip install twzrd-receipt-verifier` |
| [`twzrd-mcp-server`](https://www.npmjs.com/package/twzrd-mcp-server) / [`twzrd-mcp`](https://pypi.org/project/twzrd-mcp/) | A local MCP client with 6 tools that pays the $0.001 and $0.05 calls itself under a spend cap (a wallet only if you enable paid calls). | Calls the hosted checks; use the hosted MCP directly for the free checks. | `npx -y twzrd-mcp-server` or `pip install twzrd-mcp` |
| [`@wzrd_sol/plugin-trustgate`](https://www.npmjs.com/package/@wzrd_sol/plugin-trustgate), [`@wzrd_sol/eliza-plugin`](https://www.npmjs.com/package/@wzrd_sol/eliza-plugin) | Framework seats: a settle hook for facilitators (see [docs](https://github.com/twzrd-sol/twzrd-trust/blob/main/docs/facilitator-trust-in-3-lines.md)), a Faremeter payer chooser, and elizaOS actions. | Each seat calls the hosted checks from inside its framework. | `npm install @wzrd_sol/plugin-trustgate` |
| [`twzrd-agent-intel`](https://pypi.org/project/twzrd-agent-intel/) | The server package behind the hosted checks. Run it yourself behind a firewall; a local run serves a small static snapshot, not live data. | Point a self-hosted instance at live data with its environment variables. | `pip install twzrd-agent-intel`, then `twzrd-agent-intel-mcp` |
| Seller starters: [`x402-solana-starter`](https://github.com/twzrd-sol/x402-solana-starter), [`x402-seller-starter`](https://github.com/twzrd-sol/x402-seller-starter) | Cloudflare Worker templates for selling a paid API to agents over x402: `x402-solana-starter` is the production-style Solana storefront (x402 v2), `x402-seller-starter` a minimal wedge. | Both default to the TWZRD facilitator. `x402-solana-starter` also runs a settle guard, advisory and fail-open, that screens payers through the hosted checks. | Deploy button in each repo |

**Put them together**

- **Refuse before signing:** gate (or preflight) + hosted checks. A blocked seller never reaches your signer. Prove it with no wallet and no spend: `curl -fsS https://intel.twzrd.xyz/v1/intel/demo-gate`.
- **Keep proof of what you paid for:** paid trust receipt + receipt verifier. A signed receipt you or anyone else can verify offline.
- **Check a listing before you buy:** `check_listing` + your human approval step. A price above the card is refused; a price below it, or a card with no price, asks a human. Optionally add the paid checkout brief.
- **Screen every settlement you broker:** plugin-trustgate settle hook + hosted checks. A facilitator aborts a settle to a blocked seller before the transfer.

**What TWZRD does not claim**

- TWZRD scores observed wallet and payment behavior. It does not prove a person, company, or agent identity.
- A listing card is an observer card, not a merchant attestation. Advertised means a captured page said it; purchase completion and delivery are not verified.
- `authorizes_spend` is always false: a check is evidence for your own spend policy, never permission to spend.
- Not a wallet. Not a payment network.
<!-- twzrd:ecosystem:end -->

## Install

```bash
npm install twzrd-preflight
# depends on twzrd-x402-gate@0.12.5 (exact)
```

Register in your OpenClaw config:

```json
{
  "plugins": ["twzrd-preflight"]
}
```

HTTP 402 wrap (OpenClaw has no global-fetch hook — assign this on the client's fetch):

```js
import { wrapFetchWithTwzrdPreflight } from "twzrd-preflight";
const fetch = wrapFetchWithTwzrdPreflight(globalThis.fetch);
```

A wash-flagged `payTo` **throws** `TwzrdPaymentBlockedError` with
`error.refuse.schema === "twzrd.gate_eval_refuse.v1"` (`signer_invocation_count: 0`,
`usdc_spent: 0`, `closes_external_adoption_metric: false`). Mechanism / harness
proof, not an EXTERNAL_RUN. No invented ALLOW txs.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `mode` | `"enforce"` | `off` / `shadow` (opt-in log-only) / `enforce` |
| `failMode` | `"closed"` | `closed` (block on intel outage) or `open` (opt-in allow) |
| `refuseWashFlagged` | `true` | Refuse when merchant_card.wash_flagged; opt out with `false` |
| `refuseUnparsedPayments` | `true` | Refuse a payment-shaped tool call whose payee cannot be read (see below); opt out with `false` |
| `timeoutMs` | `5000` | Preflight HTTP timeout in ms |
| `maxPriceUsdc` | `null` | Local price ceiling — blocks above this USDC amount without API call |
| `endpoint` | `"https://intel.twzrd.xyz"` | TWZRD intel API base URL |
| `allowWallets` | `[]` | Always-allow seller wallet addresses (no API call) |
| `denyWallets` | `[]` | Always-block seller wallet addresses (no API call) |
| `cacheTtlMs` | `3600000` | TTL for per-seller decision and 402 origin cache (1 hour) |
| `matchers` | `[]` | Custom tool matchers for coverage beyond built-in rails |

Example opt-in (legacy shadow / fail-open / wash-off):

```json
{
  "plugins": [
    {
      "name": "twzrd-preflight",
      "config": {
        "mode": "shadow",
        "failMode": "open",
        "refuseWashFlagged": false
      }
    }
  ]
}
```

## Custom matchers

Built-in coverage: AgentCash MCP tools + exec/curl x402 payments. For other payment tools:

```json
{
  "matchers": [
    {
      "tool": "payment_send",
      "walletParam": "recipient",
      "priceParam": "amount_usdc",
      "resourceParam": "memo"
    }
  ]
}
```

| Key | Required | Description |
|-----|----------|-------------|
| `tool` | yes | Tool name substring to match (case-insensitive) |
| `walletParam` | no | Param key whose value is the seller wallet (Solana base58) |
| `urlParam` | no | Param key whose value is a URL; origin used as `resource_url` |
| `priceParam` | no | Param key for payment amount in USDC |
| `resourceParam` | no | Param key for a human-readable resource name |

## What it covers (honest)

- **MCP payment tools** (AgentCash `fetch`/`bridge` style): counterparty = `origin`/`url`
  param, upgraded to the real Solana `payTo` wallet once a 402 envelope has been observed
  (`after_tool_call` cache).
- **exec/curl x402 payments**: regex extraction of `seller_wallet`/`payTo`/`price_usdc`/
  `resource_name` from the command string. A curl or wget command that sends a signed
  `PAYMENT-SIGNATURE` or `X-PAYMENT` header (`-H` / `--header`) with no seller wallet is
  checked against the `payTo` this gate saw in that origin's 402 (`after_tool_call` cache).
- **Custom matchers**: operator-defined tool + param mappings for any other payment rail.
- **A payment it cannot read is refused** (`refuseUnparsedPayments`, default on). Two shapes:
  - an exec command sending a signed payment header to a URL, with no seller wallet and no
    observed 402 for its origin. The header was signed before the hook ran, so the refusal
    stops the payment being sent, not the signing, and carries no refuse transcript;
  - a tool named, by whole word, as a payment tool (`agentcash`, `x402`, `pay`, `payment`)
    that carries a URL outside the `origin`/`url` params. The tool does not run, so neither
    does its signer.

  A refusal applies whatever `failMode` says (it is not an outage), and `shadow` logs it as a
  would-block. A read-only tool in a payment-named family, such as one whose `resource_url`
  param is not read, is refused too; a custom matcher for it turns the refusal into a check.
- **NOT covered**: ClawRouter proxy settlements (sign inside localhost:8402, invisible to tool
  hooks — needs ClawRouter's upstream `onBeforePayment` hook). An exec that pays inside another
  CLI, with no payment header on its command line, is not seen. A payee named inside the
  header payload is not decoded.

## Gate rules

- Block iff `decision === "block"`. Never gates on `can_spend` (unknown wallets score warn/45,
  which is allowed by default).
- `shadow` mode: evaluates + logs would-blocks, never blocks.
- Fail-closed by default: trust API unreachable = block (`failMode: "open"` is opt-in allow).
- A payment-shaped call with no readable payee = block, in either `failMode`
  (`refuseUnparsedPayments: false` is opt-in skip).
- Local policy (denylist, allowlist, price cap) runs without any API call.
- Loop guard: calls to the trust API itself are never gated.

## Privacy

In `shadow` and `enforce` modes, payment-shaped tool metadata is sent to `intel.twzrd.xyz`:
seller wallet, origin, price, resource name, and an `agent_intent` marker. No payload content
or full params are forwarded. The endpoint is configurable.

## Test

```bash
npm test                          # offline: intel stubbed at fetch, no network
TWZRD_PREFLIGHT_LIVE=1 npm test   # the same tests against the LIVE free preflight (no auth, no payments)
```

Offline, the stub answers only for the two sellers the harness records (one `block`, one
`warn`, each with a clean merchant card), and the run fails on any other intel request. The
`Test` workflow runs it offline on Node 20, 22 and 24; the openclaw contract checks (T10c,
T10e) run on 24 only, because openclaw needs Node >=24.16.

`npm test` also runs `test/guard-vectors.test.mjs`: the shared guard vectors from
[twzrd-trust](https://github.com/twzrd-sol/twzrd-trust/tree/main/docs/vectors), vendored in
`test/fixtures` with the commit and sha256 they were copied from, played through the
`before_tool_call` hook. The hook agrees on 8 of 17. On the other 9 it lets the payment run
where the vectors refuse, or records a different reason. Each is pinned in the test with the
outcome it reaches and why: it has no cap rule, no unevaluated rule and no wash-coverage rule,
and it reads a preflight answer with no card as `warn`.

Verified against OpenClaw **2026.7.1-2** (`openclaw.build.openclawVersion` + T10c).
Gate pin: `twzrd-x402-gate@0.12.5`. Refuse-bin spawn without `@x402/*` peers is a
missing-peer fail (exit 2), not a live dogfood EXTERNAL_RUN.

## CLI

```bash
npx twzrd-preflight <solana-wallet-or-x402-url>
npx twzrd-preflight <wallet> --json
npx twzrd-preflight <url> --strict
```

Exits 0 on allow/warn, 1 on block. Useful for scripts and one-off checks. Sends the same X-Twzrd-Caller header.

## Attribution

All preflight calls (plugin and CLI) now include:

```
X-Twzrd-Caller: twzrd-preflight/<version>
```

This lets the intel surface attribute seats and free-card usage back to this integration for scoreboard / distribution tracking.
