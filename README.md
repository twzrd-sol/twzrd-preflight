# twzrd-preflight

OpenClaw plugin: TWZRD trust gate for agent payments. Gates payment-shaped tool calls via a
free preflight check before they execute. Blocked counterparties are stopped (enforce mode) or
logged (shadow mode). Safe counterparties are allowed through; decisions are cached for 1 hour.

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

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `mode` | `"shadow"` | `off` / `shadow` (log only) / `enforce` (block on decision=block) |
| `failMode` | `"open"` | `open` (allow on API timeout) or `closed` (block on timeout, enforce only) |
| `timeoutMs` | `5000` | Preflight HTTP timeout in ms |
| `maxPriceUsdc` | `null` | Local price ceiling — blocks above this USDC amount without API call |
| `endpoint` | `"https://intel.twzrd.xyz"` | TWZRD intel API base URL |
| `allowWallets` | `[]` | Always-allow seller wallet addresses (no API call) |
| `denyWallets` | `[]` | Always-block seller wallet addresses (no API call) |
| `cacheTtlMs` | `3600000` | TTL for per-seller decision and 402 origin cache (1 hour) |
| `matchers` | `[]` | Custom tool matchers for coverage beyond built-in rails |

Example enforce config:

```json
{
  "plugins": [
    {
      "name": "twzrd-preflight",
      "config": {
        "mode": "enforce",
        "maxPriceUsdc": 1.00,
        "denyWallets": ["<known-bad-wallet>"]
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
