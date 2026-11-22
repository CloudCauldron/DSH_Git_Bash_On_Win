# Verifying the ordinary-copy release

Run from the repository root in native Windows x64 Git Bash. The recorded host used Windows Node 26.12.1, pnpm 12.18.0, DSH 0.2.2-rc.5, Git for Windows, and Chrome. Allow NTFS space for disposable Git trees, runtime generations and DSH profiles. Use the pinned x64 MSVC and Windows SDK for release builds. [Toolchain manifest](../../../native/build.json) · [Development and testing](../../../README.md#7---development-and-testing)

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm test:release
```

The release command preflights the installed CLI, Git and Chrome, then runs type checking, lint, a pinned clean build, the Windows suite, the browser suite and the packed-profile test. It compares two independent archives and checks generated library bytes against the Git index. A successful run reports zero failures, skips and cancellations. The recorded suite counts apply to their named revisions.

| Override | Value and use |
| --- | --- |
| `DSH_PACKAGE_JSON` | Absolute path to the installed `@deepseek-ai/dsh` package manifest when CLI discovery needs an override. |
| `DSH_TEST_GIT_BASH` | Absolute path to `bin/bash.exe` or `usr/bin/bash.exe` in the real Git installation to exercise. Repeat the suite selecting each layout. |
| `CHROME_PATH` | Absolute path to the Chrome executable when outside its default location. An invalid override should fail preflight before fixture creation. |
| `DSH_TEST_TARBALL` | Archive path, absolute or relative to the repository root, for the optional host suite or benchmark. With the variable unset, each packs its own release. The two-pack comparison in the release suite builds its own inputs. |

## Optional installed programs

With packaged PowerShell, WinGet and GDB installed, run the following from the same shell. The WinGet opt-in permits its normal diagnostic logs. Check package identities and native exit codes against stock DSH and verify that GDB launches an owned target under each policy.

```bash
DSH_TEST_WINGET=1 node --test test/qualify-host.ts
```

## Deployment checks with additional prerequisites

The packed-profile test runs isolated Web and Desktop profile workers in Windows Node. The following recorded exercises required additional host fixtures. To repeat them with a release build, use the same artifact throughout and record its SHA-256.

- **Electron Desktop.** Use the matching rc.5 Desktop executable and ASAR with an isolated DSH home and Electron user-data directory. Verify the running executable, ASAR path and Electron version. Run Git and a workspace-write probe under each policy, observe child-console visibility, rebuild from Settings, navigate away, exit the host and purge offline. The recorded fixture suppressed protocol registration in that test process.
- **Two NTFS volumes.** Put an owned Git installation on one volume and its disposable DSH home on the other. Confirm distinct device IDs, run Bash, grep and Git through DSH, check the resource junction target, rebuild and check a changed selector. Close the hosts, purge, confirm absence of the cache and writer lock and compare source file hashes, identities and link counts.
- **Same-root upgrade.** Start from the two [recorded PortableGit versions and archive digests](evidence/release.md#same-root-portablegit-upgrade). Run all policies before the update. Close all hosts sharing the installation, update the owned tree at the same path and retain its byte-identical MSYS file for the unchanged-stamp control. Verify the Git stamp and package-list digest changed. The first command should publish a fresh generation, all policies should report the new Git version and a subsequent restart should reuse the selector.

[Recorded package and platform results](evidence/release.md)
