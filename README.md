# twzrd-preflight

OpenClaw plugin **0.2.0**: install = intercept.

`wrapFetchWithTwzrdPreflight` runs TWZRD preflight + merchant_card **wash refuse**
on every HTTP **402** before a signer can attach payment. Defaults: **enforce**,
**fail-closed**, **refuseWashFlagged on**. Shadow / fail-open / wash-off are opt-in.

Also gates payment-shaped OpenClaw tool calls (`before_tool_call`).

**Check the seller before you pay:** free ReadinessCard first, then buy a portable signed V6
trust receipt only when you need deeper evidence.

```bash
npx twzrd-preflight <wallet-or-x402-url>
```

## Paid escalation ($0.05 signed V6 receipt)

The free card is a corpus teaser. When the decision is `warn` and you need the full renorm
score plus a portable signed receipt, the card prints the paid route:

- `GET https://intel.twzrd.xyz/v1/intel/trust/{wallet}` — 0.05 USDC via x402 (Solana mainnet):
  full intel + signed V6 receipt.
- `GET https://intel.twzrd.xyz/v1/intel/quick/{wallet}` — 0.001 USDC quick tier: score only,
  no receipt.

Any x402-capable client can settle these; every free card includes the exact paid URL for the
wallet it scored.

## Install

```bash
npm install twzrd-preflight
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
`usdc_spent: 0`). Mechanism proof, not an EXTERNAL_RUN.

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `mode` | `"enforce"` | `off` / `shadow` (opt-in log-only) / `enforce` |
| `failMode` | `"closed"` | `closed` (block on intel outage) or `open` (opt-in allow) |
| `refuseWashFlagged` | `true` | Refuse when merchant_card.wash_flagged; opt out with `false` |
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
- **exec/curl x402 payments**: conservative regex extraction of `seller_wallet`/`payTo`/
  `price_usdc`/`resource_name` from the command string. Failed parse = no gate (never blocks
  on extraction bugs).
- **Custom matchers**: operator-defined tool + param mappings for any other payment rail.
- **NOT covered**: ClawRouter proxy settlements (sign inside localhost:8402, invisible to tool
  hooks — needs ClawRouter's upstream `onBeforePayment` hook).

## Gate rules

- Block iff `decision === "block"`. Never gates on `can_spend` (unknown wallets score warn/45,
  which is allowed by default).
- `shadow` mode: evaluates + logs would-blocks, never blocks.
- Fail-open by default: trust API unreachable = allow (`failMode: "closed"` reverses this).
- Local policy (denylist, allowlist, price cap) runs without any API call.
- Loop guard: calls to the trust API itself are never gated.

## Privacy

In `shadow` and `enforce` modes, payment-shaped tool metadata is sent to `intel.twzrd.xyz`:
seller wallet, origin, price, resource name, and an `agent_intent` marker. No payload content
or full params are forwarded. The endpoint is configurable.

## Test

```bash
npm test    # 13-case harness; hits the live FREE preflight (no auth, no payments)
```

Verified against OpenClaw 2026.3.13.

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
