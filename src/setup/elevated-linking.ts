import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import type Subprocess from '@deepseek-ai/dsh-subprocess';
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess';
import { discoverGitInstallation, type GitLayout } from '../runtime/git-installation.ts';
import {
  absolutePath, admitChildDirectory, admitDirectory, children, createSetupLease,
  overlaps, requireActiveLease, sameIdentity, samePath, writeNewMetadata, type Directory, type FileIdentity,
} from '../runtime/ntfs-filesystem.ts';
import { LocalizedError } from '../localized-error.ts';

export interface ProvisioningAttempt {
  readonly source: Directory;
  readonly cache: Directory;
  readonly generation: Directory;
  readonly base: Directory;
  readonly layout: GitLayout;
}

interface ElevationPlan {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly sourceRoot: string;
  readonly cacheRoot: string;
  readonly generationId: string;
  readonly baseRoot: string;
  readonly layout: GitLayout;
  readonly identities: Readonly<Record<'source' | 'cache' | 'generation' | 'base' | 'lease', FileIdentity>>;
}

const id = z.string().pattern(/^[a-f0-9]{32}$/).required();
const path = z.string().min(3).max(32767).required();
const integer = z.string().pattern(/^\d{1,20}$/).required();
const identity = z.object({ volumeSerial: integer, fileId: integer }).required();
const planSchema = z.object({
  schemaVersion: z.const(1).required(), attemptId: id, sourceRoot: path, cacheRoot: path,
  generationId: id, baseRoot: path, layout: z.union([z.const('ucrt64'), z.const('mingw64')]).required(),
  identities: z.object({ source: identity, cache: identity, generation: identity, base: identity, lease: identity }).required(),
}).required();
export const planByteLimit = 512 * 1024;

export function decodeElevationPlan(value: unknown): ElevationPlan {
  return (planSchema as unknown as (value: unknown) => ElevationPlan)(value);
}

/** Both entries take only the fixed control path, never an executable or file list. */
export function planGeneration(planPath: string): Directory {
  planPath = absolutePath(planPath);
  if (basename(planPath) !== 'plan.json' || !/^[a-f0-9]{32}$/.test(basename(dirname(planPath)))
    || basename(dirname(dirname(planPath))) !== 'generations') throw new Error('Expected a generation plan.json path.');
  return admitDirectory(dirname(planPath));
}

/** Independently bind the input to existing objects before any privileged mutation. */
export function admitElevationPlan(plan: ElevationPlan, openedGeneration: Directory): ProvisioningAttempt {
  const source = admitDirectory(plan.sourceRoot, plan.identities.source);
  const cache = admitDirectory(plan.cacheRoot, plan.identities.cache);
  if (!samePath(source.path, plan.sourceRoot) || !samePath(cache.path, plan.cacheRoot)
    || overlaps(source.path, cache.path) || source.volumeSerial !== cache.volumeSerial) throw new Error('Invalid setup source/cache boundary.');
  const generation = admitChildDirectory(admitChildDirectory(cache, 'generations'), plan.generationId, plan.identities.generation);
  if (!samePath(generation.path, openedGeneration.path) || !sameIdentity(generation, openedGeneration)) throw new Error('Plan is outside its expected generation.');
  const base = admitChildDirectory(generation, 'base', plan.identities.base);
  if (!samePath(base.path, absolutePath(plan.baseRoot))) throw new Error('Plan base must be exactly the generation base.');
  requireActiveLease(generation, plan.identities.lease);
  if (children(base).length) throw new Error('Elevated setup requires an empty base.');
  const selected = discoverGitInstallation(join(source.path, 'usr/bin/bash.exe'));
  if (!samePath(selected.root, source.path) || selected.layout !== plan.layout) throw new Error('Source layout disagrees with the setup plan.');
  return { source, cache, generation, base, layout: plan.layout };
}

const brokerGraceMs = 250;

/** Local broker shutdown failed; ordinary setup rejection does not imply this. */
export class ProvisioningCleanupError extends AggregateError {}

