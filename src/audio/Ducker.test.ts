import { describe, expect, it } from 'vitest';
import { Ducker } from './Ducker';

describe('Ducker', () => {
  it('is 0 dB with no ducks', () => {
    expect(new Ducker().targetDb('ambience', 0)).toBe(0);
  });

  it('applies the deepest active duck without stacking, then releases', () => {
    const d = new Ducker();
    d.duck('ambience', -6, 0, 2);
    d.duck('ambience', -9, 0.5, 0.3);
    expect(d.targetDb('ambience', 0.6)).toBe(-9);
    expect(d.targetDb('ambience', 1)).toBe(-6);
    expect(d.targetDb('ambience', 2.5)).toBe(0);
  });

  it('keeps buses independent and ignores positive dB', () => {
    const d = new Ducker();
    d.duck('sfx', -8, 0, 1);
    d.duck('ui', 5, 0, 1);
    expect(d.targetDb('ambience', 0.5)).toBe(0);
    expect(d.targetDb('sfx', 0.5)).toBe(-8);
    expect(d.targetDb('ui', 0.5)).toBe(0);
  });

  it('caps stored entries under spam', () => {
    const d = new Ducker();
    for (let i = 0; i < 1000; i++) d.duck('ambience', -4, i * 0.001, 0.2);
    expect(d.targetDb('ambience', 1)).toBe(-4);
    d.clear();
    expect(d.targetDb('ambience', 1)).toBe(0);
  });
});
