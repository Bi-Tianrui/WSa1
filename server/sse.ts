import type { Response } from 'express';
import { LlmFailure } from './errors';

/** Stage 4 requirement: a heartbeat at least every 15 seconds. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * An SSE response with keep-alive heartbeat and write-after-close guards.
 *
 * Long provider "thinking" pauses otherwise leave the socket idle long enough for
 * proxies to drop it, which surfaces in the UI as a cursor that never resolves.
 */
export class SseChannel {
  private readonly res: Response;
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;
  readonly aborter = new AbortController();

  constructor(res: Response) {
    this.res = res;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      try {
        // SSE comment frame: keeps the socket warm without reaching the client parser.
        this.res.write(': keep-alive\n\n');
      } catch {}
    }, HEARTBEAT_INTERVAL_MS);

    res.on('close', () => {
      // Client navigated away or pressed stop; cancel any in-flight upstream request.
      this.closed = true;
      this.stopHeartbeat();
      this.aborter.abort();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  send(payload: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {}
  }

  /** Short progress line so the UI can show which pipeline stage is running. */
  stage(message: string): void {
    this.send({ stage: message });
  }

  notice(level: 'info' | 'warn', message: string): void {
    this.send({ notice: { level, message } });
  }

  fail(failure: LlmFailure): void {
    this.send({ error: failure.message, errorCode: failure.code, hint: failure.hint });
    this.end();
  }

  end(payload?: Record<string, unknown>): void {
    if (this.closed) return;
    if (payload) this.send(payload);
    this.stopHeartbeat();
    this.closed = true;
    try {
      this.res.end();
    } catch {}
  }
}
