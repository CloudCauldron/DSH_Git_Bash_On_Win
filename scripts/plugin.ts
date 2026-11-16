// Enable the official DSH package-manager wrapper only when maintained runtime
// installation and strict cache purge are available.
throw new Error('Plugin package operations are unavailable during the Phase 1 bootstrap; strict cache purge is not implemented.');
