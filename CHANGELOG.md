# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-20

Follow-up hardening of the confinement state machine, aligned with the
community repair invariants in the DeepSeek Harness Handbook.

### Added

- No child starts before the grant is confirmed — while a workspace is
  `preparing` or `failed`, `confine()` refuses with `SandboxUnavailableError`
  instead of starting a half-authorized command; only `ready` proceeds.
- Workspace roots are canonicalized (`realpathSync.native`, per the official
  `workspaceWriteSid` contract), so every spelling of one directory shares one
  in-flight grant, one SID, and one failure counter.

### Changed

- E2E probe reads the real temp path from the confined runner argv and
  captures full JSON braces in the probe regex (tests only).

### Docs

- Grant state machine and lifecycle diagram (`preparing` / `ready` / `failed`).
- Deep benchmark scaling data — power-law fit, fail-closed confirm window, and
  event-loop responsiveness — with raw report (`docs/bench-acl-deep.json`) and
  plot script.

## [0.1.0] - 2026-08-19

First release. A `ctx.sandbox` provider for DeepSeek Harness that materializes
the Windows ACL workspace write grant out-of-band, so a large workspace's first
provision never freezes the event loop.

### Added

- Non-blocking workspace authorization: the standing write ACE is materialized
  by a `grant-cli` child process (fire-and-forget), never on the event loop.
- Concurrent first-time grants for one workspace coalesce onto a single
  `grant-cli` spawn.
- Standing / revocable lifecycle: the workspace ACE is the cross-session reuse
  cache (never revoked); each session/workspace pair gets a random private temp
  directory with its own capability SID, revoked on provider dispose.
- `prewarm` config to start the walk at boot for known workspaces, shrinking
  the fail-closed window before the first command.
- Bounded retry (`maxGrantRetries`, default 3): consecutive grant failures pin
  a workspace to the `failed` state; `retryWorkspaceGrant` resets the counter.
- Explicit grant state via `workspaceGrantState(root)`
  (`preparing` / `ready` / `failed`).
- Settle-aware shutdown: provider dispose waits for in-flight grant helpers
  before revoking temp ACEs.
- Cordis bundle-patch installation on the official harness — no fork required.

### Fixed

- Replaced the non-existent `z.number().int()` with `min(0).step(1)` so the
  config schema builds against `@deepseek-ai/schemastery` 3.18.1's published
  types (no `.int()` on `Schema<number>`).
- Pointed the package `repository` field at the real upstream
  (`Ranecc/topolyte-windows-acl`).
