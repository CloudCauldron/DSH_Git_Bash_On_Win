import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { ipcSids, nativeRuntime } from './native.ts';
import { debugPrivateBash } from './ipc.ts';
import { runtimeEnvironment, type PrivateRuntime } from './private-runtime.ts';

// This file is a subprocess entry, reached only after the original DSH confinement.
try {
  const [root, source, mode, encoded, grace, installationRoot] = process.argv.slice(2);
  if (!root || !source || !['read-only', 'workspace-write', 'danger-full-access'].includes(mode ?? '') || encoded === undefined) throw new Error('Invalid private Git Bash invocation.');
  const runtime: PrivateRuntime = { root: realpathSync(root), source: realpathSync(source), bash: join(root, 'usr/bin/bash.exe'), fingerprint: '', links: 0 };
  if (!installationRoot || realpathSync(installationRoot).toLowerCase() !== runtime.root.toLowerCase()) throw new Error('The MSYS view must resolve to the private runtime.');
  if (!existsSync(runtime.bash)) throw new Error('The private runtime has been removed.');
  const dll = readFileSync(join(root, 'usr/bin/msys-2.0.dll'));
  const pe = dll.readUInt32LE(0x3c);
  if (dll.readUInt16LE() !== 0x5a4d || dll.readUInt16LE(pe + 4) !== 0x8664 || dll.readUInt16LE(pe + 24) !== 0x20b) throw new Error('A supported x64 MSYS runtime is required.');
  const { pipeSid, defaultDaclSid } = ipcSids(mode!);
  const confined = mode !== 'danger-full-access';
  const graceMs = Number(grace);
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > 2_147_483_647) throw new Error('Invalid DSH process grace period.');
  const env = Object.fromEntries(Object.entries({ ...process.env, ...runtimeEnvironment(runtime, process.env) })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'path' && name !== 'PATH') delete env[name];
  const result = await debugPrivateBash(nativeRuntime, { privateRoot: root, bash: runtime.bash,
    cwd: process.cwd(), command: Buffer.from(encoded, 'base64').toString('utf8'), pipeSid, defaultDaclSid,
    ...confined ? { installationRoot } : {},
    repairPipe: confined, repairDefaultDacl: confined, repairMappings: confined, followFamily: true,
    inheritStdio: true, env, timeoutMs: Infinity, graceMs });
  if (result.error || !result.exited || result.exitCode === undefined) throw new Error(result.error ?? 'Private process family did not exit.');
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(`dsh-git-bash: compatibility setup failed; no unrestricted retry: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 127;
}
