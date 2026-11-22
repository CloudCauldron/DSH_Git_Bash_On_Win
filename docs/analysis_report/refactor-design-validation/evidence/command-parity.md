# Command and alias parity across three DSH policies

On November 21, 2026, DSH 0.2.2-rc.5 ran 24 test cases per policy on the normal Windows 11 desktop with Node 26.12.1 and `ucrt64` Git 2.56.0.windows.4. Both fixtures used junction views and the [same proof-of-concept DLLs](builds.md), differing only in the private executable directory: one used ordinary file copies, while the other replaced Bash, sh, grep, and Perl with verified NTFS file symlinks.

Both fixtures produced **63 passes and 9 accepted limitations across 72 trials**, with identical verdicts and exit codes in every cell below and every launched candidate range settling cleanly. `PASS` means the output and exit code matched the expected oracle (including expected nonzero parity exits); `FAIL` marks commands that could not run as requested.

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

- **Restricted Node pipes.** In read-only and workspace-write modes, Node spawning `grep` with piped stdio failed with `EPERM`, whereas inherited stdio with an input file succeeded. Under stock `pwsh-sandbox`, Node spawning ordinary Windows `cmd.exe` hit the exact same piped-versus-inherited split, isolating a restricted native-pipe limitation in this Node version unrelated to MSYS; PowerShell's own pipeline into `grep` worked.
- **Native Bash wrapper.** The 44,904-byte `bin/bash.exe` wrapper launches the installed, unpatched 2,449,886-byte MSYS Bash directly. In restricted modes, namespace creation returned `0xC0000022`, causing the launcher to exit `0xC0000142` (3221225794; reproduced under stock PowerShell) and Bash invocations of the wrapper to return 127. Full access ran the wrapper against the installed runtime, while invoking the installed `usr/bin/bash.exe` from inside candidate Bash redirected to the private runtime in all three modes.
- **Extended Windows path.** Native DSH `argv` accepted an extended-length executable path, but using a quoted `\\?\` path as a command inside Bash failed lookup with exit 127 (matching ordinary Git Bash). The shebang and short-path cases passed with distinct 8.3 names and a quoted Unicode argument.

## Nonzero parity results and debugger scope

Package identities and native exits were read from the held process handle. Both stock DSH and candidate Bash launched PowerShell 7.7.0.0 (which deliberately exited 19) and DesktopAppInstaller 1.29.380.0 (WinGet printed `v1.29.380` and exited 0 in full access, while restricted WinGet returned native `0x8A150001`, surfaced as shell status 1). No diagnostic debugger was attached, and Windows Terminal and Notepad aliases were inventoried only.

The vendor Perl version check printed 6.83 and exited 255 (matching ordinary Git), and the group helper exited 0 with empty output in both fixtures. Each GDB 16.3 run launched its own owned target, reported the target's PID and exit `027` (octal 23), and exited 0.

[Design experiment summary](../README.md) · [Reproduction](../REPRODUCING.md)
