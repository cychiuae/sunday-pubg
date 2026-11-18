import { describe, expect, it } from 'vitest';
import { LogLimiter } from './logLimiter';

describe('LogLimiter', () => {
  it('logs the first warning per key at once, then one per interval with the suppressed count', () => {
    let now = 0;
    const out: string[] = [];
    const log = new LogLimiter(() => now, 5000, (m) => out.push(m));
    for (let i = 0; i < 100; i++) {
      log.warn('a', 'bad frame');
      now += 50; // 20 Hz for 5 s
    }
    log.warn('b', 'other key');
    expect(out).toEqual(['bad frame', 'other key']);
    log.warn('a', 'bad frame');
    expect(out).toEqual(['bad frame', 'other key', 'bad frame (+99 similar in the last 5 s)']);
    log.reset();
    expect(log.warn('a', 'again')).toBe(true);
  });
});
