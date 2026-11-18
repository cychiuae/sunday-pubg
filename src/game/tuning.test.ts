import { describe, expect, expectTypeOf, it } from 'vitest';
import { BALANCE, balanceForMap, CLIENT_FEEL_FP_KEYS, type Balance, type ClientFeelBalance } from '../shared/balance';
import { GUN_IDS } from '../shared/types';
import { DEFAULT_CLIENT_TUNING, FP_TUNING_KEYS, resolveClientTuning, type ClientTuning, type FpTuningKey } from './tuning';

/** game-designer is adding clientFeel.deathCamKillerRange (30); the union holds before and after it lands. */
type PendingFeelKey = 'deathCamKillerRange';

describe('resolveClientTuning', () => {
  it('ClientTuning and balance clientFeel use exactly the same key names', () => {
    expectTypeOf<keyof ClientTuning>().toEqualTypeOf<keyof ClientFeelBalance | FpTuningKey | 'fpRecoil' | PendingFeelKey>();
    expect([...FP_TUNING_KEYS].sort()).toEqual([...CLIENT_FEEL_FP_KEYS].sort());
  });

  it('the real balance.json clientFeel section sets every tuning key', () => {
    const feel = BALANCE.clientFeel as Record<string, unknown> | undefined;
    expect(feel).toBeDefined();
    const t = resolveClientTuning(BALANCE);
    for (const key of Object.keys(DEFAULT_CLIENT_TUNING) as (keyof ClientTuning)[]) {
      if (key === 'fpRecoil') continue;
      if (key === 'deathCamKillerRange' && feel?.[key] === undefined) continue; // until the designer's key lands
      expect(feel?.[key], key).toBeTypeOf('number');
      expect(t[key], key).toBe(feel?.[key]);
    }
    for (const gun of GUN_IDS) expect(t.fpRecoil[gun], gun).toEqual((feel?.['fpRecoil'] as Record<string, unknown>)[gun]);
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

  it('fpRecoil merges per gun; incomplete or non-finite entries are ignored', () => {
    const feel = { fpRecoil: { pistol: { kickBack: 1, kickPitchDeg: 2, rollDeg: 3, fovPunchDeg: 4, returnMs: 5 }, smg: { kickBack: 1 } } };
    const t = resolveClientTuning({ ...BALANCE, clientFeel: feel as ClientFeelBalance });
    expect(t.fpRecoil.pistol).toEqual({ kickBack: 1, kickPitchDeg: 2, rollDeg: 3, fovPunchDeg: 4, returnMs: 5 });
    expect(t.fpRecoil.smg).toEqual(DEFAULT_CLIENT_TUNING.fpRecoil.smg);
  });

  it('M2b: resolved from the per-map balance, so maps.<id>.clientFeel overrides apply', () => {
    const base = resolveClientTuning(BALANCE);
    const officeFeel = (BALANCE.maps?.['office'] as { clientFeel?: Record<string, number> } | undefined)?.clientFeel;
    const office = resolveClientTuning(balanceForMap(BALANCE, 'office'));
    if (officeFeel?.['carrierCameraDistance'] !== undefined) {
      expect(office.carrierCameraDistance).toBe(officeFeel['carrierCameraDistance']);
      expect(office.carrierCameraDistance).not.toBe(base.carrierCameraDistance);
    } else {
      expect(office.carrierCameraDistance).toBe(base.carrierCameraDistance);
    }
  });
});
