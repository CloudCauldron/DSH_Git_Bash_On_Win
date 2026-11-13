# Phase 1 and Phase 2 feasibility record

This historical record describes the diagnostic harnesses preceding the plugin. Phase 1 measures the stock runtime's failures. Phase 2 tests process-local IPC compatibility while checking the existing sandbox boundary. Those early experiments used disposable binary copies; the current plugin and its verification use hardlinks. See the [current workflow](../README.md).

The final plugin must affect only DSH's Git Bash execution on Windows, leave no persistent machine changes, and leave existing programs unaffected. That is a release requirement; the current PoC provides bounded evidence, not a production guarantee.

The harness requires native Windows x64 Node 26, Git for Windows, and the existing DSH `0.2.2-rc.2` installation. It loads the installed `ctx.sandbox` and `ctx.subprocess` implementations directly and does not install a bundle or edit a profile.

## Run

Type-check from the development environment:

```bash
pnpm install --ignore-scripts
pnpm check
```

Run the real tests in **Windows native Git Bash**, from this repository:

```bash
node "$(cygpath -m "$PWD/poc/run.ts")"
```

`pnpm poc` also works when the active Node/pnpm installation is native Windows. WSL Node is deliberately rejected before creating test data.

The default Git Bash path is `C:/Program Files/Git/bin/bash.exe`. Set `DSH_POC_BASH` for another Git installation's **bin/bash.exe**. Set `DSH_POC_PACKAGE` to an installed DSH `package.json` if the CLI cannot be selected unambiguously from pnpm's Windows global directory. These overrides apply only to the test process.

The report is written to `poc/results/latest.json`. A successful harness exit means its checks completed as expected; the separate `assessment.verdict` states whether confined Git Bash actually started. An expected compatibility failure is never retried with unrestricted access. The explicitly labelled `unconfined-control` executes only known disposable probe commands.

## Phase 1 experiment boundaries

- All filesystem fixtures live in a fresh Windows temporary tree. Fresh write probes are removed immediately, including probes in the sandbox's own temporary directory.
- Kernel IPC experiments create only fresh random `dsh-gitbash-poc-*` objects. Creation uses no `OBJ_OPENIF`; collisions fail. Handles are closed, and disappearance of the privately provisioned root is checked.
- Existing MSYS objects are opened for access diagnostics only. Their descriptors are never changed.
- No restricted SID, privilege, token default DACL, integrity level, existing filesystem grant, or installed executable is modified by the experiments. DSH itself provisions its normal grants on the disposable workspace and private temp directory.
- Existing DSH token/ACL code and compiled runners are hashed before and after the run. Installed Git runtime bytes are also checked.
- A byte-identical disposable copy of `bash.exe` and `msys-2.0.dll` is made separately for each mode. Each copy has a distinct installation path/key, so an unconfined control cannot seed the confined copy's MSYS namespace. No replacement native code is compiled or injected.
- DSH services are disposed before temporary files are removed. The disposable controller redirects its own `TEMP`/`TMP` to its private tree so DSH's normal ACL lock files are removed with that tree. Its environment is restored, and ambient ACL lock-directory additions are checked.

The native diagnostics reuse the installed DSH Win32 binding extension API and its existing Koffi dependency. There are no custom native helper executables or DLLs.

## Measured results

Tested on Windows `10.0.26200`, Node `26.12.1`, DSH `0.2.2-rc.2`, and MSYS `3.6.10-5a1665c8a0fb24930e55f1621441dfd98a798c15`.

| Test | read-only | workspace-write |
| --- | --- | --- |
| Native `cmd`, PowerShell, `cmd` pipeline | Starts | Starts |
| Native file writes before/after IPC tests | Denied in workspace, outside, temp | Workspace/private temp allowed; outside denied |
| Outside overwrite/append/rename/delete | Denied | Denied |
| Native descendant with inherited stdio | Same token and Job; same file boundary | Same token and Job; same file boundary |
| Installed Git Bash | MSYS namespace access denied | MSYS namespace access denied |
| Disposable, byte-identical Bash runtime | Signal-pipe initialization denied | Signal-pipe initialization denied |
| New pipe with explicit user/admin/system descriptor | Self-connection denied | Self-connection denied |
| New pipe additionally granting the existing logon SID | Self-connection succeeds | Self-connection succeeds |
| Fresh private namespace with an explicit Low label and existing logon SID | Usable | Usable |

