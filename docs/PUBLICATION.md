# Public snapshot — 2026-11-14

This is a new source snapshot of qq-bridge, with no inherited Git history. Original MIT attribution is preserved. No GitHub release is implied by the package version or references to upstream release pages.

## Included

Bridge source, QQ MCP tools, DSH plugins and presets, console pages, persona templates, offline tests, example configuration, dependency locks, launcher scripts, Android shell source, operational guides, STATUS, DEVLOG and the P6 Project Intelligence proposal.

## Excluded

Production config.json and backups; state, tokens, logs, sessions and chat records; node_modules; personal audio; temporary files, snapshots and generated builds; Android signing keys and APKs; private evaluation inputs and results; local one-off scripts and internal research/audit archives. Private few-shot conversations are replaced with newly written synthetic examples. Local account identifiers, private hostnames and user paths in published examples have been replaced with placeholders. Android users must configure their own console address and generate their own signing key.

## Installation

Use Windows and Node.js 24.14+ within major version 24. The existing launchers explicitly require node:sqlite.backup. Install with `npm ci --legacy-peer-deps` (or `npm install --legacy-peer-deps`): the upstream lock was generated without optional peer dependency resolution. Install hooks include the existing SnowLuma SDK import-extension patch.

Copy config.example.json to config.json and configure your own account, endpoints and whitelist. Both projectRead and ea2Shadow are disabled by default. The optional EA2 integration requires a separately installed EA2 project and an explicit projectDir; the sibling voice-tool is also not included. Do not enable these integrations based on a path from historical deployment notes.

## Verification scope

The STATUS and DEVLOG describe the original deployment's reported acceptance evidence. That environment's raw private evidence is not distributed. Verification of this public snapshot is recorded below after the isolated audit run. Live QQ messaging, production configuration and service restarts are outside this publication task. SKIPPED test cases remain explicitly reported.

## Publication-only fixes

The Node engine requirement and installation flags now agree with the existing launcher and dependency lock. The voice test verifies the public example instead of requiring private production configuration. The privacy scanner now advances global regular expressions correctly and applies entropy noise filtering only to the entropy rule, so custom numeric identity rules are no longer silently skipped. Its regression test is included in the offline audit suite. These changes are confined to this public copy.

## Independent verification of this snapshot

- 2026-11-14, Windows, Node.js 24.21.0.
- Fresh dependency installation: npm ci --ignore-scripts --legacy-peer-deps, followed by the declared local SDK import patch; 130 packages installed.
- Offline audit: 35/35 scripts exited successfully. Project-read: 14 passed, 1 skipped, 0 failed. Ordinary symlink creation was denied by Windows (EPERM); junction denial was verified. Other optional environment-dependent checks retain their own skip messages.
- Documentation consistency: 7 passed, 0 failed. Few-shot parsing/retrieval: 17 passed, 0 failed.
- Privacy scanner regression passed. Final repository privacy scan and an independent comparison against the original configuration's nonempty sensitive values are performed before the first commit; private values and raw logs are not published.
- No live QQ messages were sent for this publication. The original deployment was not reconfigured or restarted.
