# @topolyte/windows-acl

Windows ACL write-restriction sandbox provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
with **non-blocking workspace-grant materialization**.

The official windows-acl backend materializes a workspace's standing write ACE
synchronously inside `confine()`: on a large workspace the eager
inheritable-ACE propagation (`SetNamedSecurityInfoW`) walks the whole tree for
minutes **on the Node event loop**, freezing the entire server (all sessions,
HTTP, RPC) on first use. This package fixes that — the tree walk runs in a
`grant-cli` child process, fire-and-forget, so the first provision never
freezes a command spawn.

Installs on the **official** harness as a `ctx.sandbox` replacement via the
Cordis bundle-patch mechanism — **no fork required**.

## What it does

- **Non-blocking authorization** — the workspace's standing write ACE is
  materialized out-of-band by a `grant-cli` child process (`spawn`, not
  `spawnSync`); concurrent first-time calls for one workspace coalesce onto a
  single helper spawn.
- **Fail-closed, never a freeze** — until the standing ACE lands, the confined
  child's workspace writes are denied (`access is denied`); once it stands, the
  exact-ACE skip makes every later provision O(1).
- **Standing / revocable lifecycle preserved** — the workspace ACE is the
  cross-session reuse cache (never revoked); each session/workspace pair gets a
  random private temp directory with its own capability SID, revoked on
  provider dispose.
- **`prewarm` config** — start the walk at boot for known workspaces, shrinking
  the fail-closed window before the first command.
- Built on the official `@deepseek-ai/dsh-sandbox-windows-acl` primitives
  (`AclWriteGrant`, `workspaceWriteSid`, `tempWriteSid`) and the official
  `SandboxProvider` base class — the full official sandbox semantics are
  inherited.

## Install

```sh
dsh plugin --profile <name> add @topolyte/windows-acl
```

The bundle's `cordis.patch.yml` disables the official `@deepseek-ai/dsh-sandbox-local`
row and inserts this provider under its own id (`topolyte-sandbox`), so it
becomes the only live `ctx.sandbox` service. Configure the workspaces to
pre-warm at boot:

```yaml
- insert:
    - id: sandbox
      name: '@topolyte/windows-acl'
      config:
        prewarm:
          - C:/path/to/your/workspace
```

## How it works

```
tool-pwsh / tool-bash
  └─ confine() ──► TopolyteWindowsAclProvider (extends SandboxProvider)
       ├─ kickOffWorkspaceGrant(root)      spawn grant-cli child (never awaited)
       │     └─ grant-cli: AclWriteGrant.add(root, standing)  ← full-tree walk HERE
       └─ runner argv: --workspace --temp --mode --write-sid --temp-write-sid
```

The expensive `grantWrite → SetNamedSecurityInfoW` eager inheritance walk runs
in the `grant-cli` child process, so the harness event loop never blocks.

## Test

```sh
# unit tests
pnpm --filter @topolyte/windows-acl exec vitest run

# real end-to-end (ACL semantics via icacls; spawns real grant-cli + runner)
pnpm --filter @topolyte/windows-acl exec node --import tsx/esm scripts/e2e-acl.ts
```

## Why not a fork / PR

The upstream maintainers are aware of the ACL cost (see the "eager inheritance;
minutes on large workspaces" note in the official `acl.ts`) but do not accept
PRs. This package ships the same fix as an independent, installable plugin so
any official-harness user gets the non-blocking behavior without maintaining a
fork.

## Third-party notices

This package builds on, and in no way modifies, the following upstream projects
(their licenses apply to the linked sources, not to this package's own code):

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT) —
  `SandboxProvider` base class and the `dsh` plugin/bundle runtime this plugin
  plugs into (`@deepseek-ai/dsh-sandbox`, `@deepseek-ai/dsh-sandbox-windows-acl`,
  `@deepseek-ai/dsh-sandbox-local`).
- [Cordis](https://github.com/cordiverse/cordis) (MIT) — the plugin/bundle
  container (`ctx`, `plugin`, bundle-patch layers).
- [koffi](https://github.com/Koromix/rygel) (MIT) — the FFI layer used by the
  upstream windows-acl backend for `SetNamedSecurityInfoW`; not a direct
  dependency here but transitively exercised by the ACL primitives we reuse.
- [Win32 API `SetNamedSecurityInfoW`](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setnamedsecurityinfow)
  — Microsoft docs reference for the inherited-ACE propagation semantics this
  fix avoids.

All reuse is via the official packages' published public APIs and type
declarations; no upstream source is vendored or copied into this repository.

## Contributing

Contributions are welcome but should stay within the package's narrow scope:
non-blocking Windows ACL sandboxing for DeepSeek Harness. Before opening a PR,
please:

1. Keep every change on a real code path — no empty skeletons, no
   `not-implemented` stubs, no hardcoded values.
2. Preserve the fail-closed invariant: a missing standing ACE must deny, never
   freeze, and never silently widen the grant.
3. Add or update tests: unit tests (`vitest run`) and, for ACL semantics, the
   real end-to-end script (`scripts/e2e-acl.ts`, Win32-only, asserts via
   `icacls`).
4. Verify with `pnpm --filter @topolyte/windows-acl exec vitest run` before
   submitting.

Report bugs and upstream concerns via GitHub issues rather than forks; this
package deliberately avoids forking the official harness.

## License

MIT
