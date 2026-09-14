import type { ServerResponse } from 'node:http';

/** Bound unsent data per browser; disconnected clients recover from replay. */
const MAX_PENDING_BYTES = 64 * 1024;

export function formatEvent(event: string, data: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class SseConnection {
  private readonly pending: string[] = [];
  private pendingBytes = 0;
  private blocked = false;
  private closed = false;
  private onDispose: () => void = () => {};

  constructor(private readonly response: ServerResponse) {
    response.on('drain', this.flush);
    response.once('close', this.dispose);
    response.once('error', this.dispose);
  }

  setDisposeCallback(callback: () => void): void {
    this.onDispose = callback;
    if (this.closed) callback();
  }

  send(message: string): void {
    if (this.closed) return;
    if (this.blocked) {
      this.pendingBytes += Buffer.byteLength(message);
      if (this.pendingBytes > MAX_PENDING_BYTES) {
        this.dispose();
        this.response.destroy();
        return;
      }
      this.pending.push(message);
      return;
    }
    try {
      this.blocked = !this.response.write(message);
    } catch {
      this.dispose();
      this.response.destroy();
    }
  }

  close(): void {
    this.dispose();
    this.response.end();
  }

  private readonly flush = (): void => {
    this.blocked = false;
    while (!this.blocked && this.pending.length > 0 && !this.closed) {
      const message = this.pending.shift()!;
      this.pendingBytes -= Buffer.byteLength(message);
      this.send(message);
    }
  };

  private readonly dispose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.response.off('drain', this.flush);
    this.response.off('close', this.dispose);
    this.onDispose();
  };
}
