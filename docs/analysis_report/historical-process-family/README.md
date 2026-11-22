# Historical process-family backend

On November 12–19, 2026, Windows 11 x64 build 26200 ran DSH 0.2.2-rc.2 and Windows Node 26.12.1. The study asked whether Git Bash could run under DSH’s existing read-only and workspace-write policies, then tested how to share the runtime and remove it safely.

| Question | Finding |
| --- | --- |
| Could stock Bash start? | The stock-shell fixture passed 107/107 assertions, including the expected startup failures. In both restricted modes the observation-only and signal-pipe variants exited 2147483651. The full private-process-family IPC variant exited zero. Its 111/111 checks included the outside canary and watched security records. |
| Could an installed profile reuse the runtime? | The early profile fixture passed 61/61, including restart, source preservation and ordinary Bash. The later hardlink backend ran six simultaneous sessions from one 8,181-link base. A workspace-write peer could read another session’s process mapping and Windows denied it write access. |
| What did removal establish? | The tests restored the owned Git tree’s source link counts and preserved shared Shell settings. Actual UAC approval, denial and delayed approval tested publication and cancellation. The 0.1.0 release and installed-browser checks passed on November 19. |

The ordinary-copy backend superseded this implementation. [Feasibility assertions and exit codes](evidence/feasibility.json) · [Cache, consent and installed profiles](evidence/windows.md) · [Reproduction by revision](REPRODUCING.md) · [Analysis index](../README.md)
