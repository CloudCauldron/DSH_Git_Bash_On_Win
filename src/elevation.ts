import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupCancellationFile } from './private-runtime.ts';

/** Elevate only the fixed link helper, while DSH's event loop stays responsive. */
export async function elevateLinks(source: string, generation: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let cancellationError: unknown;
  const cancel = () => {
    try { writeFileSync(join(generation, setupCancellationFile), '', { flag: 'wx' }); }
    catch (error) {
      if (!['EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) cancellationError = error;
    }
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL('./elevation-worker.js', import.meta.url), { workerData: {
        source, generation,
      } });
      let failure: unknown;
      worker.once('error', error => { failure = error; });
      // Even an errored/cancelled worker must exit before staging is removed.
      worker.once('exit', code => {
        if (cancellationError) reject(cancellationError);
        else if (signal.aborted) reject(signal.reason);
        else if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Hardlink setup worker exited ${code}; the command did not run.`));
        else resolve();
      });
    });
  } finally { signal.removeEventListener('abort', cancel); }
}
