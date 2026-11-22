# Windows backend analyses

The current Windows executor runs Git Bash from ordinary file copies and loads a compatibility DLL inside MSYS processes. The earlier executor used NTFS hardlinks and a debugger to supervise a private process family. Both were tested under DSH’s three execution policies.

| Status and date (2026) | Analysis | Question |
| --- | --- | --- |
| Current · Nov 22–23 | [Ordinary-copy release verification](copy-backend-verification/README.md) | Which Git layouts, DSH hosts, upgrade and removal paths ran successfully? |
| Current · Nov 21–23 | [Runtime performance and image-load delays](copy-backend-performance/README.md) | What did the packaged backend cost to prepare and run? Where did the earlier prototype stall? |
| Pre-implementation · Nov 21–22 | [Windows design experiments](refactor-design-validation/README.md) | Which loader, token, process-lifetime and file-copy behaviors shaped the replacement? |
| Historical · Nov 12–19 | [Process-family feasibility and lifecycle](historical-process-family/README.md) | Could a supervised Bash run confined, share one hardlink base and uninstall cleanly? |
| Historical · Nov 18 | [Supervisor overhead](historical-supervisor-benchmark/README.md) | What did supervision cost, and did reducing thread-context writes help? |

For the implementation contracts, see the [current backend design](../backend-20261122-design-decisions.md) and the [historical backend design](../backend-20261117-design-decisions.md).
