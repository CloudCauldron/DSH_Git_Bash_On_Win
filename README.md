# DSH Git Bash on Windows

Backend refactor for native Windows x64, Node 26+ and DSH **0.2.2-rc.2**.
**Phase 1 restores development inputs only. Runtime preparation, execution and
strict cache purge are not implemented yet. Do not install or publish this tree.**
Execution, cleanup and package-manager entries fail explicitly; `prepack` blocks
release packaging.

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
They do **not** establish native cache, UAC, debugger or Bash execution correctness.
Those suites will be added with their modules in Phases 2–6.

`scripts/installed-dsh.ts` discovers the installed CLI without loading a profile.
If discovery is ambiguous, set `DSH_PACKAGE_JSON` for the current process to the
absolute installed `@deepseek-ai/dsh/package.json`. The selected CLI must match
the pinned release. Only an absent CLI skips the installed-CLI test; ambiguous,
invalid or broken installations fail validation. `scripts/plugin.ts` currently
rejects every package operation before loading a profile or starting pnpm. Its
official DSH delegation will be enabled with maintained installation and strict
purge; no pnpm argument parser or provisional cleanup API is needed in Phase 1.

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

These are implementation requirements, not currently available operations.
Normal disposal must stop/join owned work and close native handles and locks;
the validated cache persists. Private ephemeral residue may remain for later GC.

Once guarded cleanup is implemented, offline rebuilding will require closing all
relevant DSH instances and running `node lib/cleanup.js <absolute profile cache
path>` to purge both the profile `.git-bash-on-win` and package `.runtime` caches.
Keep the package and settings, then restart for cold preparation. The future
online rebuild operation will preserve existing uses of retired pins.

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

The planned six-anchor warm check is a bounded freshness sample, not a full-tree
comparison. Restart does not promise non-anchor repair; explicit rebuild restores
layout from installed Git and cannot repair damaged source bytes.
