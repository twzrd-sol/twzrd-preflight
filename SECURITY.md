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

## Dependabot security updates with no resolvable patch

`openclaw` depends on `npm@12.1.0`. That package bundles `undici@6.28.0`
(`node-gyp`) and `postcss-selector-parser@7.1.4`. Both are `inBundle`, so an
npm override cannot replace them. Dependabot's latest resolvable versions are
those bundled copies; the patched versions are `undici@6.28.1` and
`postcss-selector-parser@7.1.6`. `openclaw` also depends on `undici@8.11.2`,
so the 6.x copy cannot be collapsed onto the 8.x copy. The published plugin
depends only on `twzrd-x402-gate`. These two modules are in the dev tree.
The security update jobs fail with `security_update_not_possible` until
`openclaw` publishes an `npm` release that bundles the patched versions.
