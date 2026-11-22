# Historical process-family backend

From November 12–19, 2026, tests on Windows 11 x64 build 26200 with DSH 0.2.2-rc.2 and Windows Node 26.12.1 evaluated whether Git Bash could run under DSH's read-only and workspace-write policies, and how to share and remove its runtime cleanly.

| Question | Finding |
| --- | --- |
| Could stock Bash start? | The stock-shell fixture passed 107/107 assertions, including expected startup failures. In both restricted modes, the observation-only and signal-pipe variants exited `2147483651`, whereas the full private-process-family IPC variant exited 0 and passed 111/111 checks (including the outside-workspace canary and watched security records). |
| Could an installed profile reuse the runtime? | The early profile fixture passed 61/61 checks covering restart, source preservation, and ordinary Bash. The later hardlink backend ran six simultaneous sessions from one 8,181-link base; a workspace-write peer could read another session's process mapping, while Windows denied write access. |
| What did removal establish? | Strict purge restored source link counts in the owned Git tree and kept shared Shell settings intact. Live UAC approval, denial, and delayed approval verified publication and cancellation, and the 0.1.0 release and installed-browser checks passed on November 19. |

The ordinary-copy backend has since superseded this implementation. [Feasibility assertions and exit codes](evidence/feasibility.json) · [Cache, consent and installed profiles](evidence/windows.md) · [Reproduction by revision](REPRODUCING.md) · [Analysis index](../README.md)
