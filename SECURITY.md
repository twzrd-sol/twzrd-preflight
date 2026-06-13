# Security Policy

## Reporting

Please report security issues privately through GitHub Security Advisories for
`twzrd-sol/twzrd-preflight`.

If GitHub advisories are unavailable, open a minimal issue that does not include
exploit details and request a private contact path.

## Scope

This repository contains the OpenClaw `twzrd-preflight` plugin and Codex
packaging metadata. The plugin calls `https://intel.twzrd.xyz/v1/intel/preflight`
for payment-shaped tool calls and should be treated as payment-adjacent code.

Do not include private keys, wallet seed material, API keys, or unpublished
counterparty data in public reports.
