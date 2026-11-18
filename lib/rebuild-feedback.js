import { randomUUID } from 'node:crypto';
import { LocalizedAggregateError, LocalizedError } from './localized-error.js';
export function describeFailure(error) {
    return { error: error instanceof Error ? error.message : String(error),
        localized: error instanceof LocalizedError || error instanceof LocalizedAggregateError ? error.localized : undefined };
}
/** Lives with one executor. Only an owner with a mounted overlay can answer its current request. */
export class RebuildFeedback {
    clients = new Map();
    failures = [];
    pending;
    frame(success = false) {
        const snapshot = { confirmation: this.pending?.notice, failure: this.failures[0], success };
        return new TextEncoder().encode(JSON.stringify(snapshot) + '\n');
    }
    publish(success = false) {
        const frame = this.frame(success);
        for (const client of this.clients.keys())
            client.enqueue(frame);
    }
    succeeded() { this.publish(true); }
    failed(error) {
        this.failures.push({ id: randomUUID(), reason: describeFailure(error) });
        this.publish();
    }
    async confirm(sourceChanged, unavailable, signal) {
        signal.throwIfAborted();
        if (!this.clients.size)
            throw unavailable;
        const id = randomUUID();
        let abort;
        try {
            await new Promise((resolve, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
                this.pending = { notice: { id, sourceChanged }, confirm: resolve, disconnect: () => reject(unavailable) };
                this.publish();
            });
        }
        finally {
            signal.removeEventListener('abort', abort);
            this.pending = undefined;
            this.publish();
        }
    }
    /** The native Connection registry checks owner authentication for both methods. */
    handle(request) {
        if (request.method === 'GET')
            return this.subscribe(request.signal);
        const params = new URL(request.url).searchParams;
        const id = params.get('id');
        if (params.get('action') === 'confirm' && this.pending?.notice.id === id) {
            this.pending.confirm();
            this.pending = undefined;
        }
        else if (params.get('action') === 'dismiss' && this.failures[0]?.id === id) {
            this.failures.shift();
            this.publish();
        }
        else
            return new Response(null, { status: 409 });
        return new Response(null, { status: 204 });
    }
    subscribe(signal) {
        let client;
        const remove = () => {
            signal.removeEventListener('abort', abort);
            if (this.clients.delete(client) && !this.clients.size)
                this.pending?.disconnect();
        };
        const abort = () => { if (this.clients.has(client))
            client.close(); remove(); };
        const stream = new ReadableStream({
            start: controller => {
                client = controller;
                this.clients.set(client, abort);
                client.enqueue(this.frame());
                if (signal.aborted)
                    abort();
                else
                    signal.addEventListener('abort', abort, { once: true });
            },
            cancel: remove,
        });
        return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
    }
    disconnect() {
        for (const close of this.clients.values())
            close();
    }
}