Additional observation: Node's captured `spawnSync` descendants return `EPERM` inside both restricted modes, while inherited-stdio descendants and the directly launched native shells work. This remains a distinct limitation of the captured child-launch path; it is not evidence that all native descendants fail.

The namespace diagnostics further distinguish the parent container from the existing MSYS directory. On this machine, restricted native probes can create a fresh random directory under `\BaseNamedObjects`, but cannot open the existing installed-runtime MSYS directory with create rights. A separate runtime copy gets past that failure and reaches the independent signal-pipe failure. The native pipe reproduction separates server creation from client self-connection; it is not a trace of the real MSYS pipe call.

The installed runtime's source explains why a launcher-only environment change is insufficient:

- [Shared namespace initialization](https://github.com/git-for-windows/msys2-runtime/blob/5a1665c8a0fb24930e55f1621441dfd98a798c15/winsup/cygwin/mm/shared.cc) uses an installation-specific namespace.
- [Signal initialization](https://github.com/git-for-windows/msys2-runtime/blob/5a1665c8a0fb24930e55f1621441dfd98a798c15/winsup/cygwin/sigproc.cc) supplies an explicit user-specific security descriptor.
- [User initialization](https://github.com/git-for-windows/msys2-runtime/blob/5a1665c8a0fb24930e55f1621441dfd98a798c15/winsup/cygwin/uinfo.cc) also resets the token's default DACL inside MSYS.

These Phase 1 primitives alone do **not** demonstrate a working sandboxed Git Bash. No production shell switch or unrestricted fallback is installed.

## Phase 2 — private process-family IPC experiments

Run in Windows native Git Bash:

```bash
node "$(cygpath -m "$PWD/poc/phase2.ts")" --repair-ipc --repair-mappings --follow-family --both-modes
```

The report is `poc/results/phase2-latest.json`. Observation and signal-pipe-only variants are negative controls. The `ipc` variant exercises the complete current experiment. Its assertions distinguish expected control failures from actual compatibility and cleanup failures.

The observer itself runs under the original DSH restricted-token runner. It starts only a fresh private process family using DSH's shared Win32 process/Job primitives. There is no attach-to-existing-process operation. Every process creation event is checked for membership in the probe-owned Job. Only processes loading the exact private DLL copy receive hardware breakpoints; native descendants without that DLL receive no API adjustments.

The experimental adjustments are limited to:

1. The fresh signal pipe whose name contains the private runtime's installation key and its creating process's PID, with first-instance and remote-client-rejection flags retained.
2. The private MSYS process's proposed default DACL, retaining an SID already present in DSH's restricting list. `workspace-write` uses the original **private-temp capability**, obtained using DSH's `tempWriteSid`; `read-only` uses the existing logon SID. Restricting SIDs, privileges and Low integrity are not widened.
3. Page-file-backed `cygpid` sections created from private MSYS code. Their root handle is queried and must identify that exact private runtime namespace. File-backed mappings and unrelated namespaces are excluded.

Only new data buffers and call arguments inside these disposable processes are written. No executable pages are written, no helper DLL is injected, and no installed executable, global namespace DACL, filesystem ACL outside the test tree, registry setting or machine environment is edited by this mechanism. The exact installed MSYS source [excludes its Cygwin installation-registry write in MSYS builds](https://github.com/git-for-windows/msys2-runtime/blob/5a1665c8a0fb24930e55f1621441dfd98a798c15/winsup/cygwin/mm/cygheap.cc).

The successful sample runs cover Bash startup, an external MSYS `true.exe`, a Bash pipeline, a native descendant, Bash redirections, native file creation, and denial of outside overwrite/append/rename/delete. They compare the observer's restriction fingerprint and default DACL before/after; installed Git/DSH/profile file hashes; sampled directory/file security-descriptor hashes; and ordinary installed Git Bash behavior before/after. The private namespace names and process-family exits are recorded, and namespace disappearance is checked after exit.

The watchdog was also exercised by earlier failing fork/mapping variants: their Job was terminated and the temporary tree removed, with no new ambient ACL lock files. Those diagnostic reports remain under `poc/results/`. This is evidence for bounded failure cleanup, not certification of every possible host crash or interruption.

This debugger-based mechanism is **experimental**. It is not yet the final plugin design, and these samples do not establish complete DSH feature parity, cross-session IPC isolation, adversarial sandbox security, or production suitability. The installed DSH profile is unchanged.
