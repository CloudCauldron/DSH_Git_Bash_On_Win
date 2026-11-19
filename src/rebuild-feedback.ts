import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-gateway';
import { RemoteError, TypertRemoteService, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { randomUUID } from 'node:crypto';
import { LocalizedAggregateError, LocalizedError } from './localized-error.ts';
import type { LinkProgress } from './runtime/runtime-cache.ts';

export function describeFailure(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error),
    localized: error instanceof LocalizedError || error instanceof LocalizedAggregateError ? error.localized : undefined };
}

export interface RebuildNotice {
  confirmation?: { id: string; sourceChanged: boolean };
  failure?: { id: string; reason: ReturnType<typeof describeFailure> };
  success?: boolean;
  progress?: LinkProgress;
}

const namespace = 'gitBashFeedback';
const streamContract = {
  package: 'dsh-git-bash-on-win',
  descriptors: [{ id: namespace + '/watch', service: namespace, namespace, method: 'watch', mode: 'stream',
    invocation: { kind: 'direct' }, parameters: [], cancellation: { parameter: 'signal' }, result: { mode: 'src-json' } }],
} as const satisfies TypertRemoteContribution;

/** Lives with one executor. Only an owner with a mounted overlay can answer its current request. */
export class RebuildFeedback extends TypertRemoteService {
  private progress?: LinkProgress;
  private nextPathUpdate = 0;
  private readonly clients = new Map<ReadableStreamDefaultController<RebuildNotice>, () => void>();
  private readonly failures: NonNullable<RebuildNotice['failure']>[] = [];
  private pending?: { notice: NonNullable<RebuildNotice['confirmation']>; confirm(): void; disconnect(): void };

  constructor(ctx: Context) {
    super(ctx, namespace);
    ctx.inject(['typert'], scope => {
      scope.typert.register({ package: streamContract.package, face: 'host', model: { services: [], events: [], objects: [] },
        schemas: [], invocations: streamContract.descriptors });
      scope.effect(() => () => this.disconnect());
    });
  }

  private frame(success = false): RebuildNotice {
    return { confirmation: this.pending?.notice, failure: this.failures[0], success, progress: this.progress };
  }

  private publish(success = false) {
    const frame = this.frame(success);
    for (const client of this.clients.keys()) client.enqueue(frame);
  }

  setProgress(progress?: LinkProgress) {
    // Bound filename updates on the owner stream. Always deliver phase changes and the final count.
    if (typeof progress === 'object') {
      const now = performance.now();
      if (now < this.nextPathUpdate && !(progress.completed !== undefined && progress.completed === progress.total)) return;
      this.nextPathUpdate = now + 150;
    } else {
      this.nextPathUpdate = 0;
    }
    this.progress = progress;
    this.publish();
  }

  succeeded() { this.publish(true); }

  failed(error: unknown) {
    this.failures.push({ id: randomUUID(), reason: describeFailure(error) });
    this.publish();
  }

  async confirm(sourceChanged: boolean, unavailable: LocalizedError, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.clients.size) throw unavailable;
    const id = randomUUID();
    let abort!: () => void;
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        this.pending = { notice: { id, sourceChanged }, confirm: resolve, disconnect: () => reject(unavailable) };
        this.publish();
      });
    } finally {
      signal.removeEventListener('abort', abort);
      this.pending = undefined;
      this.publish();
    }
  }

  /** The native Connection registry checks owner authentication for both methods. */
  handle(request: Request): Response {
    if (request.method === 'GET') return Response.json(streamContract);
    const params = new URL(request.url).searchParams;
    const id = params.get('id');
    if (params.get('action') === 'confirm' && this.pending?.notice.id === id) {
      this.pending.confirm();
      this.pending = undefined;
    } else if (params.get('action') === 'dismiss' && this.failures[0]?.id === id) {
      this.failures.shift();
      this.publish();
    } else return new Response(null, { status: 409 });
    return new Response(null, { status: 204 });
  }

  /** The Gateway runs this method on the calling peer's Cordis context. */
  watch(signal: AbortSignal) {
    const peer = this.ctx.invocation?.peer;
    if (peer?.principal.kind !== 'owner' || peer.interactions !== 'answer') {
      throw new RemoteError('gateway/interactions-forbidden', 'Interactive DSH owner required.', { endpoint: namespace + '/watch' });
    }
    let client: ReadableStreamDefaultController<RebuildNotice>;
    const remove = () => {
      signal.removeEventListener('abort', abort);
      if (this.clients.delete(client) && !this.clients.size) this.pending?.disconnect();
    };
    const abort = () => { if (this.clients.has(client)) client.close(); remove(); };
    return new ReadableStream<RebuildNotice>({
      start: controller => {
        client = controller;
        this.clients.set(client, abort);
        client.enqueue(this.frame());
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      },
      cancel: remove,
    });
  }

  disconnect() {
    for (const close of this.clients.values()) close();
  }
}
