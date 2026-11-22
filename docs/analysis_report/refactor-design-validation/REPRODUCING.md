# Checking the design experiments against the implementation

Because the November 21–22 experiments predated the ordinary-copy executor, their evidence files record the prototype fixtures, controls, observations, and image hashes directly; the original symlink comparison, packaged-root lifetime timeline, and one-host timing captures have no standalone historical replay command. The commands below run the maintained production equivalents against owned Git copies.

Run from the repository root in native Windows x64 Git Bash using DSH 0.2.2-rc.5, Windows Node (recorded with 26.12.1), Git for Windows, and the MSVC/SDK versions listed in the [build manifest](../../../native/build.json). Set `DSH_PACKAGE_JSON` or `DSH_TEST_GIT_BASH` to absolute paths if default discovery needs an override.

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm build
node --test test/pe.test.ts test/native-compat.test.ts
node --test test/runtime-cache.test.ts test/pin-lifetime.test.ts test/bash-execution.test.ts
```

| Check | What to compare with the prototype |
| --- | --- |
| PE and native | Covers import and section bounds, restored read-only pages, module identities, fork bases, policy/token admission, section access, and refused loads. Re-run with `DSH_TEST_GIT_BASH` pointing to a real `mingw64` installation. |
| Cache and pin lifetime | Covers fresh file identity and attributes, writer-locked publication, collector claims excluding active pins, retry after a sharing blocker, and guarded removal. |
| Executor | Covers all three policies, view reuse, command completion, disposal, and lease retention after an unconfirmed range wait (the original AppModel counterexample itself ran against stock packaged PowerShell). |

On hosts with packaged PowerShell, WinGet, and GDB installed, run `DSH_TEST_WINGET=1 node --test test/qualify-host.ts` (the opt-in permits WinGet's normal diagnostic logging). Run `pnpm test:release` for pinned reproducible builds and installed-profile qualification. [Design experiment results](README.md) · [Release prerequisites](../copy-backend-verification/REPRODUCING.md)
