# DSH Git Bash on Windows

Experimental, TypeScript-only Git Bash provider for native Windows x64 DSH **0.2.2-rc.2**, using Git for Windows and Node 26+. WSL and other operating systems are excluded by the bundle's platform admission rule.

The plugin retains DSH's sandbox, shell settings, native Bash tool, output collection, deadlines, background jobs, and approval mechanism. Compatibility failure stops execution; there is no unrestricted retry. Windows ACL enforcement remains DSH's existing **partial** enforcement, including its existing limits on reads, network access, and hardlinks.

## Build and verify

Run in **native Windows Git Bash**, from this repository:

```bash
pnpm install --ignore-scripts
pnpm lint
pnpm check
pnpm build
pnpm test:windows
```

ESLint checks source, tests, and scripts with the recommended JavaScript/TypeScript rules and type-aware promise checks. It follows `.gitignore`, adds no formatting rules, and rejects explicit `any`; native and dynamic API boundaries use named contracts or `unknown`. The TypeScript 7 compiler remains available as `tsc` through the `@typescript/native` alias; the `typescript` alias supplies the TypeScript 6 compatibility API required by typescript-eslint, following [Microsoft's side-by-side guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60).

The Windows tests provision runtime hardlinks directly from the installed Git into a disposable temporary tree. They also create synthetic, user-owned files for replacement/refresh tests; they do not replace installed Git binaries. Profile/install checks pack the current build into the temporary scope. The isolated DSH home, profile, workspace, runtime directories, and test files are removed at completion. Reports are written under `test/results/`.

Initial live setup requires interactive approval of the fixed hardlink helper's Windows UAC prompts. The 120-second command/subprocess deadline limits the caller's wait, not the lifetime of an unresolved Windows consent dialog. Cancellation signals the fixed helper to stop before/between links and prevents publication of the aborted setup; rollback waits for the actual helper and worker to exit. Windows provides no supported way here to forcibly dismiss pending consent, so provider disposal must wait for the user to accept or cancel that dialog. Missing profile verification reports include the subprocess exit status and stderr.

The aggregate test command runs focused lifecycle regressions, live execution/profile checks, and packed install/uninstall checks. Coverage includes fresh-process cache reuse and metadata recovery without setup, concurrent owners, update/repair while an old generation remains in use, owner death, symmetric workspace/source/cache separation, source/parent junction rejection, pre-creation validation, automatic cleanup retries, loader-verification failures, readable output spill files, and selection of a distinct Git root. Timeout, cancellation, and normal shell-exit checks observe live child/grandchild processes and retain process handles until their exit is confirmed. The live profile suite runs the real tools again after a DSH restart, checking that the generation is unchanged and no elevation was requested.

`node test/plugin.ts --profile-only` runs just the isolated profile checks. The repository retains its historical Phase 1/2 experiments in `docs/POC.md`; their debugger implementation is shared with the plugin.

## Installation after review

The development/test workflow does **not** install this plugin into the active `web` profile. To package and install it after approval:

```bash
pnpm build
pnpm pack --pack-destination artifacts
gitbash_pnpm="$(cygpath -m "$(type -P pnpm.exe)")"
node scripts/plugin.ts "$gitbash_pnpm" web add "$(cygpath -m "$PWD/artifacts/dsh-git-bash-on-win-0.1.0-experimental.1.tgz")" --ignore-scripts
dsh --profile web --dump-config
```

This machine's DSH CLI fails to resolve the bare `pnpm` executable. The small repository helper calls the **same official DSH plugin-manager operation**, including compatibility checks and bundle reconciliation, with an absolute `pnpm.exe` path. It changes no global PATH or core files. Where native executable lookup works, the equivalent standard command is `dsh plugin --profile web add <tarball> --ignore-scripts`.

Restart DSH normally. Keep DSH unelevated. Restart after enabling/disabling the bundle or its replacement entries.

For a nonstandard installation, set `gitBashPath` on the existing `pwsh-sandbox` row, using DSH's native plugin configuration editor. A profile override is also supported:

```yaml
- id: pwsh-sandbox
  config:
    gitBashPath: 'C:/Tools/Git/bin/bash.exe'
    # Retain any shell settings already configured on this row.
```

DSH replaces a patched `config` wholesale. Preserve any existing timeout/output values when editing YAML. Both Git's `bin/bash.exe` and `usr/bin/bash.exe` are accepted. The runtime directory and Git installation must be on the same NTFS volume and outside the workspace.

The backend reuses the native Bash schema for `cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, and `graceMs`. All six fields, plus `gitBashPath`, use DSH's native validation, live configuration references, and profile persistence. Changes apply to subsequent commands without replacing the executor. No frontend or client behavior is added.

For complete uninstallation, first remove any optional `gitBashPath` override, preserving other Shell settings (delete a manually edited override row if it becomes empty), and close every DSH instance using the profile or installed package. The repository helper purges both the profile cache and the installed package's fallback `.runtime` before invoking the official package-removal operation, and refuses to purge an active cache:

```bash
node scripts/plugin.ts "$gitbash_pnpm" web remove dsh-git-bash-on-win --ignore-scripts
```

For removal with DSH's native CLI instead, purge the caches with the packaged cleanup entry **before** removing the package. It purges its own package fallback as well as the specified cache. For the default home/profile location, from native Windows Git Bash:

```bash
profile_dir="${DSH_HOME:-$HOME/.dsh}/profiles/web"
node "$profile_dir/node_modules/dsh-git-bash-on-win/lib/cleanup.js" "$(cygpath -m "$profile_dir/.git-bash-on-win")"
dsh plugin --profile web remove dsh-git-bash-on-win --ignore-scripts
```

Native plugin-manager removal alone does not purge the cache. A remaining cache or plugin-only override means complete uninstallation has not finished.

## Setup and isolation

**Scope and clean-removal guarantee:** This plugin operates exclusively within DSH's Git Bash execution on Windows. It does not patch the configuration or execution behavior of ordinary Git Bash or existing host programs. It makes no persistent system-wide configuration changes: no registry changes, global `PATH`/environment changes, or edits to installed Git/DSH binary contents or their ACLs. All plugin-managed runtime artifacts and temporary locks stay in DSH-scoped directories, preferably the plugin's private directories. Complete uninstallation removes every plugin-managed file, hardlink, junction/view, lock, and configuration residue and restores source link counts.

NTFS bookkeeping is the explicitly accepted exception: creating/removing hardlinks changes filesystem-maintained change timestamps, can set the archive bit, and produces journal/audit records. These metadata effects can be observed by backup/monitoring tools and are not reversed. Source contents and ACLs remain unchanged; the plugin never rewrites source attributes/timestamps or clears journals. This is clean artifact/configuration removal, not bit-for-bit restoration of filesystem metadata. [Microsoft's hardlink operation specification describes these effects.](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/891bb8eb-89f8-46ca-80b7-9f5d4e8b5583)

Runtime files are NTFS hardlinks, never copies. They include MSYS programs, runtime libraries/shared data and TLS configuration, Git's native architecture binaries/helpers/libraries/templates, and its `etc` layout; desktop metadata and standalone documentation are excluded. An internal `/bin` junction resolves back to the same private `usr/bin`; child `PATH` and Git helper paths use the private tree. The debugger rejects MSYS executables outside that tree.

Protected `Program Files` binaries require Administrator permission to create hardlinks. Windows UAC elevates **only a fixed TypeScript-compiled link helper**. It only adds links into prepared private directories and reports the result. It does not run shell commands, alter source ACLs, or elevate DSH. Refusing UAC fails setup closed. [Microsoft documents the source write-attributes requirement.](https://www.microsoft.com/en-us/msrc/blog/2025/06/redirectionguard-mitigating-unsafe-junction-traversal-in-windows)

The profile's fixed `.git-bash-on-win` directory contains a persistent cache: `current.json` selects a generation under `generations/`. Generation names derive from the source fingerprint; repair uses a fresh short name to preserve a generation still in use. This profile-scoped storage keeps native executable paths short even when pnpm installs the package deeply. A composition without profile metadata uses the package's fixed `.runtime` directory.

The runtime parent and all existing ancestors must be directories without reparse points. The workspace, Git source, and runtime cache must be disjoint in both containment directions, validated before any runtime directories are created. Source and cached-layout traversal also checks every selected root's ancestors, including intermediate `usr` and architecture `libexec` directories. Cleanup rechecks the parent path and refuses redirection rather than following a junction to another directory.

Separate runtime paths keep read-only, workspace-write, and full-access apart. Small private junction views give sessions independent MSYS namespaces over the same linked files. The startup hook retains a view's valid DLL pathname in MSYS's installation-root buffer while redirecting its optional normalization output to private scratch memory. It verifies the DLL file identity first; native calls/returns still execute normally. Session views are reused; agentless views are released after execution.

Every loaded module must be identified. The debugger checks the resolved PSAPI path or the DLL debug event's full Unicode loader name against the private DLL path. Verification may be deferred while startup information is unavailable, but must succeed at the initial breakpoint or subsequent MSYS load; unresolved paths stop the private process family.

Preparation fingerprints the source's layout, file identities (`dev`/`ino`), sizes, and modification timestamps, then verifies all three cached mode trees and their private `/bin` junctions against that source. A matching cache is reused across process restarts without creating links or requesting UAC. Missing or malformed metadata is recovered from a generation only after the same source/layout/identity verification, including previously repaired generations. Missing or replaced links, a changed Git installation, or a different configured source trigger provisioning when no verified generation matches. Setup still tries unelevated hardlinks first; protected Git files require the fixed elevated helper only when provisioning is necessary. All three modes are provisioned together, and modal UAC work remains on a separate Node worker whose actual exit is joined.

An exclusive, delete-on-close file serializes cache preparation and publication across DSH instances. Each execution holds a generation lease until it finishes; normal disposal first cancels and joins all owned work. Superseded generations are removed when their last lease ends, while the current generation remains available for the next startup. Windows closes these private lease/lock handles on owner death as well. Instance-owned views are removed on disposal, and stale views from exited owners are collected on subsequent preparation. All lease files, locks, staging directories, and metadata remain inside the private cache.

The confined launcher inherits the original DSH token and creates a contained private process family using DSH's Win32 Job primitives. Hardware breakpoints adjust only that private MSYS family's startup path, new signal pipes, proposed default DACLs, and private `cygpid` mappings. Repairs reuse the **already present logon SID** in read-only mode and the **original private-temp SID** in workspace-write mode. Session namespace separation avoids broadening grants to share IPC across different temp capabilities. Explicit full-access mode needs no IPC repairs. Restricted SIDs, privileges, Low integrity, filesystem grants, and native policy approval remain DSH-owned. Existing processes and existing kernel-object ACLs are not modified.

Hardlinks share both data and security descriptors with their source. Setup/disposal never writes through them, applies ACLs, or calls chmod. Cleanup uses explicit unlink/rmdir operations because recursive package/file removal is not a substitute for the plugin's ownership and cleanup checks. Workspaces overlapping runtime/source trees in either direction are refused before confinement, so workspace ACL inheritance cannot reach linked program files. Source files carrying the Windows read-only *attribute* are refused as well.

Normal disposal cancels and joins plugin executions and preparation work, then removes instance-owned views and leases while retaining the validated current cache. Generation collection, complete cache removal, and setup rollback share a bounded retry policy for transient sharing/permission failures, using only unlink/rmdir operations. Complete uninstallation additionally removes the persistent cache and any optional plugin-only `gitBashPath` override, following the procedure above; source link counts are restored when the cache is purged. DSH's plugin manager preserves user-authored configuration and has no bundle cache-cleanup hook, so bundle removal alone is insufficient. Forced termination, power loss, or a reported cleanup error can leave artifacts; any remaining plugin-private artifacts must be removed before uninstallation is complete. This guarantee covers plugin-managed changes; DSH's own standing workspace ACL grants, normal output spill behavior, and user-requested command results retain upstream behavior.

## Structure

| Module | Responsibility |
| --- | --- |
| `cordis.patch.yml`, `src/adapter.ts` | Gate native Windows entries, then mount replacement providers through Cordis/Loader APIs. Preserve canonical module names, `pwsh-sandbox`, and its original config/enablement so native settings can persist name-qualified overrides. |
| `src/index.ts` | Subclass `SandboxBashExecutor`; replace only the final shell argv. Reuse `LocalBashExecutor`, sandbox classification, and `ctx.subprocess`. |
| `src/preset.ts`, `src/tool.ts` | Adapt the native standard/ptc/cordis presets and base shell-tool row to the official `dsh-tool-bash`. No custom UI or tool implementation. |
| `src/private-runtime.ts`, `src/cleanup.ts` | Persistent hardlink generations, identity checks, scoped leases/serialization, unlink-only collection, and complete cache purge. |
| `src/elevation.ts`, `src/elevation-worker.ts`, `src/link-helper.ts` | Responsive, narrowly scoped UAC setup. Only the fixed link helper elevates. |
| `src/launcher.ts`, `src/native.ts`, `src/ipc.ts` | Token checks, private process-family debugging, and process-local IPC compatibility. |

`--dump-config` is deliberately boot-free, so it shows the gated native rows and adapter declaration. Runtime profile checks additionally verify the actual executor and execute the native tools in each preset.

## Verification limits

The automated suite checks real commands, confinement, cancellation, output limits, concurrency, cleanup, native settings bindings, preset execution, and coexistence with the installed cleanup plugin. It hashes watched DSH/profile files, hardlink-source contents/security/link counts, and selected Git/MSYS/environment registry keys, and compares ordinary Git Bash before/after. Registry snapshots cover the named keys in the report; they are not a system-wide registry trace. Passing tests are bounded evidence, not a complete sandbox audit or a guarantee against every host crash or future Git/DSH release.

`node test/install.ts` can run the packed install/uninstall checks separately. It also verifies active fallback-cache refusal and explicit cleanup before package-manager removal, using synthetic user-owned files. The profile, pnpm store, package-manager state, and fixtures stay in temporary directories. It requires no UAC and starts no Git Bash runtime.