/** A rejected observation is not a join. DSH retains the managed range throughout. */
async function stopBroker(broker: SubprocessHandle): Promise<void> {
  const errors: unknown[] = [];
  let exited = false;
  try { exited = await broker.waitForExit(AbortSignal.timeout(brokerGraceMs)); }
  catch (error) { errors.push(error); }
  if (!exited) { try { broker.terminate(); } catch (error) { errors.push(error); } }
  const settled = await Promise.allSettled([broker.done.catch(() => {}), broker.waitForExit()]);
  for (const result of settled) if (result.status === 'rejected') errors.push(result.reason);
  if (settled[1]?.status === 'fulfilled' && !settled[1].value) errors.push(new Error('Setup broker range did not settle.'));
  if (errors.length) throw new ProvisioningCleanupError(errors, 'Failed to settle the setup broker.');
}

/** Keep the setup lease through the caller's synchronous final admission. */
export async function provisionRuntime<T>(attempt: ProvisioningAttempt, signal: AbortSignal, spawn: Subprocess['spawn'], validate: () => T): Promise<T> {
  signal.throwIfAborted();
  const lease = createSetupLease(attempt.generation);
  let cancel!: () => void;
  const cancelled = new Promise<void>(resolve => { cancel = resolve; });
  const errors: unknown[] = [];
  let broker: SubprocessHandle | undefined;
  let joined = false;
  let validated!: T;
  const revoke = () => {
    try { lease.close(); } catch (error) { errors.push(error); }
    cancel();
  };
  signal.addEventListener('abort', revoke, { once: true });
  try {
    const fileIdentity = ({ volumeSerial, fileId }: FileIdentity): FileIdentity => ({ volumeSerial, fileId });
    const plan: ElevationPlan = {
      schemaVersion: 1, attemptId: randomUUID().replaceAll('-', ''), sourceRoot: attempt.source.path,
      cacheRoot: attempt.cache.path, generationId: basename(attempt.generation.path), baseRoot: attempt.base.path, layout: attempt.layout,
      identities: {
        source: fileIdentity(attempt.source), cache: fileIdentity(attempt.cache), generation: fileIdentity(attempt.generation),
        base: fileIdentity(attempt.base), lease: fileIdentity(lease.information()),
      },
    };
    writeNewMetadata(attempt.generation, 'plan.json', plan);
    signal.throwIfAborted();
    const child = broker = spawn({
      argv: [process.execPath, fileURLToPath(new URL('./elevation-broker.js', import.meta.url)), join(attempt.generation.path, 'plan.json')],
      cwd: attempt.cache.path, graceMs: brokerGraceMs,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 0 }, stderr: { maxBytes: 8192 } },
      env: { NODE_OPTIONS: undefined },
    });
    // A failed target outcome must revoke setup even if managed descendants
    // remain alive. Only successful exit waits for normal range settlement.
    const successfulExit = child.done.then(outcome => {
      if (outcome.exitCode !== 0 || outcome.signal !== null) {
        const diagnostic = child.collected.stderr?.readFrom(0).text ?? '';
        throw new LocalizedError(`Elevated setup failed (exit ${outcome.exitCode}, signal ${outcome.signal}). ${diagnostic}`, {
          key: 'error.elevatedSetup', params: { exit: String(outcome.exitCode), signal: String(outcome.signal) }, diagnostic,
        });
      }
    });
    const result = await Promise.race([Promise.all([successfulExit, child.waitForExit()]), cancelled]);
    signal.throwIfAborted();
    if (!result || !result[1]) throw new Error('Setup broker range did not settle.');
    joined = true;
    validated = validate();
  } catch (error) { errors.push(error); }
  // Revocation precedes local shutdown even when observation failed. Never use
  // plan unlink as cancellation; the caller retires it after final admission or
  // under the ordinary collector guard when this operation rejects.
  try { lease.close(); } catch (error) { errors.push(error); }
  if (broker && !joined) { try { await stopBroker(broker); } catch (error) { errors.push(error); } }
  signal.removeEventListener('abort', revoke);
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, 'Elevated setup or its local cleanup failed.');
  signal.throwIfAborted();
  return validated;
}
