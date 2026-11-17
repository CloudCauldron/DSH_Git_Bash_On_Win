# DSH Git Bash on Windows

Backend refactor for native Windows x64, Node 26+ and DSH **0.2.2-rc.2**.
**Phases 1–2 provide maintained inputs, local cache preparation, native pin lifetime
and strict cache purge. UAC, executor and debugger integration remain pending.
Do not install or publish this tree.** Execution and package-manager entries remain
gated; `prepack` blocks release packaging.

The approved [roadmap](docs/backend-20261117-refactor-roadmap.md),
[contract baseline](docs/backend-20261117-contract-baseline.md) and
[design decisions](docs/backend-20261117-design-decisions.md) govern later phases.
The local `.deprecated/` archive is reference material, excluded from maintained
source, tooling, tests, build output and packages. No archived runtime is launched.

## Development

Run these commands in **Windows-native Git Bash**:

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm check
pnpm lint
pnpm test:windows
```

`pnpm build` cleans `lib/` before compiling only `src/`. `pnpm check` and lint
also cover `scripts/` and `test/`; `pnpm test` rebuilds and runs maintained
`node --test` cases. The TypeScript 7 compiler uses the `@typescript/native`
alias; TypeScript 6 supplies the API required by typescript-eslint.
Public DSH dependencies, including `@deepseek-ai/dsh-atomic-write`, are pinned.

Bootstrap tests verify the native schema, Loader entry/configuration identity,
installed CLI discovery, public dependency resolution and transitive input
exclusion. They use disposable fixtures and never open a personal profile.
The native Phase 2 suites verify root ownership, bounded inventory/linking,
single-record publication, warm admission, pin/collector sharing, interrupted
collection/purge, view lifetime and cleanup. Fixtures contain owned source files;
tests verify restored source link counts and unchanged contents/ACLs after purge.
These checks do not establish UAC or real DSH Bash execution correctness.

`scripts/installed-dsh.ts` discovers the installed CLI without loading a profile.
If discovery is ambiguous, set `DSH_PACKAGE_JSON` for the current process to the
absolute installed `@deepseek-ai/dsh/package.json`. The selected CLI must match
the pinned release. Only an absent CLI skips the installed-CLI test; ambiguous,
invalid or broken installations fail validation. `scripts/plugin.ts` currently
rejects every package operation before loading a profile or starting pnpm. Its
official DSH delegation will be enabled after runtime integration and release
validation. It does not load a personal profile during these tests.

Production package inputs are limited to `lib/`, `cordis.patch.yml`, `README.md`
and the manifest. For an inclusion audit only, `pnpm --ignore-scripts pack
--dry-run --json` bypasses the release gate without creating/installing a tarball.
Do not use that bypass to distribute this bootstrap.

## Integration and isolation contract

The bundle is Windows-only. The adapter preserves native entry IDs, canonical
module names and Shell configuration. The native Bash schema is reused with one
additional volatile `gitBashPath` setting; presets and tools reuse DSH modules.
There is no frontend or custom settings UI.

All future compatibility work stays within DSH's Windows Git Bash process family.
Ordinary Git Bash, other hosts, WSL and non-Windows DSH must remain unaffected.
Installed Git/DSH contents and ACLs, registry settings and global environment are
never modified. Managed artifacts stay in private DSH cache directories.

## Recovery and complete uninstallation

The cache layer now provides guarded offline purge. Normal pin retirement retains
the validated cache, refuses new uses, and protects existing uses with the same
native directory handle until their last release. View cleanup is best effort;
native handle close failures remain errors. Process shutdown will be integrated
with the executor in later phases.

Close all relevant DSH instances before running:

```bash
node lib/cleanup.js '<absolute profile cache path>'
```

This purges both the supplied profile cache and the package `.runtime` fallback.
Only a root with this implementation's valid ownership marker is admitted; an old,
markerless or unrecognized directory is refused without deletion. Recovery uses
ordinary plan unlink and native generation claims; a busy pin or plan prevents
completion. Deletion uses checked `DeleteFileW`/`RemoveDirectoryW` calls without
attribute repair; read-only files cause an explicit obstruction. Enumerated names
are addressed exactly, including unusual trailing characters. After an obstruction
clears, rerun purge. For offline rebuilding,
retain the package and settings. Automatic cold preparation on the next Bash call
will become available with the executor integration.

Complete uninstallation requires removing only the plugin-specific `gitBashPath`
override while preserving shared Shell settings, closing all relevant DSH
instances, successfully purging both caches, then using official package removal.
Purge must not follow junctions/reparse points; interruptions, blocked removal
and failed native closes must fail explicitly. Never recursively delete these
caches as a substitute for guarded purge.

Source contents and ACLs must remain unchanged and source link counts must be
restored. Hardlink creation/removal changes filesystem-maintained timestamps,
archive bits and journal/audit records; this permitted bookkeeping is observable.
No bit-for-bit restoration of host state is promised.

The six-anchor warm check is a bounded freshness sample, not a full-tree
comparison. Restart does not promise non-anchor repair; explicit rebuild restores
layout from installed Git and cannot repair damaged source bytes.

Local preparation probes one Bash hardlink before inventory, then links one fresh
base and atomically publishes `current.json`. A permission denial at that probe
currently reports that Phase 3 elevation is unavailable. Other setup failures drain
work and leave no published partial generation. Preparation and recovery do not run
archived helpers. Warm hits do not create owner files, scan the tree, collect old
generations or wait on the writer lock. Native fixture measurements are reported
by the tests; 5 ms remains an unestablished target.
