# What a positive DSH range wait establishes

On November 21, 2026, stock `pwsh-sandbox` in DSH 0.2.2-rc.5 launched packaged PowerShell 7.7.0.0 through its Windows App Execution Alias. The Windows 11 x64 observer held native process handles, checked creation times and package identity, and read process exit status independently of output closure. A disposable handle served as the command lease. A separate unrelated process remained alive as a control.

## Counterexample in full access

| Time from request | Observation |
| ---: | --- |
| 1,597 ms | The packaged root (PID 6932) exited with code 17. |
| 1,619 ms | DSH’s `waitForExit()` returned true. The native child (PID 16816) still had an unsignaled process handle. |
| 2,109 ms | The adapter released the fixture lease. The child was still alive. |
| 6,605 ms | At the cleanup deadline, both the child and unrelated control were alive. |
| 6,637 ms | After fixture cleanup, the child’s handle signaled with exit code 125. The unrelated process survived. |

## Controls and limits

Thirteen valid trials covered three orderly nested packaged launches, nine direct-root stops and the counterexample. In every policy the orderly nested PowerShell exited 13 and the root exited 7. Both handles had signaled by settlement. The timeout (5,000 ms with 500 ms grace), caller cancellation and provider disposal each stopped the directly managed packaged root in all three policies. A final sweep found all 19 recorded target/control identities from the verifier’s list exited.

The root-exit counterexample used an ordinary native child and was run only in full access. Forced-stop trials with an independently activated nested packaged CLI were unmeasured. `IsProcessInJob` with a null Job handle established membership in some Job. It could not establish membership in DSH’s particular Job.

The executor therefore retains the lease through confirmed settlement of DSH’s managed range. A failed wait retains ownership. The lifetime of descendants outside that range is a separate Windows AppModel boundary. [Project ownership contract](../../../../AGENTS.md) · [Current executor design](../../../backend-20261122-design-decisions.md#execution-and-native-admission)

[Design experiment summary](../README.md) · [Reproduction](../REPRODUCING.md)
