import { buildRuntimeEnvironment } from './runtime/git-installation.js';
import { inheritedCompatibility } from './debugger/native-debug.js';
import { runPrivateBash } from './debugger/process-family.js';
// Reached through DSH's native policy/subprocess machinery. No token creation,
// source probes, cache metadata or duplicate filesystem admission belong here.
process.exitCode = 127;
try {
    const [baseRoot, installationRoot, sourceRoot, layout, mode, encoded, grace] = process.argv.slice(2);
    if (process.argv.length !== 9 || !baseRoot || !installationRoot || !sourceRoot
        || (layout !== 'ucrt64' && layout !== 'mingw64')
        || (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access')
        || encoded === undefined)
        throw new Error('Invalid private Git Bash invocation.');
    const command = Buffer.from(encoded, 'base64').toString('utf8');
    if (Buffer.from(command, 'utf8').toString('base64') !== encoded || command.includes('\0'))
        throw new Error('Invalid encoded Bash command.');
    const graceMs = Number(grace);
    if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > 2147483647)
        throw new Error('Invalid DSH process grace period.');
    const compatibility = inheritedCompatibility(mode);
    const runtimeEnvironment = buildRuntimeEnvironment(installationRoot, sourceRoot, layout, process.env);
    const replaced = new Set(Object.keys(runtimeEnvironment).map(key => key.toLowerCase()));
    const environment = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined && !replaced.has(entry[0].toLowerCase())));
    Object.assign(environment, runtimeEnvironment);
    const result = await runPrivateBash({ baseRoot, installationRoot, cwd: process.cwd(), command, environment, compatibility, graceMs });
    process.exitCode = result.exitCode;
}
catch (error) {
    console.error(`dsh-git-bash: compatibility setup failed; no unrestricted retry: ${error instanceof Error ? error.message : String(error)}`);
}
