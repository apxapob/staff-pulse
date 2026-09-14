import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { formatEvent, SseConnection } from './sse.js';

class ResponseStub extends EventEmitter {
  write = vi.fn<(message: string) => boolean>().mockReturnValue(true);
  end = vi.fn();
  destroy = vi.fn();
}

describe('SSE backpressure', () => {
  it('queues in order after a blocked write and resumes on drain', () => {
    const response = new ResponseStub();
    response.write.mockReturnValueOnce(false);
    const connection = new SseConnection(response as unknown as ServerResponse);
    connection.send('first');
    connection.send('second');
    connection.send('third');
    expect(response.write.mock.calls).toEqual([['first']]);
    response.emit('drain');
    expect(response.write.mock.calls).toEqual([['first'], ['second'], ['third']]);
    connection.close();
  });

  it('disconnects a slow client when its bounded pending queue fills', () => {
    const response = new ResponseStub();
    response.write.mockReturnValue(false);
    const connection = new SseConnection(response as unknown as ServerResponse);
    const unsubscribe = vi.fn();
    connection.setDisposeCallback(unsubscribe);
    connection.send('blocked');
    connection.send('x'.repeat(64 * 1024));
    connection.send('over limit');
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(response.listenerCount('drain')).toBe(0);
  });

  it('cleans up exactly once when the connection closes', () => {
    const response = new ResponseStub();
    const connection = new SseConnection(response as unknown as ServerResponse);
    const unsubscribe = vi.fn();
    connection.setDisposeCallback(unsubscribe);
    response.emit('close');
    connection.close();
    connection.send('ignored');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(response.write).not.toHaveBeenCalled();
  });

  it('formats named JSON events and resume ids', () => {
    expect(formatEvent('ready', { cursor: 'instance:2' }, 'instance:2')).toBe(
      'id: instance:2\nevent: ready\ndata: {"cursor":"instance:2"}\n\n',
    );
  });
});
