import { randomUUID } from 'node:crypto';
import { LocalizedAggregateError, LocalizedError } from './localized-error.ts';

export function describeFailure(error: unknown) {
  return { error: error instanceof Error ? error.message : String(error),
    localized: error instanceof LocalizedError || error instanceof LocalizedAggregateError ? error.localized : undefined };
}

export interface RebuildNotice {
  confirmation?: { id: string; sourceChanged: boolean };
  failure?: { id: string; reason: ReturnType<typeof describeFailure> };
  success?: boolean;
}

/** Lives with one executor. Only an owner with a mounted overlay can answer its current request. */
export class RebuildFeedback {
  private readonly clients = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>();
  private readonly failures: NonNullable<RebuildNotice['failure']>[] = [];
  private pending?: { notice: NonNullable<RebuildNotice['confirmation']>; confirm(): void; disconnect(): void };

  private frame(success = false) {
    const snapshot: RebuildNotice = { confirmation: this.pending?.notice, failure: this.failures[0], success };
    return new TextEncoder().encode(JSON.stringify(snapshot) + '\n');
  }

  private publish(success = false) {
    const frame = this.frame(success);
    for (const client of this.clients.keys()) client.enqueue(frame);
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
    if (request.method === 'GET') return this.subscribe(request.signal);
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

  private subscribe(signal: AbortSignal) {
    let client: ReadableStreamDefaultController<Uint8Array>;
    const remove = () => {
      signal.removeEventListener('abort', abort);
      if (this.clients.delete(client) && !this.clients.size) this.pending?.disconnect();
    };
    const abort = () => { if (this.clients.has(client)) client.close(); remove(); };
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        client = controller;
        this.clients.set(client, abort);
        client.enqueue(this.frame());
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      },
      cancel: remove,
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
  }

  disconnect() {
    for (const close of this.clients.values()) close();
  }
}
