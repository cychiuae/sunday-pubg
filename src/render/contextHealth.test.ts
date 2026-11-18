import { describe, expect, it } from 'vitest';
import { CONTEXT_RESTORE_TIMEOUT_MS } from '../shared/constants';
import { ContextHealth } from './contextHealth';

describe('ContextHealth (IRenderer.getGraphicsStatus)', () => {
  it('is ok until the context is lost', () => {
    const h = new ContextHealth(CONTEXT_RESTORE_TIMEOUT_MS);
    expect(h.status(0)).toBe('ok');
    expect(h.isLost).toBe(false);
  });

  it('reports restoring while lost, failed after the timeout, ok after a restore', () => {
    const h = new ContextHealth(5000);
    h.lost(1000);
    expect(h.isLost).toBe(true);
    expect(h.status(1000)).toBe('restoring');
    expect(h.status(5999)).toBe('restoring');
    expect(h.status(6000)).toBe('failed');
    h.restored();
    expect(h.status(7000)).toBe('ok');
    expect(h.lossCount).toBe(1);
  });

  it('a late restore after failed goes back to ok, and a new loss restarts the clock', () => {
    const h = new ContextHealth(5000);
    h.lost(0);
    expect(h.status(10_000)).toBe('failed');
    h.restored();
    expect(h.status(10_001)).toBe('ok');
    h.lost(20_000);
    expect(h.status(24_000)).toBe('restoring');
    expect(h.status(25_000)).toBe('failed');
    expect(h.lossCount).toBe(2);
  });

  it('a repeated loss event does not reset the timeout', () => {
    const h = new ContextHealth(5000);
    h.lost(0);
    h.lost(4000);
    expect(h.status(5000)).toBe('failed');
    expect(h.lossCount).toBe(1);
  });
});
