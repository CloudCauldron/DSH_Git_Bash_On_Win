// Phase 2 will delegate to runtime-cache's guarded purge. No deletion is safe
// here until its ownership and native hold checks exist.
throw new Error('Runtime purge is not implemented in Phase 1; cleanup and uninstallation are incomplete.');
