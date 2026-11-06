import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCARD_TIMEOUT_MS, discardRest } from './routes/attachments.js';

describe('discardRest', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drops a client that keeps sending past the timeout', () => {
    const raw = new PassThrough();
    discardRest(raw);
    raw.write(Buffer.alloc(1024));
    vi.advanceTimersByTime(DISCARD_TIMEOUT_MS - 1);
    expect(raw.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(raw.destroyed).toBe(true);
  });

  it('honours a shorter injected timeout', () => {
    const raw = new PassThrough();
    discardRest(raw, 50);
    vi.advanceTimersByTime(50);
    expect(raw.destroyed).toBe(true);
  });

  it('clears the timer once the body ends', async () => {
    const raw = new PassThrough({ autoDestroy: false });
    discardRest(raw, 50);
    raw.end(Buffer.alloc(10));
    const destroy = vi.spyOn(raw, 'destroy');
    await new Promise((r) => raw.once('end', r));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('clears the timer when the request closes', async () => {
    const raw = new PassThrough();
    discardRest(raw, 50);
    raw.destroy();
    await new Promise((r) => raw.once('close', r));
    expect(vi.getTimerCount()).toBe(0);
  });
});
