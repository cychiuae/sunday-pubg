import { describe, expect, it } from 'vitest';
import { VoicePool } from './VoicePool';

describe('VoicePool', () => {
  it('admits while under both limits', () => {
    const pool = new VoicePool<string>(4);
    expect(pool.admit('a', 50, 2).kind).toBe('admit');
    pool.add('a', 50, 0, 1, 'a1');
    expect(pool.admit('a', 50, 2).kind).toBe('admit');
  });

  it('steals the oldest instance of the same cue at its per-cue limit', () => {
    const pool = new VoicePool<string>(10);
    const first = pool.add('smg', 70, 0, 1, 'first');
    pool.add('smg', 70, 0.1, 1, 'second');
    const r = pool.admit('smg', 70, 2);
    expect(r.kind).toBe('steal');
    if (r.kind === 'steal') expect(r.victim).toBe(first);
  });

  it('prefers stealing a far (lower effective priority) instance over an older close one', () => {
    const pool = new VoicePool<string>(10);
    pool.add('smg', 74, 0, 1, 'old-close');
    const far = pool.add('smg', 71, 0.5, 1, 'new-far');
    const r = pool.admit('smg', 73, 2);
    expect(r.kind === 'steal' && r.victim).toBe(far);
  });

  it('rejects a same-cue voice quieter/farther than every playing instance', () => {
    const pool = new VoicePool<string>(10);
    pool.add('smg', 74, 0, 1, 'a');
    pool.add('smg', 74, 0, 1, 'b');
    expect(pool.admit('smg', 71, 2).kind).toBe('reject');
  });

  it('steals the lowest-priority voice globally when full, never a higher one', () => {
    const pool = new VoicePool<string>(3);
    pool.add('gull', 10, 0, 9, 'gull');
    pool.add('shot', 80, 0, 9, 'shot');
    pool.add('hit', 95, 0, 9, 'hit');
    const r = pool.admit('foot', 65, 4);
    expect(r.kind === 'steal' && r.victim.handle).toBe('gull');
    expect(pool.admit('impact', 5, 4).kind).toBe('reject');
  });

  it('breaks priority ties by age (oldest goes first)', () => {
    const pool = new VoicePool<string>(2);
    pool.add('x', 50, 1, 9, 'newer');
    pool.add('y', 50, 0.5, 9, 'older');
    const r = pool.admit('z', 50, 1);
    expect(r.kind === 'steal' && r.victim.handle).toBe('older');
  });

  it('never exceeds maxVoices when the caller honours admissions', () => {
    const pool = new VoicePool<number>(8);
    for (let i = 0; i < 200; i++) {
      const cue = `c${i % 5}`;
      const r = pool.admit(cue, (i * 37) % 100, 3);
      if (r.kind === 'reject') continue;
      if (r.kind === 'steal') pool.remove(r.victim);
      pool.add(cue, (i * 37) % 100, i, i + 10, i);
      expect(pool.size).toBeLessThanOrEqual(8);
      for (let c = 0; c < 5; c++) expect(pool.countOf(`c${c}`)).toBeLessThanOrEqual(3);
    }
  });

  it('reaps ended voices and reports each once', () => {
    const pool = new VoicePool<string>(8);
    pool.add('a', 1, 0, 1, 'a');
    pool.add('b', 1, 0, 2, 'b');
    pool.add('c', 1, 0, Infinity, 'loop');
    const ended: string[] = [];
    pool.reap(1.5, (v) => ended.push(v.handle));
    expect(ended).toEqual(['a']);
    pool.reap(100, (v) => ended.push(v.handle));
    expect(ended).toEqual(['a', 'b']);
    expect(pool.size).toBe(1);
  });

  it('remove is idempotent and clear empties the pool', () => {
    const pool = new VoicePool<string>(4);
    const v = pool.add('a', 1, 0, 1, 'a');
    pool.add('b', 1, 0, 1, 'b');
    expect(pool.remove(v)).toBe(true);
    expect(pool.remove(v)).toBe(false);
    expect(pool.has(v)).toBe(false);
    const cleared: string[] = [];
    pool.clear((x) => cleared.push(x.handle));
    expect(cleared).toEqual(['b']);
    expect(pool.size).toBe(0);
  });
});
