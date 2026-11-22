# Command and alias parity across three DSH policies

On November 21, 2026, DSH 0.2.2-rc.5 ran 24 cases per policy on the normal Windows 11 desktop with Node 26.12.1 and ucrt64 Git 2.56.0.windows.4. One fixture used ordinary files in the private executable directory. The other substituted verified NTFS file symlinks for Bash, sh, grep and Perl. Both used junction views and the [same proof-of-concept DLLs](builds.md).

Each fixture produced **63 passes and 9 accepted limitations across 72 trials**. Every cell below had the same verdict and exit code in both fixtures. FAIL records an observed failure to run the requested command. PASS means the oracle matched, including expected nonzero parity results. All launched candidate ranges settled.

| Case | read-only | workspace-write | danger-full-access |
|---|---|---|---|
| Candidate Bash startup | PASS 0 | PASS 0 | PASS 0 |
| Bash → Git shell alias → sh | PASS 0 | PASS 0 | PASS 0 |
| Node → grep, piped stdio | FAIL 1 | FAIL 1 | PASS 0 |
| Node → grep, inherited stdio | PASS 0 | PASS 0 | PASS 0 |
| Packaged PowerShell → grep | PASS 0 | PASS 0 | PASS 0 |
| Shebang with quoted Unicode path and argument | PASS 0 | PASS 0 | PASS 0 |
| Relative PATH lookup | PASS 0 | PASS 0 | PASS 0 |
| core_perl/json_pp | PASS 0 | PASS 0 | PASS 0 |
| vendor_perl/lwp-request -v | PASS 255 | PASS 255 | PASS 255 |
| usr/libexec/lessecho.exe | PASS 0 | PASS 0 | PASS 0 |
| usr/lib/awk/grcat.exe | PASS 0 | PASS 0 | PASS 0 |
| usr/bin/bash.exe entry | PASS 0 | PASS 0 | PASS 0 |
| Native bin/bash.exe entry | FAIL 3221225794 | FAIL 3221225794 | PASS 0 |
| Absolute installed usr/bin/bash.exe inside Bash | PASS 0 | PASS 0 | PASS 0 |
| Absolute installed bin/bash.exe inside Bash | FAIL 127 | FAIL 127 | PASS 0 |
| sh invocation and POSIX mode | PASS 0 | PASS 0 | PASS 0 |
| exec -a and argv[0] | PASS 0 | PASS 0 | PASS 0 |
| 8.3 executable spelling | PASS 0 | PASS 0 | PASS 0 |
| 8.3 script spelling | PASS 0 | PASS 0 | PASS 0 |
| Extended-length executable path via native DSH argv | PASS 0 | PASS 0 | PASS 0 |
| Quoted extended-length command inside Bash | FAIL 127 | FAIL 127 | FAIL 127 |
| Bare pwsh alias | PASS 19 | PASS 19 | PASS 19 |
| Bare winget alias | PASS 1 | PASS 1 | PASS 0 |
| GDB debugging fixture target | PASS 0 | PASS 0 | PASS 0 |

## How to read the failures

- **Restricted Node pipes.** Node’s piped grep child failed at spawn with `EPERM` in read-only and workspace-write. With inherited stdio and an input file, grep succeeded. Under the stock PowerShell executor, Node launching ordinary Windows `cmd.exe` reproduced the same piped/inherited split. This isolates a restricted native-pipe limitation for this Node version, independent of MSYS. PowerShell’s own pipeline into grep worked.
- **Native Bash wrapper.** The genuine 44,904-byte `bin/bash.exe` directly launched the installed, unpatched 2,449,886-byte MSYS Bash. In restricted modes its namespace creation returned `0xC0000022`. The launcher returned `0xC0000142` (3221225794) and invoking the wrapper from inside Bash yielded 127. Stock PowerShell reproduced the native exit. Full access ran the wrapper with the installed runtime. Calling the installed `usr/bin/bash.exe` from candidate Bash reached the private runtime through the MSYS child redirection in all three modes.
- **Extended Windows path.** Native DSH argv accepted the extended-length executable name. Used as a quoted command inside Bash, the `\\?\` spelling failed command lookup with 127, also observed in ordinary Git Bash. The shebang and short-path tests passed with distinct 8.3 names and a quoted Unicode argument.

## Nonzero parity results and debugger scope

Package identity and native exit came from the held process handle. Both stock DSH and candidate Bash launched PowerShell 7.7.0.0, which deliberately exited 19. Both launched DesktopAppInstaller 1.29.380.0. WinGet printed v1.29.380 and exited zero in full access. Restricted WinGet returned native `0x8A150001`, exposed as shell status 1. No diagnostic debugger was attached. Windows Terminal and Notepad aliases were inventoried only.

The vendor Perl version command printed 6.83 and exited 255, matching ordinary Git. The group helper exited zero with empty output in both fixtures. Each GDB 16.3 run reported the owned target’s PID and exit 027 (octal for 23), then exited zero. The test exercised a debugger launching its own target.

[Design experiment summary](../README.md) · [Reproduction](../REPRODUCING.md)
