# What a positive DSH range wait establishes

On November 21, 2026, stock `pwsh-sandbox` in DSH 0.2.2-rc.5 launched packaged PowerShell 7.7.0.0 through its Windows App Execution Alias on Windows 11 x64. An observer held native process handles, verified creation times and package identity, and tracked process exits independently of stdio closure, using a disposable handle as the command lease alongside an unrelated live control process.

## Counterexample in full access

| Time from request | Observation |
| ---: | --- |
| 1,597 ms | The packaged root (PID 6932) exited with code 17. |
| 1,619 ms | DSH's `waitForExit()` returned true while the native child (PID 16816) still had an unsignaled process handle. |
| 2,109 ms | The adapter released the fixture lease; the child was still alive. |
| 6,605 ms | At the cleanup deadline, both the child and the unrelated control were alive. |
| 6,637 ms | After fixture cleanup, the child's handle signaled with exit code 125 while the unrelated control survived. |

## Controls and limits

Thirteen valid trials covered three orderly nested packaged launches, nine direct-root stops, and the counterexample above. In every policy, the orderly nested PowerShell exited 13 and the root exited 7 with both handles signaled by settlement, and timeout (5,000 ms with 500 ms grace), caller cancellation, and provider disposal each stopped the directly managed packaged root across all three policies; a final sweep confirmed all 19 recorded target and control identities had exited.

The counterexample used an ordinary native child in full access only, and forced stops with an independently activated nested packaged CLI were not tested. Calling `IsProcessInJob` with a null Job handle confirmed only that a process belonged to some Job, not specifically to DSH's Job.

The executor therefore holds its runtime lease until `waitForExit()` confirms settlement of DSH's managed range—keeping ownership if a wait fails—while the lifetime of descendants spawned outside that range remains a Windows AppModel boundary. [Project ownership contract](../../../../AGENTS.md) · [Current executor design](../../../backend-20261122-design-decisions.md#execution-and-native-admission)

[Design experiment summary](../README.md) · [Reproduction](../REPRODUCING.md)
