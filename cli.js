#!/usr/bin/env node
/**
 * twzrd-preflight CLI — one-command trust check for Solana wallets and x402 URLs.
 *
 * Usage:
 *   npx twzrd-preflight <wallet-or-url>
 *   npx twzrd-preflight <wallet-or-url> --json
 *   npx twzrd-preflight <wallet-or-url> --strict   (exit 1 on warn too)
 *
 * Exit codes:
 *   0  decision=allow or decision=warn (safe to proceed)
 *   1  decision=block (do not pay this counterparty)
 *   2  usage error or preflight unavailable
 */

const BASE = "https://intel.twzrd.xyz";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,50}$/;

// ANSI colours (suppressed when NO_COLOR set or stdout not a TTY)
const color = process.env.NO_COLOR || !process.stdout.isTTY
  ? { reset: "", bold: "", red: "", yellow: "", green: "", cyan: "", dim: "" }
  : {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      red: "\x1b[31m",
      yellow: "\x1b[33m",
      green: "\x1b[32m",
      cyan: "\x1b[36m",
      dim: "\x1b[2m",
    };

function c(col, text) { return col + text + color.reset; }

function printHelp() {
  console.log(`
${c(color.bold, "twzrd-preflight")} — TWZRD trust check for Solana wallets and x402 endpoints

${c(color.bold, "Usage:")}
  npx twzrd-preflight <wallet-or-url> [options]

${c(color.bold, "Arguments:")}
  <wallet-or-url>   Solana wallet address (base58) OR an https:// URL of an x402 endpoint

${c(color.bold, "Options:")}
  --json            Output raw JSON (readiness_card) — suitable for piping
  --strict          Exit 1 on decision=warn as well as block
  --no-color        Suppress ANSI colours (also: set NO_COLOR env var)
  --help, -h        Show this help

${c(color.bold, "Examples:")}
  npx twzrd-preflight 34w53Ukhf4BvyEpFMt2iMiMCpC5xhobAqn5E1BX8eete6
  npx twzrd-preflight https://stableenrich.dev/v1/enrich --json

${c(color.bold, "Exit codes:")}
  0   allow or warn — counterparty appears legitimate
  1   block — do not pay this counterparty
  2   usage error / preflight unavailable
`);
}

function decisionColor(decision) {
  if (decision === "block") return color.red;
  if (decision === "warn") return color.yellow;
  return color.green;
}

function formatCard(card, raw) {
  const d = card.decision ?? "?";
  const dc = decisionColor(d);
  const score = card.trust_score != null ? card.trust_score.toFixed(1) : "?";
  const canSpend = card.can_spend === true ? c(color.green, "yes") : c(color.yellow, "no");

  const lines = [
    "",
    `${c(color.bold, "TWZRD Preflight")}  ${c(color.dim, `#${raw.preflight_id ?? "?"}`)}`,
    "",
    `  ${c(color.bold, "Seller")}     ${card.seller_wallet ?? card.resource_name ?? "?"}`,
    `  ${c(color.bold, "Decision")}   ${c(dc + color.bold, d.toUpperCase())}`,
    `  ${c(color.bold, "Score")}      ${score} / 100`,
    `  ${c(color.bold, "Can spend")}  ${canSpend}`,
  ];

  if (card.caveats?.length) {
    lines.push("", `  ${c(color.bold, "Caveats")}`);
    for (const cav of card.caveats.slice(0, 4)) {
      lines.push(`  ${c(color.dim, "-")} ${cav}`);
    }
  }

  if (card.next_fixes?.length && d !== "allow") {
    lines.push("", `  ${c(color.bold, "Next fixes")}`);
    for (const fix of card.next_fixes.slice(0, 3)) {
      lines.push(`  ${c(color.dim, "+")} ${fix}`);
    }
  }

  if (card.paid_deep_dive) {
    lines.push("", `  ${c(color.dim, "Full report:")} ${c(color.cyan, `https://intel.twzrd.xyz${card.paid_deep_dive}`)}`);
  }

  lines.push("");
  return lines.join("\n");
}

async function run() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  const jsonMode = args.includes("--json");
  const strictMode = args.includes("--strict");
  const positional = args.filter(a => !a.startsWith("--"));

  if (positional.length === 0) {
    console.error("Error: provide a wallet address or URL.");
    printHelp();
    process.exit(2);
  }

  const input = positional[0];

  // Build preflight body: wallet vs URL
  let body;
  if (BASE58_RE.test(input)) {
    body = { seller_wallet: input };
  } else if (input.startsWith("http://") || input.startsWith("https://")) {
    // Extract seller_wallet from URL if it looks like a wallet path segment,
    // otherwise send as resource_url and let the server resolve it.
    const urlPath = new URL(input).pathname;
    const walletMatch = BASE58_RE.exec(urlPath.split("/").pop() ?? "");
    if (walletMatch) {
      body = { seller_wallet: walletMatch[0], resource_url: input };
    } else {
      body = { resource_url: input, resource_name: input };
    }
  } else {
    console.error(`Error: "${input}" is not a base58 wallet address or a https:// URL.`);
    process.exit(2);
  }

  // Hit the free preflight
  let raw, card;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${BASE}/v1/intel/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Preflight error: HTTP ${res.status} ${text.slice(0, 120)}`);
      process.exit(2);
    }
    raw = await res.json();
    card = raw.readiness_card ?? raw;
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("Preflight timed out (8s). Is https://intel.twzrd.xyz reachable?");
    } else {
      console.error(`Preflight failed: ${err.message}`);
    }
    process.exit(2);
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(raw, null, 2) + "\n");
  } else {
    process.stdout.write(formatCard(card, raw));
  }

  const decision = (card.decision ?? "warn").toLowerCase();
  if (decision === "block") process.exit(1);
  if (strictMode && decision === "warn") process.exit(1);
  process.exit(0);
}

run().catch(err => {
  console.error("Unexpected error:", err.message);
  process.exit(2);
});
