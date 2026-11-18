import { describe, expect, expectTypeOf, it } from 'vitest';
import { BALANCE, type Balance, type ClientFeelBalance } from '../shared/balance';
import { DEFAULT_CLIENT_TUNING, resolveClientTuning, type ClientTuning } from './tuning';

describe('resolveClientTuning', () => {
  it('ClientTuning and balance clientFeel use exactly the same key names', () => {
    expectTypeOf<keyof ClientTuning>().toEqualTypeOf<keyof ClientFeelBalance>();
  });

  it('the real balance.json clientFeel section sets every tuning key', () => {
    const feel = BALANCE.clientFeel;
    expect(feel).toBeDefined();
    const t = resolveClientTuning(BALANCE);
    for (const key of Object.keys(DEFAULT_CLIENT_TUNING) as (keyof ClientTuning)[]) {
      expect(feel?.[key], key).toBeTypeOf('number');
      expect(t[key], key).toBe(feel?.[key]);
    }
  });

  it('uses the code defaults when balance has no clientFeel section', () => {
    const balance: Balance = { ...BALANCE };
    delete balance.clientFeel;
    expect(resolveClientTuning(balance)).toEqual(DEFAULT_CLIENT_TUNING);
  });

  it('balance.clientFeel overrides individual keys; explicit overrides win over balance', () => {
    const balance: Balance = { ...BALANCE, clientFeel: { cameraFovDeg: 80, cameraDistance: 4, correctionDecayMs: Number.NaN } };
    const t = resolveClientTuning(balance, { cameraDistance: 5 });
    expect(t.cameraFovDeg).toBe(80);
    expect(t.cameraDistance).toBe(5);
    // Non-finite values are ignored.
    expect(t.correctionDecayMs).toBe(DEFAULT_CLIENT_TUNING.correctionDecayMs);
    expect(t.mouseRadiansPerPixel).toBe(DEFAULT_CLIENT_TUNING.mouseRadiansPerPixel);
  });
});
