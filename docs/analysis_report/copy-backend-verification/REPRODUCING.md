# Verifying the ordinary-copy release

Run these commands from the repository root in native Windows x64 Git Bash. The recorded host used Windows Node 26.12.1, pnpm 12.18.0, DSH 0.2.2-rc.5, Git for Windows, Chrome, and the pinned x64 MSVC and Windows SDK for release builds, with free NTFS space for disposable Git trees, runtime generations, and DSH profiles. [Toolchain manifest](../../../native/build.json) · [Development and testing](../../../README.md#7---development-and-testing)

```bash
pnpm install --ignore-scripts --frozen-lockfile
pnpm test:release
```

`pnpm test:release` preflights the installed DSH CLI, Git, and Chrome, then runs type checking, lint, a pinned clean build, the Windows suite, the browser suite, and the packed-profile test. It also compares two independently packed archives byte for byte and verifies that generated library bytes match the Git index. Expect zero failures, skips, or cancellations (individual test counts vary by revision).

| Override | Value and use |
| --- | --- |
| `DSH_PACKAGE_JSON` | Absolute path to the installed `@deepseek-ai/dsh` package manifest when CLI discovery needs an override. |
| `DSH_TEST_GIT_BASH` | Absolute path to `bin/bash.exe` or `usr/bin/bash.exe` in the real Git installation to test. Run the suite once per layout. |
| `CHROME_PATH` | Absolute path to the Chrome executable when installed outside its default path; an invalid override should fail preflight before creating fixtures. |
| `DSH_TEST_TARBALL` | Archive path (absolute or relative to the repository root) for the optional host suite or benchmark. When unset, each packs its own release; the release suite's two-pack check always builds fresh inputs. |

## Optional installed programs

On a host with packaged PowerShell, WinGet, and GDB installed, run the host qualification suite from the same shell. Enabling `DSH_TEST_WINGET=1` allows WinGet's normal diagnostic logging; the suite compares package identities and native exit codes against stock DSH and checks that GDB launches an owned target under each policy.

```bash
DSH_TEST_WINGET=1 node --test test/qualify-host.ts
```

## Deployment checks with additional prerequisites

The packed-profile test exercises isolated Web and Desktop profile workers in Windows Node. The three deployment checks below require extra host fixtures; when running them against a release build, reuse the same tarball throughout and record its SHA-256.

- **Electron Desktop.** Launch the matching rc.5 Desktop executable and ASAR with an isolated DSH home and Electron user-data directory (suppressing protocol registration in that test process). Confirm the executable path, ASAR path, and Electron version, run Git and a workspace-write probe under each policy, check child-console visibility, trigger a rebuild from Settings, navigate away, exit cleanly, and run offline purge.
- **Two NTFS volumes.** Place an owned Git installation on one NTFS volume and its disposable DSH home on another, confirming distinct device IDs. Run Bash, grep, and Git through DSH, inspect the resource junction target, trigger a rebuild and verify that the selector changes, then close the hosts, purge offline, confirm that the cache and writer lock are gone, and compare source file hashes, identities, and link counts.
- **Same-root upgrade.** Start from the two [recorded PortableGit versions and archive digests](evidence/release.md#same-root-portablegit-upgrade). Run all three policies before upgrading, close every host sharing the installation, and update the owned tree in place—keeping its byte-identical MSYS file intact for the unchanged-stamp control—confirming that the Git stamp and package-list digest change. The first command after the upgrade should publish a fresh generation, all three policies should report the new Git version, and a subsequent restart should reuse the selector.

[Recorded package and platform results](evidence/release.md)
