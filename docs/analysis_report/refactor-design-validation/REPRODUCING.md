# Checking the design experiments against the implementation

The November 21–22 experiments predated the ordinary-copy executor. The evidence records the fixtures, controls, observations and image hashes needed to interpret them. The maintained equivalents below use production code on owned Git copies. The original symlink comparison, packaged-root lifetime timeline and one-host timing captures are recorded observations without a standalone historical replay command.

From the checkout root in native Windows x64 Git Bash, use DSH 0.2.2-rc.5, Windows Node (the recorded version was 26.12.1), Git for Windows, and the MSVC/SDK versions in the [build manifest](../../../native/build.json). Set `DSH_PACKAGE_JSON` or `DSH_TEST_GIT_BASH` to absolute paths if discovery needs them.

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm build
node --test test/pe.test.ts test/native-compat.test.ts
node --test test/runtime-cache.test.ts test/pin-lifetime.test.ts test/bash-execution.test.ts
```

| Check | What to compare with the prototype |
| --- | --- |
| PE and native | Import and section bounds, restored read-only pages, module identities, fork bases, policy/token admission, section access and refused loads. Repeat with `DSH_TEST_GIT_BASH` selecting a real mingw64 installation. |
| Cache and pin lifetime | Fresh file identity and attributes, publication under a writer lock, claims excluding pins, retry after a sharing blocker and guarded removal. |
| Executor | Three policies, view reuse, command completion, disposal and retention after an unconfirmed range wait. These checks cover the adapter contract. The original AppModel counterexample used stock packaged PowerShell. |

With the packaged PowerShell and WinGet aliases and GDB available, run `DSH_TEST_WINGET=1 node --test test/qualify-host.ts`. The opt-in permits WinGet’s normal diagnostic logging. Run `pnpm test:release` for pinned independent builds and installed-profile qualification. [Design experiment results](README.md) · [Release prerequisites](../copy-backend-verification/REPRODUCING.md)
